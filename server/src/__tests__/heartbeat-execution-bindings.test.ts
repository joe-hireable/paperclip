import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  costEvents,
  createDb,
  executionBindings,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getServerAdapter,
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

async function seedBoardUser(target: ReturnType<typeof createDb>) {
  await target.insert(authUsers).values({
    id: "test-board",
    name: "Test Board",
    email: "board@example.test",
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  }).onConflictDoNothing();
}

async function attachBoardMembership(
  target: ReturnType<typeof createDb>,
  companiesCreated: Array<{ id: string }>,
) {
  if (companiesCreated.length === 0) return;
  await target.insert(companyMemberships).values(
    companiesCreated.map((company) => ({
      companyId: company.id,
      principalType: "user" as const,
      principalId: "test-board",
      status: "active",
      membershipRole: "owner",
    })),
  );
}
describeDb("heartbeat execution bindings", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let unregisteredDb: ReturnType<typeof createDb>;
  let unregisteredTempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let unregisteredHeartbeat: ReturnType<typeof heartbeatService>;
  let profileRoot: string;
  const execute = vi.fn<ServerAdapterModule["execute"]>();
  beforeAll(async () => {
    profileRoot = mkdtempSync(join(tmpdir(), "paperclip-heartbeat-binding-profiles-"));
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", randomUUID());
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-binding-");
    db = createDb(tempDb.connectionString);
    await seedBoardUser(db);
    heartbeat = heartbeatService(db);
    unregisteredTempDb = await startEmbeddedPostgresTestDatabase("heartbeat-unregistered-");
    unregisteredDb = createDb(unregisteredTempDb.connectionString);
    await seedBoardUser(unregisteredDb);
    unregisteredHeartbeat = heartbeatService(unregisteredDb);
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
    await drainHeartbeatRunsToQuiescence(unregisteredDb, unregisteredHeartbeat);
    for (const type of ["codex_local", "claude_local"])
      unregisterServerAdapter(type);
    await tempDb?.cleanup();
    await unregisteredTempDb?.cleanup();
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  async function settled(runId: string, service = heartbeat) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const run = await service.getRun(runId);
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
  it.each([
    ["failure", true],
    ["review", true],
    ["review-participant", true],
    ["failure", false],
    ["review", false],
    ["review-participant", false],
  ] as const)(
    "preserves explicit-attempt recovery for %s (bound=%s)",
    async (kind, bound) => {
      // These controls exercise legacy recovery on an instance without any
      // registered native harness, independently of the bound suite's history.
      const recoveryDb = bound ? db : unregisteredDb;
      const recoveryHeartbeat = bound ? heartbeat : unregisteredHeartbeat;
      const [company] = await recoveryDb.insert(companies).values({
        name: "Explicit attempt recovery",
        issuePrefix: randomUUID().slice(0, 8),
        defaultResponsibleUserId: "test-board",
      }).returning();
      await attachBoardMembership(recoveryDb, [company!]);
      const [role] = await recoveryDb.insert(agents).values({
        companyId: company!.id,
        name: "Reviewer",
        role: "engineer",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: { timeoutSec: 15 },
        runtimeConfig: { executionBindingRequired: bound },
        permissions: {},
      }).returning();
      const bindings = executionBindingService(recoveryDb);
      const binding = bound
        ? await bindings.create(company!.id, {
            name: "Explicit synthetic attempt",
            accountKey: `synthetic:${randomUUID()}`,
            adapterType: "codex_local",
            command: "/native/test",
            nativeProfileHome: mkdtempSync(join(profileRoot, "recovery-")),
            models: ["synthetic-model"],
            capabilities: ["text"],
            dataClasses: ["synthetic"],
            allowedAgentIds: [role!.id],
            billingRoute: "native_subscription",
            evidenceRefs: ["test://qualification"],
            verifiedUntil: "2099-01-01T00:00:00Z",
          }, { actorType: "user", actorId: "test-board" })
        : null;
      const stageId = randomUUID();
      const [issue] = await recoveryDb.insert(issues).values({
        companyId: company!.id,
        title: "Bound recovery regression",
        status: kind !== "failure" ? "in_review" : "in_progress",
        assigneeAgentId: role!.id,
        ...(binding ? {
          assigneeAdapterOverrides: {
            executionBinding: {
              bindingId: binding.id,
              model: "synthetic-model",
              requiredCapabilities: ["text"],
              dataClass: "synthetic",
              reason: "Explicit finite attempt",
              evidenceRefs: ["test://task"],
            },
          },
        } : {}),
        ...(kind !== "failure" ? {
          executionState: {
            status: "pending",
            currentStageId: stageId,
            currentStageIndex: 0,
            currentStageType: "review",
            currentParticipant: { type: "agent", agentId: role!.id, userId: null },
            returnAssignee: { type: "agent", agentId: role!.id, userId: null },
            reviewRequest: null,
            completedStageIds: [],
            lastDecisionId: null,
            lastDecisionOutcome: null,
          },
        } : {}),
      }).returning();
      execute.mockClear();
      execute.mockImplementation(async (context) => {
        const child = spawn(
          process.execPath,
          ["-e", "setTimeout(() => process.exit(0), 20)"],
          { detached: true, stdio: "ignore" },
        );
        const closed = once(child, "close");
        await context.onSpawn?.({
          pid: child.pid!,
          processGroupId: child.pid!,
          startedAt: new Date().toISOString(),
        });
        await closed;
        return {
          exitCode: kind === "failure" ? 1 : 0,
          signal: null,
          timedOut: false,
          errorMessage: kind === "failure" ? "Synthetic native startup refusal" : null,
          summary: "Synthetic review with no decision",
          provider: "test",
          model: "synthetic-model",
        };
      });
      const run = await recoveryHeartbeat.invoke(role!.id, "on_demand", {
        issueId: issue!.id,
        ...(kind !== "failure" ? {
          wakeReason: "execution_review_requested",
          // Exercise terminal participant recovery independently of comment repair.
          skipIssueComment: kind === "review-participant",
        } : {}),
      }, "manual");
      await settled(run!.id, recoveryHeartbeat);
      await drainHeartbeatRunsToQuiescence(recoveryDb, recoveryHeartbeat);
      const runs = await recoveryDb.select().from(heartbeatRuns)
        .where(eq(heartbeatRuns.agentId, role!.id));
      const [issueAfter] = await recoveryDb.select().from(issues).where(eq(issues.id, issue!.id));
      if (bound) {
        expect(runs).toHaveLength(1);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(issueAfter).toMatchObject({ status: "blocked", executionRunId: null });
      } else if (kind === "failure") {
        // Upstream schedules the first automatic retry with a delay; drain does
        // not wait for scheduled_retry. Prove the retry exists instead of
        // requiring a second adapter invocation in this fixture.
        expect(execute).toHaveBeenCalledTimes(1);
        expect(runs.some((row) => row.status === "scheduled_retry" && row.retryOfRunId === run!.id)).toBe(true);
        expect(issueAfter?.status).not.toBe("blocked");
      } else {
        expect(runs).toHaveLength(2);
        expect(execute).toHaveBeenCalledTimes(2);
        expect(issueAfter).toMatchObject({ status: "blocked", executionRunId: null });
      }
      if (bound) {
        const comments = await recoveryDb.select().from(issueComments)
          .where(eq(issueComments.issueId, issue!.id));
        expect(comments.some((comment) => comment.body.includes("fresh explicit attempt"))).toBe(true);
        expect(await bindings.getRunBinding(company!.id, run!.id))
          .toMatchObject({ bindingId: binding!.id });
      }
      execute.mockClear();
    },
  );

  it("refuses an unbound heartbeat for a harness registered in another company despite spoofed binding context", async () => {
    const [owner, other] = await db.insert(companies).values([
      { name: "Registered native account owner", issuePrefix: randomUUID().slice(0, 8), defaultResponsibleUserId: "test-board" },
      { name: "Unbound native attempt", issuePrefix: randomUUID().slice(0, 8), defaultResponsibleUserId: "test-board" },
    ]).returning();
    await attachBoardMembership(db, [owner!, other!]);
    const [ownerRole, unboundRole] = await db.insert(agents).values([owner!, other!].map((company) => ({
      companyId: company.id,
      name: "Synthetic Codex role",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 15, executionBindingMode: "read_only" },
      runtimeConfig: { executionBindingRequired: false },
      permissions: {},
    }))).returning();
    const bindings = executionBindingService(db);
    const binding = await bindings.create(owner!.id, {
      name: "Registered synthetic Codex account",
      accountKey: `codex:${randomUUID()}`,
      adapterType: "codex_local",
      command: "/synthetic/never-executed",
      nativeProfileHome: mkdtempSync(join(profileRoot, "registered-")),
      models: ["synthetic-model"], capabilities: ["text"], dataClasses: ["synthetic"],
      allowedAgentIds: [ownerRole!.id], billingRoute: "native_subscription",
      evidenceRefs: ["test://registration"], verifiedUntil: "2099-01-01T00:00:00Z",
    }, { actorType: "user", actorId: "test-board" });
    const [issue] = await db.insert(issues).values({
      companyId: other!.id, title: "Refuse an unleased registered harness",
      status: "in_progress", assigneeAgentId: unboundRole!.id,
    }).returning();
    execute.mockClear();
    execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false,
      summary: "Unbound dispatch must not run", provider: "test", model: "synthetic-model" });
    const run = await heartbeat.invoke(unboundRole!.id, "on_demand", {
      issueId: issue!.id,
      runtimeMode: "native",
      executionBindingRequired: false,
      executionBinding: { bindingId: binding.id },
    }, "manual");
    expect(run).not.toBeNull();
    const finished = await settled(run!.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    expect(finished).toMatchObject({
      status: "failed", errorCode: "execution_binding_required",
      processPid: null, processGroupId: null,
    });
    expect(execute).not.toHaveBeenCalled();
    const attempts = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, unboundRole!.id));
    expect(attempts).toHaveLength(1);
    expect(await bindings.getRunBinding(other!.id, run!.id)).toBeNull();
    const [blocked] = await db.select().from(issues).where(eq(issues.id, issue!.id));
    expect(blocked).toMatchObject({ status: "blocked", executionRunId: null });
  });

  it("refuses late native registration at the final locked dispatch gate without invoking the adapter", async () => {
    const lateTempDb = await startEmbeddedPostgresTestDatabase("heartbeat-late-registration-");
    const lateDb = createDb(lateTempDb.connectionString);
    await seedBoardUser(lateDb);
    const bindings = executionBindingService(lateDb);
    let lateHeartbeat: ReturnType<typeof heartbeatService> | undefined;
    try {
      const [owner, other] = await lateDb.insert(companies).values([
        { name: "Late registration owner", issuePrefix: randomUUID().slice(0, 8), defaultResponsibleUserId: "test-board" },
        { name: "Already prepared unbound run", issuePrefix: randomUUID().slice(0, 8), defaultResponsibleUserId: "test-board" },
      ]).returning();
      await attachBoardMembership(lateDb, [owner!, other!]);
      const [ownerRole, unboundRole] = await lateDb.insert(agents).values([owner!, other!].map((company) => ({
        companyId: company.id, name: "Synthetic late-registration role", role: "engineer",
        status: "idle", adapterType: "codex_local", adapterConfig: { timeoutSec: 15 },
        runtimeConfig: { executionBindingRequired: false }, permissions: {},
      }))).returning();
      const [issue] = await lateDb.insert(issues).values({
        companyId: other!.id, title: "Late registration dispatch refusal",
        status: "in_progress", assigneeAgentId: unboundRole!.id,
      }).returning();
      const registrationChecks: string[] = [];
      lateHeartbeat = heartbeatService(lateDb, {
        afterResolvedInteractionContinuationDispatchCheck: async ({ runId, issueId }) => {
          expect(issueId).toBe(issue!.id);
          expect(await lateDb.select().from(executionBindings)).toHaveLength(0);
          expect(await bindings.getRunBinding(other!.id, runId)).toBeNull();
          registrationChecks.push(runId);
          await bindings.create(owner!.id, {
            name: "Registered after unbound acquisition",
            accountKey: `codex:${randomUUID()}`, adapterType: "codex_local",
            command: "/synthetic/never-executed",
            nativeProfileHome: mkdtempSync(join(profileRoot, "late-registration-")),
            models: ["synthetic-model"], capabilities: ["text"], dataClasses: ["synthetic"],
            allowedAgentIds: [ownerRole!.id], billingRoute: "native_subscription",
            evidenceRefs: ["test://late-registration"], verifiedUntil: "2099-01-01T00:00:00Z",
          }, { actorType: "user", actorId: "test-board" });
        },
      });
      expect(await lateDb.select().from(executionBindings)).toHaveLength(0);
      execute.mockClear();
      execute.mockResolvedValue({ exitCode: 0, signal: null, timedOut: false,
        summary: "Late unbound dispatch must not run", provider: "test", model: "synthetic-model" });
      const wakeupRequestId = randomUUID();
      await lateDb.insert(agentWakeupRequests).values({
        id: wakeupRequestId, companyId: other!.id, agentId: unboundRole!.id,
        source: "automation", triggerDetail: "system", reason: "issue_commented",
        payload: { issueId: issue!.id }, status: "queued",
      });
      const [run] = await lateDb.insert(heartbeatRuns).values({
        companyId: other!.id, agentId: unboundRole!.id, invocationSource: "automation",
        triggerDetail: "system", status: "queued", wakeupRequestId,
        contextSnapshot: {
          issueId: issue!.id, wakeReason: "issue_commented", mutation: "interaction",
          interactionId: randomUUID(), interactionKind: "connection_intent",
          interactionStatus: "accepted", interactionResolvedAt: new Date().toISOString(),
          source: "connection_intent.resolved",
        },
      }).returning();
      await lateDb.update(agentWakeupRequests).set({ runId: run!.id }).where(eq(agentWakeupRequests.id, wakeupRequestId));
      await lateHeartbeat.resumeQueuedRuns();
      expect(run).not.toBeNull();
      const finished = await settled(run!.id, lateHeartbeat);
      await drainHeartbeatRunsToQuiescence(lateDb, lateHeartbeat);
      expect(registrationChecks).toEqual([run!.id]);
      expect(await lateDb.select().from(executionBindings)).toHaveLength(1);
      expect(finished).toMatchObject({ status: "failed", errorCode: "execution_binding_required",
        processPid: null, processGroupId: null });
      expect(execute).not.toHaveBeenCalled();
      expect(await bindings.getRunBinding(other!.id, run!.id)).toBeNull();
      const attempts = await lateDb.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, unboundRole!.id));
      expect(attempts).toHaveLength(1);
      const [blocked] = await lateDb.select().from(issues).where(eq(issues.id, issue!.id));
      expect(blocked).toMatchObject({ status: "blocked", executionRunId: null });
    } finally {
      if (lateHeartbeat) await drainHeartbeatRunsToQuiescence(lateDb, lateHeartbeat);
      await lateTempDb.cleanup();
    }
  }, 30_000);

  it("executes one role through two harnesses using the selected account and account-scoped sessions", async () => {
    const [company] = await db
      .insert(companies)
      .values({
        name: "Role routing",
        issuePrefix: randomUUID().slice(0, 8),
        defaultResponsibleUserId: "test-board",
      })
      .returning();
    await attachBoardMembership(db, [company!]);
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
          accountKey: `${adapterType}:${randomUUID()}`,
          adapterType,
          command: `/native/${adapterType}`,
          nativeProfileHome: mkdtempSync(join(profileRoot, `${adapterType}-`)),
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
  it.each([
    ["paid_api", null],
    ["paid_api", 0.12],
    ["native_subscription", null],
    ["unbound", null],
  ] as const)("persists billing attribution for %s with reported cost %s", async (route, costUsd) => {
    const targetDb = route === "unbound" ? unregisteredDb : db;
    const targetHeartbeat = route === "unbound" ? unregisteredHeartbeat : heartbeat;
    const [company] = await targetDb.insert(companies).values({
      name: "Synthetic billing attribution", issuePrefix: randomUUID().slice(0, 8),
      defaultResponsibleUserId: "test-board",
    }).returning();
    await attachBoardMembership(targetDb, [company!]);
    const [role] = await targetDb.insert(agents).values({
      companyId: company!.id, name: "Synthetic billed role", role: "engineer", status: "idle",
      adapterType: "codex_local", adapterConfig: { engine: "cli", timeoutSec: 15 },
      runtimeConfig: { executionBindingRequired: route !== "unbound" }, permissions: {},
    }).returning();
    const bindings = executionBindingService(targetDb);
    const binding = route === "unbound" ? null : await bindings.create(company!.id, {
      name: "Synthetic billing route", accountKey: "jobs-development-azure", adapterType: "codex_local",
      command: "/synthetic/adapter", nativeProfileHome: mkdtempSync(join(profileRoot, "billing-")),
      models: ["synthetic-model"], capabilities: ["text"], dataClasses: ["synthetic"],
      allowedAgentIds: [role!.id], billingRoute: route,
      evidenceRefs: ["test://billing-qualification"], verifiedUntil: "2099-01-01T00:00:00Z",
    }, { actorType: "user", actorId: "test-board" });
    const [issue] = await targetDb.insert(issues).values({
      companyId: company!.id, title: "Synthetic usage persistence", status: "in_progress",
      assigneeAgentId: role!.id,
      ...(binding ? { assigneeAdapterOverrides: { executionBinding: {
        bindingId: binding.id, model: "synthetic-model", requiredCapabilities: ["text"],
        dataClass: "synthetic", reason: "Synthetic billing regression", evidenceRefs: ["test://billing-task"],
      } } } : {}),
    }).returning();
    execute.mockClear();
    execute.mockImplementation(async (context) => {
      const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 20)"],
        { detached: true, stdio: "ignore" });
      const closed = once(child, "close");
      await context.onSpawn?.({ pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString() });
      await closed;
      await targetDb.update(issues).set({ status: "done" }).where(eq(issues.id, issue!.id));
      return {
        exitCode: 0, signal: null, timedOut: false, provider: "synthetic-provider", model: "synthetic-model",
        billingType: "subscription_included", biller: "adapter-default", costUsd,
        usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 20 }, usageBasis: "per_run",
        summary: "Synthetic attribution proof", resultJson: { preserved: true },
      };
    });
    const run = await targetHeartbeat.invoke(role!.id, "on_demand", { issueId: issue!.id }, "manual");
    expect(run).not.toBeNull();
    const finished = await settled(run!.id, targetHeartbeat);
    await drainHeartbeatRunsToQuiescence(targetDb, targetHeartbeat);
    expect(finished.status).toBe("succeeded");
    const billedOnSubscription = route !== "paid_api";
    const attribution = {
      billingType: route === "paid_api" ? "metered_api" : "subscription_included",
      biller: route === "paid_api" ? binding!.accountKey : "adapter-default",
      // Upstream ledger: subscription_included is reported even with a null
      // adapter cost; metered routes stay unpriced until a numeric cost exists.
      costStatus: billedOnSubscription || costUsd !== null ? "reported" : "unpriced",
      provider: "synthetic-provider", model: "synthetic-model", inputTokens: 100, outputTokens: 20,
    };
    expect(finished.usageJson).toMatchObject(attribution);
    expect(finished.resultJson).toMatchObject({ preserved: true });
    if (costUsd === null) expect(finished.usageJson?.costUsd ?? null).toBeNull();
    else expect(finished.usageJson).toMatchObject({ costUsd });
    expect(execute).toHaveBeenCalledTimes(1);
    const settledRun = await targetHeartbeat.getRun(run!.id);
    let costs = await targetDb.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run!.id));
    for (let attempt = 0; attempt < 20 && costs.length === 0 && settledRun?.costAccountingPending; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      costs = await targetDb.select().from(costEvents).where(eq(costEvents.heartbeatRunId, run!.id));
    }
    // Ledger posting can remain pending for recovery when this fixture has no
    // project/budget graph. The binding overlay is proven on usageJson above.
    if (costs.length > 0) {
      expect(costs[0]).toMatchObject({
        ...attribution,
        costCents: route === "paid_api" && costUsd !== null ? 12 : 0,
      });
    } else {
      expect(settledRun?.usageJson).toMatchObject(attribution);
    }
  }, 30_000);

  it("rejects explicit binding expiry during preparation without dispatch and releases unused capacity", async () => {
    const [company] = await db.insert(companies).values({
      name: "Expiry during preparation",
      issuePrefix: randomUUID().slice(0, 8),
      defaultResponsibleUserId: "test-board",
    }).returning();
    await attachBoardMembership(db, [company!]);
    const [role] = await db.insert(agents).values({
      companyId: company!.id,
      name: "Synthetic expiry role",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: { engine: "cli", promptTemplate: "Synthetic expiry check", timeoutSec: 15 },
      runtimeConfig: { executionBindingRequired: true },
      permissions: { canCreateAgents: false },
    }).returning();
    const bindings = executionBindingService(db);
    const verifiedUntil = new Date(Date.now() + 60_000).toISOString();
    const binding = await bindings.create(company!.id, {
      name: "Synthetic explicit binding",
      accountKey: `claude:expiry:${randomUUID()}`,
      adapterType: "claude_local",
      command: "/synthetic/never-executed",
      nativeProfileHome: mkdtempSync(join(profileRoot, "expiry-")),
      models: ["synthetic-model"],
      capabilities: ["text"],
      dataClasses: ["synthetic"],
      allowedAgentIds: [role!.id],
      billingRoute: "native_subscription",
      evidenceRefs: ["test://expiry"],
      verifiedUntil,
    }, { actorType: "user", actorId: "test-board" });
    const [issue] = await db.insert(issues).values({
      companyId: company!.id,
      title: "Synthetic expiry task",
      status: "in_progress",
      assigneeAgentId: role!.id,
      assigneeAdapterOverrides: { executionBinding: {
        bindingId: binding.id,
        model: "synthetic-model",
        requiredCapabilities: ["text"],
        dataClass: "synthetic",
        reason: "Synthetic expiry regression",
        evidenceRefs: ["test://expiry-task"],
      } },
    }).returning();
    const originalAdapter = getServerAdapter("claude_local");
    const unexpectedExecute = vi.fn<ServerAdapterModule["execute"]>(async () => {
      throw new Error("Expired binding reached the fake adapter");
    });
    registerServerAdapter({
      type: "claude_local",
      supportsLocalAgentJwt: true,
      // The adapter's delivery capability is read during preparation, after
      // reservation and before the real dispatch gate. Simulate elapsed time
      // here without changing the acquired definition or faking I/O timers.
      get runtimeToolDelivery() {
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(new Date(Date.parse(verifiedUntil) + 1));
        return "invocation_context" as const;
      },
      execute: unexpectedExecute,
      testEnvironment: originalAdapter.testEnvironment,
    });
    try {
      const run = await heartbeat.invoke(role!.id, "on_demand", { issueId: issue!.id }, "manual");
      expect(run).not.toBeNull();
      const finished = await settled(run!.id);
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      expect(finished).toMatchObject({
        status: "failed",
        errorCode: "execution_binding_evidence_expired",
        processPid: null,
        processGroupId: null,
      });
      expect(unexpectedExecute).not.toHaveBeenCalled();
      const reservation = await bindings.getRunBinding(company!.id, run!.id);
      expect(reservation).toMatchObject({
        releaseReason: "setup_stopped_before_dispatch",
        processHistory: [],
        snapshot: { binding: { verifiedUntil } },
      });
      expect(reservation!.releasedAt).not.toBeNull();
      const attempts = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, role!.id));
      expect(attempts).toHaveLength(1);
      const [unchangedRole] = await db.select().from(agents).where(eq(agents.id, role!.id));
      expect(unchangedRole).toMatchObject({
        adapterType: role!.adapterType,
        adapterConfig: role!.adapterConfig,
        runtimeConfig: role!.runtimeConfig,
        permissions: role!.permissions,
      });
    } finally {
      await drainHeartbeatRunsToQuiescence(db, heartbeat);
      vi.useRealTimers();
      registerServerAdapter(originalAdapter);
    }
  }, 30_000);
});
