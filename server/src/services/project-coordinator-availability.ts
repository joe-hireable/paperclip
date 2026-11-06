import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { intelligentRoutingContracts } from "@paperclipai/db/schema/intelligent_routing";
import type { ExecutionBindingSnapshot } from "@paperclipai/shared/execution-bindings";
import {
  intelligentRoutingDecisionSchema,
  intelligentRoutingRequirementsSchema,
  type IntelligentExecutionProfile,
  type IntelligentRoutingObservation,
} from "@paperclipai/shared/intelligent-routing";
import { forbidden } from "../errors.js";
import { intelligentRoutingCandidateInputSchema } from "./intelligent-routing-contracts.js";
import {
  intelligentRoutingDigest,
  selectIntelligentExecutionBinding,
} from "./intelligent-routing-policy.js";

export interface CoordinatorAvailability {
  version: 1;
  provenance: "board_recorded";
  runId: string;
  bindingId: string;
  accountKey: string;
  profileDigest: string;
  configurationDigest: string;
  model: string;
  expectedServedModelId: string;
  effort: IntelligentExecutionProfile["effort"];
  contractId: string;
  contractRevision: number;
  observation: IntelligentRoutingObservation;
  maximumObservationAgeMs: number;
  validUntil: string;
}
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
  .object({
    contractId: z.string().uuid(),
    revision: z.number().int().positive(),
    inputDigest: digest,
    requirementsDigest: digest,
    profileDigest: digest,
  })
  .strict();

// The caller already verified this active run, held lease and current authority.
// Revalidate only its sealed selection/evidence; result documents must not change routing inputs.
export async function coordinatorAvailability(
  db: Db,
  input: {
    companyId: string;
    attemptId: string;
    runId: string;
    agentId: string;
    responsibleUserId: string;
    profile: IntelligentExecutionProfile;
    snapshot: ExecutionBindingSnapshot;
  },
): Promise<CoordinatorAvailability> {
  const parsedReceipt = receiptSchema.safeParse(input.snapshot.routingReceipt);
  if (!parsedReceipt.success)
    throw forbidden(
      "Coordinator availability requires its acquired routing receipt",
    );
  const receipt = parsedReceipt.data;
  const [contract] = await db
    .select()
    .from(intelligentRoutingContracts)
    .where(
      and(
        eq(intelligentRoutingContracts.id, receipt.contractId),
        eq(intelligentRoutingContracts.companyId, input.companyId),
        eq(intelligentRoutingContracts.issueId, input.attemptId),
      ),
    )
    .for("share");
  if (
    !contract ||
    contract.revision !== receipt.revision ||
    contract.inputDigest !== receipt.inputDigest ||
    contract.assigneeAgentId !== input.agentId ||
    contract.createdByUserId !== input.responsibleUserId
  )
    throw forbidden(
      "Coordinator availability contract does not belong to this run",
    );
  const requirements = intelligentRoutingRequirementsSchema.safeParse(
    contract.requirements,
  );
  const decision = intelligentRoutingDecisionSchema.safeParse(
    contract.decision,
  );
  const candidates = z
    .array(intelligentRoutingCandidateInputSchema)
    .min(1)
    .max(32)
    .safeParse(contract.candidateEvidenceSnapshot);
  if (
    !requirements.success ||
    !decision.success ||
    decision.data.status !== "selected" ||
    !candidates.success
  )
    throw forbidden("Coordinator availability evidence is invalid");
  const selected = decision.data;
  const profileDigest = intelligentRoutingDigest(input.profile);
  if (
    selected.profile.deliveryMode !== "manifest_coordinator" ||
    intelligentRoutingDigest(requirements.data) !==
      receipt.requirementsDigest ||
    selected.requirementsDigest !== receipt.requirementsDigest ||
    selected.profileDigest !== receipt.profileDigest ||
    profileDigest !== receipt.profileDigest ||
    intelligentRoutingDigest(selected.profile) !== profileDigest ||
    intelligentRoutingDigest(selected.selection) !==
      intelligentRoutingDigest(input.snapshot.selection)
  )
    throw forbidden("Coordinator availability selection changed");
  const matching = candidates.data.filter(
    (candidate) => candidate.profile.bindingId === input.snapshot.binding.id,
  );
  if (
    matching.length !== 1 ||
    intelligentRoutingDigest(matching[0]!.profile) !== profileDigest
  )
    throw forbidden("Coordinator availability selected candidate changed");
  const candidate = matching[0]!,
    observation = candidate.observation;
  const now = Date.now();
  const observedAt = Date.parse(observation.observedAt);
  const validUntil = Math.min(
    Date.parse(observation.expiresAt),
    observedAt + requirements.data.maximumObservationAgeMs,
  );
  if (
    observation.profileDigest !== profileDigest ||
    !Number.isFinite(validUntil) ||
    observedAt > now ||
    now >= validUntil ||
    observation.available !== true ||
    observation.availableCapacity === null ||
    observation.availableCapacity <= 0 ||
    observation.remainingQuota === 0 ||
    !observation.billingApproved ||
    observation.billingRoute !== "native_subscription" ||
    observation.billingRoute !== input.snapshot.binding.billingRoute
  )
    throw forbidden("Coordinator availability is expired or unavailable");
  // Reuse the native pure qualification policy for the selected, sealed candidate.
  // No task-document loader, latest-contract lookup, reservation or provider probe.
  const qualification = selectIntelligentExecutionBinding({
    companyId: input.companyId,
    agentId: input.agentId,
    requirements: requirements.data,
    candidates: [
      {
        ...candidate,
        binding: {
          ...input.snapshot.binding,
          createdAt: new Date(String(input.snapshot.binding.createdAt)),
        },
      },
    ],
    now: new Date(now),
  });
  if (
    qualification.status !== "selected" ||
    qualification.profileDigest !== profileDigest ||
    qualification.requirementsDigest !== receipt.requirementsDigest ||
    qualification.mode !== selected.mode
  )
    throw forbidden("Coordinator structural qualification is no longer valid");
  return {
    version: 1,
    provenance: "board_recorded",
    runId: input.runId,
    bindingId: input.profile.bindingId,
    accountKey: input.profile.accountKey,
    profileDigest,
    configurationDigest: input.profile.configurationDigest,
    model: input.profile.model,
    expectedServedModelId: input.profile.expectedServedModelId,
    effort: input.profile.effort,
    contractId: contract.id,
    contractRevision: contract.revision,
    observation,
    maximumObservationAgeMs: requirements.data.maximumObservationAgeMs,
    validUntil: new Date(validUntil).toISOString(),
  };
}
