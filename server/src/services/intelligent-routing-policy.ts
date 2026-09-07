import { createHash } from "node:crypto";
import { z } from "zod";
import {
  createExecutionBindingSchema,
  type ExecutionBindingSelection,
} from "@paperclipai/shared/execution-bindings";
import {
  intelligentExecutionProfileSchema,
  intelligentRoutingBaselineSchema,
  intelligentRoutingEvaluationSchema,
  intelligentRoutingObservationSchema,
  intelligentRoutingRequirementsSchema,
  type IntelligentRoutingCandidateDecision,
  type IntelligentRoutingDecision,
  type IntelligentRoutingRequirements,
} from "@paperclipai/shared/intelligent-routing";
import { selectExecutionBinding } from "./execution-binding-policy.js";

const candidateSchema = z
  .object({
    binding: createExecutionBindingSchema.safeExtend({
      id: z.string().uuid(),
      companyId: z.string().uuid(),
      enabled: z.boolean(),
      createdAt: z.date(),
    }),
    profile: intelligentExecutionProfileSchema,
    // Catalogue claims are inspectable inputs, never qualification evidence.
    advertisedCapabilities: z.array(z.string()).max(100),
    evaluations: z.array(intelligentRoutingEvaluationSchema).max(100),
    observation: intelligentRoutingObservationSchema,
    baseline: intelligentRoutingBaselineSchema.nullable(),
  })
  .strict();
export type IntelligentRoutingCandidate = z.infer<typeof candidateSchema>;

const requestSchema = z
  .object({
    companyId: z.string().uuid(),
    agentId: z.string().uuid(),
    now: z.date(),
    requirements: intelligentRoutingRequirementsSchema,
    candidates: z.array(z.unknown()).max(1000),
  })
  .strict();
const identifierSchema = z.string().uuid();
const permittedAgentsSchema = z.array(identifierSchema).min(1).max(100);

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function sorted(values: string[]) {
  return [...new Set(values)].sort(compare);
}

// Hash only JSON-shaped validated policy objects, with stable object key order.
export function intelligentRoutingDigest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return `[${item.map(canonical).join(",")}]`;
    if (item !== null && typeof item === "object") {
      return `{${Object.entries(item)
        .sort(([a], [b]) => compare(a, b))
        .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
        .join(",")}}`;
    }
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean" ||
      (typeof item === "number" && Number.isFinite(item))
    ) {
      return JSON.stringify(item);
    }
    throw new Error("Routing digests require finite JSON values");
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function current(start: string, end: string, now: number) {
  return Date.parse(start) <= now && now < Date.parse(end);
}

function qualificationExclusions(
  evidence:
    | IntelligentRoutingCandidate["evaluations"][number]
    | NonNullable<IntelligentRoutingCandidate["baseline"]>,
  requirements: IntelligentRoutingRequirements,
  profileDigest: string,
  now: number,
): string[] {
  const result: string[] = [];
  if (evidence.profileDigest !== profileDigest) result.push("profile_mismatch");
  if (evidence.taskFamily !== requirements.taskFamily)
    result.push("task_family_mismatch");
  if (evidence.benchmarkDigest !== requirements.benchmarkDigest)
    result.push("benchmark_mismatch");
  if (evidence.rubricDigest !== requirements.rubricDigest)
    result.push("rubric_mismatch");
  if (evidence.evaluationPolicyDigest !== requirements.evaluationPolicyDigest)
    result.push("evaluation_policy_mismatch");
  if (!current(evidence.recordedAt, evidence.expiresAt, now))
    result.push("evaluation_not_current");
  if (
    requirements.requiredCapabilities.some(
      (capability) => !evidence.capabilities.includes(capability),
    )
  )
    result.push("unvalidated_capability");
  if (
    requirements.requiredModalities.some(
      (modality) => !evidence.modalities.includes(modality),
    )
  )
    result.push("unvalidated_modality");
  if (evidence.contextTokens < requirements.requiredContextTokens)
    result.push("unvalidated_context");
  if (!evidence.risks.includes(requirements.risk))
    result.push("unqualified_risk");
  return result;
}

// The 95% Wilson score lower bound measures uncertainty in independent binary
// benchmark outcomes. It is not a prior or a claim about another task family.
function qualityLowerBound(successes: number, count: number) {
  const z = 1.959963984540054;
  const p = successes / count;
  return Math.max(
    0,
    (p +
      (z * z) / (2 * count) -
      z * Math.sqrt((p * (1 - p)) / count + (z * z) / (4 * count * count))) /
      (1 + (z * z) / count),
  );
}

