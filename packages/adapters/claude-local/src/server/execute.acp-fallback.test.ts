import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const {
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetRuntimeCommandInstalled,
  executeClaudeAcp,
  resolveAdapterExecutionTargetCommandForLogs,
  runAdapterExecutionTargetProcess,
} = vi.hoisted(() => ({
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => undefined),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => undefined),
  executeClaudeAcp: vi.fn(async () => {
    throw new Error('Transform failed with 1 error: execute.ts:818:0: ERROR: Unexpected "<<"');
  }),
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: [
      JSON.stringify({ type: "system", subtype: "init", session_id: "claude-session-1", model: "claude-sonnet" }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-1",
        message: { content: [{ type: "text", text: "hello" }] },
      }),
      JSON.stringify({
        type: "result",
        session_id: "claude-session-1",
        result: "hello",
        usage: { input_tokens: 1, cache_read_input_tokens: 0, output_tokens: 1 },
      }),
    ].join("\n"),
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  })),
}));

vi.mock("./acp.js", () => ({
  createClaudeAcpExecutor: () => executeClaudeAcp,
  formatClaudeAcpFallbackMessage: (reason: string) =>
    `[paperclip] Claude ACP default unavailable; falling back to Claude CLI. ${reason} Set engine=acp to require ACP or engine=cli to silence this fallback.\n`,
  resolveClaudeExecutionEngineForRun: async (ctx: { config: Record<string, unknown> }) =>
    ctx.config.engine === "cli"
      ? { engine: "cli", explicit: true }
      : ctx.config.engine === "acp"
      ? { engine: "acp", explicit: true }
      : { engine: "acp", explicit: false },
}));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    ensureAdapterExecutionTargetCommandResolvable,
    ensureAdapterExecutionTargetRuntimeCommandInstalled,
    resolveAdapterExecutionTargetCommandForLogs,
    runAdapterExecutionTargetProcess,
  };
});

describe("claude_local static routing delivery", () => {
  let root: string;
  let nativeHome: string;
  let instructions: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-static-"));
    nativeHome = path.join(root, "native-profile");
    instructions = path.join(root, "ROLE.md");
    await fs.mkdir(nativeHome);
    await fs.writeFile(instructions, "Synthetic explicit role instruction.");
    await fs.writeFile(path.join(nativeHome, "settings.json"), '{"permissions":{"defaultMode":"plan"}}');
    vi.stubEnv("PAPERCLIP_HOME", path.join(root, "paperclip"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  });
  const context = (config: Record<string, unknown> = {}) => buildContext({
    engine: "cli",
    intelligentRoutingDeliveryMode: "static_native",
    cwd: root,
    command: "synthetic-claude",
    model: "synthetic-model",
    effort: "high",
    dangerouslySkipPermissions: false,
    instructionsFilePath: instructions,
    env: { CLAUDE_CONFIG_DIR: nativeHome },
    ...config,
  });

  it("seals native customisations while preserving exact model, effort, OAuth profile and explicit instructions", async () => {
    const before = await fs.readFile(path.join(nativeHome, "settings.json"), "utf8");
    await execute(context() as never);
    const call = runAdapterExecutionTargetProcess.mock.calls[0] as unknown as [
      string, unknown, string, string[], { env: Record<string, string> },
    ];
    const args = call[3];
    expect(executeClaudeAcp).not.toHaveBeenCalled();
    expect(args).toEqual(expect.arrayContaining([
      "--safe-mode", "--disable-slash-commands", "--no-chrome", "--strict-mcp-config",
    ]));
    expect(args).not.toContain("--bare");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args[args.indexOf("--model") + 1]).toBe("synthetic-model");
    expect(args[args.indexOf("--effort") + 1]).toBe("high");
    expect(call[4].env.CLAUDE_CONFIG_DIR).toBe(nativeHome);
    const mcpPath = args[args.indexOf("--mcp-config") + 1]!;
    expect(JSON.parse(await fs.readFile(mcpPath, "utf8"))).toEqual({ mcpServers: {} });
    const instructionPath = args[args.indexOf("--append-system-prompt-file") + 1]!;
    expect(await fs.readFile(instructionPath, "utf8")).toContain("Synthetic explicit role instruction.");
    expect(await fs.readFile(path.join(nativeHome, "settings.json"), "utf8")).toBe(before);
    expect(await fs.readdir(nativeHome)).toEqual(["settings.json"]);
  });
  it.each([
    { engine: "acp" },
    { extraArgs: ["--plugin-dir", "/synthetic-plugin"] },
    { args: ["--fallback-model", "another-model"] },
    { chrome: true },
  ])("refuses a static-mode override before preparation: %j", async (config) => {
    await expect(execute(context(config) as never)).rejects.toMatchObject({ code: "intelligent_routing_dynamic_delivery_denied" });
    expect(executeClaudeAcp).not.toHaveBeenCalled();
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
  it("refuses connector injection instead of silently changing the qualified tools", async () => {
    const ctx = { ...context(), runtimeMcp: { getServers: () => [{ name: "synthetic-connector" }] } };
    await expect(execute(ctx as never)).rejects.toMatchObject({ code: "intelligent_routing_dynamic_delivery_denied" });
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
  it("fails closed when an explicit instruction file disappears after qualification", async () => {
    await fs.unlink(instructions);
    await expect(execute(context() as never)).rejects.toMatchObject({ code: "intelligent_routing_instructions_unavailable" });
    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});

import { execute } from "./execute.js";

function buildContext(config: Record<string, unknown> = {}) {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Coder",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config,
    context: {},
    onLog: vi.fn(async () => {}),
  };
}

describe("claude_local ACP startup fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to Claude CLI when auto-selected ACP fails before execution starts", async () => {
    const ctx = buildContext();

    const result = await execute(ctx as never);

    expect(result.exitCode).toBe(0);
    expect(executeClaudeAcp).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("Claude ACP startup failed"),
    );
    expect(ctx.onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining('Unexpected "<<"'),
    );
  });

  it("trusts the Paperclip API URL when network access is allowlisted", async () => {
    const paperclipApiUrl = "http://127.0.0.1:4310";
    vi.stubEnv("PAPERCLIP_API_URL", paperclipApiUrl);
    const ctx = buildContext({ networkScope: "allowlist" });

    await execute(ctx as never);

    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledTimes(1);
    expect(runAdapterExecutionTargetProcess).toHaveBeenCalledWith(
      expect.any(String),
      null,
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({
        localProcessSandbox: expect.objectContaining({
          networkScope: "allowlist",
          networkTrustedUrls: [paperclipApiUrl],
        }),
      }),
    );
  });

  it("keeps explicit ACP strict when startup fails", async () => {
    const ctx = buildContext({ engine: "acp" });

    await expect(execute(ctx as never)).rejects.toThrow('Unexpected "<<"');

    expect(runAdapterExecutionTargetProcess).not.toHaveBeenCalled();
  });
});
