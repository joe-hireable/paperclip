import { and, eq } from "drizzle-orm";
import {
  agents,
  companySkills,
  companySkillVersions,
  executionBindings,
  projects,
  projectWorkspaces,
  type Db,
} from "@paperclipai/db";
import {
  projectCoordinationPolicySchema,
  updateProjectCoordinationPolicySchema,
  type ProjectCoordinationPolicy,
  type ProjectCoordinationPolicyReadiness,
} from "@paperclipai/shared";
import type { AuthorizationActor } from "./authorization.js";
import { accessService } from "./access.js";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";

type Project = typeof projects.$inferSelect;

// Read only: no reservation, profile probing, skill projection or provider calls.
async function roleReferenceProblems(
  db: Db,
  project: Project,
  policy: Pick<ProjectCoordinationPolicy, "profiles" | "skills" | "dataClass">,
  agentId: string,
): Promise<string[]> {
  const problems: string[] = [];
  const [lead] = await db
    .select()
    .from(agents)
    .where(
      and(
        eq(agents.id, agentId),
        eq(agents.companyId, project.companyId),
      ),
    );
  if (!lead) problems.push("role_unavailable");
  else if (lead.status !== "idle" && lead.status !== "running")
    problems.push("role_not_active");
  for (const profile of policy.profiles) {
    const [binding] = await db
      .select()
      .from(executionBindings)
      .where(
        and(
          eq(executionBindings.id, profile.bindingId),
          eq(executionBindings.companyId, project.companyId),
        ),
      );
    if (!binding) {
      problems.push("binding_unavailable");
      continue;
    }
    const def = binding.definition;
    if (
      !def.allowedAgentIds.includes(agentId) ||
      !def.dataClasses.includes(policy.dataClass)
    )
      problems.push("binding_scope_mismatch");
    if (
      profile.accountKey !== def.accountKey ||
      profile.harness !== def.adapterType ||
      !def.models.includes(profile.model) ||
      profile.effort !== def.reasoningEffort
    )
      problems.push("binding_profile_mismatch");
    if (!["claude_local", "codex_local"].includes(def.adapterType))
      problems.push("delivery_not_supported");
    if (
      !binding.enabled ||
      !binding.profileRoots?.length ||
      Date.parse(def.verifiedUntil) <= Date.now()
    )
      problems.push("binding_not_qualified");
  }
  for (const pin of policy.skills) {
    const [version] = await db
      .select({ id: companySkillVersions.id })
      .from(companySkillVersions)
      .innerJoin(
        companySkills,
        eq(companySkills.id, companySkillVersions.companySkillId),
      )
      .where(
        and(
          eq(companySkills.companyId, project.companyId),
          eq(companySkills.key, pin.key),
          eq(companySkillVersions.companyId, project.companyId),
          eq(companySkillVersions.id, pin.versionId),
        ),
      );
    if (!version) problems.push("skill_version_unavailable");
  }
  return [...new Set(problems)];
}

async function referenceProblems(db: Db, project: Project, policy: ProjectCoordinationPolicy) {
  const problems = (await roleReferenceProblems(db, project, policy, project.leadAgentId!))
    .map(reason => reason.replace(/^role_/, "lead_"));
  const specialist = policy.specialistHandoff;
  if (specialist) {
    problems.push(...(await roleReferenceProblems(db, project, {
      dataClass: policy.dataClass, profiles: [specialist.profile], skills: specialist.skills,
    }, specialist.agentId)).map(reason => `specialist_${reason}`));
    if (specialist.agentId === project.leadAgentId) problems.push("specialist_role_must_differ");
    if (specialist.profile.deliveryMode !== "manifest_coordinator") problems.push("specialist_delivery_not_supported");
    const [workspace] = await db.select().from(projectWorkspaces).where(and(
      eq(projectWorkspaces.id, specialist.projectWorkspaceId),
      eq(projectWorkspaces.companyId, project.companyId),
      eq(projectWorkspaces.projectId, project.id),
    ));
    if (!workspace) problems.push("specialist_workspace_unavailable");
    else if (workspace.sourceType !== "local_path" || !workspace.cwd ||
      [workspace.setupCommand, workspace.cleanupCommand, workspace.remoteProvider, workspace.remoteWorkspaceRef,
        workspace.repoUrl, workspace.repoRef, workspace.defaultRef, workspace.sharedWorkspaceKey]
        .some(value => value != null && value !== "") || Object.keys(workspace.metadata ?? {}).length ||
        Object.keys(project.executionWorkspacePolicy ?? {}).length) {
      problems.push("specialist_workspace_configuration_unsupported");
    }
    // Filesystem canonicalisation and current delivery are checked at child preparation/admission.
  }
  return [...new Set(problems)];
}