function bindingIdOf(value: unknown): string {
  if (value === null || typeof value !== "object" || !("binding" in value))
    return "invalid";
  const binding = value.binding;
  const id =
    binding !== null &&
    typeof binding === "object" &&
    "id" in binding &&
    typeof binding.id === "string"
      ? binding.id
      : null;
  return id !== null && identifierSchema.safeParse(id).success ? id : "invalid";
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function scopeExclusion(
  value: unknown,
  companyId: string,
  agentId: string,
): string | null {
  const binding = record(record(value).binding);
  if (!identifierSchema.safeParse(binding.companyId).success)
    return "invalid_candidate";
  if (binding.companyId !== companyId) return "binding:company_mismatch";
  // Check the array bound before parsing or searching untrusted member IDs.
  if (
    !Array.isArray(binding.allowedAgentIds) ||
    binding.allowedAgentIds.length > 100
  )
    return "invalid_candidate";
  if (!permittedAgentsSchema.safeParse(binding.allowedAgentIds).success)
    return "invalid_candidate";
  return binding.allowedAgentIds.includes(agentId)
    ? null
    : "binding:agent_not_allowed";
}

function boundedEvaluations(value: unknown): boolean {
  const evaluations = record(value).evaluations;
  if (!Array.isArray(evaluations) || evaluations.length > 100) return false;
  return evaluations.every((evaluation) => {
    const { id, cases } = record(evaluation);
    // Limits precede both the duplicate-ID pass and Zod's nested array parser.
    return (
      typeof id === "string" &&
      id.length <= 200 &&
      Array.isArray(cases) &&
      cases.length <= 10000
    );
  });
}

// Trusted control-plane code supplies observations and sealed evaluator records;
// accepting an arbitrary agent-authored JSON report would not establish trust.
// This pure selector never acquires capacity: dispatch must revalidate everything
// and atomically reserve the selected account under the normal binding rules.
export function selectIntelligentExecutionBinding(
  input: unknown,
): IntelligentRoutingDecision {
  const parsed = requestSchema.safeParse(input);
  const audit = {
    policyVersion: 1 as const,
    evaluatedAt: parsed.success ? parsed.data.now.toISOString() : null,
    requirementsDigest: parsed.success
      ? intelligentRoutingDigest(parsed.data.requirements)
      : null,
    capacityReserved: false as const,
    qualityMethod: "wilson_lower_95" as const,
    candidates: [] as IntelligentRoutingCandidateDecision[],
  };
  if (!parsed.success)
    return {
      ...audit,
      status: "no_selection",
      reason: "invalid_requirements",
      invalidFields: sorted(
        parsed.error.issues.map((issue) => issue.path.join(".")),
      ),
    };
  const { companyId, agentId, requirements, candidates, now } = parsed.data;
  const duplicateCases =
    new Set(requirements.benchmarkCaseDigests).size !==
    requirements.benchmarkCaseDigests.length;
  if (
    duplicateCases ||
    requirements.minimumSampleCount > requirements.benchmarkCaseDigests.length
  ) {
    return {
      ...audit,
      status: "no_selection",
      reason: "invalid_requirements",
      invalidFields: [
        duplicateCases
          ? "requirements.benchmarkCaseDigests"
          : "requirements.minimumSampleCount",
      ],
    };
  }
  const inventory = candidates.map((raw) => {
    const exclusion = scopeExclusion(raw, companyId, agentId);
    return {
      raw,
      exclusion,
      bounded: exclusion === null && boundedEvaluations(raw),
    };
  });
  const idCounts = new Map<string, number>();
  for (const item of inventory) {
    if (item.exclusion) continue;
    const id = bindingIdOf(item.raw);
    idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
  }
  const evidenceCounts = new Map<string, number>();
  for (const { raw, exclusion, bounded } of inventory) {
    if (exclusion || !bounded) continue;
    if (
      raw === null ||
      typeof raw !== "object" ||
      !("evaluations" in raw) ||
      !Array.isArray(raw.evaluations)
    )
      continue;
    for (const evaluation of raw.evaluations) {
      if (
        evaluation !== null &&
        typeof evaluation === "object" &&
        "id" in evaluation &&
        typeof evaluation.id === "string"
      ) {
        const id = evaluation.id.trim();
        if (id) evidenceCounts.set(id, (evidenceCounts.get(id) ?? 0) + 1);
      }
    }
  }
  const eligible: Array<{
    candidate: IntelligentRoutingCandidate;
    decision: IntelligentRoutingCandidateDecision;
    selection: ExecutionBindingSelection;
  }> = [];

  for (const { raw, exclusion, bounded } of inventory) {
    const decision: IntelligentRoutingCandidateDecision = {
      bindingId:
        exclusion === "binding:company_mismatch"
          ? "out_of_scope"
          : bindingIdOf(raw),
      profileDigest: null,
      eligible: false,
      mode: null,
      exclusions: [],
      evidenceRefs: [],
      sampleCount: null,
      qualityLowerBound: null,
      endToEndP95Ms: null,
      marginalCostMicrosUsd: null,
      remainingQuota: null,
    };
    audit.candidates.push(decision);
    // Scope failures must not expose another company/role's profile, quota or
    // private evidence in an otherwise company-scoped routing audit.
    if (exclusion || !bounded) {
      decision.exclusions.push(exclusion ?? "invalid_candidate");
      continue;
    }
    if ((idCounts.get(decision.bindingId) ?? 0) > 1)
      decision.exclusions.push("duplicate_binding");
    const candidateResult = candidateSchema.safeParse(raw);
    if (!candidateResult.success) {
      decision.exclusions.push("invalid_candidate");
      continue;
    }
    const candidate = candidateResult.data;
    const { binding, profile, observation, evaluations, baseline } = candidate;
    const profileDigest = intelligentRoutingDigest(profile);
    decision.profileDigest = profileDigest;
    decision.remainingQuota = observation.remainingQuota;
    if (
      profile.bindingId !== binding.id ||
      profile.accountKey !== binding.accountKey ||
      profile.harness !== binding.adapterType ||
      binding.models[0] !== profile.model
    ) {
      decision.exclusions.push("binding_profile_mismatch");
    }
    if (binding.reasoningEffort !== profile.effort)
      decision.exclusions.push("binding_effort_mismatch");
    // Static native delivery has no dynamically resolved tool manifest. These
    // capabilities refer only to qualified native text, shell and file work.
    if (
      requirements.requiredCapabilities.some(
        (capability) =>
          ![
            "text",
            "synthetic_arithmetic",
            "local_shell",
            "shell",
            "static_file_edit",
            "files",
          ].includes(capability),
      )
    )
      decision.exclusions.push("delivery_capability_unqualified");
    if (observation.profileDigest !== profileDigest)
      decision.exclusions.push("observation_profile_mismatch");
    if (
      !current(observation.observedAt, observation.expiresAt, now.getTime()) ||
      now.getTime() - Date.parse(observation.observedAt) >
        requirements.maximumObservationAgeMs
    )
      decision.exclusions.push("observation_not_current");
    if (observation.available !== true)
      decision.exclusions.push("availability_unconfirmed");
    if (
      observation.availableCapacity === null ||
      observation.availableCapacity === 0
    )
      decision.exclusions.push("capacity_unavailable");
    if (observation.remainingQuota === 0)
      decision.exclusions.push("quota_exhausted");
    if (
      !observation.billingApproved ||
      observation.billingRoute !== binding.billingRoute
    )
      decision.exclusions.push("billing_unapproved");

    const independentReview = (reviewer: string | null) =>
      reviewer !== null &&
      reviewer !== profileDigest &&
      requirements.frontierReviewerProfileDigests.includes(reviewer);
    const needsReview =
      requirements.requireFrontierReview || profile.modelDeployment === "local";
    if (evaluations.length === 1) {
      const evaluation = evaluations[0]!;
      if ((evidenceCounts.get(evaluation.id) ?? 0) > 1)
        decision.exclusions.push("duplicate_evidence");
      decision.mode = "measured";
      decision.evidenceRefs = [evaluation.evidenceRef];
      decision.exclusions.push(
        ...qualificationExclusions(
          evaluation,
          requirements,
          profileDigest,
          now.getTime(),
        ),
      );
      if (evaluation.servedModelId !== profile.expectedServedModelId)
        decision.exclusions.push("served_model_mismatch");
      if (
        evaluation.evaluatorProfileDigest === profileDigest ||
        !requirements.trustedEvaluatorProfileDigests.includes(
          evaluation.evaluatorProfileDigest,
        )
      )
        decision.exclusions.push("evaluator_not_independent");
      const caseIds = evaluation.cases.map((item) => item.caseDigest);
      if (
        new Set(caseIds).size !== caseIds.length ||
        sorted(caseIds).join() !==
          sorted(requirements.benchmarkCaseDigests).join()
      )
        decision.exclusions.push("benchmark_cases_mismatch");
      if (
        needsReview &&
        evaluation.cases.some(
          (item) => !independentReview(item.frontierReviewerProfileDigest),
        )
      )
        decision.exclusions.push("frontier_review_missing");
      const count = evaluation.cases.length;
      decision.sampleCount = count;
      decision.qualityLowerBound = qualityLowerBound(
        evaluation.cases.filter((item) => item.passed).length,
        count,
      );
      if (
        count < requirements.minimumSampleCount ||
        decision.qualityLowerBound < requirements.minimumQualityLowerBound
      )
        decision.exclusions.push("quality_unqualified");
      const latencies = evaluation.cases
        .map((item) => item.endToEndMs)
        .sort((a, b) => a - b);
      decision.endToEndP95Ms = latencies[Math.ceil(count * 0.95) - 1]!;
      decision.marginalCostMicrosUsd = evaluation.cases.every(
        (item) => item.marginalCostMicrosUsd !== null,
      )
        ? evaluation.cases.reduce(
            (sum, item) => sum + item.marginalCostMicrosUsd!,
            0,
          ) / count
        : null;
    } else if (evaluations.length > 1) {
      // A caller supplies one frozen complete report, not a preferred repeated
      // trial or overlapping/contradictory evidence counted as extra samples.
      decision.exclusions.push("ambiguous_evaluation");
    } else if (
      baseline &&
      profile.modelDeployment === "frontier" &&
      requirements.frontierBaselineProfileDigests.includes(profileDigest)
    ) {
      decision.mode = "frontier_baseline";
      decision.evidenceRefs = [baseline.evidenceRef];
      decision.exclusions.push(
        ...qualificationExclusions(
          baseline,
          requirements,
          profileDigest,
          now.getTime(),
        ),
      );
      if (
        needsReview &&
        !independentReview(baseline.frontierReviewerProfileDigest)
      )
        decision.exclusions.push("frontier_review_missing");
    } else decision.exclusions.push("evaluation_missing");

    const nativeResult = selectExecutionBinding({
      companyId,
      agentId,
      now,
      candidates: [binding],
      requirements: {
        model: profile.model,
        dataClass: requirements.dataClass,
        requiredCapabilities: requirements.requiredCapabilities,
        preferredBindingIds: [],
        reason: `Quality-first ${decision.mode ?? "unqualified"} route for ${requirements.taskFamily}; policy ${audit.requirementsDigest}.`,
        evidenceRefs: sorted([
          ...decision.evidenceRefs,
          `routing-policy:${audit.requirementsDigest}`,
        ]),
      },
    });
    if (nativeResult.status !== "selected")
      decision.exclusions.push(
        ...nativeResult.candidates.flatMap((item) =>
          item.exclusions.map((code) => `binding:${code}`),
        ),
      );
    decision.exclusions = sorted(decision.exclusions);
    decision.eligible =
      decision.exclusions.length === 0 && nativeResult.status === "selected";
    if (decision.eligible && nativeResult.status === "selected")
      eligible.push({ candidate, decision, selection: nativeResult.selection });
  }
  audit.candidates.sort(
    (a, b) =>
      compare(a.bindingId, b.bindingId) ||
      compare(JSON.stringify(a), JSON.stringify(b)),
  );
  eligible.sort((a, b) => {
    if (a.decision.mode !== b.decision.mode)
      return a.decision.mode === "measured" ? -1 : 1;
    if (a.decision.mode === "frontier_baseline")
      return (
        requirements.frontierBaselineProfileDigests.indexOf(
          a.decision.profileDigest!,
        ) -
        requirements.frontierBaselineProfileDigests.indexOf(
          b.decision.profileDigest!,
        )
      );
    const quality =
      b.decision.qualityLowerBound! - a.decision.qualityLowerBound!;
    const latency = a.decision.endToEndP95Ms! - b.decision.endToEndP95Ms!;
    if (quality || latency) return quality || latency;
    const ac = a.decision.marginalCostMicrosUsd;
    const bc = b.decision.marginalCostMicrosUsd;
    if (ac !== bc) return ac === null ? 1 : bc === null ? -1 : ac - bc;
    return compare(a.candidate.binding.id, b.candidate.binding.id);
  });
  const winner = eligible[0];
  if (!winner)
    return {
      ...audit,
      status: "no_selection",
      reason: "no_qualified_candidate",
      invalidFields: [],
    };
  return {
    ...audit,
    status: "selected",
    mode: winner.decision.mode!,
    selection: winner.selection,
    profile: winner.candidate.profile,
    profileDigest: winner.decision.profileDigest!,
  };
}
