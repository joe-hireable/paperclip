import { describe, expect, it } from "vitest";
import type { ExecutionBinding } from "@paperclipai/shared/execution-bindings";
import {
  selectExecutionBinding,
  type ExecutionBindingRequirements,
} from "./execution-binding-policy.js";

const companyId = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const firstId = "33333333-3333-4333-8333-333333333333";
const secondId = "44444444-4444-4444-8444-444444444444";
const now = new Date("2026-09-07T12:00:00.000Z");

function binding(overrides: Partial<ExecutionBinding> = {}): ExecutionBinding {
  return {
    id: firstId,
    companyId,
    name: "Synthetic native account",
    accountKey: "synthetic-account",
    adapterType: "codex_local",
    command: "/profiles/synthetic/native-cli",
    nativeProfileHome: "/profiles/synthetic/home",
    models: ["model-exact"],
    capabilities: ["structured_output", "shell"],
    dataClasses: ["synthetic"],
    allowedAgentIds: [agentId],
    billingRoute: "native_subscription",
    evidenceRefs: ["qualification/account-1"],
    verifiedUntil: "2026-09-08T12:00:00.000Z",
    enabled: true,
    createdAt: new Date("2026-09-07T11:00:00.000Z"),
    ...overrides,
  };
}

function requirements(
  overrides: Partial<ExecutionBindingRequirements> = {},
): ExecutionBindingRequirements {
  return {
    model: "model-exact",
    requiredCapabilities: ["structured_output"],
    dataClass: "synthetic",
    reason: "Execute the approved synthetic output contract.",
    evidenceRefs: ["task/approved-contract"],
    preferredBindingIds: [],
    ...overrides,
  };
}

function select(candidates: ExecutionBinding[], task = requirements()) {
  return selectExecutionBinding({
    agentId,
    companyId,
    requirements: task,
    candidates,
    now,
  });
}

