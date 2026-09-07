import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  registerServerAdapter,
  unregisterServerAdapter,
  type ServerAdapterModule,
} from "../adapters/index.js";
import {
  heartbeatService,
  resolveExecutionRunAdapterConfig,
} from "../services/heartbeat.js";
import {
  executionBindingService,
  resolveExecutionBindingSnapshot,
} from "../services/execution-bindings.js";
import { verifyLocalAgentJwt } from "../agent-auth-jwt.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb =
  support.supported && process.platform !== "win32" ? describe : describe.skip;
describeDb("heartbeat execution bindings", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const execute = vi.fn<ServerAdapterModule["execute"]>();
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-binding-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    for (const type of ["codex_local", "claude_local"])
      registerServerAdapter({
        type,
        supportsLocalAgentJwt: true,
        execute,
        testEnvironment: async () => ({
          adapterType: type,
          status: "pass",
          checks: [],
          testedAt: new Date().toISOString(),
        }),
      });
  }, 30_000);
  afterAll(async () => {
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    for (const type of ["codex_local", "claude_local"])
      unregisterServerAdapter(type);
    await tempDb?.cleanup();
    vi.unstubAllEnvs();
  });
  async function settled(runId: string) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const run = await heartbeat.getRun(runId);
      if (run && !["queued", "running"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error("Synthetic run did not settle");
  }
  it.each([
    ["projectEnv", "CLAUDE_CONFIG_DIR", "execution_binding_config_changed"],
    ["routineEnv", "CLAUDE_CONFIG_DIR", "execution_binding_config_changed"],
    ["projectEnv", "CODEX_API_KEY", "execution_binding_billing_denied"],
    ["routineEnv", "CODEX_API_KEY", "execution_binding_billing_denied"],
  ] as const)(
    "rejects %s injecting %s during secret projection",
    async (envSource, key, code) => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const bindingId = randomUUID();
      const snapshot = resolveExecutionBindingSnapshot({
        agent: {
          id: agentId,
          companyId,
          adapterConfig: {},
        } as typeof agents.$inferSelect,
        taskKey: "task",
        binding: {
          id: bindingId,
          companyId,
          enabled: true,
          createdAt: new Date(),
          name: "Native",
          accountKey: "claude:one",
          adapterType: "claude_local",
          command: "/native/claude",
          nativeProfileHome: "/native/one",
          models: ["model"],
          capabilities: ["text"],
          dataClasses: ["synthetic"],
          allowedAgentIds: [agentId],
          billingRoute: "native_subscription",
          evidenceRefs: ["test://qualification"],
          verifiedUntil: "2099-01-01T00:00:00Z",
        },
        selection: {
          bindingId,
          model: "model",
          requiredCapabilities: ["text"],
          dataClass: "synthetic",
          reason: "Test",
          evidenceRefs: ["test://task"],
        },
      });
      await expect(
        resolveExecutionRunAdapterConfig({
          companyId,
          agentId,
          adapterType: "claude_local",
          executionBinding: snapshot,
          executionRunConfig: snapshot.adapterConfig,
          projectEnv: {},
          [envSource]: { [key]: "test-only-rejected-value" },
          secretsSvc: {
            resolveEnvBindings: async (_companyId: string, env: unknown) => ({
              env,
              secretKeys: new Set(),
              manifest: [],
            }),
            resolveAdapterConfigForRuntime: async (
              _companyId: string,
              config: unknown,
            ) => ({
              config: structuredClone(config),
              secretKeys: new Set(),
              manifest: [],
            }),
          } as never,
        }),
      ).rejects.toMatchObject({ code });
    },
  );
  it("executes one role through two harnesses using the selected account and account-scoped sessions", async () => {
    const [company] = await db
      .insert(companies)
      .values({
        name: "Role routing",
        issuePrefix: randomUUID().slice(0, 8),
        defaultResponsibleUserId: "test-board",
      })
      .returning();
    const [role] = await db
      .insert(agents)
      .values({
        companyId: company!.id,
        name: "Experience Lead",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {
          engine: "cli",
          promptTemplate: "Synthetic role contract",
          timeoutSec: 15,
          env: {
            PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID: {
              type: "plain",
              value: "policy-plugin",
            },
            PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST: {
              type: "plain",
              value: "verified-digest",
            },
          },
        },
        runtimeConfig: { executionBindingRequired: true },
        permissions: { canCreateAgents: false },
      })
      .returning();
    const bindings = executionBindingService(db);
    execute.mockImplementation(async (context) => {
      // Use a real short-lived process group so teardown evidence is exercised.
      // This is a deterministic fake adapter, never a provider/model request.
      const child = spawn(
        process.execPath,
        ["-e", "setTimeout(() => process.exit(0), 100)"],
        { detached: true, stdio: "ignore" },
      );
      const closed = once(child, "close");
      await context.onSpawn?.({
        pid: child.pid!,
        processGroupId: child.pid!,
        startedAt: new Date().toISOString(),
      });
      await closed;
      await db
        .update(issues)
        .set({ status: "done" })
        .where(eq(issues.id, String(context.context.issueId)));
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        provider: context.agent.adapterType,
        model: String(context.config.model),
        summary: "Synthetic contract passed",
        resultJson: { proof: "binding-smoke" },
        sessionId: randomUUID(),
      };
    });
    const runIds: string[] = [];
    for (const adapterType of ["claude_local", "codex_local"] as const) {
      const binding = await bindings.create(
        company!.id,
        {
          name: adapterType,
          accountKey: `${adapterType}:one`,
          adapterType,
          command: `/native/${adapterType}`,
          nativeProfileHome: `/native/${adapterType}/profile`,
          models: ["synthetic-model"],
          capabilities: ["text"],
          dataClasses: ["synthetic"],
          allowedAgentIds: [role!.id],
          billingRoute: "native_subscription",
          evidenceRefs: ["test://adapter-qualification"],
          verifiedUntil: "2099-01-01T00:00:00Z",
        },
        { actorType: "user", actorId: "test-board" },
      );
      const [issue] = await db
        .insert(issues)
        .values({
          companyId: company!.id,
          title: "Synthetic routing task",
          status: "in_progress",
          assigneeAgentId: role!.id,
          assigneeAdapterOverrides: {
            executionBinding: {
              bindingId: binding.id,
              model: "synthetic-model",
              requiredCapabilities: ["text"],
              dataClass: "synthetic",
              reason: "Explicit smoke route",
              evidenceRefs: ["test://task"],
            },
          },
        })
        .returning();
      const run = await heartbeat.invoke(
        role!.id,
        "on_demand",
        { issueId: issue!.id },
        "manual",
      );
      expect(run).not.toBeNull();
      const finished = await settled(run!.id);
      expect(finished).toMatchObject({
        status: "succeeded",
        agentId: role!.id,
        runtimeMode: "legacy",
      });
      expect(finished.resultJson).toMatchObject({ proof: "binding-smoke" });
      const lastInvocation = execute.mock.calls.at(-1)![0];
      const claims = verifyLocalAgentJwt(lastInvocation.authToken!);
      expect(claims).toMatchObject({
        sub: role!.id,
        company_id: company!.id,
        run_id: run!.id,
        adapter_type: adapterType,
      });
      expect(lastInvocation.agent).toMatchObject({
        id: role!.id,
        adapterType,
        permissions: { canCreateAgents: false },
      });
      expect(lastInvocation.config).toMatchObject({
        engine: "cli",
        command: binding.command,
        model: "synthetic-model",
        promptTemplate: "Synthetic role contract",
        env: {
          PAPERCLIP_SHARED_OPERATIONS_PLUGIN_ID: "policy-plugin",
          PAPERCLIP_SHARED_OPERATIONS_EXPECTED_DIGEST: "verified-digest",
        },
      });
      expect(lastInvocation.runtime.sessionId).toBeNull();
      const homeKey =
        adapterType === "codex_local" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
      expect(
        (lastInvocation.config.env as Record<string, unknown>)[homeKey],
      ).toBe(binding.nativeProfileHome);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      const reservation = await bindings.getRunBinding(company!.id, run!.id);
      expect(reservation?.releasedAt).not.toBeNull();
      runIds.push(run!.id);
    }
    expect(execute).toHaveBeenCalledTimes(2);
    const snapshots = await Promise.all(
      runIds.map((id) => bindings.getRunBinding(company!.id, id)),
    );
    expect(snapshots[0]!.snapshot.sessionKey).not.toBe(
      snapshots[1]!.snapshot.sessionKey,
    );
    const [unchangedRole] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, role!.id));
    expect(unchangedRole?.adapterType).toBe("codex_local");
    expect(
      (unchangedRole?.adapterConfig as Record<string, unknown>).command,
    ).toBeUndefined();
    const runs = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.agentId, role!.id));
    expect(runs).toHaveLength(2);
  }, 30_000);
});
