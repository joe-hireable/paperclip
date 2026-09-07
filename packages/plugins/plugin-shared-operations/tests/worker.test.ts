import { describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginDatabaseClient } from "@paperclipai/plugin-sdk";
import { applyCommand, emptyState, type Actor, type Command, type CompanyState } from "../src/domain.js";
import type { TaskHead } from "../src/store.js";
import { createOperations } from "../src/worker.js";

vi.mock("@paperclipai/plugin-sdk", () => ({
  definePlugin: (plugin: unknown) => plugin,
  runWorker: vi.fn(),
}));

const company = "00000000-0000-0000-0000-000000000001";
const taskId = "00000000-0000-0000-0000-000000000002";
const board: Actor = { id: "local-board", kind: "board" };
const receiver: Actor = { id: "assigned-agent", kind: "agent" };
const head: TaskHead = { id: taskId, taskRevision: "81:1788775200.123456", receiverId: receiver.id };
const now = "2026-09-07T10:00:00.000Z";
const publish: Command = {
  type: "policy.publish", id: "policy-1", reason: "Initial policy",
  bundle: { instructions: ["Verify task context"], constraints: [], skills: [], hooks: [] },
};
const snapshot: Command = {
  type: "context.snapshot", id: "snapshot-1", receiverId: receiver.id,
  taskId, taskRevision: head.taskRevision, memoryIds: [], omissions: [],
};
const initial = () => applyCommand(emptyState(), publish, board, now);
const withSnapshot = () => applyCommand(initial(), snapshot, board, now);
const receive = (state: CompanyState): Command => ({
  type: "context.receive", snapshotId: "snapshot-1",
  digest: state.snapshots[0].digest, taskRevision: head.taskRevision,
});

function harness(state = initial()) {
  let currentHead: TaskHead | null = { ...head };
  let updateCount = 1;
  const query = vi.fn(async (statement: string, params: unknown[] = []): Promise<unknown[]> => {
    if (statement.includes("FROM public.issues")) {
      expect(params).toEqual([company, taskId]);
      return currentHead ? [structuredClone(currentHead)] : [];
    }
    expect(params).toEqual([company]);
    return [{ revision: 3, document: structuredClone(state) }];
  });
  const execute = vi.fn(async (statement: string, _params?: unknown[]) => ({
    rowCount: statement.startsWith("UPDATE") ? updateCount : 0,
  }));
  const getIssue = vi.fn(async (_taskId: string, _company: string): Promise<object | null> => ({ id: taskId, companyId: company }));
  const db: PluginDatabaseClient = {
    namespace: "plugin_shared_operations_test", execute,
    async query<T>(statement: string, params?: unknown[]) { return await query(statement, params) as T[]; },
  };
  const ctx = { db, issues: { get: getIssue } } as unknown as PluginContext;
  const operations = createOperations(ctx);
  return {
    query, execute, getIssue,
    changeTask(next: TaskHead | null) { currentHead = next; },
    loseConditionalWrite() { updateCount = 0; },
    run(command: Command, actor = board, expectedRevision = 3) {
      return operations.command({ companyId: company, expectedRevision, command }, actor);
    },
  };
}