describe("selectExecutionBinding", () => {
  it("qualifies an exact route without claiming quota or reserving execution capacity", () => {
    const result = select([binding()]);
    expect(result).toMatchObject({
      status: "selected",
      policyVersion: 1,
      evaluatedAt: now.toISOString(),
      quota: "unknown",
      capacityReserved: false,
      eligibleBindingIds: [firstId],
      selection: {
        bindingId: firstId,
        model: "model-exact",
        requiredCapabilities: ["structured_output"],
        dataClass: "synthetic",
        reason: "Execute the approved synthetic output contract.",
        evidenceRefs: ["qualification/account-1", "task/approved-contract"],
      },
    });
  });

  it("uses explicit preferences only after qualification, independently of candidate order", () => {
    const candidates = [
      binding(),
      binding({ id: secondId, adapterType: "claude_local" }),
    ];
    const task = requirements({ preferredBindingIds: [secondId, firstId] });
    const result = select(candidates, task);
    expect(result).toMatchObject({
      status: "selected",
      selection: { bindingId: secondId },
    });
    expect(select([...candidates].reverse(), task)).toEqual(result);
  });

  it("falls back deterministically without preferring a harness brand", () => {
    const candidates = [
      binding({ id: secondId }),
      binding({ adapterType: "claude_local" }),
    ];
    expect(select(candidates)).toMatchObject({
      status: "selected",
      selection: { bindingId: firstId },
    });
    expect(select(candidates)).toEqual(select([...candidates].reverse()));
  });

  it("does not let a preference override a disabled route", () => {
    const result = select(
      [binding({ enabled: false }), binding({ id: secondId })],
      requirements({ preferredBindingIds: [firstId] }),
    );
    expect(result).toMatchObject({
      status: "selected",
      selection: { bindingId: secondId },
    });
    expect(result.candidates[0]?.exclusions).toContain("binding_disabled");
  });

  it.each([
    ["company boundary", { companyId: secondId }, "company_mismatch"],
    ["role allowlist", { allowedAgentIds: [secondId] }, "agent_not_allowed"],
    ["disabled binding", { enabled: false }, "binding_disabled"],
    [
      "expired evidence",
      { verifiedUntil: "2026-09-07T11:59:59.999Z" },
      "evidence_expired",
    ],
    [
      "evidence expiry boundary",
      { verifiedUntil: now.toISOString() },
      "evidence_expired",
    ],
    [
      "unavailable exact model",
      { models: ["model-exact-new"] },
      "model_unavailable",
    ],
    [
      "unknown required capability",
      { capabilities: ["shell"] },
      "capabilities_missing",
    ],
    ["private data denial", { dataClasses: ["public"] }, "data_class_denied"],
  ] as const)("rejects %s", (_name, override, code) => {
    const result = select([binding(override as Partial<ExecutionBinding>)]);
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "no_eligible_candidate",
    });
    expect(result.candidates[0]?.exclusions).toContain(code);
  });

  it.each([
    ["no evidence", { evidenceRefs: [] }],
    ["invalid expiry", { verifiedUntil: "yesterday" }],
    ["missing native profile", { nativeProfileHome: undefined }],
    ["relative native profile", { nativeProfileHome: "profiles/account" }],
    ["unqualified cloud adapter", { adapterType: "cursor_cloud" }],
    ["API billing", { billingRoute: "api" }],
    ["undeclared API fallback", { allowApiFallback: true }],
  ])("fails closed on a malformed binding: %s", (_name, override) => {
    const candidate = { ...binding(), ...override } as ExecutionBinding;
    const result = select([candidate]);
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "no_eligible_candidate",
    });
    expect(result.candidates[0]?.exclusions).toContain("invalid_binding");
  });

  it("records every applicable exclusion and exact missing capabilities", () => {
    const result = select([
      binding({
        enabled: false,
        models: ["different"],
        capabilities: ["shell"],
      }),
    ]);
    expect(result.candidates[0]).toMatchObject({
      eligible: false,
      exclusions: [
        "binding_disabled",
        "model_unavailable",
        "capabilities_missing",
      ],
      missingCapabilities: ["structured_output"],
    });
  });

  it.each([
    "model",
    "requiredCapabilities",
    "dataClass",
    "reason",
    "evidenceRefs",
    "preferredBindingIds",
  ])("does not infer missing requirement %s", (key) => {
    const task = { ...requirements() } as Record<string, unknown>;
    delete task[key];
    const result = select([binding()], task as ExecutionBindingRequirements);
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "invalid_requirements",
      candidates: [],
      eligibleBindingIds: [],
    });
  });

  it("rejects an invalid clock rather than treating stale evidence as current", () => {
    const result = selectExecutionBinding({
      companyId,
      agentId,
      requirements: requirements(),
      candidates: [binding()],
      now: new Date(NaN),
    });
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "invalid_requirements",
      evaluatedAt: null,
      invalidFields: ["now"],
    });
  });

  it("rejects empty company and agent identities", () => {
    const result = selectExecutionBinding({
      companyId: "",
      agentId: "",
      requirements: requirements(),
      candidates: [binding()],
      now,
    });
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "invalid_requirements",
      invalidFields: ["agentId", "companyId"],
    });
  });

  it("rejects ambiguous duplicate binding identities", () => {
    const result = select([
      binding(),
      binding({ accountKey: "another-account" }),
    ]);
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "no_eligible_candidate",
    });
    expect(
      result.candidates.every((candidate) =>
        candidate.exclusions.includes("duplicate_binding"),
      ),
    ).toBe(true);
  });

  it("retains all evidence or excludes the route when the selection contract cannot hold it", () => {
    const result = select([
      binding({
        evidenceRefs: Array.from(
          { length: 20 },
          (_, i) => `qualification/${i}`,
        ),
      }),
    ]);
    expect(result).toMatchObject({
      status: "no_selection",
      reason: "no_eligible_candidate",
    });
    expect(result.candidates[0]?.exclusions).toContain(
      "evidence_limit_exceeded",
    );
  });

  it("does not mutate inputs and keeps audit evidence stable across duplicate capability/ref ordering", () => {
    const candidate = binding({ evidenceRefs: ["z", "a", "a"] });
    const task = requirements({
      requiredCapabilities: ["shell", "structured_output", "shell"],
      evidenceRefs: ["a", "b"],
    });
    const before = structuredClone({ candidate, task });
    const result = select([candidate], task);
    expect({ candidate, task }).toEqual(before);
    expect(result).toMatchObject({
      status: "selected",
      selection: {
        evidenceRefs: ["a", "b", "z"],
        requiredCapabilities: ["shell", "structured_output"],
      },
    });
  });

  it("returns a typed no-selection for an empty candidate inventory", () => {
    expect(select([])).toMatchObject({
      status: "no_selection",
      reason: "no_eligible_candidate",
      candidates: [],
      eligibleBindingIds: [],
    });
  });
  it("keeps duplicate-identity exclusion evidence stable across inventory ordering", () => {
    const first = binding();
    const second = { ...first, enabled: false };
    expect(select([first, second])).toEqual(select([second, first]));
  });
});
