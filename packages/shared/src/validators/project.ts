import { executionDataClassSchema } from "../execution-bindings.js";
import { intelligentExecutionProfileSchema, intelligentRoutingCandidateInputSchema, intelligentRoutingRequirementsSchema } from "../intelligent-routing.js";
import { agentDesiredSkillEntrySchema } from "./adapter-skills.js";
import { z } from "zod";
import { PROJECT_STATUSES, PROJECT_ICON_NAMES } from "../constants.js";
import { envConfigSchema } from "./secret.js";
import { trustAuthorizationPolicySchema } from "./trust-policy.js";
import { objectWithoutDefaults } from "./partial.js";

const executionWorkspaceStrategySchema = z
  .object({
    type: z.enum(["project_primary", "git_worktree", "adapter_managed", "cloud_sandbox"]).optional(),
    baseRef: z.string().optional().nullable(),
    branchTemplate: z.string().optional().nullable(),
    worktreeParentDir: z.string().optional().nullable(),
    provisionCommand: z.string().optional().nullable(),
    runtimeProvisionCommand: z.string().optional().nullable(),
    teardownCommand: z.string().optional().nullable(),
  })
  .strict();

export const projectExecutionWorkspacePolicySchema = z
  .object({
    enabled: z.boolean(),
    sharedWorkspaceConcurrency: z.enum(["auto", "serialize", "allow"]).optional(),
    defaultMode: z.enum(["shared_workspace", "isolated_workspace", "operator_branch", "adapter_default"]).optional(),
    allowIssueOverride: z.boolean().optional(),
    defaultProjectWorkspaceId: z.string().guid().optional().nullable(),
    environmentId: z.string().guid().optional().nullable(),
    workspaceStrategy: executionWorkspaceStrategySchema.optional().nullable(),
    workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
    branchPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    pullRequestPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    runtimePolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    cleanupPolicy: z.record(z.string(), z.unknown()).optional().nullable(),
    authorizationPolicy: trustAuthorizationPolicySchema.optional().nullable(),
  })
  .strict();

export const projectWorkspaceRuntimeConfigSchema = z.object({
  workspaceRuntime: z.record(z.string(), z.unknown()).optional().nullable(),
  desiredState: z.enum(["running", "stopped", "manual"]).optional().nullable(),
  serviceStates: z.record(z.string(), z.enum(["running", "stopped", "manual"])).optional().nullable(),
}).strict();

const projectWorkspaceSourceTypeSchema = z.enum(["local_path", "git_repo", "remote_managed", "non_git_path"]);
const projectWorkspaceVisibilitySchema = z.enum(["default", "advanced"]);

const projectWorkspaceFields = {
  name: z.string().min(1).optional(),
  sourceType: projectWorkspaceSourceTypeSchema.optional(),
  cwd: z.string().min(1).optional().nullable(),
  repoUrl: z.string().url().optional().nullable(),
  repoRef: z.string().optional().nullable(),
  defaultRef: z.string().optional().nullable(),
  visibility: projectWorkspaceVisibilitySchema.optional(),
  setupCommand: z.string().optional().nullable(),
  cleanupCommand: z.string().optional().nullable(),
  remoteProvider: z.string().optional().nullable(),
  remoteWorkspaceRef: z.string().optional().nullable(),
  sharedWorkspaceKey: z.string().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional().nullable(),
  runtimeConfig: projectWorkspaceRuntimeConfigSchema.optional().nullable(),
};

function validateProjectWorkspace(value: Record<string, unknown>, ctx: z.RefinementCtx) {
  const sourceType = value.sourceType ?? "local_path";
  const hasCwd = typeof value.cwd === "string" && value.cwd.trim().length > 0;
  const hasRepo = typeof value.repoUrl === "string" && value.repoUrl.trim().length > 0;
  const hasRemoteRef = typeof value.remoteWorkspaceRef === "string" && value.remoteWorkspaceRef.trim().length > 0;

  if (sourceType === "remote_managed") {
    if (!hasRemoteRef && !hasRepo) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Remote-managed workspace requires remoteWorkspaceRef or repoUrl.",
        path: ["remoteWorkspaceRef"],
      });
    }
    return;
  }

  if (!hasCwd && !hasRepo) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Workspace requires at least one of cwd or repoUrl.",
      path: ["cwd"],
    });
  }
}

export const createProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional().default(false),
}).superRefine(validateProjectWorkspace);

export type CreateProjectWorkspace = z.infer<typeof createProjectWorkspaceSchema>;

export const updateProjectWorkspaceSchema = z.object({
  ...projectWorkspaceFields,
  isPrimary: z.boolean().optional(),
}).partial();

