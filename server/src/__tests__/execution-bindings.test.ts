import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionBindings,
  heartbeatRuns,
  issues,
  runExecutionBindings,
} from "@paperclipai/db";
import type {
  ExecutionBinding,
  ExecutionBindingSelection,
} from "@paperclipai/shared/execution-bindings";
import { createExecutionBindingSchema } from "@paperclipai/shared/execution-bindings";
import { agentRuntimeConfigSchema } from "@paperclipai/shared/validators/agent";
import {
  assertExecutionBindingConfig,
  executionBindingService,
  removeReleasedRunExecutionBindings,
  resolveExecutionBindingSnapshot,
} from "../services/execution-bindings.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { assertStaticIntelligentRoutingDelivery } from "../services/intelligent-routing-runtime.js";

function definition(agentId: string) {
  return {
    name: "Qualified native account",
    accountKey: "claude:one",
    adapterType: "claude_local" as const,
    command: "/usr/local/bin/claude-one",
    nativeProfileHome: "/native/claude-one",
    models: ["qualified-model"],
    capabilities: ["text", "files"],
    dataClasses: ["synthetic" as const],
    allowedAgentIds: [agentId],
    billingRoute: "native_subscription" as const,
    evidenceRefs: ["test://qualification"],
    verifiedUntil: "2099-01-01T00:00:00Z",
  };
}
function selection(bindingId: string): ExecutionBindingSelection {
  return {
    bindingId,
    model: "qualified-model",
    requiredCapabilities: ["files"],
    dataClass: "synthetic",
    reason: "Explicit qualified account for synthetic work",
    evidenceRefs: ["test://task-plan"],
  };
}
const agent = {
  id: randomUUID(),
  companyId: randomUUID(),
  name: "Experience Lead",
  role: "engineer",
  permissions: { canCreateAgents: false },
  adapterType: "codex_local",
  adapterConfig: {
    instructionsFilePath: "/roles/experience/AGENTS.md",
    cwd: "/work/project",
    timeoutSec: 20,
    command: "/old-account",
    env: { OPENAI_API_KEY: "must-not-copy", CODEX_API_KEY: "must-not-copy" },
    extraArgs: ["--old-account"],
    engine: "acp",
    codexHome: "/old-account-home",
    model: "old-model",
  },
} as unknown as typeof agents.$inferSelect;
const binding: ExecutionBinding = {
  ...definition(agent.id),
  id: randomUUID(),
  companyId: agent.companyId,
  enabled: true,
  createdAt: new Date(),
};

