import { z } from "zod";
import {
  executionBindingReasoningEffortSchema,
  executionBindingSelectionSchema,
  executionDataClassSchema,
} from "./execution-bindings.js";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().trim().min(1).max(200);
const labels = z.array(label).max(50);
const digests = z.array(digest).max(10000);
const timestamp = z.string().datetime();

// Configuration includes the harness version, tools, instructions, context policy
// and review/rework pipeline. Changing any of these invalidates its evidence.
export const intelligentExecutionProfileSchema = z
  .object({
    version: z.literal(1),
    bindingId: z.string().uuid(),
    accountKey: label,
    harness: label,
    model: label,
    expectedServedModelId: label,
    effort: executionBindingReasoningEffortSchema,
    configurationDigest: digest,
    modelDeployment: z.enum(["frontier", "local"]),
    deliveryMode: z.literal("static_native").default("static_native"),
  })
  .strict();

export const intelligentRoutingRequirementsSchema = z
  .object({
    version: z.literal(1),
    taskFamily: label,
    benchmarkDigest: digest,
    benchmarkCaseDigests: digests.min(1),
    rubricDigest: digest,
    evaluationPolicyDigest: digest,
    trustedEvaluatorProfileDigests: digests.min(1),
    frontierReviewerProfileDigests: digests,
    requiredCapabilities: labels.min(1),
    requiredModalities: labels.min(1),
    requiredContextTokens: z.number().int().positive(),
    dataClass: executionDataClassSchema,
    risk: z.enum(["low", "medium", "high"]),
    minimumQualityLowerBound: z.number().min(0).max(1),
    minimumSampleCount: z.number().int().positive(),
    requireFrontierReview: z.boolean(),
    maximumObservationAgeMs: z.number().int().positive().max(300000),
    // Explicitly authorised fallback order, only used without measured candidates.
    frontierBaselineProfileDigests: digests.max(100),
  })
  .strict();

const qualification = {
  profileDigest: digest,
  taskFamily: label,
  benchmarkDigest: digest,
  rubricDigest: digest,
  evaluationPolicyDigest: digest,
  capabilities: labels,
  modalities: labels,
  contextTokens: z.number().int().positive(),
  risks: z.array(z.enum(["low", "medium", "high"])).min(1),
  recordedAt: timestamp,
  expiresAt: timestamp,
  evidenceRef: z.string().trim().min(1).max(500),
};

// Produced by a trusted evaluation runner, never inferred from run exit status
// or a model's assertion that its own work succeeded. Every case is retained.
export const intelligentRoutingEvaluationSchema = z
  .object({
    version: z.literal(1),
    id: label,
    ...qualification,
    evaluatorProfileDigest: digest,
    servedModelId: label,
    source: z.literal("controlled_evaluation"),
    split: z.literal("held_out"),
    leakageCheck: z.literal("verified_clear"),
    cases: z
      .array(
        z
          .object({
            caseDigest: digest,
            passed: z.boolean(),
            endToEndMs: z.number().finite().nonnegative(),
            // Includes execution, review and rework; null remains unknown, never zero.
            marginalCostMicrosUsd: z.number().int().nonnegative().nullable(),
            frontierReviewerProfileDigest: digest.nullable(),
          })
          .strict(),
      )
      .min(1)
      .max(10000),
  })
  .strict();

export const intelligentRoutingBaselineSchema = z
  .object({
    version: z.literal(1),
    ...qualification,
    authority: z.literal("board_approved"),
    frontierReviewerProfileDigest: digest.nullable(),
  })
  .strict();

export const intelligentRoutingObservationSchema = z
  .object({
    version: z.literal(1),
    profileDigest: digest,
    observedAt: timestamp,
    expiresAt: timestamp,
    available: z.boolean().nullable(),
    availableCapacity: z.number().int().nonnegative().nullable(),
    remainingQuota: z.number().nonnegative().nullable(),
    billingRoute: z.enum([
      "native_subscription",
      "local_compute",
      "paid_api",
      "unknown",
    ]),
    billingApproved: z.boolean(),
  })
  .strict();

export type IntelligentExecutionProfile = z.infer<
  typeof intelligentExecutionProfileSchema
>;
export type IntelligentRoutingRequirements = z.infer<
  typeof intelligentRoutingRequirementsSchema
>;
export type IntelligentRoutingEvaluation = z.infer<
  typeof intelligentRoutingEvaluationSchema
>;
export type IntelligentRoutingBaseline = z.infer<
  typeof intelligentRoutingBaselineSchema
>;
export type IntelligentRoutingObservation = z.infer<
  typeof intelligentRoutingObservationSchema
>;

export const intelligentRoutingCandidateDecisionSchema = z
  .object({
    bindingId: z.string(),
    profileDigest: digest.nullable(),
    eligible: z.boolean(),
    mode: z.enum(["measured", "frontier_baseline"]).nullable(),
    exclusions: z.array(z.string()),
    evidenceRefs: z.array(z.string()),
    sampleCount: z.number().int().nonnegative().nullable(),
    qualityLowerBound: z.number().min(0).max(1).nullable(),
    endToEndP95Ms: z.number().nonnegative().nullable(),
    marginalCostMicrosUsd: z.number().nonnegative().nullable(),
    remainingQuota: z.number().nonnegative().nullable(),
  })
  .strict();

const decisionAudit = {
  policyVersion: z.literal(1),
  evaluatedAt: timestamp.nullable(),
  requirementsDigest: digest.nullable(),
  capacityReserved: z.literal(false),
  qualityMethod: z.literal("wilson_lower_95"),
  candidates: z.array(intelligentRoutingCandidateDecisionSchema),
};
export const intelligentRoutingDecisionSchema = z.discriminatedUnion("status", [
  z
    .object({
      ...decisionAudit,
      status: z.literal("selected"),
      mode: z.enum(["measured", "frontier_baseline"]),
      selection: executionBindingSelectionSchema,
      profile: intelligentExecutionProfileSchema,
      profileDigest: digest,
    })
    .strict(),
  z
    .object({
      ...decisionAudit,
      status: z.literal("no_selection"),
      reason: z.enum(["invalid_requirements", "no_qualified_candidate"]),
      invalidFields: z.array(z.string()),
    })
    .strict(),
]);
export type IntelligentRoutingCandidateDecision = z.infer<
  typeof intelligentRoutingCandidateDecisionSchema
>;
export type IntelligentRoutingDecision = z.infer<
  typeof intelligentRoutingDecisionSchema
>;
