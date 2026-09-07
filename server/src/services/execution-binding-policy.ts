import { z } from "zod";
import {
  createExecutionBindingSchema,
  executionBindingSelectionSchema,
  type ExecutionBinding,
  type ExecutionBindingSelection,
} from "@paperclipai/shared/execution-bindings";

export const executionBindingRequirementsSchema =
  executionBindingSelectionSchema.omit({ bindingId: true }).extend({
    preferredBindingIds: z.array(z.string().uuid()).max(100),
  });
export type ExecutionBindingRequirements = z.infer<
  typeof executionBindingRequirementsSchema
>;

const candidateSchema = createExecutionBindingSchema.extend({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  enabled: z.boolean(),
  createdAt: z.date(),
});
const requestSchema = z.object({
  agentId: z.string().uuid(),
  companyId: z.string().uuid(),
  requirements: executionBindingRequirementsSchema,
  now: z.date(),
});

export type ExecutionBindingExclusion =
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

export interface ExecutionBindingCandidateDecision {
  bindingId: string;
  eligible: boolean;
  exclusions: ExecutionBindingExclusion[];
  missingCapabilities: string[];
}

interface ExecutionBindingPolicyAudit {
  policyVersion: 1;
  evaluatedAt: string | null;
  quota: "unknown";
  capacityReserved: false;
  candidates: ExecutionBindingCandidateDecision[];
  eligibleBindingIds: string[];
}

export type ExecutionBindingPolicyResult = ExecutionBindingPolicyAudit &
  (
    | { status: "selected"; selection: ExecutionBindingSelection }
    | {
        status: "no_selection";
        reason: "invalid_requirements" | "no_eligible_candidate";
        invalidFields: string[];
      }
  );

function compareId(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort(compareId);
}

// Qualification is pure and does not imply a capacity lease or remaining quota.
// Dispatch must revalidate the binding and atomically acquire the account lease.
export function selectExecutionBinding(input: {
  agentId: string;
  companyId: string;
  requirements: ExecutionBindingRequirements;
  candidates: readonly ExecutionBinding[];
  now: Date;
}): ExecutionBindingPolicyResult {
  const request = requestSchema.safeParse(input);
  const audit: ExecutionBindingPolicyAudit = {
    policyVersion: 1,
    evaluatedAt:
      input.now instanceof Date && Number.isFinite(input.now.getTime())
        ? input.now.toISOString()
        : null,
    quota: "unknown",
    capacityReserved: false,
    candidates: [],
    eligibleBindingIds: [],
  };
  if (!request.success) {
    return {
      ...audit,
      status: "no_selection",
      reason: "invalid_requirements",
      invalidFields: uniqueSorted(
        request.error.issues.map((issue) => issue.path.join(".")),
      ),
    };
  }

  const { requirements, now, companyId, agentId } = request.data;
  const requiredCapabilities = uniqueSorted(requirements.requiredCapabilities);
  const ids = new Map<string, number>();
  for (const candidate of input.candidates)
    ids.set(candidate.id, (ids.get(candidate.id) ?? 0) + 1);
  const qualified = new Map<string, ExecutionBindingSelection>();

  for (const candidate of input.candidates) {
    const exclusions: ExecutionBindingExclusion[] = [];
    const parsed = candidateSchema.safeParse(candidate);
    let missingCapabilities: string[] = [];
    if (!parsed.success) exclusions.push("invalid_binding");
    if ((ids.get(candidate.id) ?? 0) > 1) exclusions.push("duplicate_binding");
    if (parsed.success) {
      const binding = parsed.data;
      if (binding.companyId !== companyId) exclusions.push("company_mismatch");
      if (!binding.allowedAgentIds.includes(agentId))
        exclusions.push("agent_not_allowed");
      if (!binding.enabled) exclusions.push("binding_disabled");
      if (Date.parse(binding.verifiedUntil) <= now.getTime())
        exclusions.push("evidence_expired");
      if (!binding.models.includes(requirements.model))
        exclusions.push("model_unavailable");
      missingCapabilities = requiredCapabilities.filter(
        (capability) => !binding.capabilities.includes(capability),
      );
      if (missingCapabilities.length > 0)
        exclusions.push("capabilities_missing");
      if (!binding.dataClasses.includes(requirements.dataClass))
        exclusions.push("data_class_denied");
      const evidenceRefs = uniqueSorted([
        ...binding.evidenceRefs,
        ...requirements.evidenceRefs,
      ]);
      if (evidenceRefs.length > 20) exclusions.push("evidence_limit_exceeded");
      if (exclusions.length === 0) {
        qualified.set(binding.id, {
          bindingId: binding.id,
          model: requirements.model,
          requiredCapabilities,
          dataClass: requirements.dataClass,
          reason: requirements.reason,
          evidenceRefs,
        });
      }
    }
    audit.candidates.push({
      bindingId: candidate.id,
      eligible: exclusions.length === 0,
      exclusions,
      missingCapabilities,
    });
  }

  audit.candidates.sort(
    (a, b) =>
      compareId(a.bindingId, b.bindingId) ||
      compareId(JSON.stringify(a), JSON.stringify(b)),
  );
  const preference = (id: string) => {
    const rank = requirements.preferredBindingIds.indexOf(id);
    return rank < 0 ? requirements.preferredBindingIds.length : rank;
  };
  audit.eligibleBindingIds = [...qualified.keys()].sort(
    (a, b) => preference(a) - preference(b) || compareId(a, b),
  );
  const selectedId = audit.eligibleBindingIds[0];
  if (!selectedId) {
    return {
      ...audit,
      status: "no_selection",
      reason: "no_eligible_candidate",
      invalidFields: [],
    };
  }
  return {
    ...audit,
    status: "selected",
    selection: qualified.get(selectedId)!,
  };
}
