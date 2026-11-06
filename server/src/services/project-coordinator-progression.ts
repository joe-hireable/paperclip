import { and, eq, sql } from "drizzle-orm";
import { authUsers, companyMemberships, companies, heartbeatRuns, issueComments, issues, projects, type Db } from "@paperclipai/db";
import { projectCoordinationPolicySchema } from "@paperclipai/shared";
import { forbidden, HttpError } from "../errors.js";
import { accessService } from "./access.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import type { AuthorizationActor } from "./authorization.js";
import { documentService } from "./documents.js";
import { resolveExecutionBindingSnapshot } from "./execution-bindings.js";
import type { heartbeatService } from "./heartbeat.js";
import { intelligentRoutingContractService } from "./intelligent-routing-contracts.js";
import { issueService } from "./issues.js";
import { projectCoordinatorAttemptService } from "./project-coordinator-attempts.js";
import { COORDINATOR_INTAKE_SOURCE_KEY } from "./project-coordinator-intake.js";

/** Continues durable intake using existing admission and heartbeat, without retrying a native run. */
export function projectCoordinatorProgressionService(db: Db, wakeup: ReturnType<typeof heartbeatService>["wakeup"]) {
  async function advance(intakeId: string) {
    const [intake] = await db.select().from(issues).where(and(eq(issues.id, intakeId), eq(issues.originKind, "project_coordinator_intake")));
    if (!intake?.projectId || intake.status !== "blocked") return;
    const [project] = await db.select().from(projects).where(and(eq(projects.id, intake.projectId), eq(projects.companyId, intake.companyId)));
    const parsed = projectCoordinationPolicySchema.safeParse(project?.coordinationPolicy);
    if (!project || project.archivedAt || !parsed.success || !parsed.data.enabled || !parsed.data.automaticExecution) return;
    const policy = parsed.data, automatic = policy.automaticExecution!;
    const sourceDocument = await documentService(db).getIssueDocumentByKey(intake.id, COORDINATOR_INTAKE_SOURCE_KEY);
    if (!sourceDocument?.lockedAt || !sourceDocument.body) return;
    const source = JSON.parse(sourceDocument.body);
    // Never adopt historical intakes when automatic execution is enabled later.
    if (source.projectPolicyRevision !== project.coordinationPolicyRevision) return;
    const userId = source.requestedByUserId;
    try {
      const [user] = await db.select({ id: authUsers.id }).from(authUsers).where(eq(authUsers.id, userId));
      if (!user) throw forbidden("The requesting user is no longer available");
      const memberships = await db.select().from(companyMemberships).where(and(
        eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId), eq(companyMemberships.status, "active"),
      ));
      const actor: AuthorizationActor = { type: "board", source: "session", userId, ignoreInstanceAdmin: true,
        companyIds: memberships.map(m => m.companyId), memberships };
      const allowed = await accessService(db).decide({ actor, action: "runtime:manage", resource: { type: "project", companyId: project.companyId, projectId: project.id } });
      if (!allowed.allowed) throw forbidden("The requesting user cannot authorise project execution");
      const attempts = projectCoordinatorAttemptService(db);
      const prepared = await attempts.prepare(intake.id, actor, {
        projectWorkspaceId: automatic.projectWorkspaceId, expectedPolicyRevision: project.coordinationPolicyRevision,
        centralCompanyId: automatic.centralCompanyId, expectedCentralPolicyDigest: automatic.centralPolicyDigest,
        ...(policy.dataClass === "private" ? { projectContext: {} } : {}),
      });
      const [parent] = await db.select().from(issues).where(eq(issues.id, prepared.attemptId));
      const [child] = parent?.status === "in_review" ? await db.select().from(issues).where(and(
        eq(issues.companyId, intake.companyId), eq(issues.originKind, "project_coordinator_attempt"), eq(issues.originId, prepared.attemptId),
      )) : [];
      const target = child ?? parent;
      if (!target || !["blocked", "todo"].includes(target.status)) return;
      const [previousRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
        eq(heartbeatRuns.companyId, intake.companyId),
        sql`(${heartbeatRuns.nativeIssueId} = ${target.id} or ${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${target.id})`,
      ));
      if (previousRun) return;
      const evidence = child ? automatic.specialist : automatic.coordinator;
      if (!evidence) throw forbidden("The specialist has no approved routing evidence");
      const routes = intelligentRoutingContractService(db, { resolveSnapshot: resolveExecutionBindingSnapshot });
      const context = await routes.context(intake.companyId, target.id);
      const route = await routes.latest(intake.companyId, target.id) ?? await routes.create(intake.companyId, target.id, {
        ...evidence, expectedInputDigest: context.inputDigest, expectedRevision: context.latestRevision,
      }, userId);
      const admitted = await attempts.admit(target.id, actor, {
        expectedAuthorityDigest: target.originFingerprint, expectedRoutingRevision: route.revision,
      });
      if (admitted.enqueue && admitted.agentId) await wakeup(admitted.agentId, {
        source: "automation", triggerDetail: "system", reason: "project_coordinator_automatic_execution",
        requestedByActorType: "user", requestedByActorId: userId,
        contextSnapshot: { issueId: target.id }, idempotencyKey: `coordinator:${target.id}`,
      });
    } catch (error) {
      // Keep the submitted request durable. A later recovery tick may repair a
      // pre-start race, but never changes evidence or restarts an existing run.
      const reason = error instanceof HttpError ? error.message : "Execution could not be prepared; server diagnostics are required";
      const body = `[Request](/issues/${intake.id}) is waiting: ${reason}.`;
      const publications: ActivityPublication[] = [];
      await db.transaction(async tx => {
        await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, intake.parentId!)).for("update");
        const [existing] = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
          eq(issueComments.issueId, intake.parentId!), eq(issueComments.authorType, "system"), eq(issueComments.body, body),
        ));
        if (existing) return;
        const comment = await issueService(tx as unknown as Db).addComment(intake.parentId!, body, {}, {
          authorType: "system", sourceTrust: intake.sourceTrust,
          presentation: { kind: "system_notice", tone: "warning", title: "Request waiting", detailsDefaultOpen: true },
        });
        await logActivity(tx as unknown as Db, { companyId: intake.companyId, actorType: "system", actorId: "coordinator-progression",
          action: "issue.comment_added", entityType: "issue", entityId: intake.parentId!, issueId: intake.parentId!,
          details: { commentId: comment.id, intakeId, reason } }, publications);
      });
      publications.forEach(publishActivity);
    }
  }

  async function recover(createdAtGte?: Date | null) {
    const pending = await db.select({ id: issues.id }).from(issues)
      .innerJoin(projects, and(eq(projects.id, issues.projectId), eq(projects.companyId, issues.companyId)))
      .innerJoin(companies, eq(companies.id, issues.companyId)).where(and(
        eq(issues.originKind, "project_coordinator_intake"), eq(issues.status, "blocked"), eq(companies.status, "active"),
        sql`${projects.coordinationPolicy} -> 'automaticExecution' is not null`,
        createdAtGte ? sql`${issues.createdAt} >= ${createdAtGte}` : undefined,
      ));
    for (const intake of pending) await advance(intake.id);
  }
  return { advance, recover };
}
