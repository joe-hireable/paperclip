import { z } from "zod";

// Execution bindings are deliberately narrower than arbitrary adapter config.
// Definitions are immutable; disabling one prevents future acquisition.
export const executionDataClassSchema = z.enum([
  "public",
  "synthetic",
  "private",
]);
// Native CLI values, not a claim that every model supports every level.
// Model/effort qualification belongs to the immutable binding's evidence.
export const executionBindingReasoningEffortSchema = z.enum([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
export type ExecutionBindingReasoningEffort = z.infer<
  typeof executionBindingReasoningEffortSchema
>;
export const executionBindingSelectionSchema = z
  .object({
    bindingId: z.string().uuid(),
    model: z.string().trim().min(1).max(200),
    requiredCapabilities: z
      .array(z.string().trim().min(1).max(100))
      .min(1)
      .max(50),
    dataClass: executionDataClassSchema,
    reason: z.string().trim().min(1).max(2000),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  })
  .strict();

export const createExecutionBindingSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    accountKey: z
      .string()
      .trim()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/),
    adapterType: z.enum(["claude_local", "codex_local", "cursor", "grok_local"]),
    command: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(
        (value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value),
        "An absolute native profile launcher path is required",
      ),
    nativeProfileHome: z
      .string()
      .trim()
      .min(1)
      .max(1000)
      .refine(
        (value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value),
        "An absolute authenticated native profile directory is required",
      ),
    // For Cursor, nativeProfileHome is XDG_CONFIG_HOME, the credential store.
    cursorProfile: z.object({
      configDir: z.string().min(1).refine((value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value)),
      dataDir: z.string().min(1).refine((value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value)),
    }).strict().optional(),
    restrictedMode: z.enum(["read_only", "prompt_only"]).optional(),
    // Capabilities are qualified for this exact model; a union across an account's
    // model catalogue would incorrectly grant stronger models' tools/modalities.
    models: z.array(z.string().trim().min(1).max(200)).length(1),
    reasoningEffort: executionBindingReasoningEffortSchema.optional(),
    // Operator-declared concrete CLI/runtime artefacts behind the launcher.
    // Intelligent routing fingerprints these without running a command.
    runtimeFilePaths: z.array(z.string().trim().min(1).max(1000).refine(
      (value) => value.startsWith("/") || /^[A-Za-z]:[/\\]/.test(value),
      "An absolute runtime artefact path is required",
    )).min(1).max(8).optional(),
    capabilities: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    dataClasses: z.array(executionDataClassSchema).min(1),
    allowedAgentIds: z.array(z.string().uuid()).min(1).max(100),
    billingRoute: z.enum(["native_subscription", "paid_api"]),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    verifiedUntil: z.string().datetime(),
  })
  .strict()
  .superRefine((binding, ctx) => {
    if (binding.billingRoute === "paid_api" && binding.adapterType !== "codex_local") {
      ctx.addIssue({ code: "custom", path: ["billingRoute"], message: "Paid API execution is qualified only for Codex" });
    }
    const restricted = binding.adapterType === "cursor" || binding.adapterType === "grok_local";
    if (!restricted) {
      if (binding.cursorProfile || binding.restrictedMode) ctx.addIssue({ code: "custom", message: "Restricted native profile fields require Cursor or Grok" });
      return;
    }
    if (binding.restrictedMode !== (binding.adapterType === "cursor" ? "read_only" : "prompt_only")) {
      ctx.addIssue({ code: "custom", path: ["restrictedMode"], message: "This harness requires its restricted execution mode" });
    }
    if ((binding.adapterType === "cursor") !== (binding.cursorProfile !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["cursorProfile"], message: "Only Cursor requires explicit config and data directories" });
    }
    if (binding.reasoningEffort !== undefined) ctx.addIssue({ code: "custom", path: ["reasoningEffort"], message: "Effort is not qualified for these restricted native routes" });
    if (binding.dataClasses.includes("private")) ctx.addIssue({ code: "custom", path: ["dataClasses"], message: "Private instruction delivery is not qualified for these routes" });
    if (binding.capabilities.some((capability) => capability !== "text" && !(binding.adapterType === "cursor" && capability === "repository_read"))) {
      ctx.addIssue({ code: "custom", path: ["capabilities"], message: "Capability exceeds the restricted native mode" });
    }
    if (binding.models.some((model) => !/^[A-Za-z0-9][A-Za-z0-9._:/\[\],=+-]*$/.test(model) || ["auto", "default", "grok-build"].includes(model.toLowerCase()))) {
      ctx.addIssue({ code: "custom", path: ["models"], message: "An explicit native model id is required; aliases and CLI options are not qualified" });
    }
  })
  .refine(
    (binding) =>
      binding.adapterType !== "claude_local" ||
      binding.reasoningEffort === undefined ||
      !["minimal", "ultra"].includes(binding.reasoningEffort),
    {
      path: ["reasoningEffort"],
      message: "Claude Code effort must be low, medium, high, xhigh or max",
    },
  );

export type ExecutionBindingDefinition = z.infer<
  typeof createExecutionBindingSchema
>;
export type ExecutionBindingSelection = z.infer<
  typeof executionBindingSelectionSchema
>;
export interface ExecutionBinding extends ExecutionBindingDefinition {
  id: string;
  companyId: string;
  enabled: boolean;
  createdAt: Date;
}
export interface ExecutionBindingSnapshot {
  version: 1;
  binding: ExecutionBinding;
  selection: ExecutionBindingSelection;
  adapterConfig: Record<string, unknown>;
  sessionKey: string;
  resolvedAt: string;
  routingAuthorityDigest?: string;
  routingReceipt?: {
    contractId: string;
    revision: number;
    inputDigest: string;
    requirementsDigest: string;
    profileDigest: string;
  };
}

/** Board preview is qualification only: no quota claim or account reservation. */
export type ExecutionBindingPreviewRequirements = Omit<ExecutionBindingSelection, "bindingId"> & {
  preferredBindingIds: string[];
};
export interface ExecutionBindingPreviewRequest {
  agentId: string;
  requirements: ExecutionBindingPreviewRequirements;
}
export type ExecutionBindingPreviewExclusion =
  | "invalid_binding"
  | "duplicate_binding"
  | "company_mismatch"
  | "agent_not_allowed"
  | "binding_disabled"
  | "evidence_expired"
  | "model_unavailable"
  | "capabilities_missing"
  | "data_class_denied"
  | "evidence_limit_exceeded";

export interface ExecutionBindingPreviewCandidateDecision {
  bindingId: string;
  eligible: boolean;
  exclusions: ExecutionBindingPreviewExclusion[];
  missingCapabilities: string[];
}

export type ExecutionBindingPreviewResult = {
  policyVersion: 1;
  evaluatedAt: string | null;
  quota: "unknown";
  capacityReserved: false;
  candidates: ExecutionBindingPreviewCandidateDecision[];
  eligibleBindingIds: string[];
} & (
  | { status: "selected"; selection: ExecutionBindingSelection }
  | { status: "no_selection"; reason: "invalid_requirements" | "no_eligible_candidate"; invalidFields: string[] }
);
