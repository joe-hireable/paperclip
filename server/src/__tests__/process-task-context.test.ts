import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext, AdapterInvocationMeta } from "../adapters/types.js";
import { execute } from "../adapters/process/execute.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function captureChildEnv(context: Record<string, unknown>, env: Record<string, string> = {}) {
  const invocation: AdapterInvocationMeta[] = [];
  // Inspect only synthetic values selected by these tests, never the full host env.
  const script = `process.stdout.write(JSON.stringify({
    taskId: process.env.PAPERCLIP_TASK_ID ?? null,
    runId: process.env.PAPERCLIP_RUN_ID,
    agentId: process.env.PAPERCLIP_AGENT_ID,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    custom: process.env.PROCESS_TEST_CUSTOM,
    extension: process.env.PAPERCLIP_PROCESS_TEST_EXTENSION
  }));`;
  const ctx: AdapterExecutionContext = {
    runId: "run-process-test",
    agent: {
      id: "agent-process-test",
      companyId: "company-process-test",
      name: "Process test",
      adapterType: "process",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: "stale-runtime-task",
    },
    config: {
      command: process.execPath,
      args: ["-e", script],
      timeoutSec: 5,
      graceSec: 1,
      env,
    },
    context,
    onLog: async () => {},
    onMeta: async (meta) => { invocation.push(meta); },
  };
  const result = await execute(ctx);
  expect(result.exitCode).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.errorMessage).toBeUndefined();
  const child = JSON.parse(String(result.resultJson?.stdout)) as Record<string, string | null>;
  return { child, loggedEnv: invocation[0]?.env };
}

describe("process adapter task context", () => {
  it.each([
    { context: { taskId: " task-current ", issueId: "issue-fallback" }, expected: "task-current" },
    { context: { issueId: " issue-current " }, expected: "issue-current" },
    { context: { taskId: " \t ", issueId: "issue-current" }, expected: "issue-current" },
    { context: { taskId: 42, issueId: "issue-current" }, expected: "issue-current" },
  ])("passes the authoritative task to the child and invocation metadata: $context", async ({ context, expected }) => {
    const { child, loggedEnv } = await captureChildEnv(context);
    expect(child.taskId).toBe(expected);
    expect(loggedEnv?.PAPERCLIP_TASK_ID).toBe(expected);
  });

  it("keeps current task identity ahead of config and inherited values", async () => {
    vi.stubEnv("PAPERCLIP_TASK_ID", "stale-inherited-task");
    const { child, loggedEnv } = await captureChildEnv({ issueId: "issue-current" }, {
      PAPERCLIP_TASK_ID: "spoofed-config-task",
      PAPERCLIP_RUN_ID: "spoofed-config-run",
      PAPERCLIP_AGENT_ID: "spoofed-config-agent",
      PAPERCLIP_COMPANY_ID: "spoofed-config-company",
      PROCESS_TEST_CUSTOM: "custom-value",
      PAPERCLIP_PROCESS_TEST_EXTENSION: "extension-value",
    });
    expect(child).toEqual({
      taskId: "issue-current",
      runId: "run-process-test",
      agentId: "agent-process-test",
      companyId: "company-process-test",
      custom: "custom-value",
      extension: "extension-value",
    });
    expect(loggedEnv?.PAPERCLIP_TASK_ID).toBe("issue-current");
  });

  it.each([{}, { taskId: " \t ", issueId: "\n" }, { taskId: 42, issueId: { id: "not-a-task" } }])(
    "omits task identity on taskless runs despite config, inherited and prior task state: %j",
    async (context) => {
      vi.stubEnv("PAPERCLIP_TASK_ID", "stale-inherited-task");
      const { child, loggedEnv } = await captureChildEnv(context, { PAPERCLIP_TASK_ID: "stale-config-task" });
      expect(child.taskId).toBeNull();
      expect(loggedEnv).not.toHaveProperty("PAPERCLIP_TASK_ID");
    },
  );
});
