import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  heartbeatRuns,
  issues,
  projects,
  runExecutionBindings,
  type Db,
} from "@paperclipai/db";
import type { ProjectConversation } from "@paperclipai/shared";
import { projectCoordinationPolicySchema } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

const ORIGIN = "project_master_chat";
type Project = typeof projects.$inferSelect;
type Issue = typeof issues.$inferSelect;

function summary(project: Project, master: Issue | null): ProjectConversation {
  const policy = projectCoordinationPolicySchema.safeParse(project.coordinationPolicy);
  return {
    companyId: project.companyId,
    projectId: project.id,
    masterIssue: master
      ? {
          id: master.id,
          identifier: master.identifier,
          title: master.title,
          status: master.status,
          assigneeUserId: master.assigneeUserId,
        }
      : null,
    executionReady: false,
    automaticExecutionConfigured: !project.archivedAt && policy.success && policy.data.enabled && !!policy.data.automaticExecution,
    readinessReason: project.archivedAt
      ? "project_archived"
      : "coordinator_not_qualified",
  };
}

export function projectConversationService(db: Db) {
  async function master(reader: Db, companyId: string, projectId: string) {
    return reader
      .select()
      .from(issues)
      .where(
        and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, ORIGIN),
          eq(issues.originId, projectId),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  return {
    async get(
      companyId: string,
      projectId: string,
    ): Promise<ProjectConversation> {
      const [project] = await db
        .select()
        .from(projects)
        .where(
          and(eq(projects.id, projectId), eq(projects.companyId, companyId)),
        );
      if (!project) throw notFound("Project not found");
      return summary(project, await master(db, companyId, projectId));
    },

    async ensure(
      companyId: string,
      projectId: string,
      actorUserId: string,
      adoptIssueId?: string,
    ): Promise<ProjectConversation> {
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        const txDb = tx as unknown as Db;
        // Permanent project identity serialises creation and adoption, regardless of issue status.
        const [project] = await tx
          .select()
          .from(projects)
          .where(
            and(eq(projects.id, projectId), eq(projects.companyId, companyId)),
          )
          .for("update");
        if (!project) throw notFound("Project not found");
        if (project.archivedAt)
          throw conflict("Cannot create or adopt conversations in archived projects");
        const existing = await master(txDb, companyId, projectId);
        if (existing) {
          if (adoptIssueId && adoptIssueId !== existing.id)
            throw conflict(
              "Project already has a different master conversation",
            );
          return summary(project, existing);
        }

        let conversation: Issue;
        if (adoptIssueId) {
          const [candidate] = await tx
            .select()
            .from(issues)
            .where(
              and(
                eq(issues.id, adoptIssueId),
                eq(issues.companyId, companyId),
                eq(issues.projectId, projectId),
              ),
            )
            .for("update");
          if (
            !candidate ||
            candidate.parentId ||
            candidate.originKind !== "manual" ||
            candidate.assigneeAgentId ||
            candidate.checkoutRunId ||
            candidate.executionRunId ||
            candidate.executionLockedAt
          ) {
            throw unprocessable(
              "Adoption requires an unassigned manual root issue in this project with no active execution",
            );
          }
          const [activeRun] = await tx
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .leftJoin(
              runExecutionBindings,
              eq(runExecutionBindings.runId, heartbeatRuns.id),
            )
            .where(
              and(
                eq(heartbeatRuns.companyId, companyId),
                or(
                  eq(heartbeatRuns.nativeIssueId, candidate.id),
                  sql`${heartbeatRuns.contextSnapshot}->>'issueId' = ${candidate.id}`,
                ),
                or(
                  inArray(heartbeatRuns.status, [
                    "queued",
                    "scheduled_retry",
                    "running",
                  ]),
                  and(
                    isNotNull(runExecutionBindings.runId),
                    isNull(runExecutionBindings.releasedAt),
                  ),
                ),
              ),
            )
            .limit(1);
          const [pendingWake] = await tx
            .select({ id: agentWakeupRequests.id })
            .from(agentWakeupRequests)
            .where(
              and(
                eq(agentWakeupRequests.companyId, companyId),
                inArray(agentWakeupRequests.status, [
                  "queued",
                  "deferred_issue_execution",
                  "claimed",
                ]),
                sql`${agentWakeupRequests.payload}->>'issueId' = ${candidate.id}`,
              ),
            )
            .limit(1);
          if (activeRun || pendingWake)
            throw conflict(
              "Issue still has pending work or an unsettled execution",
            );
          // Preserve all content, history and ownership. This reserved identity is not a generic issue edit.
          [conversation] = await tx
            .update(issues)
            .set({ originKind: ORIGIN, originId: projectId })
            .where(eq(issues.id, candidate.id))
            .returning();
        } else {
          conversation = await issueService(txDb).create(companyId, {
            projectId,
            title: `${project.name} conversation`,
            status: "backlog",
            originKind: ORIGIN,
            originId: projectId,
            createdByUserId: actorUserId,
            actorResponsibleUserId: actorUserId,
            allowDuplicate: true,
          });
        }
        await logActivity(
          txDb,
          {
            companyId,
            actorType: "user",
            actorId: actorUserId,
            action: adoptIssueId ? "issue.updated" : "issue.created",
            entityType: "issue",
            entityId: conversation.id,
            details: {
              projectId,
              projectConversation: true,
              adopted: Boolean(adoptIssueId),
            },
          },
          publications,
        );
        return summary(project, conversation);
      });
      publications.forEach(publishActivity);
      return result;
    },
  };
}
