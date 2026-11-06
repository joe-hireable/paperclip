import { describe, expect, it } from "vitest";
import type { ExecutionBinding } from "@paperclipai/shared/execution-bindings";
import type {
  IntelligentExecutionProfile,
  IntelligentRoutingEvaluation,
  IntelligentRoutingObservation,
  IntelligentRoutingRequirements,
} from "@paperclipai/shared/intelligent-routing";
import {
  intelligentRoutingDigest,
  selectIntelligentExecutionBinding,
  type IntelligentRoutingCandidate,
} from "./intelligent-routing-policy.js";
import { intelligentRoutingDecisionSchema } from "@paperclipai/shared/intelligent-routing";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const firstId = "33333333-3333-4333-8333-333333333333";
const secondId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-09-07T12:00:00.000Z");
const recordedAt = "2026-09-07T11:00:00.000Z";
const expiresAt = "2026-09-08T12:00:00.000Z";
const d = (number: number) => number.toString(16).padStart(64, "0");
const task: IntelligentRoutingRequirements = {
  version: 1,
  taskFamily: "synthetic-schema-edit",
  benchmarkDigest: d(1),
  benchmarkCaseDigests: Array.from({ length: 20 }, (_, index) =>
    d(index + 100),
  ),
  rubricDigest: d(2),
  evaluationPolicyDigest: d(3),
  trustedEvaluatorProfileDigests: [d(4)],
  frontierReviewerProfileDigests: [d(5)],
  requiredCapabilities: ["shell"],
  requiredModalities: ["text"],
  requiredContextTokens: 10000,
  dataClass: "synthetic",
  risk: "low",
  minimumQualityLowerBound: 0.7,
  minimumSampleCount: 20,
  requireFrontierReview: true,
  maximumObservationAgeMs: 60000,
  frontierBaselineProfileDigests: [],
};

function candidate(
  id = firstId,
  successes = 20,
  latency = 100,
  cost: number | null = 100,
): IntelligentRoutingCandidate {
  const binding: ExecutionBinding = {
    id,
    companyId,
    name: "Synthetic binding",
    accountKey: id,
    adapterType: "codex_local",
    command: "/profiles/synthetic/runner",
    nativeProfileHome: "/profiles/synthetic/home",
    models: [id],
    capabilities: ["shell"],
    dataClasses: ["synthetic"],
    allowedAgentIds: [agentId],
    reasoningEffort: "high",
    billingRoute: "native_subscription",
    evidenceRefs: ["fixture/binding"],
    verifiedUntil: expiresAt,
    enabled: true,
    createdAt: new Date(recordedAt),
  };
  const profile: IntelligentExecutionProfile = {
    version: 1,
    bindingId: id,
    accountKey: id,
    harness: "codex_local",
    model: id,
    effort: "high",
    expectedServedModelId: id,
    configurationDigest: d(6),
    modelDeployment: "frontier",
    deliveryMode: "static_native",
  };
  const profileDigest = intelligentRoutingDigest(profile);
  const evaluation: IntelligentRoutingEvaluation = {
    version: 1,
    id,
    profileDigest,
    taskFamily: task.taskFamily,
    benchmarkDigest: task.benchmarkDigest,
    rubricDigest: task.rubricDigest,
    evaluationPolicyDigest: task.evaluationPolicyDigest,
    capabilities: ["shell"],
    modalities: ["text"],
    contextTokens: 10000,
    risks: ["low"],
    recordedAt,
    expiresAt,
    evidenceRef: `fixture/${id}`,
    evaluatorProfileDigest: d(4),
    servedModelId: id,
    source: "controlled_evaluation",
    split: "held_out",
    leakageCheck: "verified_clear",
    cases: task.benchmarkCaseDigests.map((caseDigest, index) => ({
      caseDigest,
      passed: index < successes,
      endToEndMs: latency,
      marginalCostMicrosUsd: cost,
      frontierReviewerProfileDigest: d(5),
    })),
  };
  const observation: IntelligentRoutingObservation = {
    version: 1,
    profileDigest,
    observedAt: now.toISOString(),
    expiresAt,
    available: true,
    availableCapacity: 1,
    remainingQuota: null,
    billingRoute: "native_subscription",
    billingApproved: true,
  };
  return {
    binding,
    profile,
    advertisedCapabilities: ["anything"],
    evaluations: [evaluation],
    observation,
    baseline: null,
  };
}

const select = (
  candidates: ReturnType<typeof candidate>[],
  requirements = task,
) =>
  selectIntelligentExecutionBinding({
    companyId,
    agentId,
    requirements,
    candidates,
    now,
  });

