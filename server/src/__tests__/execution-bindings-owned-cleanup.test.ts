import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { runChildProcess, runningProcesses } from "@paperclipai/adapter-utils/server-utils";
import { executionBindingService } from "../services/execution-bindings.js";
import { heartbeatService } from "../services/heartbeat.js";
import { isPidAlive, isProcessGroupAlive } from "../services/local-service-supervisor.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
if (!support.supported) console.warn(`Owned cleanup DB test unavailable: ${support.reason}`);
describe.skipIf(process.platform !== "linux" || !support.supported)("original-owner process cleanup settlement", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let profileRoot: string;
  beforeAll(async () => {
    profileRoot = mkdtempSync(join(tmpdir(), "paperclip-owned-cleanup-profiles-"));
    tempDb = await startEmbeddedPostgresTestDatabase("owned-cleanup-");
    db = createDb(tempDb.connectionString);
  }, 30_000);
  afterAll(async () => {
    await tempDb?.cleanup();
    if (profileRoot) rmSync(profileRoot, { recursive: true, force: true });
  });

  it.each(["close", "cancel"])("holds the same owner's lease through parent close, then releases after %s cleanup", async (mode) => {
    const [company] = await db.insert(companies).values({ name: "Synthetic cleanup", issuePrefix: randomUUID().slice(0, 8) }).returning();
    const [agent] = await db.insert(agents).values({ companyId: company!.id, name: "Synthetic fixture", role: "engineer",
      status: "idle", adapterType: "claude_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} }).returning();
    const service = executionBindingService(db);
    const binding = await service.create(company!.id, {
      name: "Synthetic native binding", accountKey: `fixture:${randomUUID()}`, adapterType: "claude_local",
      command: process.execPath, nativeProfileHome: mkdtempSync(join(profileRoot, "profile-")), models: ["synthetic-model"],
      capabilities: ["text"], dataClasses: ["synthetic"], allowedAgentIds: [agent!.id],
      billingRoute: "native_subscription", evidenceRefs: ["test://synthetic"], verifiedUntil: "2099-01-01T00:00:00Z",
    }, { actorType: "user", actorId: "test-board" });
    const [issue] = await db.insert(issues).values({ companyId: company!.id, title: "Synthetic cleanup", status: "in_progress",
      assigneeAgentId: agent!.id, assigneeAdapterOverrides: { executionBinding: {
        bindingId: binding.id, model: "synthetic-model", requiredCapabilities: ["text"], dataClass: "synthetic",
        reason: "Synthetic local cleanup proof", evidenceRefs: ["test://synthetic"],
      } } }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: company!.id, agentId: agent!.id, status: "running",
      contextSnapshot: { issueId: issue!.id } }).returning();
    await service.acquire(run!, agent!);
    let group = 0;
    let descendant = 0;
    const release = () => service.releaseAfterExecution({ companyId: company!.id, runId: run!.id,
      adapterStarted: true, hasActiveChild: runningProcesses.has(run!.id), isProcessAlive: isPidAlive, isProcessGroupAlive });
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.send('ready'); setInterval(() => {}, 1000)"],
        { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
      child.once('message', () => { process.stdout.write(String(child.pid)); child.disconnect(); child.unref(); setTimeout(() => process.exit(0), 50); });
    `;
    try {
      const resultPromise = runChildProcess(run!.id, process.execPath, ["-e", script], {
        cwd: process.cwd(), env: {}, timeoutSec: 5, graceSec: 1, cleanupOwnedProcessGroup: true,
        onSpawn: async (meta) => { group = meta.processGroupId!; await service.recordProcess(run!.id, meta); },
        onLog: async (_stream, text) => { descendant = Number(text); },
      });
      const deadline = Date.now() + 3000;
      while ((!descendant || isPidAlive(group)) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 20));
      expect(descendant).toBeGreaterThan(0);
      expect(isPidAlive(group)).toBe(false);
      expect(isProcessGroupAlive(group)).toBe(true);
      if (mode === "close") await db.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, run!.id));
      expect(await release()).toBe(false);
      expect((await service.getRunBinding(company!.id, run!.id))?.releasedAt).toBeNull();
      if (mode === "cancel") await heartbeatService(db).cancelRun(run!.id);
      const result = await resultPromise;
      expect(result.ownedProcessGroupCleanup).toEqual({ status: "gone", forceKilled: true });
      expect(isProcessGroupAlive(group)).toBe(false);
      expect(await release()).toBe(true);
      const lease = await service.getRunBinding(company!.id, run!.id);
      expect(lease?.releasedAt).not.toBeNull();
      expect(lease?.releaseReason).toBe("execution_settled_process_tree_gone");
      expect(await release()).toBe(false);
    } finally {
      if (descendant && isPidAlive(descendant)) { try { process.kill(descendant, "SIGKILL"); } catch {} }
      runningProcesses.delete(run!.id);
    }
  }, 10_000);
});
