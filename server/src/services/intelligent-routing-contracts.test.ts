import { describe, expect, it } from "vitest";
import type { agents, issues } from "@paperclipai/db";
import type {
  ExecutionBinding,
  ExecutionBindingSnapshot,
} from "@paperclipai/shared/execution-bindings";
import {
  assertIntelligentRoutingContract,
  routingConfigurationDigest,
  routingIssueInputDigest,
  type IntelligentRoutingContractInput,
  type IntelligentRoutingContract,
} from "./intelligent-routing-contracts.js";
import {
  intelligentRoutingDigest,
  selectIntelligentExecutionBinding,
} from "./intelligent-routing-policy.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const bindingId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-09-07T12:00:00.000Z");
const expiresAt = "2026-09-08T12:00:00.000Z";
const d = (value: number) => value.toString(16).padStart(64, "0");

function fixture() {
  const agent = {
    id: agentId,
    companyId,
    permissions: {},
    adapterConfig: {},
    adapterType: "codex_local",
  } as typeof agents.$inferSelect;
  const issue = {
    id: issueId,
    companyId,
    title: "Synthetic edit",
    description: "One bounded edit",
    assigneeAgentId: agentId,
    assigneeAdapterOverrides: {},
  } as typeof issues.$inferSelect;
  const binding: ExecutionBinding = {
    id: bindingId,
    companyId,
    name: "Synthetic binding",
    accountKey: "synthetic",
    adapterType: "codex_local",
    command: "/native/codex",
    nativeProfileHome: "/native/profile",
    models: ["exact-model"],
    reasoningEffort: "high",
    capabilities: ["text"],
    dataClasses: ["synthetic"],
    allowedAgentIds: [agentId],
    billingRoute: "native_subscription",
    evidenceRefs: ["fixture/binding"],
    verifiedUntil: expiresAt,
    enabled: true,
    createdAt: now,
  };
  const adapterConfig = {
    model: "exact-model",
    modelReasoningEffort: "high",
    cwd: "/synthetic/fixture",
  };
  const profile = {
    version: 1 as const,
    bindingId,
    accountKey: "synthetic",
    harness: "codex_local",
    model: "exact-model",
    expectedServedModelId: "exact-model",
    effort: "high" as const,
    configurationDigest: routingConfigurationDigest(
      adapterConfig,
      agent.permissions,
    ),
    modelDeployment: "frontier" as const,
    deliveryMode: "static_native" as const,
  };
  const profileDigest = intelligentRoutingDigest(profile);
  const requirements: IntelligentRoutingContractInput["requirements"] = {
    version: 1,
    taskFamily: "fixture",
    benchmarkDigest: d(1),
    benchmarkCaseDigests: [d(2)],
    rubricDigest: d(3),
    evaluationPolicyDigest: d(4),
    trustedEvaluatorProfileDigests: [d(5)],
    frontierReviewerProfileDigests: [d(6)],
    requiredCapabilities: ["text"],
    requiredModalities: ["text"],
    requiredContextTokens: 1000,
    dataClass: "synthetic",
    risk: "low",
    minimumQualityLowerBound: 0,
    minimumSampleCount: 1,
    requireFrontierReview: true,
    maximumObservationAgeMs: 60000,
    frontierBaselineProfileDigests: [],
  };
  const candidate: IntelligentRoutingContractInput["candidates"][number] = {
    profile,
    advertisedCapabilities: [],
    baseline: null,
    observation: {
      version: 1,
      profileDigest,
      observedAt: now.toISOString(),
      expiresAt,
      available: true,
      availableCapacity: 1,
      remainingQuota: null,
      billingRoute: "native_subscription",
      billingApproved: true,
    },
    evaluations: [
      {
        version: 1,
        id: "fixture",
        profileDigest,
        taskFamily: "fixture",
        benchmarkDigest: d(1),
        rubricDigest: d(3),
        evaluationPolicyDigest: d(4),
        capabilities: ["text"],
        modalities: ["text"],
        contextTokens: 1000,
        risks: ["low"],
        recordedAt: now.toISOString(),
        expiresAt,
        evidenceRef: "fixture/evaluation",
        evaluatorProfileDigest: d(5),
        servedModelId: "exact-model",
        source: "controlled_evaluation",
        split: "held_out",
        leakageCheck: "verified_clear",
        cases: [
          {
            caseDigest: d(2),
            passed: true,
            endToEndMs: 10,
            marginalCostMicrosUsd: null,
            frontierReviewerProfileDigest: d(6),
          },
        ],
      },
    ],
  };
  const decision = selectIntelligentExecutionBinding({
    companyId,
    agentId,
    requirements,
    candidates: [{ ...candidate, binding }],
    now,
  });
  if (decision.status !== "selected") throw new Error("Fixture must qualify");
  issue.assigneeAdapterOverrides = { executionBinding: decision.selection };
  const contract: IntelligentRoutingContract = {
    id: "55555555-5555-4555-8555-555555555555",
    companyId,
    issueId,
    assigneeAgentId: agentId,
    revision: 1,
    inputDigest: routingIssueInputDigest(issue, []),
    requirements,
    candidateEvidenceSnapshot: [candidate],
    decision,
    createdByUserId: "owner",
    createdAt: now,
  };
  const snapshot: ExecutionBindingSnapshot = {
    version: 1,
    binding,
    selection: decision.selection,
    adapterConfig,
    sessionKey: "fixture",
    resolvedAt: now.toISOString(),
  };
  return {
    contract,
    issue,
    agent,
    binding,
    snapshot,
    documentRevisionDigests: [],
    now,
  };
}