describe("execution binding snapshot", () => {
  it("retains truthful paid Codex billing without importing role credentials", () => {
    const paid = { ...binding, adapterType: "codex_local" as const, billingRoute: "paid_api" as const };
    const snapshot = resolveExecutionBindingSnapshot({ binding: paid, selection: selection(binding.id), agent, taskKey: "azure-pilot" });
    expect(snapshot.binding.billingRoute).toBe("paid_api");
    expect(snapshot.adapterConfig.env).toEqual({ CODEX_HOME: paid.nativeProfileHome });
    expect(snapshot.adapterConfig.model).toBe("qualified-model");
    expect(() => resolveExecutionBindingSnapshot({ binding: { ...paid, adapterType: "claude_local" }, selection: selection(binding.id), agent, taskKey: "azure-pilot" })).toThrow();
  });
  it.each(["cursor", "grok_local"])("pins the restricted %s profile and permission mode", (adapterType) => {
    const restricted = {
      ...binding,
      adapterType,
      nativeProfileHome: "/native/credentials",
      cursorProfile: adapterType === "cursor" ? { configDir: "/native/config", dataDir: "/native/data" } : undefined,
      restrictedMode: adapterType === "cursor" ? "read_only" : "prompt_only",
      models: [adapterType === "cursor" ? "claude-opus-5" : "grok-4.6-build"],
      capabilities: ["text"],
    } as unknown as ExecutionBinding;
    const snapshot = resolveExecutionBindingSnapshot({
      binding: restricted,
      selection: { ...selection(binding.id), model: restricted.models[0]!, requiredCapabilities: ["text"] },
      agent,
      taskKey: "restricted-review",
    });
    expect(() => resolveExecutionBindingSnapshot({ binding: restricted, selection: { ...selection(binding.id), model: restricted.models[0]!, requiredCapabilities: ["text"] }, agent, taskKey: "task", deliveryMode: "static_native" })).toThrow("not qualified for intelligent routing");
    expect(() => resolveExecutionBindingSnapshot({ binding: restricted, selection: { ...selection(binding.id), model: restricted.models[0]!, requiredCapabilities: ["text"] }, agent: { ...agent, adapterConfig: { timeoutSec: 0 } }, taskKey: "task" })).toThrow("finite positive");
    expect(snapshot.adapterConfig.executionBindingMode).toBe(adapterType === "cursor" ? "read_only" : "prompt_only");
    expect(snapshot.adapterConfig.env).toEqual(adapterType === "cursor" ? {
      XDG_CONFIG_HOME: "/native/credentials",
      CURSOR_CONFIG_DIR: "/native/config",
      CURSOR_DATA_DIR: "/native/data",
    } : { GROK_HOME: "/native/credentials" });
    expect(snapshot.adapterConfig.dangerouslySkipPermissions).not.toBe(true);
    expect(snapshot.adapterConfig.dangerouslyBypassApprovalsAndSandbox).not.toBe(true);
    expect(() => assertExecutionBindingConfig(snapshot, snapshot.adapterConfig)).not.toThrow();
    expect(() => assertExecutionBindingConfig(snapshot, { ...snapshot.adapterConfig, executionBindingMode: undefined })).toThrow();
    expect(() => assertExecutionBindingConfig(snapshot, {
      ...snapshot.adapterConfig,
      env: { ...snapshot.adapterConfig.env as Record<string, unknown>, GROK_HOME: "/different-account" },
    })).toThrow();
  });
  it("rejects provider billing and endpoint overrides for every bound run", () => {
    const snapshot = resolveExecutionBindingSnapshot({ binding, selection: selection(binding.id), agent, taskKey: "review" });
    for (const key of ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_API_ENDPOINT", "XAI_API_KEY", "XAI_BASE_URL"]) {
      expect(() => assertExecutionBindingConfig(snapshot, snapshot.adapterConfig, { [key]: "test-only-override" })).toThrow();
    }
  });
  it.each(["cursor", "grok_local"] as const)("keeps %s outside static intelligent routing", async (adapterType) => {
    await expect(assertStaticIntelligentRoutingDelivery({ adapterType, qualifiedCwd: "/work", config: {}, context: {}, runtimeToolsPresent: false, runtimeMcpServerCount: 0, managedMcpPresent: false })).rejects.toMatchObject({ code: "intelligent_routing_runtime_harness_unsupported" });
  });

  it.each(["cursor", "grok_local"])("rejects unqualified %s modes, profiles, models and effort", (adapterType) => {
    const valid = {
      ...definition(agent.id), adapterType,
      nativeProfileHome: "/native/credentials",
      cursorProfile: adapterType === "cursor" ? { configDir: "/native/config", dataDir: "/native/data" } : undefined,
      restrictedMode: adapterType === "cursor" ? "read_only" : "prompt_only",
      capabilities: ["text"], models: [adapterType === "cursor" ? "claude-opus-5" : "grok-4.6-build"],
    };
    expect(createExecutionBindingSchema.safeParse(valid).success).toBe(true);
    for (const override of [
      { restrictedMode: undefined }, { restrictedMode: "unrestricted" }, { reasoningEffort: "high" },
      { models: ["auto"] }, { models: ["grok-build"] }, { models: ["--force"] }, { models: ["model\n--force"] },
      { dataClasses: ["private"] }, { capabilities: ["shell"] },
      ...(adapterType === "cursor" ? [{ cursorProfile: undefined }, { cursorProfile: { configDir: "relative", dataDir: "/data" } }] : [{ cursorProfile: { configDir: "/config", dataDir: "/data" } }]),
    ]) expect(createExecutionBindingSchema.safeParse({ ...valid, ...override }).success).toBe(false);
  });
  it("requires the role opt-in flag to be a boolean", () => {
    expect(
      agentRuntimeConfigSchema.safeParse({ executionBindingRequired: true })
        .success,
    ).toBe(true);
    expect(
      agentRuntimeConfigSchema.safeParse({ executionBindingRequired: "true" })
        .success,
    ).toBe(false);
  });
  it("preserves role instructions and limits while replacing account, harness and model", () => {
    const snapshot = resolveExecutionBindingSnapshot({
      binding,
      selection: selection(binding.id),
      agent,
      taskKey: "issue",
    });
    expect(snapshot.adapterConfig).toEqual({
      instructionsFilePath: "/roles/experience/AGENTS.md",
      cwd: "/work/project",
      timeoutSec: 20,
      engine: "cli",
      command: binding.command,
      model: "qualified-model",
      dangerouslySkipPermissions: false,
      env: { CLAUDE_CONFIG_DIR: binding.nativeProfileHome },
    });
    expect(agent.adapterType).toBe("codex_local");
    expect(agent.permissions).toEqual({ canCreateAgents: false });
  });
  it("projects Codex's native home before credential preflight", () => {
    const snapshot = resolveExecutionBindingSnapshot({
      binding: { ...binding, adapterType: "codex_local" },
      selection: selection(binding.id),
      agent,
      taskKey: "issue",
    });
    expect(snapshot.adapterConfig.env).toEqual({
      CODEX_HOME: binding.nativeProfileHome,
    });
    expect(snapshot.adapterConfig.engine).toBe("cli");
  });
  it.each([
    ["codex_local", "ultra", "modelReasoningEffort"],
    ["claude_local", "max", "effort"],
  ] as const)(
    "projects immutable %s effort without inheriting another model's settings",
    (adapterType, reasoningEffort, nativeKey) => {
      const qualified = { ...binding, adapterType, reasoningEffort };
      const snapshot = resolveExecutionBindingSnapshot({
        binding: qualified,
        selection: selection(qualified.id),
        agent: {
          ...agent,
          adapterType:
            adapterType === "codex_local" ? "claude_local" : "codex_local",
          adapterConfig: {
            ...agent.adapterConfig,
            effort: "low",
            modelReasoningEffort: "medium",
            reasoningEffort: "minimal",
          },
        },
        taskKey: "issue",
      });
      expect(snapshot.binding.reasoningEffort).toBe(reasoningEffort);
      expect(snapshot.adapterConfig[nativeKey]).toBe(reasoningEffort);
      for (const key of ["effort", "modelReasoningEffort", "reasoningEffort"]) {
        if (key !== nativeKey) {
          expect(snapshot.adapterConfig).not.toHaveProperty(key);
          expect(() =>
            assertExecutionBindingConfig(snapshot, {
              ...snapshot.adapterConfig,
              [key]: reasoningEffort,
            }),
          ).toThrow(
            expect.objectContaining({
              code: "execution_binding_config_changed",
            }),
          );
        }
        for (const value of ["high", null, 1]) {
          expect(() =>
            assertExecutionBindingConfig(snapshot, {
              ...snapshot.adapterConfig,
              [key]: value,
            }),
          ).toThrow(
            expect.objectContaining({
              code: "execution_binding_config_changed",
            }),
          );
        }
      }
      expect(() =>
        assertExecutionBindingConfig(snapshot, {
          ...snapshot.adapterConfig,
          [nativeKey]: undefined,
        }),
      ).toThrow(
        expect.objectContaining({ code: "execution_binding_config_changed" }),
      );
      expect(() =>
        assertExecutionBindingConfig(snapshot, snapshot.adapterConfig),
      ).not.toThrow();
    },
  );
  it.each(["claude_local", "codex_local"] as const)(
    "preserves legacy %s definitions without inheriting or injecting model effort",
    (adapterType) => {
      const snapshot = resolveExecutionBindingSnapshot({
        binding: { ...binding, adapterType },
        selection: selection(binding.id),
        taskKey: "issue",
        agent: {
          ...agent,
          adapterConfig: {
            ...agent.adapterConfig,
            effort: "max",
            modelReasoningEffort: "ultra",
            reasoningEffort: "high",
          },
        },
      });
      for (const key of ["effort", "modelReasoningEffort", "reasoningEffort"]) {
        expect(snapshot.adapterConfig).not.toHaveProperty(key);
        expect(() =>
          assertExecutionBindingConfig(snapshot, {
            ...snapshot.adapterConfig,
            [key]: "high",
          }),
        ).toThrow(
          expect.objectContaining({ code: "execution_binding_config_changed" }),
        );
      }
      expect(() =>
        assertExecutionBindingConfig(snapshot, snapshot.adapterConfig),
      ).not.toThrow();
    },
  );
  it("validates effort against each harness's accepted values, including persisted definitions", () => {
    for (const adapterType of ["claude_local", "codex_local"] as const) {
      for (const reasoningEffort of [
        undefined,
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ]) {
        expect(
          createExecutionBindingSchema.safeParse({
            ...definition(agent.id),
            adapterType,
            reasoningEffort,
          }).success,
        ).toBe(true);
      }
      for (const reasoningEffort of ["minimal", "ultra"]) {
        expect(
          createExecutionBindingSchema.safeParse({
            ...definition(agent.id),
            adapterType,
            reasoningEffort,
          }).success,
        ).toBe(adapterType === "codex_local");
        if (adapterType === "claude_local")
          expect(() =>
            resolveExecutionBindingSnapshot({
              binding: {
                ...binding,
                adapterType,
                reasoningEffort,
              } as ExecutionBinding,
              selection: selection(binding.id),
              agent,
              taskKey: "issue",
            }),
          ).toThrow();
      }
      for (const reasoningEffort of [
        "none",
        "unlimited",
        "HIGH",
        " high ",
        "",
        null,
        1,
      ]) {
        expect(
          createExecutionBindingSchema.safeParse({
            ...definition(agent.id),
            adapterType,
            reasoningEffort,
          }).success,
        ).toBe(false);
        expect(() =>
          resolveExecutionBindingSnapshot({
            binding: {
              ...binding,
              adapterType,
              reasoningEffort,
            } as ExecutionBinding,
            selection: selection(binding.id),
            agent,
            taskKey: "issue",
          }),
        ).toThrow();
      }
    }
  });
  it("preserves an explicit permission choice across harnesses without applying Claude's permissive default", () => {
    const safe = resolveExecutionBindingSnapshot({
      binding,
      selection: selection(binding.id),
      agent,
      taskKey: "task",
    });
    expect(safe.adapterConfig.dangerouslySkipPermissions).toBe(false);
    const allowedRole = {
      ...agent,
      adapterType: "claude_local",
      adapterConfig: { dangerouslySkipPermissions: true },
    };
    const codex = resolveExecutionBindingSnapshot({
      binding: { ...binding, adapterType: "codex_local" },
      selection: selection(binding.id),
      agent: allowedRole,
      taskKey: "task",
    });
    expect(codex.adapterConfig.dangerouslyBypassApprovalsAndSandbox).toBe(true);
    expect(() =>
      assertExecutionBindingConfig(safe, {
        ...safe.adapterConfig,
        dangerouslySkipPermissions: true,
      }),
    ).toThrow(
      expect.objectContaining({ code: "execution_binding_config_changed" }),
    );
  });
  it("rejects Claude confinement while the native adapter would replace the selected profile", () => {
    expect(() =>
      resolveExecutionBindingSnapshot({
        binding,
        selection: selection(binding.id),
        agent: { ...agent, adapterConfig: { filesystemScope: "workspace" } },
        taskKey: "task",
      }),
    ).toThrow(
      expect.objectContaining({
        code: "execution_binding_profile_scope_unsupported",
      }),
    );
  });
  it.each([
    [false, true, false],
    [true, false, true],
    [undefined, true, true],
    [undefined, false, false],
  ])(
    "preserves Codex permission precedence across harnesses (%s, %s)",
    (primary, legacy, expected) => {
      const role = {
        ...agent,
        adapterType: "codex_local",
        adapterConfig: {
          dangerouslyBypassApprovalsAndSandbox: primary,
          dangerouslyBypassSandbox: legacy,
        },
      };
      for (const adapterType of ["claude_local", "codex_local"] as const) {
        const snapshot = resolveExecutionBindingSnapshot({
          binding: { ...binding, adapterType },
          selection: selection(binding.id),
          agent: role,
          taskKey: "task",
        });
        expect(
          snapshot.adapterConfig[
            adapterType === "claude_local"
              ? "dangerouslySkipPermissions"
              : "dangerouslyBypassApprovalsAndSandbox"
          ],
        ).toBe(expected);
      }
    },
  );
  it.each(["legacy", "plain"] as const)(
    "preserves %s central policy references and managed instruction mode",
    (format) => {
      const policyValue = (value: string) =>
        format === "plain" ? { type: "plain", value } : value;
      const role = {
        ...agent,
        adapterConfig: {
          ...agent.adapterConfig,
          instructionsBundleMode: "managed",
          env: {
            PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID: policyValue("policy-plugin"),
            PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST:
              policyValue("verified-digest"),
            ANTHROPIC_API_KEY: "must-not-copy",
          },
        },
      };
      const snapshot = resolveExecutionBindingSnapshot({
        binding,
        selection: selection(binding.id),
        agent: role,
        taskKey: "issue",
      });
      expect(snapshot.adapterConfig.instructionsBundleMode).toBe("managed");
      expect(snapshot.adapterConfig.env).toEqual({
        CLAUDE_CONFIG_DIR: binding.nativeProfileHome,
        PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID: "policy-plugin",
        PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST: "verified-digest",
      });
      expect(() =>
        assertExecutionBindingConfig(snapshot, snapshot.adapterConfig),
      ).not.toThrow();
      for (const key of [
        "PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID",
        "PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST",
      ]) {
        for (const value of [
          "other-policy",
          { type: "plain", value: "other-policy" },
          { type: "secret_ref", secretId: randomUUID() },
        ]) {
          expect(() =>
            assertExecutionBindingConfig(snapshot, {
              ...snapshot.adapterConfig,
              env: {
                ...(snapshot.adapterConfig.env as Record<string, unknown>),
                [key]: value,
              },
            }),
          ).toThrow(
            expect.objectContaining({
              code: "execution_binding_config_changed",
            }),
          );
        }
      }
    },
  );
  it.each([
    { type: "secret_ref", secretId: randomUUID(), value: "must-not-resolve" },
    { type: "user_secret_ref", key: "policy", value: "must-not-resolve" },
    { type: "plain", value: 123 },
    { type: "plain" },
    { type: "plain", value: "mixed-reference", secretId: randomUUID() },
    { value: "untyped-reference" },
    null,
  ])("rejects secret or malformed central policy binding %#", (value) => {
    for (const key of [
      "PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID",
      "PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST",
    ]) {
      expect(() =>
        resolveExecutionBindingSnapshot({
          binding,
          selection: selection(binding.id),
          taskKey: "issue",
          agent: { ...agent, adapterConfig: { env: { [key]: value } } },
        }),
      ).toThrow(
        expect.objectContaining({
          code: "execution_binding_policy_reference_invalid",
        }),
      );
    }
  });
  it("rejects post-selection changes to the command, engine, model and native profile", () => {
    const snapshot = resolveExecutionBindingSnapshot({
      binding,
      selection: selection(binding.id),
      agent,
      taskKey: "issue",
    });
    for (const patch of [
      { command: "/other" },
      { model: "other" },
      { engine: "acp" },
      { env: { CLAUDE_CONFIG_DIR: "/other" } },
      { extraArgs: ["--other-account"] },
    ]) {
      expect(() =>
        assertExecutionBindingConfig(snapshot, {
          ...snapshot.adapterConfig,
          ...patch,
        }),
      ).toThrow(
        expect.objectContaining({ code: "execution_binding_config_changed" }),
      );
    }
    expect(() =>
      assertExecutionBindingConfig(snapshot, snapshot.adapterConfig),
    ).not.toThrow();
  });
  it("rejects ambient as well as projected provider credentials without printing their values", () => {
    const snapshot = resolveExecutionBindingSnapshot({
      binding,
      selection: selection(binding.id),
      agent,
      taskKey: "issue",
    });
    for (const key of [
      "OPENAI_API_KEY",
      "CODEX_API_KEY",
      "ANTHROPIC_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "CLAUDE_CODE_USE_BEDROCK",
    ]) {
      expect(() =>
        assertExecutionBindingConfig(snapshot, snapshot.adapterConfig, {
          [key]: "never-print-this",
        }),
      ).toThrow(
        expect.objectContaining({ code: "execution_binding_billing_denied" }),
      );
      expect(() =>
        assertExecutionBindingConfig(snapshot, {
          ...snapshot.adapterConfig,
          env: {
            ...(snapshot.adapterConfig.env as Record<string, unknown>),
            [key]: "never-print-this",
          },
        }),
      ).toThrow(
        expect.objectContaining({ code: "execution_binding_billing_denied" }),
      );
    }
  });
  it.each([
    ["company", { companyId: randomUUID() }, {}, "execution_binding_scope"],
    ["disabled", { enabled: false }, {}, "execution_binding_disabled"],
    [
      "role",
      { allowedAgentIds: [randomUUID()] },
      {},
      "execution_binding_role_denied",
    ],
    [
      "expired evidence",
      { verifiedUntil: "2000-01-01T00:00:00Z" },
      {},
      "execution_binding_evidence_expired",
    ],
    ["model", {}, { model: "unavailable" }, "execution_binding_model_denied"],
    [
      "capability",
      {},
      { requiredCapabilities: ["browser"] },
      "execution_binding_capability_denied",
    ],
    ["data", {}, { dataClass: "private" }, "execution_binding_data_denied"],
  ])("rejects %s mismatch", (_label, bindingPatch, requestPatch, code) => {
    expect(() =>
      resolveExecutionBindingSnapshot({
        binding: { ...binding, ...bindingPatch },
        selection: {
          ...selection(binding.id),
          ...requestPatch,
        } as ExecutionBindingSelection,
        agent,
        taskKey: "issue",
      }),
    ).toThrow(expect.objectContaining({ code }));
  });
  it("separates sessions by role, task, account binding, harness and model", () => {
    const resolve = (
      b = binding,
      a = agent,
      taskKey = "issue",
      model = "qualified-model",
    ) =>
      resolveExecutionBindingSnapshot({
        binding: b,
        agent: a,
        taskKey,
        selection: { ...selection(b.id), model },
      }).sessionKey;
    const otherRole = { ...agent, id: randomUUID() };
    const keys = [
      resolve(),
      resolve({ ...binding, id: randomUUID() }),
      resolve({ ...binding, adapterType: "codex_local" }),
      resolve(binding, agent, "issue2"),
      resolve({ ...binding, models: ["second"] }, agent, "issue", "second"),
      resolve({ ...binding, allowedAgentIds: [otherRole.id] }, otherRole),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(resolve()).toBe(resolve());
  });
  it("rejects cloud, paid fallback, inline secrets, arbitrary args and relative profiles", () => {
    for (const patch of [
      { adapterType: "cursor_cloud" },
      { billingRoute: "api" },
      { env: { KEY: "secret" } },
      { extraArgs: ["anything"] },
      { nativeProfileHome: "relative" },
      { models: ["vision", "text-only"] },
    ]) {
      expect(
        createExecutionBindingSchema.safeParse({
          ...definition(agent.id),
          ...patch,
        }).success,
      ).toBe(false);
    }
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported)
  console.warn(`Execution binding DB tests unavailable: ${support.reason}`);
describeDb("durable account reservation", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let profileRoot: string;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("execution-bindings-");
    db = createDb(tempDb.connectionString);
    profileRoot = await mkdtemp(path.join(tmpdir(), "binding-profiles-"));
  }, 30_000);
  afterAll(async () => {
    await tempDb?.cleanup();
    await rm(profileRoot, { recursive: true, force: true });
  });

  async function fixture(adapterType: "claude_local" | "cursor" | "grok_local" = "claude_local", identity: { accountKey?: string; nativeProfileHome?: string; cursorProfile?: { configDir: string; dataDir: string } } = {}) {
    const [company] = await db
      .insert(companies)
      .values({ name: "Binding test", issuePrefix: randomUUID().slice(0, 8) })
      .returning();
    const roleRows = await db
      .insert(agents)
      .values(
        [0, 1].map((index) => ({
          companyId: company!.id,
          name: `Role ${index}`,
          role: "engineer",
          status: "idle",
          adapterType: "claude_local",
          adapterConfig: adapterType === "claude_local" ? {} : { timeoutSec: 20 },
          runtimeConfig: {},
          permissions: {},
        })),
      )
      .returning();
    const service = executionBindingService(db);
    const nativeProfileHome = identity.nativeProfileHome ?? await mkdtemp(path.join(profileRoot, "account-"));
    const accountKey = identity.accountKey ?? `${adapterType}:${randomUUID()}`;
    const account = await service.create(
      company!.id,
      {
        ...definition(roleRows[0]!.id),
        ...(adapterType === "claude_local" ? {} : {
          adapterType, accountKey: `${adapterType}:one`, capabilities: ["text"],
          restrictedMode: adapterType === "cursor" ? "read_only" as const : "prompt_only" as const,
          ...(adapterType === "cursor" ? { cursorProfile: identity.cursorProfile ?? { configDir: nativeProfileHome, dataDir: nativeProfileHome } } : {}),
        }),
        accountKey, nativeProfileHome,
        allowedAgentIds: roleRows.map((role) => role.id),
      },
      { actorType: "user", actorId: "test-board" },
    );
    const runs = [];
    for (const role of roleRows) {
      const [issue] = await db
        .insert(issues)
        .values({
          companyId: company!.id,
          title: "Synthetic task",
          status: "in_progress",
          assigneeAgentId: role.id,
          assigneeAdapterOverrides: { executionBinding: { ...selection(account.id), ...(adapterType === "claude_local" ? {} : { requiredCapabilities: ["text"] }) } },
        })
        .returning();
      const [run] = await db
        .insert(heartbeatRuns)
        .values({
          companyId: company!.id,
          agentId: role.id,
          status: "running",
          contextSnapshot: { issueId: issue!.id },
        })
        .returning();
      runs.push(run!);
    }
    return { service, account, roles: roleRows, runs, companyId: company!.id };
  }
  it("retains disabled legacy registration while exposing only current company-qualified models", async () => {
    expect(await executionBindingService(db).isRegisteredHarness("grok_local")).toBe(false);
    const f = await fixture("grok_local");
    const [row] = await db.select().from(executionBindings).where(eq(executionBindings.id, f.account.id));
    const [foreign] = await db.insert(companies).values({ name: "Other inventory", issuePrefix: randomUUID().slice(0, 8) }).returning();
    await db.insert(executionBindings).values([
      { ...row!, id: randomUUID(), definition: { ...row!.definition, models: ["disabled-model"] }, enabled: false },
      { ...row!, id: randomUUID(), definition: { ...row!.definition, models: ["legacy-model"] }, profileRoots: null },
      { ...row!, id: randomUUID(), definition: { ...row!.definition, models: ["expired-model"], verifiedUntil: "2000-01-01T00:00:00Z" } },
      { ...row!, id: randomUUID(), definition: { ...row!.definition, models: ["foreign-model"] }, companyId: foreign!.id },
      { ...row!, id: randomUUID() },
    ]);
    expect(await f.service.listQualifiedModels(f.companyId, "grok_local")).toEqual(
      f.account.models.map((id) => ({ id, label: id })),
    );
    expect(await f.service.listQualifiedModels(f.companyId, "cursor")).toEqual([]);
    await db.update(executionBindings).set({ enabled: false, profileRoots: null });
    expect(await f.service.isRegisteredHarness("grok_local")).toBe(true);
    await expect(f.service.assertUnboundAllowed("grok_local")).rejects.toMatchObject({ code: "execution_binding_required" });
    expect(await f.service.listQualifiedModels(f.companyId, "grok_local")).toEqual([]);
  });
  it("reserves a shared account across companies and independent database connections without leaking the holder", async () => {
    const first = await fixture();
    const second = await fixture("claude_local", { accountKey: first.account.accountKey });
    const other = executionBindingService(createDb(tempDb.connectionString));
    const results = await Promise.allSettled([
      first.service.acquire(first.runs[0]!, first.roles[0]!),
      other.acquire(second.runs[0]!, second.roles[0]!),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(loser.reason).toMatchObject({ code: "execution_binding_capacity_busy" });
    for (const secret of [first.companyId, second.companyId, first.runs[0]!.id, second.runs[0]!.id]) {
      expect(loser.reason.message).not.toContain(secret);
    }
    expect(await other.getRunBinding(second.companyId, first.runs[0]!.id)).toBeNull();
  });
  it("enforces global held-account uniqueness even when inserts bypass the service", async () => {
    const first = await fixture();
    const second = await fixture("claude_local", { accountKey: first.account.accountKey });
    await first.service.acquire(first.runs[0]!, first.roles[0]!);
    const held = await first.service.getRunBinding(first.companyId, first.runs[0]!.id);
    await expect(db.insert(runExecutionBindings).values({ ...held!, runId: second.runs[0]!.id,
      companyId: second.companyId, bindingId: second.account.id })).rejects.toMatchObject({
        cause: { code: "23505", constraint_name: "run_execution_bindings_held_global_account_uniq" },
      });
  });
  it("admits distinct accounts concurrently across companies", async () => {
    const first = await fixture(), second = await fixture();
    const results = await Promise.all([
      first.service.acquire(first.runs[0]!, first.roles[0]!),
      second.service.acquire(second.runs[0]!, second.roles[0]!),
    ]);
    expect(results.every(Boolean)).toBe(true);
  });
  it("rejects cross-company symlink and nested-root aliases under another capacity key", async () => {
    const first = await fixture();
    const alias = path.join(profileRoot, randomUUID());
    await symlink(first.account.nativeProfileHome, alias);
    await expect(fixture("claude_local", { nativeProfileHome: `${alias}/../${path.basename(alias)}/` })).rejects.toThrow("already belongs");
    const nested = path.join(first.account.nativeProfileHome, "nested");
    await mkdir(nested);
    await expect(fixture("claude_local", { nativeProfileHome: nested })).rejects.toThrow("already belongs");
  });
  it("rejects a changed profile alias both before reservation and before dispatch", async () => {
    const target = await mkdtemp(path.join(profileRoot, "target-"));
    const alias = path.join(profileRoot, randomUUID());
    await symlink(target, alias);
    const first = await fixture("claude_local", { nativeProfileHome: alias });
    const snapshot = await first.service.acquire(first.runs[0]!, first.roles[0]!);
    const replacement = await mkdtemp(path.join(profileRoot, "replacement-"));
    await unlink(alias); await symlink(replacement, alias);
    await expect(first.service.acquire(first.runs[1]!, first.roles[1]!)).rejects.toMatchObject({ code: "execution_binding_identity_changed" });
    await expect(first.service.assertBeforeLaunch(first.runs[0]!, first.roles[0]!, snapshot!)).rejects.toMatchObject({ code: "execution_binding_identity_changed" });
  });
  it("requires existing native profile directories", async () => {
    await expect(fixture("claude_local", { nativeProfileHome: path.join(profileRoot, "missing") })).rejects.toMatchObject({ code: "execution_binding_identity_unavailable" });
  });
  it("rejects a second Cursor account sharing a secondary state root", async () => {
    const first = await fixture("cursor");
    await expect(fixture("cursor", { cursorProfile: {
      configDir: first.account.nativeProfileHome, dataDir: first.account.nativeProfileHome,
    } })).rejects.toThrow("already belongs");
  });
  it("blocks registration while a held legacy account has no captured physical identity", async () => {
    const first = await fixture();
    await first.service.acquire(first.runs[0]!, first.roles[0]!);
    await db.update(executionBindings).set({ profileRoots: null }).where(eq(executionBindings.id, first.account.id));
    try {
      await expect(fixture()).rejects.toMatchObject({ code: "execution_binding_legacy_reconciliation_required" });
      await expect(first.service.acquire(first.runs[1]!, first.roles[1]!)).rejects.toMatchObject({ code: "execution_binding_identity_unverified" });
      expect((await first.service.getRunBinding(first.companyId, first.runs[0]!.id))?.releasedAt).toBeNull();
    } finally {
      await db.update(executionBindings).set({ profileRoots: [first.account.nativeProfileHome] }).where(eq(executionBindings.id, first.account.id));
    }
  });
  it("keeps cross-company capacity held through cancellation until the original owner settles", async () => {
    const first = await fixture();
    const second = await fixture("claude_local", { accountKey: first.account.accountKey });
    await first.service.acquire(first.runs[0]!, first.roles[0]!);
    await first.service.recordProcess(first.runs[0]!.id, { pid: 100, processGroupId: 100 });
    await db.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date(0) }).where(eq(heartbeatRuns.id, first.runs[0]!.id));
    const release = { companyId: first.companyId, runId: first.runs[0]!.id, adapterStarted: true,
      isProcessAlive: () => false, isProcessGroupAlive: () => true, hasActiveChild: false };
    expect(await first.service.releaseAfterExecution(release)).toBe(false);
    expect(await executionBindingService(db).releaseAfterExecution({ ...release, isProcessGroupAlive: () => false })).toBe(false);
    await expect(second.service.acquire(second.runs[0]!, second.roles[0]!)).rejects.toMatchObject({ code: "execution_binding_capacity_busy" });
    expect(await first.service.releaseAfterExecution({ ...release, isProcessGroupAlive: () => false })).toBe(true);
    expect(await second.service.acquire(second.runs[0]!, second.roles[0]!)).not.toBeNull();
  });
  it("aborts a conflicting migration without losing either legacy lease, then migrates cleanly after settlement", async () => {
    const first = await fixture();
    const second = await fixture("claude_local", { accountKey: first.account.accountKey });
    await first.service.acquire(first.runs[0]!, first.roles[0]!);
    const held = await first.service.getRunBinding(first.companyId, first.runs[0]!.id);
    const statements = (await readFile(new URL("../../../packages/db/src/migrations/0441_complex_sunfire.sql", import.meta.url), "utf8")).split("--> statement-breakpoint");
    const rollback = new Error("restore synthetic migration fixture");
    await expect(db.transaction(async (tx) => {
      // Reproduce the old schema inside a transaction; restore the entire fixture afterwards.
      await tx.execute(sql`DROP INDEX run_execution_bindings_held_global_account_uniq`);
      await tx.execute(sql`CREATE UNIQUE INDEX run_execution_bindings_held_account_uniq ON run_execution_bindings(company_id, account_key) WHERE released_at IS NULL`);
      await tx.execute(sql`ALTER TABLE execution_bindings DROP COLUMN profile_roots`);
      await tx.insert(runExecutionBindings).values({ ...held!, runId: second.runs[0]!.id, companyId: second.companyId, bindingId: second.account.id });
      await tx.execute(sql`SAVEPOINT migration_attempt`);
      await expect((async () => { for (const statement of statements) await tx.execute(sql.raw(statement)); })()).rejects.toMatchObject({ cause: { code: "23505" } });
      await tx.execute(sql`ROLLBACK TO SAVEPOINT migration_attempt`);
      const survivors = await tx.select().from(runExecutionBindings).where(eq(runExecutionBindings.accountKey, first.account.accountKey));
      expect(survivors).toHaveLength(2);
      expect(survivors.every((row) => row.releasedAt === null)).toBe(true);
      expect((await tx.execute(sql`SELECT indexname FROM pg_indexes WHERE indexname='run_execution_bindings_held_account_uniq'`)).length).toBe(1);
      // Synthetic settlement only, to exercise the successful migration path.
      await tx.update(runExecutionBindings).set({ releasedAt: new Date(), releaseReason: "test settlement" }).where(eq(runExecutionBindings.runId, second.runs[0]!.id));
      for (const statement of statements) await tx.execute(sql.raw(statement));
      expect((await tx.select().from(runExecutionBindings).where(eq(runExecutionBindings.accountKey, first.account.accountKey)))).toHaveLength(2);
      const [legacy] = await tx.select().from(executionBindings).where(eq(executionBindings.id, first.account.id));
      expect(legacy?.profileRoots).toBeNull();
      throw rollback;
    })).rejects.toBe(rollback);
  });
  it.each(["cursor", "grok_local"] as const)("uses the unchanged durable account lease for %s", async (adapterType) => {
    const f = await fixture(adapterType);
    const results = await Promise.allSettled(f.runs.map((run, index) => f.service.acquire(run, f.roles[index]!)));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([expect.objectContaining({ reason: expect.objectContaining({ code: "execution_binding_capacity_busy" }) })]);
    const winner = results.findIndex((result) => result.status === "fulfilled");
    const run = f.runs[winner]!;
    const lease = await f.service.getRunBinding(f.companyId, run.id);
    expect(lease?.snapshot.binding.adapterType).toBe(adapterType);
    const { id, companyId, enabled, createdAt, ...definition } = f.account;
    await expect(f.service.create(f.companyId, { ...definition, accountKey: "another-capacity-key", ...(adapterType === "cursor" ? { cursorProfile: { configDir: f.account.nativeProfileHome, dataDir: f.account.nativeProfileHome } } : {}) }, { actorType: "user", actorId: "board" })).rejects.toThrow("already belongs");
    await f.service.recordProcess(run.id, { pid: 100, processGroupId: 100 });
    await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run.id));
    expect(await f.service.releaseAfterExecution({ companyId: f.companyId, runId: run.id, adapterStarted: true, hasActiveChild: false, isProcessAlive: () => false, isProcessGroupAlive: () => false })).toBe(true);
  });

  it("atomically admits one of two roles using the same account", async () => {
    const f = await fixture();
    const results = await Promise.allSettled(
      f.runs.map((run, index) => f.service.acquire(run, f.roles[index]!)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({
          code: "execution_binding_capacity_busy",
        }),
      }),
    ]);
    const held = await db
      .select()
      .from(runExecutionBindings)
      .where(eq(runExecutionBindings.companyId, f.companyId));
    expect(held).toHaveLength(1);
  });
  it("persists effort in separate immutable definitions and therefore separates native sessions", async () => {
    const f = await fixture();
    const low = await f.service.create(
      f.companyId,
      { ...definition(f.roles[0]!.id), accountKey: f.account.accountKey, nativeProfileHome: f.account.nativeProfileHome, reasoningEffort: "low" },
      { actorType: "user", actorId: "test-board" },
    );
    const high = await f.service.create(
      f.companyId,
      { ...definition(f.roles[0]!.id), accountKey: f.account.accountKey, nativeProfileHome: f.account.nativeProfileHome, reasoningEffort: "high" },
      { actorType: "user", actorId: "test-board" },
    );
    const persisted = await f.service.list(f.companyId);
    expect(persisted.find((item) => item.id === low.id)?.reasoningEffort).toBe(
      "low",
    );
    expect(persisted.find((item) => item.id === high.id)?.reasoningEffort).toBe(
      "high",
    );
    expect(
      persisted.find((item) => item.id === f.account.id)?.reasoningEffort,
    ).toBeUndefined();
    const snapshot = (item: ExecutionBinding) =>
      resolveExecutionBindingSnapshot({
        binding: item,
        selection: selection(item.id),
        agent: f.roles[0]!,
        taskKey: "same-task",
      });
    expect(low.id).not.toBe(high.id);
    expect(snapshot(low).sessionKey).not.toBe(snapshot(high).sessionKey);
    expect(low.accountKey).toBe(high.accountKey);
  });
  it("retains reservation after cancellation status, elapsed time and a new server owner", async () => {
    const f = await fixture();
    await f.service.acquire(f.runs[0]!, f.roles[0]!);
    await f.service.recordProcess(f.runs[0]!.id, {
      pid: 100,
      processGroupId: 100,
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled", finishedAt: new Date(0) })
      .where(eq(heartbeatRuns.id, f.runs[0]!.id));
    const release = {
      companyId: f.companyId,
      runId: f.runs[0]!.id,
      adapterStarted: true,
      isProcessAlive: () => false,
      isProcessGroupAlive: () => true,
      hasActiveChild: false,
    };
    expect(await f.service.releaseAfterExecution(release)).toBe(false);
    const restarted = executionBindingService(db);
    expect(
      await restarted.releaseAfterExecution({
        ...release,
        isProcessGroupAlive: () => false,
      }),
    ).toBe(false);
    await expect(
      restarted.acquire(f.runs[1]!, f.roles[1]!),
    ).rejects.toMatchObject({ code: "execution_binding_capacity_busy" });
    await expect(
      restarted.acquire(f.runs[0]!, f.roles[0]!),
    ).rejects.toMatchObject({
      code: "execution_binding_reconciliation_required",
    });
    expect(
      await f.service.releaseAfterExecution({
        ...release,
        isProcessGroupAlive: () => false,
      }),
    ).toBe(true);
    expect(await restarted.acquire(f.runs[1]!, f.roles[1]!)).not.toBeNull();
  });
  it("keeps missing process evidence reserved after an attempted dispatch", async () => {
    const f = await fixture();
    await f.service.acquire(f.runs[0]!, f.roles[0]!);
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, f.runs[0]!.id));
    expect(
      await f.service.releaseAfterExecution({
        companyId: f.companyId,
        runId: f.runs[0]!.id,
        adapterStarted: true,
        isProcessAlive: () => false,
        isProcessGroupAlive: () => false,
        hasActiveChild: false,
      }),
    ).toBe(false);
  });
  it("retains every attempt's process group until all descendants are gone", async () => {
    const f = await fixture();
    await f.service.acquire(f.runs[0]!, f.roles[0]!);
    await Promise.all([
      f.service.recordProcess(f.runs[0]!.id, { pid: 100, processGroupId: 100 }),
      f.service.recordProcess(f.runs[0]!.id, { pid: 200, processGroupId: 200 }),
    ]);
    await db
      .update(heartbeatRuns)
      .set({ status: "succeeded" })
      .where(eq(heartbeatRuns.id, f.runs[0]!.id));
    const lease = await f.service.getRunBinding(f.companyId, f.runs[0]!.id);
    expect(lease?.processHistory).toHaveLength(2);
    expect(lease?.processHistory).toEqual(
      expect.arrayContaining([
        { pid: 100, processGroupId: 100 },
        { pid: 200, processGroupId: 200 },
      ]),
    );
    const release = {
      companyId: f.companyId,
      runId: f.runs[0]!.id,
      adapterStarted: true,
      isProcessAlive: () => false,
      isProcessGroupAlive: (pid: number) => pid === 100,
      hasActiveChild: false,
    };
    expect(await f.service.releaseAfterExecution(release)).toBe(false);
    await expect(
      f.service.reconcile({
        companyId: f.companyId,
        runId: f.runs[0]!.id,
        checkpointRef: "test://effects-reviewed",
        isProcessAlive: () => false,
        isProcessGroupAlive: release.isProcessGroupAlive,
        activity: { actorType: "user", actorId: "board" },
      }),
    ).rejects.toThrow("process tree may still be alive");
    expect(
      await f.service.releaseAfterExecution({
        ...release,
        isProcessGroupAlive: () => false,
      }),
    ).toBe(true);
  });
  it("blocks destructive cleanup for held capacity but removes released run snapshots", async () => {
    const f = await fixture();
    await f.service.acquire(f.runs[0]!, f.roles[0]!);
    const clean = () =>
      db.transaction(async (tx) => {
        const rows = await tx
          .select({ id: heartbeatRuns.id })
          .from(heartbeatRuns)
          .where(eq(heartbeatRuns.companyId, f.companyId))
          .for("update");
        await removeReleasedRunExecutionBindings(
          tx as unknown as typeof db,
          f.companyId,
          rows.map((row) => row.id),
        );
      });
    await expect(clean()).rejects.toThrow(
      "requires reconciliation before deletion",
    );
    expect(
      await f.service.getRunBinding(f.companyId, f.runs[0]!.id),
    ).not.toBeNull();
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, f.runs[0]!.id));
    expect(
      await f.service.releaseAfterExecution({
        companyId: f.companyId,
        runId: f.runs[0]!.id,
        adapterStarted: false,
        isProcessAlive: () => false,
        isProcessGroupAlive: () => false,
        hasActiveChild: false,
      }),
    ).toBe(true);
    await clean();
    expect(
      await f.service.getRunBinding(f.companyId, f.runs[0]!.id),
    ).toBeNull();
  });
  it("requires a gone controller and process tree for board orphan reconciliation", async () => {
    const f = await fixture();
    await f.service.acquire(f.runs[0]!, f.roles[0]!);
    await f.service.recordProcess(f.runs[0]!.id, {
      pid: 100,
      processGroupId: 100,
    });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled" })
      .where(eq(heartbeatRuns.id, f.runs[0]!.id));
    const reconcile = {
      companyId: f.companyId,
      runId: f.runs[0]!.id,
      checkpointRef: "test://effects-reviewed",
      isProcessAlive: () => true,
      isProcessGroupAlive: () => false,
      activity: { actorType: "user" as const, actorId: "board" },
    };
    await expect(f.service.reconcile(reconcile)).rejects.toThrow(
      "controller may still be active",
    );
    await expect(
      f.service.reconcile({
        ...reconcile,
        isProcessAlive: () => false,
        isProcessGroupAlive: () => true,
      }),
    ).rejects.toThrow("process tree may still be alive");
    expect(
      await f.service.reconcile({ ...reconcile, isProcessAlive: () => false }),
    ).toMatchObject({ released: true });
    expect(
      (await f.service.getRunBinding(f.companyId, f.runs[0]!.id))
        ?.releaseReason,
    ).toBe("board_reconciled:test://effects-reviewed");
  });
  it("keeps the acquired snapshot unchanged when a binding is disabled", async () => {
    const f = await fixture();
    const snapshot = await f.service.acquire(f.runs[0]!, f.roles[0]!);
    await f.service.disable(f.companyId, f.account.id, {
      actorType: "user",
      actorId: "test-board",
    });
    const row = await f.service.getRunBinding(f.companyId, f.runs[0]!.id);
    expect(row?.snapshot).toEqual(JSON.parse(JSON.stringify(snapshot)));
    await expect(
      f.service.assertBeforeLaunch(f.runs[0]!, f.roles[0]!, snapshot!),
    ).resolves.toBeUndefined();
    await expect(
      f.service.acquire(f.runs[1]!, f.roles[1]!),
    ).rejects.toMatchObject({ code: "execution_binding_disabled" });
    expect(
      await f.service.getRunBinding(randomUUID(), f.runs[0]!.id),
    ).toBeNull();
  });
  it.each([0, 1])("rejects an acquired explicit binding %i ms after qualification expires", async (offsetMs) => {
    const f = await fixture();
    const snapshot = await f.service.acquire(f.runs[0]!, f.roles[0]!);
    expect(snapshot!.routingReceipt).toBeUndefined();
    await expect(
      f.service.assertBeforeLaunch(f.runs[0]!, f.roles[0]!, snapshot!),
    ).resolves.toBeUndefined();
    // Only the clock advances: the immutable acquired definition is unchanged,
    // and PostgreSQL/network timers remain real.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.parse(snapshot!.binding.verifiedUntil) + offsetMs));
    try {
      await expect(
        f.service.assertBeforeLaunch(f.runs[0]!, f.roles[0]!, snapshot!),
      ).rejects.toMatchObject({ code: "execution_binding_evidence_expired" });
    } finally {
      vi.useRealTimers();
    }
  });
  it("does not allow a task to switch the selected account via arbitrary adapter overrides", async () => {
    const f = await fixture();
    await db
      .update(issues)
      .set({
        assigneeAdapterOverrides: {
          executionBinding: selection(f.account.id),
          adapterConfig: { command: "/different-account" },
        },
      })
      .where(eq(issues.id, f.runs[0]!.contextSnapshot!.issueId as string));
    await expect(
      f.service.acquire(f.runs[0]!, f.roles[0]!),
    ).rejects.toMatchObject({ code: "execution_binding_override_denied" });
  });
  it("requires registered harness bindings even when a role opts out or spoofs a different profile", async () => {
    const f = await fixture();
    const plainRun = { ...f.runs[0]!, contextSnapshot: {} };
    await expect(f.service.acquire(plainRun, { ...f.roles[0]!,
      runtimeConfig: { executionBindingRequired: false },
      adapterConfig: { executionBindingMode: "read_only", env: { CLAUDE_CONFIG_DIR: "/different-profile" } },
    })).rejects.toMatchObject({ code: "execution_binding_required" });
    // Other unregistered adapter types retain their existing execution policy.
    expect(await f.service.acquire(plainRun, { ...f.roles[0]!, adapterType: "process" })).toBeNull();
    await expect(f.service.acquire(plainRun, { ...f.roles[0]!, adapterType: "paperclip_runner" }))
      .rejects.toMatchObject({ code: "execution_binding_required" });
    await expect(
      f.service.acquire(plainRun, {
        ...f.roles[0]!,
        runtimeConfig: { executionBindingRequired: true },
      }),
    ).rejects.toMatchObject({ code: "execution_binding_required" });
  });
  it("prevents accidental capacity splitting for the same native profile", async () => {
    const f = await fixture();
    await expect(
      f.service.create(
        f.companyId,
        { ...definition(f.roles[0]!.id), nativeProfileHome: f.account.nativeProfileHome, accountKey: "different-key" },
        { actorType: "user", actorId: "board" },
      ),
    ).rejects.toThrow("already belongs");
  });
});
