import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  agents,
  agentWakeupRequests,
  authUsers,
  companies,
  companyMemberships,
  createDb,
  heartbeatRuns,
  issues,
  issueComments,
  projects,
  runExecutionBindings,
  type Db,
} from "@paperclipai/db";
import {
  registerServerAdapter,
  unregisterServerAdapter,
} from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { projectConversationService } from "../services/project-conversations.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const ADAPTER = "synthetic-project-conversation-guard";
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("project conversation heartbeat exclusion", () => {
  let db: Db;
  let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  const execute = vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
  }));
  beforeAll(async () => {
    temp = await startEmbeddedPostgresTestDatabase(
      "project-conversation-dispatch-",
    );
    db = createDb(temp.connectionString);
    await db.insert(authUsers).values({
      id: "fixture-board",
      name: "Fixture Board",
      email: "fixture-board@example.test",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    }).onConflictDoNothing();
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: ADAPTER,
      execute,
      testEnvironment: async () => ({
        adapterType: ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 30_000);
  beforeEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    execute.mockClear();
  });
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    unregisterServerAdapter(ADAPTER);
    await temp?.cleanup();
  });
  async function fixture(master = false) {
    const companyId = randomUUID(),
      projectId = randomUUID(),
      issueId = randomUUID(),
      agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Synthetic",
      issuePrefix: randomUUID().slice(0, 8),
      defaultResponsibleUserId: "fixture-board",
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalId: "fixture-board",
      principalType: "user",
      status: "active",
      membershipRole: "admin",
    });
    await db
      .insert(projects)
      .values({ id: projectId, companyId, name: "Synthetic project" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "No provider",
      adapterType: ADAPTER,
      status: "idle",
      adapterConfig: { cwd: "/tmp", promptTemplate: "Synthetic only" },
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Conversation",
      responsibleUserId: "fixture-board",
      ...(master
        ? { originKind: "project_master_chat", originId: projectId }
        : {}),
    });
    return { companyId, projectId, issueId, agentId };
  }
  async function assertNoExecution(f: Awaited<ReturnType<typeof fixture>>) {
    await heartbeat.drainActiveRunExecutions();
    expect(execute).not.toHaveBeenCalled();
    const [row] = await db
      .select()
      .from(issues)
      .where(eq(issues.id, f.issueId));
    expect(row).toMatchObject({
      assigneeAgentId: null,
      checkoutRunId: null,
      executionRunId: null,
      executionLockedAt: null,
    });
    expect(
      await db
        .select()
        .from(runExecutionBindings)
        .where(
          and(
            eq(runExecutionBindings.companyId, f.companyId),
            sql`${runExecutionBindings.releasedAt} is null`,
          ),
        ),
    ).toHaveLength(0);
  }
  async function insertQueued(
    f: Awaited<ReturnType<typeof fixture>>,
    nativeOnly = false,
  ) {
    const [run] = await db
      .insert(heartbeatRuns)
      .values({
        companyId: f.companyId,
        agentId: f.agentId,
        status: "queued",
        responsibleUserId: "fixture-board",
        contextSnapshot: nativeOnly
          ? {}
          : { issueId: f.issueId, wakeReason: "issue_mentioned" },
        nativeIssueId: nativeOnly ? f.issueId : null,
      })
      .returning();
    return run!;
  }
  async function pausedAdoption(f: Awaited<ReturnType<typeof fixture>>) {
    const ready = gate(),
      release = gate();
    const scopedDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (callback: (tx: unknown) => Promise<unknown>) =>
          db.transaction(async (tx) => {
            const result = await callback(tx);
            ready.resolve();
            await release.promise;
            return result;
          });
      },
    }) as Db;
    const adoption = projectConversationService(scopedDb).ensure(
      f.companyId,
      f.projectId,
      "fixture-board",
      f.issueId,
    );
    await ready.promise;
    return { adoption, release };
  }
  async function waitForIssueLock() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await db.execute(
        sql`select pid from pg_stat_activity where pid <> pg_backend_pid() and wait_event_type = 'Lock' and query like '%issues%'`,
      );
      if (rows.length) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Expected real issue row-lock contention");
  }

  it.each(["context", "mention"])(
    "suppresses direct %s admission",
    async (kind) => {
      const f = await fixture(true);
      const result = await heartbeat.wakeup(f.agentId, {
        source: "on_demand",
        reason: kind === "mention" ? "issue_mentioned" : undefined,
        contextSnapshot: kind === "context" ? { issueId: f.issueId } : {},
        payload: kind === "mention" ? { issueId: f.issueId } : undefined,
        requestedByActorType: "user",
        requestedByActorId: "fixture-board",
      });
      expect(result).toBeNull();
      expect(
        await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.companyId, f.companyId)),
      ).toEqual([
        expect.objectContaining({
          status: "skipped",
          reason: "project_master_context_only",
        }),
      ]);
      await assertNoExecution(f);
    },
  );

  it.each([false, true])(
    "settles a previously queued master before setup (native identity only=%s)",
    async (nativeOnly) => {
      const f = await fixture(true),
        run = await insertQueued(f, nativeOnly);
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(run.id)).toMatchObject({
        status: "cancelled",
        errorCode: "project_master_context_only",
      });
      await assertNoExecution(f);
    },
  );

  it.each(["context", "queued"])("suppresses unqualified coordinator attempt %s without a spawn", async (path) => {
    const f = await fixture();
    await db.update(issues).set({ originKind: "project_coordinator_attempt", originId: randomUUID(), status: "blocked" }).where(eq(issues.id, f.issueId));
    if (path === "context") {
      expect(await heartbeat.wakeup(f.agentId, { source: "on_demand", contextSnapshot: { issueId: f.issueId }, requestedByActorType: "user", requestedByActorId: "fixture-board" })).toBeNull();
    } else {
      const run = await insertQueued(f);
      await heartbeat.resumeQueuedRuns();
      expect(await heartbeat.getRun(run.id)).toMatchObject({ status: "cancelled", errorCode: "project_master_context_only" });
    }
    await assertNoExecution(f);
  });

  it("refuses adoption while an admitted context run remains queued", async () => {
    const f = await fixture(),
      run = await insertQueued(f);
    await expect(
      projectConversationService(db).ensure(
        f.companyId,
        f.projectId,
        "fixture-board",
        f.issueId,
      ),
    ).rejects.toThrow(/pending work/);
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled" })
      .where(eq(heartbeatRuns.id, run.id));
    expect(
      (
        await projectConversationService(db).ensure(
          f.companyId,
          f.projectId,
          "fixture-board",
          f.issueId,
        )
      ).masterIssue?.id,
    ).toBe(f.issueId);
    await assertNoExecution(f);
  });

  it("serializes admission behind actual adoption and suppresses after its commit", async () => {
    const f = await fixture(),
      pending = await pausedAdoption(f);
    const wake = heartbeat.invoke(
      f.agentId,
      "on_demand",
      { issueId: f.issueId },
      "manual",
      { actorType: "user", actorId: "fixture-board" },
    );
    try {
      await waitForIssueLock();
    } finally {
      pending.release.resolve();
    }
    await pending.adoption;
    expect(await wake).toBeNull();
    await assertNoExecution(f);
  });

  it("rechecks a legacy queued insertion racing adoption before claim or provider setup", async () => {
    const f = await fixture(),
      pending = await pausedAdoption(f);
    // Models a legacy/internal writer inserting after adoption's pending-work query.
    const run = await insertQueued(f);
    const wakeId = randomUUID();
    await db
      .insert(agentWakeupRequests)
      .values({
        id: wakeId,
        companyId: f.companyId,
        agentId: f.agentId,
        source: "on_demand",
        payload: { issueId: f.issueId },
        runId: run.id,
      });
    await db
      .update(heartbeatRuns)
      .set({ wakeupRequestId: wakeId })
      .where(eq(heartbeatRuns.id, run.id));
    const resume = heartbeat.resumeQueuedRuns();
    try {
      await waitForIssueLock();
    } finally {
      pending.release.resolve();
    }
    await pending.adoption;
    await resume;
    expect(await heartbeat.getRun(run.id)).toMatchObject({
      status: "cancelled",
      errorCode: "project_master_context_only",
    });
    expect(
      (
        await db
          .select()
          .from(agentWakeupRequests)
          .where(eq(agentWakeupRequests.id, wakeId))
      )[0],
    ).toMatchObject({ status: "skipped" });
    await assertNoExecution(f);
  });
  it("suppresses bounded retry scheduling and leaves the master without execution identity", async () => {
    const f = await fixture(true),
      run = await insertQueued(f);
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, run.id));
    expect(
      await heartbeat.scheduleBoundedRetry(run.id, { delayMs: 0 }),
    ).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "project_master_context_only",
    });
    expect(
      await db
        .select()
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.companyId, f.companyId)),
    ).toHaveLength(1);
    await assertNoExecution(f);
  });

  it("retains ordinary issue dispatch through the synthetic adapter", async () => {
    const f = await fixture();
    await db
      .update(issues)
      .set({ assigneeAgentId: f.agentId, status: "todo" })
      .where(eq(issues.id, f.issueId));
    execute.mockImplementationOnce(async () => {
      await db
        .insert(issueComments)
        .values({
          companyId: f.companyId,
          issueId: f.issueId,
          authorAgentId: f.agentId,
          body: "Synthetic work completed",
        });
      await db
        .update(issues)
        .set({ status: "done" })
        .where(eq(issues.id, f.issueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null };
    });
    const run = await heartbeat.invoke(
      f.agentId,
      "on_demand",
      { issueId: f.issueId },
      "manual",
      { actorType: "user", actorId: "fixture-board" },
    );
    expect(run).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await heartbeat.getRun(run!.id)).toMatchObject({
      status: "succeeded",
    });
  });
});