export type UpdateProjectWorkspace = z.infer<typeof updateProjectWorkspaceSchema>;

const projectFields = {
  // Policy writes require the dedicated board/CAS endpoint, including explicit null.
  coordinationPolicy: z.never().optional(),
  coordinationPolicyRevision: z.never().optional(),
  /** @deprecated Use goalIds instead */
  goalId: z.string().guid().optional().nullable(),
  goalIds: z.array(z.string().guid()).optional(),
  name: z.string().min(1),
  description: z.string().optional().nullable(),
  status: z.enum(PROJECT_STATUSES).optional().default("backlog"),
  leadAgentId: z.string().guid().optional().nullable(),
  targetDate: z.string().optional().nullable(),
  color: z.string().optional().nullable(),
  icon: z.enum(PROJECT_ICON_NAMES).optional().nullable(),
  env: envConfigSchema.optional().nullable(),
  executionWorkspacePolicy: projectExecutionWorkspacePolicySchema.optional().nullable(),
  archivedAt: z.string().datetime().optional().nullable(),
};

export const createProjectSchema = z.object({
  ...projectFields,
  workspace: createProjectWorkspaceSchema.optional(),
});

export type CreateProject = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = objectWithoutDefaults(
  z.object(projectFields),
).partial();

export type UpdateProject = z.infer<typeof updateProjectSchema>;

export type ProjectExecutionWorkspacePolicy = z.infer<typeof projectExecutionWorkspacePolicySchema>;

export const ensureProjectConversationSchema = z.object({
  adoptIssueId: z.string().uuid().optional(),
}).strict();


// Pins describe approved intent only. They cannot qualify dynamic skill delivery.
const coordinatorSkillPinsSchema = z.array(agentDesiredSkillEntrySchema.extend({ versionId: z.string().uuid() }).strict()).min(1).max(32);
const coordinatorRoutingSchema = z.object({
  requirements: intelligentRoutingRequirementsSchema,
  candidates: z.array(intelligentRoutingCandidateInputSchema).min(1).max(32),
}).strict();
export const projectCoordinationPolicySchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  dataClass: executionDataClassSchema,
  profiles: z.array(intelligentExecutionProfileSchema).min(1).max(32),
  skills: coordinatorSkillPinsSchema,
  maxConcurrentAttempts: z.number().int().min(1).max(32),
  maxTurnsPerAttempt: z.number().int().min(1).max(100),
  // Board-owned evidence is reused unchanged; automatic progression never renews it.
  automaticExecution: z.object({
    projectWorkspaceId: z.string().uuid(),
    centralCompanyId: z.string().uuid(),
    centralPolicyDigest: z.string().regex(/^[a-f0-9]{64}$/),
    coordinator: coordinatorRoutingSchema,
    specialist: coordinatorRoutingSchema.optional(),
  }).strict().optional(),
  specialistHandoff: z.object({
    roleKey: z.string().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    agentId: z.string().uuid(),
    profile: intelligentExecutionProfileSchema,
    skills: coordinatorSkillPinsSchema,
    projectWorkspaceId: z.string().uuid(),
    maxTurns: z.number().int().min(1).max(100),
  }).strict().optional(),
}).strict().superRefine((policy, ctx) => {
  if (policy.automaticExecution && Boolean(policy.specialistHandoff) !== Boolean(policy.automaticExecution.specialist)) {
    ctx.addIssue({ code: "custom", message: "Automatic specialist execution requires both a handoff policy and routing evidence" });
  }
  if (JSON.stringify(policy).length > 1_048_576) {
    ctx.addIssue({ code: "custom", message: "Coordination policies are limited to 1 MiB" });
  }
  if (new Set(policy.profiles.map(p => p.bindingId)).size !== policy.profiles.length ||
      new Set(policy.skills.map(s => s.key)).size !== policy.skills.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate route or skill pins are not allowed" });
  }
  if (policy.specialistHandoff && new Set(policy.specialistHandoff.skills.map(s => s.key)).size !== policy.specialistHandoff.skills.length) {
    ctx.addIssue({ code: "custom", message: "Duplicate specialist skill pins are not allowed", path: ["specialistHandoff", "skills"] });
  }
});
export type ProjectCoordinationPolicy = z.infer<typeof projectCoordinationPolicySchema>;
export const updateProjectCoordinationPolicySchema = z.object({
  expectedRevision: z.number().int().nonnegative(),
  leadAgentId: z.string().uuid().nullable(),
  policy: projectCoordinationPolicySchema.nullable(),
}).strict().refine(input => !input.policy || input.leadAgentId !== null, {
  message: "A coordination policy requires a lead role", path: ["leadAgentId"],
});