describe("routing input authority", () => {
  it("ignores status and the applied binding but detects changed task input", () => {
    const issue = {
      title: "Edit synthetic schema",
      description: "Preserve inputs",
      status: "todo",
      assigneeAdapterOverrides: { executionBinding: { bindingId: "one" } },
    };
    expect(routingIssueInputDigest(issue, [])).toBe(
      routingIssueInputDigest(
        {
          ...issue,
          status: "in_progress",
          assigneeAdapterOverrides: { executionBinding: { bindingId: "two" } },
        },
        [],
      ),
    );
    expect(routingIssueInputDigest(issue, [])).not.toBe(
      routingIssueInputDigest({ ...issue, description: "Send outreach" }, []),
    );
  });
  it("pins linked task documents regardless of database ordering", () => {
    const a = { key: "plan", documentId: "one", revisionId: "r1", digest: "a" };
    const b = {
      key: "review",
      documentId: "two",
      revisionId: "r2",
      digest: "b",
    };
    expect(routingIssueInputDigest({ title: "Task" }, [a, b])).toBe(
      routingIssueInputDigest({ title: "Task" }, [b, a]),
    );
    expect(routingIssueInputDigest({ title: "Task" }, [a])).not.toBe(
      routingIssueInputDigest({ title: "Task" }, [{ ...a, digest: "changed" }]),
    );
  });
  it("pins requested workspace overrides while ignoring a materialised execution workspace id", () => {
    const issue = {
      title: "Task",
      assigneeAdapterOverrides: { useProjectWorkspace: true },
    };
    expect(routingIssueInputDigest(issue, [])).not.toBe(
      routingIssueInputDigest(
        { ...issue, assigneeAdapterOverrides: { useProjectWorkspace: false } },
        [],
      ),
    );
    expect(routingIssueInputDigest(issue, [])).toBe(
      routingIssueInputDigest({ ...issue, executionWorkspaceId: issueId }, []),
    );
  });
  it("binds effective configuration and permissions independently of object order", () => {
    expect(
      routingConfigurationDigest(
        { model: "one", effort: "high" },
        { shell: true },
      ),
    ).toBe(
      routingConfigurationDigest(
        { effort: "high", model: "one" },
        { shell: true },
      ),
    );
    expect(
      routingConfigurationDigest({ model: "one" }, { shell: true }),
    ).not.toBe(routingConfigurationDigest({ model: "one" }, { shell: false }));
  });
});

describe("routing contract launch guard", () => {
  it("returns a receipt only for the exact current task and qualified profile", () => {
    const input = fixture();
    expect(assertIntelligentRoutingContract(input)).toMatchObject({
      contractId: input.contract.id,
      revision: 1,
      inputDigest: input.contract.inputDigest,
      profileDigest: intelligentRoutingDigest(
        input.contract.decision.status === "selected"
          ? input.contract.decision.profile
          : null,
      ),
    });
  });
  it.each([
    [
      "task inputs",
      (input: ReturnType<typeof fixture>) => {
        input.issue.title = "Different task";
      },
      "routing_contract_input_changed",
    ],
    [
      "removed binding",
      (input: ReturnType<typeof fixture>) => {
        input.issue.assigneeAdapterOverrides = {};
      },
      "routing_contract_selection_changed",
    ],
    [
      "permissions",
      (input: ReturnType<typeof fixture>) => {
        input.agent.permissions = { shell: true };
      },
      "routing_contract_configuration_changed",
    ],
    [
      "effective config",
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.adapterConfig = { model: "other-model" };
      },
      "routing_contract_configuration_changed",
    ],
    [
      "company",
      (input: ReturnType<typeof fixture>) => {
        input.contract.companyId = issueId;
      },
      "routing_contract_scope",
    ],
    [
      "assignee",
      (input: ReturnType<typeof fixture>) => {
        input.issue.assigneeAgentId = issueId;
      },
      "routing_contract_scope",
    ],
    [
      "disabled binding",
      (input: ReturnType<typeof fixture>) => {
        input.binding.enabled = false;
      },
      "routing_contract_qualification_expired",
    ],
    [
      "expired observation",
      (input: ReturnType<typeof fixture>) => {
        input.now = new Date("2026-09-07T12:02:00Z");
      },
      "routing_contract_qualification_expired",
    ],
    [
      "changed effort",
      (input: ReturnType<typeof fixture>) => {
        input.binding.reasoningEffort = "low";
      },
      "routing_contract_qualification_expired",
    ],
  ])("rejects drift in %s", (_label, mutate, code) => {
    const input = fixture();
    (mutate as (input: ReturnType<typeof fixture>) => void)(input);
    expect(() => assertIntelligentRoutingContract(input)).toThrow(
      expect.objectContaining({ code }),
    );
  });
  it("detects a changed linked plan before launch", () => {
    const input = fixture();
    expect(() =>
      assertIntelligentRoutingContract({
        ...input,
        documentRevisionDigests: [
          { key: "plan", documentId: issueId, revisionId: null, digest: d(9) },
        ],
      }),
    ).toThrow(
      expect.objectContaining({ code: "routing_contract_input_changed" }),
    );
  });
  it.each(["human", "agent"])(
    "invalidates authority when a new %s comment can change the task",
    (author) => {
      const input = fixture();
      expect(() =>
        assertIntelligentRoutingContract({
          ...input,
          documentRevisionDigests: [
            {
              kind: "comment",
              commentId: issueId,
              bodyDigest: d(1),
              authorAgentId: author === "agent" ? agentId : null,
              authorUserId: author === "human" ? "owner" : null,
              sourceTrustDigest: d(2),
              digest: d(3),
            },
          ],
        }),
      ).toThrow(
        expect.objectContaining({ code: "routing_contract_input_changed" }),
      );
    },
  );
});
