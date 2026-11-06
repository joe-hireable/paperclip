import { createHash, randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  documents,
  documentRevisions,
  issueDocuments,
  issueComments,
  issues,
  projects,
  type Db,
} from "@paperclipai/db";
import type { SourceTrustMetadata } from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";
import { accessService } from "./access.js";
import { issueService } from "./issues.js";
import { conflict, forbidden, notFound } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

export const COORDINATOR_INTAKE_ORIGIN = "project_coordinator_intake";
export const COORDINATOR_INTAKE_SOURCE_KEY = "coordinator-intake-source";
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");

/** A committed child is the durable intake receipt. This slice never enqueues execution. */
export function projectCoordinatorIntakeService(db: Db) {
  return {
    addComment: async (input: {
      masterId: string;
      body: string;
      requestId?: string;
      actor: AuthorizationActor;
      sourceTrust: SourceTrustMetadata | null;
    }) => {
      if (
        input.actor.type !== "board" ||
        !input.actor.userId ||
        input.actor.agentId ||
        input.actor.runId
      )
        throw forbidden(
          "Only board-authored input can create coordinator intake",
        );
      const [identity] = await db
        .select({ projectId: issues.projectId, companyId: issues.companyId })
        .from(issues)
        .where(eq(issues.id, input.masterId));
      if (!identity?.projectId)
        throw notFound("Project conversation not found");
      const requestId = input.requestId ?? randomUUID();
      const requestDigest = digest(
        JSON.stringify({ body: input.body, userId: input.actor.userId }),
      );
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        const reader = tx as unknown as Db;
        // Same order as master creation/adoption: project, then its master issue.
        const [project] = await tx
          .select()
          .from(projects)
          .where(
            and(
              eq(projects.id, identity.projectId!),
              eq(projects.companyId, identity.companyId),
            ),
          )
          .for("update");
        const [master] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.id, input.masterId),
              eq(issues.companyId, identity.companyId),
            ),
          )
          .for("update");
        if (
          !project ||
          !master ||
          master.originKind !== "project_master_chat" ||
          master.originId !== project.id ||
          master.projectId !== project.id
        )
          throw notFound("Project conversation not found");
        for (const action of ["issue:comment", "tasks:assign"] as const) {
          const decision = await accessService(reader).decide({
            actor: input.actor,
            action,
            resource: {
              type: "issue",
              companyId: project.companyId,
              projectId: project.id,
              issueId: master.id,
              status: master.status,
              assigneeAgentId: null,
              assigneeUserId: master.assigneeUserId,
            },
          });
          if (!decision.allowed)
            throw forbidden(
              "Coordinator intake is outside this actor's authorization boundary",
            );
        }
        if (project.archivedAt)
          throw conflict(
            "Cannot create coordinator intake in an archived project",
          );
        const [existing] = await tx
          .select()
          .from(issues)
          .where(
            and(
              eq(issues.companyId, project.companyId),
              eq(issues.originKind, COORDINATOR_INTAKE_ORIGIN),
              eq(issues.originId, master.id),
              eq(issues.originFingerprint, requestId),
            ),
          );
        if (existing) {
          const [source] = await tx
            .select({ body: documents.latestBody })
            .from(issueDocuments)
            .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
            .where(
              and(
                eq(issueDocuments.issueId, existing.id),
                eq(issueDocuments.key, COORDINATOR_INTAKE_SOURCE_KEY),
              ),
            );
          if (!source) throw conflict("Coordinator intake source is missing");
          const receipt = JSON.parse(source.body) as {
            requestDigest: string;
            sourceCommentId: string;
            sourceDigest: string;
          };
          if (receipt.requestDigest !== requestDigest)
            throw conflict(
              "Intake request ID was already used for different input",
            );
          const [comment] = await tx
            .select()
            .from(issueComments)
            .where(
              and(
                eq(issueComments.id, receipt.sourceCommentId),
                eq(issueComments.issueId, master.id),
              ),
            );
          if (
            !comment ||
            comment.deletedAt ||
            digest(comment.body) !== receipt.sourceDigest
          )
            throw conflict("Coordinator intake comment is missing or changed");
          return {
            comment,
            intake: existing,
            requestId,
            executionReady: false as const,
          };
        }
        const service = issueService(reader);
        const comment = await service.addComment(
          master.id,
          input.body,
          { userId: input.actor.userId! },
          { sourceTrust: input.sourceTrust },
          tx,
        );
        const intake = await service.create(project.companyId, {
          parentId: master.id,
          projectId: project.id,
          title: "Coordinator intake awaiting qualification",
          description: `Source: [project conversation](/issues/${master.id}#comment-${comment.id}).\n\nBlocked: coordinator delivery and scoped execution are not qualified. No work has been dispatched.`,
          status: "blocked",
          assigneeAgentId: null,
          originKind: COORDINATOR_INTAKE_ORIGIN,
          originId: master.id,
          originFingerprint: requestId,
          createdByUserId: input.actor.userId!,
          actorResponsibleUserId: input.actor.userId!,
          allowDuplicate: true,
          sourceTrust: input.sourceTrust,
        });
        const body = JSON.stringify(
          {
            version: 1,
            requestId,
            requestDigest,
            companyId: project.companyId,
            projectId: project.id,
            masterIssueId: master.id,
            sourceCommentId: comment.id,
            sourceBody: comment.body,
            sourceDigest: digest(comment.body),
            requestedByUserId: input.actor.userId,
            projectPolicyRevision: project.coordinationPolicyRevision,
            qualification: "coordinator_not_qualified",
          },
          null,
          2,
        );
        const documentId = randomUUID(),
          revisionId = randomUUID();
        await tx.insert(documents).values({
          id: documentId,
          companyId: project.companyId,
          title: "Coordinator intake source",
          format: "markdown",
          latestBody: body,
          latestRevisionId: revisionId,
          latestRevisionNumber: 1,
          lockedAt: new Date(),
          createdByUserId: input.actor.userId,
          sourceTrust: input.sourceTrust,
        });
        await tx.insert(documentRevisions).values({
          id: revisionId,
          companyId: project.companyId,
          documentId,
          revisionNumber: 1,
          title: "Coordinator intake source",
          format: "markdown",
          body,
          createdByUserId: input.actor.userId,
        });
        await tx.insert(issueDocuments).values({
          companyId: project.companyId,
          issueId: intake.id,
          documentId,
          key: COORDINATOR_INTAKE_SOURCE_KEY,
        });
        await logActivity(
          reader,
          {
            companyId: project.companyId,
            actorType: "user",
            actorId: input.actor.userId!,
            action: "issue.comment_added",
            entityType: "issue",
            entityId: master.id,
            details: {
              commentId: comment.id,
              identifier: master.identifier,
              issueTitle: master.title,
            },
          },
          publications,
        );
        await logActivity(
          reader,
          {
            companyId: project.companyId,
            actorType: "user",
            actorId: input.actor.userId!,
            action: "issue.created",
            entityType: "issue",
            entityId: intake.id,
            details: {
              title: intake.title,
              identifier: intake.identifier,
              parentId: master.id,
            },
          },
          publications,
        );
        await logActivity(
          reader,
          {
            companyId: project.companyId,
            actorType: "user",
            actorId: input.actor.userId!,
            action: "project.coordinator_intake_created",
            entityType: "issue",
            entityId: intake.id,
            issueId: intake.id,
            details: {
              masterIssueId: master.id,
              sourceCommentId: comment.id,
              requestId,
              qualification: "coordinator_not_qualified",
            },
          },
          publications,
        );
        return { comment, intake, requestId, executionReady: false as const };
      });
      publications.forEach(publishActivity);
      return result;
    },
  };
}
