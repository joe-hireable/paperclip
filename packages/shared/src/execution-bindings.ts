import { z } from "zod";

// Execution bindings are deliberately narrower than arbitrary adapter config.
// Definitions are immutable; disabling one prevents future acquisition.
export const executionDataClassSchema = z.enum([
  "public",
  "synthetic",
  "private",
]);
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
    adapterType: z.enum(["claude_local", "codex_local"]),
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
    // Capabilities are qualified for this exact model; a union across an account's
    // model catalogue would incorrectly grant stronger models' tools/modalities.
    models: z.array(z.string().trim().min(1).max(200)).length(1),
    capabilities: z.array(z.string().trim().min(1).max(100)).min(1).max(50),
    dataClasses: z.array(executionDataClassSchema).min(1),
    allowedAgentIds: z.array(z.string().uuid()).min(1).max(100),
    billingRoute: z.literal("native_subscription"),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    verifiedUntil: z.string().datetime(),
  })
  .strict();

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
}