async function readiness(
  db: Db,
  project: Project,
): Promise<ProjectCoordinationPolicyReadiness> {
  const parsed =
    project.coordinationPolicy === null
      ? null
      : projectCoordinationPolicySchema.safeParse(project.coordinationPolicy);
  const policy = parsed?.success ? parsed.data : null;
  const reasons: string[] = [];
  if (project.archivedAt) reasons.push("project_archived");
  if (parsed && !parsed.success) reasons.push("policy_invalid");
  if (!parsed) reasons.push("policy_not_configured");
  if (policy) {
    if (!policy.enabled) reasons.push("policy_disabled");
    if (!project.leadAgentId) reasons.push("lead_unavailable");
    else reasons.push(...(await referenceProblems(db, project, policy)));
    // static_native explicitly excludes dynamic skills/tools. Config labels cannot override it.
    reasons.push("coordinator_delivery_not_qualified");
  }
  return {
    companyId: project.companyId,
    projectId: project.id,
    leadAgentId: project.leadAgentId,
    revision: project.coordinationPolicyRevision,
    policy,
    executionReady: false,
    readinessReasons: [...new Set(reasons)],
  };
}

export function projectCoordinationPolicyService(db: Db) {
  async function read(companyId: string, projectId: string) {
    const [project] = await db
      .select()
      .from(projects)
      .where(
        and(eq(projects.companyId, companyId), eq(projects.id, projectId)),
      );
    if (!project) throw notFound("Project not found");
    return readiness(db, project);
  }
  return {
    read,
    update: async (
      companyId: string,
      projectId: string,
      actor: AuthorizationActor,
      raw: unknown,
    ) => {
      if (actor.type !== "board") throw forbidden("Board access required");
      const input = updateProjectCoordinationPolicySchema.parse(raw);
      const publications: ActivityPublication[] = [];
      const result = await db.transaction(async (tx) => {
        const reader = tx as unknown as Db;
        const [project] = await tx
          .select()
          .from(projects)
          .where(
            and(eq(projects.companyId, companyId), eq(projects.id, projectId)),
          )
          .for("update");
        if (!project) throw notFound("Project not found");
        const access = accessService(reader);
        for (const action of ["project:read", "runtime:manage"] as const) {
          if (
            !(
              await access.decide({
                actor,
                action,
                resource: { type: "project", companyId, projectId },
              })
            ).allowed
          )
            throw forbidden(
              "Project coordination policy is outside this actor's authorization boundary",
            );
        }
        if (project.archivedAt)
          throw conflict(
            "Cannot change coordination policy in archived projects",
          );
        if (project.coordinationPolicyRevision !== input.expectedRevision)
          throw conflict("Project coordination policy revision changed");
        if (input.leadAgentId) {
          const [lead] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, input.leadAgentId),
                eq(agents.companyId, companyId),
              ),
            );
          if (!lead)
            throw unprocessable("Lead role must belong to this company");
        }
        if (input.policy) {
          const problems = await referenceProblems(
            reader,
            { ...project, leadAgentId: input.leadAgentId },
            input.policy,
          );
          // Stale/disabled but correctly scoped pins can be retained as unavailable intent.
          const invalid = problems.filter(
            (reason) =>
              reason !== "binding_not_qualified" &&
              reason !== "lead_not_active" &&
              reason !== "specialist_role_not_active" &&
              reason !== "specialist_binding_not_qualified",
          );
          if (invalid.length)
            throw unprocessable(
              `Invalid coordination references: ${invalid.join(", ")}`,
            );
        }
        const revision = input.expectedRevision + 1;
        const [updated] = await tx
          .update(projects)
          .set({
            coordinationPolicy: input.policy,
            coordinationPolicyRevision: revision,
            leadAgentId: input.leadAgentId,
            updatedAt: new Date(),
          })
          .where(eq(projects.id, projectId))
          .returning();
        await logActivity(
          reader,
          {
            companyId,
            actorType: "user",
            actorId: actor.userId ?? "local-board",
            action: "project.coordination_policy_updated",
            entityType: "project",
            entityId: projectId,
            details: {
              previousRevision: input.expectedRevision,
              revision,
              leadAgentId: input.leadAgentId,
              configured: input.policy !== null,
              enabled: input.policy?.enabled ?? false,
            },
          },
          publications,
        );
        return readiness(reader, updated!);
      });
      publications.forEach(publishActivity);
      return result;
    },
  };
}