describe("operations command integration", () => {
  it("propagates domain permission failures without writing company state", async () => {
    const h = harness(emptyState());
    await expect(h.run(publish, receiver)).rejects.toMatchObject({ code: "BOARD_REQUIRED", status: 403 });
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.getIssue).not.toHaveBeenCalled();
  });

  it("rejects a stale company revision before consulting the task or persisting", async () => {
    const h = harness();
    await expect(h.run(snapshot, board, 2)).rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    expect(h.getIssue).not.toHaveBeenCalled();
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("requires the SDK to resolve the task inside the requested company", async () => {
    const h = harness();
    h.getIssue.mockResolvedValue(null);
    await expect(h.run(snapshot)).rejects.toMatchObject({ code: "invalid_task", status: 404 });
    expect(h.getIssue).toHaveBeenCalledWith(taskId, company);
    expect(h.query).toHaveBeenCalledTimes(1);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("rejects a task that disappears between SDK lookup and the database head read", async () => {
    const h = harness();
    h.changeTask(null);
    await expect(h.run(snapshot)).rejects.toMatchObject({ code: "invalid_task", status: 404 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each(["snapshot", "receive"] as const)("checks the live task revision before context.%s", async (kind) => {
    const state = kind === "receive" ? withSnapshot() : initial();
    const h = harness(state);
    h.changeTask({ ...head, taskRevision: "82:1788775201.654321" });
    await expect(h.run(kind === "receive" ? receive(state) : snapshot, receiver))
      .rejects.toMatchObject({ code: "stale_task", status: 409 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each([null, "replacement-agent"])("rejects snapshot creation when the live assignee is %s", async (receiverId) => {
    const h = harness();
    h.changeTask({ ...head, receiverId });
    await expect(h.run(snapshot)).rejects.toMatchObject({ code: "wrong_receiver", status: 409 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it.each<Actor>([{ id: receiver.id, kind: "board" }, { id: "other-agent", kind: "agent" }])(
    "requires the actual assigned agent identity for acknowledgement: %j", async (actor) => {
      const state = withSnapshot();
      const h = harness(state);
      await expect(h.run(receive(state), actor)).rejects.toMatchObject({ code: "wrong_receiver", status: 403 });
      expect(h.execute).not.toHaveBeenCalled();
    },
  );

  it("refuses an old receiver's acknowledgement after task reassignment", async () => {
    const state = withSnapshot();
    const h = harness(state);
    h.changeTask({ ...head, receiverId: "replacement-agent" });
    await expect(h.run(receive(state), receiver)).rejects.toMatchObject({ code: "wrong_receiver", status: 409 });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it("persists a prepared snapshot with the exact company and live task guard", async () => {
    const h = harness();
    const result = await h.run(snapshot);
    expect(h.getIssue).toHaveBeenCalledWith(taskId, company);
    expect(result.revision).toBe(4);
    expect(result.state.snapshots[0]).toMatchObject({ id: "snapshot-1", taskId, taskRevision: head.taskRevision, receiverId: receiver.id, actor: board, receipt: null });
    const [statement, params] = h.execute.mock.calls[1];
    expect(statement).toContain("AND EXISTS (SELECT 1 FROM public.issues");
    expect(params?.slice(1)).toEqual([company, 3, taskId, head.taskRevision, receiver.id]);
    expect(JSON.parse(String(params?.[0]))).toEqual(result.state);
  });

  it("records an assigned agent receipt and retains its task guard when saving", async () => {
    const state = withSnapshot();
    const h = harness(state);
    const result = await h.run(receive(state), receiver);
    expect(h.getIssue).toHaveBeenCalledWith(taskId, company);
    expect(result.state.snapshots[0].receipt).toMatchObject({ actor: receiver, digest: state.snapshots[0].digest, taskRevision: head.taskRevision });
    expect(state.snapshots[0].receipt).toBeNull();
    expect(h.execute.mock.calls[1][1]?.slice(1)).toEqual([company, 3, taskId, head.taskRevision, receiver.id]);
  });

  it.each(["snapshot", "receive"] as const)("surfaces a lost conditional write instead of claiming context.%s was saved", async (kind) => {
    const state = kind === "receive" ? withSnapshot() : initial();
    const h = harness(state);
    h.loseConditionalWrite();
    await expect(h.run(kind === "receive" ? receive(state) : snapshot, receiver))
      .rejects.toMatchObject({ code: "revision_conflict", status: 409 });
    expect(h.execute.mock.calls[1][1]?.slice(1)).toEqual([company, 3, taskId, head.taskRevision, receiver.id]);
    expect(state.snapshots.length).toBe(kind === "receive" ? 1 : 0);
    if (kind === "receive") expect(state.snapshots[0].receipt).toBeNull();
  });
});