describe("intelligent execution routing", () => {
  it("does not qualify dynamic tools from static native evidence", () => {
    const item = candidate();
    item.binding.capabilities.push("managed_mcp");
    item.evaluations[0]!.capabilities.push("managed_mcp");
    expect(
      select([item], { ...task, requiredCapabilities: ["managed_mcp"] }),
    ).toMatchObject({
      status: "no_selection",
      candidates: [
        expect.objectContaining({
          exclusions: expect.arrayContaining([
            "delivery_capability_unqualified",
          ]),
        }),
      ],
    });
  });
  it("always ranks demonstrated quality before speed and cost", () => {
    const result = select([
      candidate(firstId, 19, 1, 0),
      candidate(secondId, 20, 10000, 100000),
    ]);
    expect(result).toMatchObject({
      status: "selected",
      mode: "measured",
      capacityReserved: false,
      selection: { bindingId: secondId },
      profile: { effort: "high" },
    });
    expect(result.candidates[1].qualityLowerBound).toBeCloseTo(0.838875, 5);
  });

  it("compares complete pipeline p95 before marginal cost when quality is equal", () => {
    expect(
      select([
        candidate(firstId, 20, 100, 0),
        candidate(secondId, 20, 99, 1000),
      ]),
    ).toMatchObject({ status: "selected", selection: { bindingId: secondId } });
    expect(
      select([
        candidate(firstId, 20, 100, 100),
        candidate(secondId, 20, 100, 1),
      ]),
    ).toMatchObject({ status: "selected", selection: { bindingId: secondId } });
  });

  it("does not call unknown cost free or prefer a brand", () => {
    const result = select([
      candidate(secondId, 20, 100, null),
      candidate(firstId, 20, 100, 1),
    ]);
    expect(result).toMatchObject({
      status: "selected",
      selection: { bindingId: firstId },
    });
    expect(result.candidates[1].marginalCostMicrosUsd).toBeNull();
  });

  it("returns the same inspectable audit without mutating or depending on inventory order", () => {
    const candidates = [candidate(secondId), candidate()];
    const before = structuredClone(candidates);
    expect(select(candidates)).toEqual(select([...candidates].reverse()));
    expect(candidates).toEqual(before);
  });

  it("retains all native hard gates even for the strongest measured candidate", () => {
    const good = candidate(firstId, 19);
    const denied = candidate(secondId);
    denied.binding.allowedAgentIds = [];
    expect(select([good, denied])).toMatchObject({
      status: "selected",
      selection: { bindingId: firstId },
    });
  });
  it.each(["company", "role"])(
    "does not expose an excluded %s's evidence or observations",
    (scope) => {
      const item = candidate();
      if (scope === "company")
        item.binding.companyId = "99999999-9999-4999-8999-999999999999";
      else
        item.binding.allowedAgentIds = ["99999999-9999-4999-8999-999999999999"];
      item.evaluations[0]!.evidenceRef = "private-out-of-scope-reference";
      item.observation.remainingQuota = 321;
      const result = select([item]);
      expect(result.status).toBe("no_selection");
      expect(result.candidates[0]).toMatchObject({
        profileDigest: null,
        mode: null,
        evidenceRefs: [],
        sampleCount: null,
        qualityLowerBound: null,
        endToEndP95Ms: null,
        marginalCostMicrosUsd: null,
        remainingQuota: null,
      });
      expect(JSON.stringify(result)).not.toContain(
        "private-out-of-scope-reference",
      );
      if (scope === "company")
        expect(JSON.stringify(result)).not.toContain(item.binding.id);
    },
  );

  it("does not let foreign inventory poison duplicate evidence checks for this company", () => {
    const permitted = candidate();
    const foreign = candidate(secondId);
    foreign.binding.companyId = "99999999-9999-4999-8999-999999999999";
    foreign.evaluations[0]!.id = permitted.evaluations[0]!.id;
    expect(select([permitted, foreign])).toMatchObject({
      status: "selected",
      selection: { bindingId: firstId },
    });
  });

  it("replaces unvalidated binding IDs with a fixed audit sentinel", () => {
    const item = candidate();
    item.binding.id = "private-unvalidated-".repeat(1000);
    const result = select([item]);
    expect(result.status).toBe("no_selection");
    expect(result.candidates[0]!.bindingId).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("private-unvalidated");
  });

  it("checks raw evaluation and case limits before traversing invalid candidate data", () => {
    let reads = 0;
    const oversized = candidate();
    const report = Object.defineProperty({}, "id", {
      get() {
        reads++;
        return "report";
      },
    });
    oversized.evaluations = Array(101).fill(report);
    expect(select([oversized]).status).toBe("no_selection");
    expect(reads).toBe(0);
    const cases = candidate();
    const sample = Object.defineProperty({}, "passed", {
      get() {
        reads++;
        return true;
      },
    });
    cases.evaluations[0]!.cases = Array(10001).fill(sample);
    expect(select([cases]).status).toBe("no_selection");
    expect(reads).toBe(0);
  });

  it.each([
    [
      "cross-family",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.taskFamily = "different";
      },
    ],
    [
      "changed effort",
      (c: ReturnType<typeof candidate>) => {
        c.profile.effort = "low";
      },
    ],
    [
      "changed instructions",
      (c: ReturnType<typeof candidate>) => {
        c.profile.configurationDigest = d(99);
      },
    ],
    [
      "changed benchmark",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.benchmarkDigest = d(99);
      },
    ],
    [
      "changed rubric",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.rubricDigest = d(99);
      },
    ],
    [
      "changed evaluation policy",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.evaluationPolicyDigest = d(99);
      },
    ],
    [
      "self-review",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.evaluatorProfileDigest = intelligentRoutingDigest(
          c.profile,
        );
      },
    ],
    [
      "untrusted reviewer",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.cases[0]!.frontierReviewerProfileDigest = d(99);
      },
    ],
    [
      "missing sample",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.cases.pop();
      },
    ],
    [
      "duplicated case",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.cases[1] = c.evaluations[0]!.cases[0]!;
      },
    ],
    [
      "duplicate report",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations.push(c.evaluations[0]!);
      },
    ],
    [
      "expired evaluation",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.expiresAt = now.toISOString();
      },
    ],
    [
      "future evaluation",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.recordedAt = expiresAt;
      },
    ],
    [
      "missing validated capability",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.capabilities = [];
      },
    ],
    [
      "insufficient context",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.contextTokens = 9999;
      },
    ],
    [
      "missing modality",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.modalities = ["image"];
      },
    ],
    [
      "wrong risk",
      (c: ReturnType<typeof candidate>) => {
        c.evaluations[0]!.risks = ["medium"];
      },
    ],
    [
      "unknown availability",
      (c: ReturnType<typeof candidate>) => {
        c.observation.available = null;
      },
    ],
    [
      "exhausted capacity",
      (c: ReturnType<typeof candidate>) => {
        c.observation.availableCapacity = 0;
      },
    ],
    [
      "unknown capacity",
      (c: ReturnType<typeof candidate>) => {
        c.observation.availableCapacity = null;
      },
    ],
    [
      "exhausted quota",
      (c: ReturnType<typeof candidate>) => {
        c.observation.remainingQuota = 0;
      },
    ],
    [
      "expired availability",
      (c: ReturnType<typeof candidate>) => {
        c.observation.expiresAt = now.toISOString();
      },
    ],
    [
      "unapproved charge",
      (c: ReturnType<typeof candidate>) => {
        c.observation.billingApproved = false;
      },
    ],
    [
      "paid fallback",
      (c: ReturnType<typeof candidate>) => {
        c.observation.billingRoute = "paid_api";
      },
    ],
  ])("fails closed for %s", (_label, mutate) => {
    const item = candidate();
    (mutate as (c: ReturnType<typeof candidate>) => void)(item);
    expect(select([item])).toMatchObject({
      status: "no_selection",
      reason: "no_qualified_candidate",
    });
  });

  it("rejects leakage and self-reported or malformed evidence at the schema boundary", () => {
    for (const extra of [
      { leakageCheck: "unknown" },
      { source: "self_reported" },
      { unrecognised: true },
    ]) {
      const item = candidate();
      Object.assign(item.evaluations[0]!, extra);
      expect(select([item]).status).toBe("no_selection");
    }
  });

  it("rejects conflicting binding identities instead of evaluating each independently", () => {
    const a = candidate();
    const b = candidate();
    b.profile.effort = "low";
    expect(select([a, b]).status).toBe("no_selection");
  });

  it("requires a full frozen benchmark and explicit quality threshold", () => {
    expect(
      select([candidate()], { ...task, minimumQualityLowerBound: 0.99 }).status,
    ).toBe("no_selection");
    expect(
      select([candidate()], { ...task, minimumSampleCount: 21 }).status,
    ).toBe("no_selection");
    expect(
      select([candidate()], { ...task, benchmarkCaseDigests: [d(100), d(100)] })
        .status,
    ).toBe("no_selection");
    expect(
      selectIntelligentExecutionBinding({
        companyId,
        agentId,
        requirements: task,
        candidates: [],
        now: new Date(NaN),
      }).status,
    ).toBe("no_selection");
  });

  it("binds canonical hashes to exact content and not object key order", () => {
    expect(intelligentRoutingDigest({ a: 1, b: 2 })).toBe(
      intelligentRoutingDigest({ b: 2, a: 1 }),
    );
    expect(intelligentRoutingDigest({ a: 1 })).not.toBe(
      intelligentRoutingDigest({ a: 2 }),
    );
  });

  it("rejects duplicate evidence identities across otherwise distinct profiles", () => {
    const first = candidate();
    const second = candidate(secondId);
    second.evaluations[0]!.id = first.evaluations[0]!.id;
    expect(select([first, second]).status).toBe("no_selection");
    Object.assign(second.evaluations[0]!, { source: "self_reported" });
    expect(select([first, second]).status).toBe("no_selection");
  });
  it("counts duplicate evidence IDs using the schema's trimmed identity", () => {
    const first = candidate();
    const second = candidate(secondId);
    second.evaluations[0]!.id = ` ${first.evaluations[0]!.id} `;
    const result = select([first, second]);
    expect(result.status).toBe("no_selection");
    expect(
      result.candidates.every((item) =>
        item.exclusions.includes("duplicate_evidence"),
      ),
    ).toBe(true);
  });

  it("requires the exact effort to be immutable in the native binding", () => {
    const item = candidate();
    item.binding.reasoningEffort = "low";
    expect(select([item]).status).toBe("no_selection");
    delete item.binding.reasoningEffort;
    expect(select([item]).status).toBe("no_selection");
  });

  it("compares actual served identity separately from the requested model alias", () => {
    const item = candidate();
    item.evaluations[0]!.servedModelId = "unexpected-wire-model";
    expect(select([item]).status).toBe("no_selection");
    item.profile.expectedServedModelId = "unexpected-wire-model";
    item.evaluations[0]!.profileDigest = intelligentRoutingDigest(item.profile);
    item.observation.profileDigest = intelligentRoutingDigest(item.profile);
    expect(select([item]).status).toBe("selected");
  });

  it("requires review of every local-model case even when the task does not require it", () => {
    const item = candidate();
    item.profile.modelDeployment = "local";
    item.evaluations[0]!.profileDigest = intelligentRoutingDigest(item.profile);
    item.observation.profileDigest = intelligentRoutingDigest(item.profile);
    expect(
      select([item], { ...task, requireFrontierReview: false }).status,
    ).toBe("selected");
    item.evaluations[0]!.cases[0]!.frontierReviewerProfileDigest = null;
    expect(
      select([item], { ...task, requireFrontierReview: false }).status,
    ).toBe("no_selection");
  });

  it("includes slow review and rework cases in the nearest-rank p95", () => {
    const item = candidate();
    item.evaluations[0]!.cases[18]!.endToEndMs = 10000;
    item.evaluations[0]!.cases[19]!.endToEndMs = 20000;
    const result = select([item]);
    expect(result.candidates[0]!.endToEndP95Ms).toBe(10000);
  });

  it("keeps explicit frontier fallback separate from measured quality and uses it only when permitted", () => {
    const item = candidate();
    const evaluation = item.evaluations[0]!;
    item.evaluations = [];
    item.baseline = {
      version: 1,
      profileDigest: evaluation.profileDigest,
      taskFamily: evaluation.taskFamily,
      benchmarkDigest: evaluation.benchmarkDigest,
      rubricDigest: evaluation.rubricDigest,
      evaluationPolicyDigest: evaluation.evaluationPolicyDigest,
      capabilities: evaluation.capabilities,
      modalities: evaluation.modalities,
      contextTokens: evaluation.contextTokens,
      risks: evaluation.risks,
      recordedAt,
      expiresAt,
      evidenceRef: "fixture/baseline",
      authority: "board_approved",
      frontierReviewerProfileDigest: d(5),
    };
    expect(select([item]).status).toBe("no_selection");
    const requirements = {
      ...task,
      frontierBaselineProfileDigests: [intelligentRoutingDigest(item.profile)],
    };
    const result = select([item], requirements);
    expect(result).toMatchObject({
      status: "selected",
      mode: "frontier_baseline",
    });
    expect(result.candidates[0]!.qualityLowerBound).toBeNull();
    expect(select([item, candidate(secondId)], requirements)).toMatchObject({
      status: "selected",
      mode: "measured",
      selection: { bindingId: secondId },
    });
    item.baseline.risks = ["high"];
    expect(select([item], requirements).status).toBe("no_selection");
  });

  it("keeps unknown quota explicit and fails closed when an availability observation ages", () => {
    const item = candidate();
    expect(select([item]).candidates[0]!.remainingQuota).toBeNull();
    item.observation.observedAt = recordedAt;
    expect(select([item]).status).toBe("no_selection");
  });

  it("emits schema-valid decisions for selected and excluded inventories", () => {
    expect(
      intelligentRoutingDecisionSchema.safeParse(select([candidate()])).success,
    ).toBe(true);
    expect(intelligentRoutingDecisionSchema.safeParse(select([])).success).toBe(
      true,
    );
    expect(
      intelligentRoutingDecisionSchema.safeParse(
        selectIntelligentExecutionBinding(null),
      ).success,
    ).toBe(true);
  });
});
