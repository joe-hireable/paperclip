import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertStaticIntelligentRoutingDelivery,
  collectIntelligentRoutingRuntimeFingerprint,
  type IntelligentRoutingRuntimeFingerprintInput,
  type StaticIntelligentRoutingDeliveryInput,
} from "./intelligent-routing-runtime.js";

let directory: string;
let input: IntelligentRoutingRuntimeFingerprintInput;
let delivery: StaticIntelligentRoutingDeliveryInput;
let cwd: string;
let otherCwd: string;
let nativeHome: string;
let launcher: string;
let runtime: string;
let instructions: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(tmpdir(), "paperclip-runtime-fingerprint-"),
  );
  cwd = path.join(directory, "cwd");
  otherCwd = path.join(directory, "other-cwd");
  nativeHome = path.join(directory, "native");
  launcher = path.join(directory, "launcher");
  runtime = path.join(directory, "runtime");
  instructions = path.join(directory, "ROLE.md");
  await Promise.all([cwd, otherCwd, nativeHome].map((dir) => fs.mkdir(dir)));
  await fs.writeFile(launcher, "synthetic launcher source", { mode: 0o755 });
  await fs.writeFile(runtime, "synthetic installed CLI artefact", {
    mode: 0o755,
  });
  await fs.writeFile(instructions, "Synthetic role instructions");
  input = {
    adapterConfig: { cwd, instructionsFilePath: instructions },
    binding: {
      adapterType: "codex_local",
      command: launcher,
      nativeProfileHome: nativeHome,
    },
    runtimeFilePaths: [runtime],
  };
  delivery = {
    adapterType: "codex_local",
    qualifiedCwd: cwd,
    config: { cwd, paperclipRuntimeSkills: [] },
    context: { paperclipWorkspace: { cwd, source: "project" } },
    executionTarget: { kind: "local" },
    runtimeToolsPresent: false,
    runtimeMcpServerCount: 0,
    managedMcpPresent: false,
  };
});
afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});
const fingerprint = () => collectIntelligentRoutingRuntimeFingerprint(input);

describe("bounded runtime material qualification", () => {
  it("returns only a stable digest of explicit material, not contents or private paths", async () => {
    const first = await fingerprint();
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(first).not.toContain(directory);
    expect(await fingerprint()).toBe(first);
    await fs.writeFile(instructions, "Synthetic role instructions");
    expect(await fingerprint()).toBe(first);
  });
  it.each(["launcher", "runtime", "instructions"] as const)(
    "invalidates qualification when %s content changes in place",
    async (kind) => {
      const first = await fingerprint();
      await fs.writeFile(
        kind === "launcher"
          ? launcher
          : kind === "runtime"
            ? runtime
            : instructions,
        "Changed synthetic material",
      );
      expect(await fingerprint()).not.toBe(first);
    },
  );
  it("pins actual runtime artifacts separately from a stable launcher wrapper", async () => {
    const secondRuntime = path.join(directory, "interpreter");
    await fs.writeFile(secondRuntime, "Synthetic interpreter", { mode: 0o755 });
    input.runtimeFilePaths = [runtime, secondRuntime];
    const first = await fingerprint();
    input.runtimeFilePaths = [secondRuntime, runtime, runtime];
    expect(await fingerprint()).toBe(first);
    await fs.writeFile(secondRuntime, "Changed interpreter");
    expect(await fingerprint()).not.toBe(first);
  });
  it.each([undefined, [], Array(9).fill("/synthetic/runtime")])(
    "refuses absent or unbounded explicit runtime artifact inventories",
    async (paths) => {
      input.runtimeFilePaths = paths;
      await expect(fingerprint()).rejects.toMatchObject({
        code: "intelligent_routing_runtime_artifacts_required",
      });
    },
  );
  it("streams runtime artifacts larger than the config limit", async () => {
    await fs.writeFile(runtime, Buffer.alloc(2 * 1024 * 1024, 0x61));
    expect(await fingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects oversized launcher/config files and sparse oversized runtime files before reading them", async () => {
    await fs.writeFile(launcher, Buffer.alloc(1024 * 1024 + 1));
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_file_limit",
    });
    await fs.writeFile(launcher, "synthetic launcher");
    const handle = await fs.open(runtime, "w");
    try {
      await handle.truncate(512 * 1024 * 1024 + 1);
    } finally {
      await handle.close();
    }
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_file_limit",
    });
  });
  it("missing explicit instructions cannot silently become a qualified instruction-free run", async () => {
    await fs.unlink(instructions);
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_material_missing",
    });
  });
  it("pins approved instruction-root entries including the later addition of another approved file", async () => {
    const root = path.join(directory, "role");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "AGENTS.md"), "Root instructions");
    input.adapterConfig = {
      cwd,
      instructionsRootPath: root,
      instructionsEntryFile: "AGENTS.md",
    };
    const first = await fingerprint();
    await fs.writeFile(path.join(root, "ROLE.md"), "Additional role material");
    expect(await fingerprint()).not.toBe(first);
    input.adapterConfig.instructionsEntryFile = "../../auth.json";
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_instruction_entry_unsupported",
    });
  });
  it("refuses an instruction root with no approved entry", async () => {
    input.adapterConfig = { cwd, instructionsRootPath: otherCwd };
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_instructions_missing",
    });
  });
  it.each([
    ["codex_local", "config.toml"],
    ["codex_local", "AGENTS.md"],
    ["claude_local", "settings.json"],
    ["claude_local", "CLAUDE.md"],
    ["claude_local", ".mcp.json"],
  ] as const)(
    "pins missing/present/content states for %s native %s",
    async (harness, file) => {
      input.binding.adapterType = harness;
      const missing = await fingerprint();
      await fs.writeFile(
        path.join(nativeHome, file),
        "Synthetic native configuration",
      );
      const present = await fingerprint();
      expect(present).not.toBe(missing);
      await fs.writeFile(
        path.join(nativeHome, file),
        "Changed native configuration",
      );
      expect(await fingerprint()).not.toBe(present);
      await fs.unlink(path.join(nativeHome, file));
      expect(await fingerprint()).toBe(missing);
    },
  );
  it.each(["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "CLAUDE.local.md", ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml", ".mcp.json"])(
    "pins cwd-native instructions/config %s",
    async (file) => {
      const first = await fingerprint();
      await fs.mkdir(path.dirname(path.join(cwd, file)), { recursive: true });
      await fs.writeFile(path.join(cwd, file), "New project runtime material");
      expect(await fingerprint()).not.toBe(first);
    },
  );
  it("does not read native auth files and refuses explicit credential-file inventories", async () => {
    const first = await fingerprint();
    // A dangling auth link makes an accidental auth read fail; it is deliberately outside the allowlist.
    const auth = path.join(nativeHome, "auth.json");
    await fs.symlink(path.join(directory, "never-present-secret"), auth);
    expect(await fingerprint()).toBe(first);
    input.runtimeFilePaths = [auth];
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_credential_file_denied",
    });
  });
  it.each([".credentials.json", ".auth.json", "application_default_credentials.json", "credentials.db", ".netrc"])(
    "refuses the credential filename %s before reading a caller-declared runtime artefact",
    async (name) => {
      const file = path.join(directory, name);
      // A missing target proves the name is refused before any file read.
      input.runtimeFilePaths = [file];
      await expect(fingerprint()).rejects.toMatchObject({
        code: "intelligent_routing_runtime_credential_file_denied",
      });
    },
  );
  it("does not qualify Codex static delivery while native autoload cannot be sealed", async () => {
    input.adapterConfig.intelligentRoutingDeliveryMode = "static_native";
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_static_harness_unqualified",
    });
    input.binding.adapterType = "claude_local";
    await expect(fingerprint()).resolves.toMatch(/^[a-f0-9]{64}$/);
  });
  it("rejects symlinked launchers, parent directories and optional config paths", async () => {
    await fs.rename(launcher, `${launcher}-real`);
    await fs.symlink(`${launcher}-real`, launcher);
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_symlink",
    });
    await fs.unlink(launcher);
    await fs.rename(`${launcher}-real`, launcher);
    const alias = path.join(directory, "alias");
    await fs.symlink(nativeHome, alias);
    input.binding.nativeProfileHome = alias;
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_symlink",
    });
    input.binding.nativeProfileHome = nativeHome;
    await fs.symlink(
      path.join(directory, "missing"),
      path.join(nativeHome, "config.toml"),
    );
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_symlink",
    });
  });
  it("rejects directories and hardlinks supplied as concrete runtime artifacts", async () => {
    input.runtimeFilePaths = [otherCwd];
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_regular_file_required",
    });
    await fs.link(runtime, `${runtime}-linked`);
    input.runtimeFilePaths = [runtime];
    await expect(fingerprint()).rejects.toMatchObject({
      code: "intelligent_routing_runtime_regular_file_required",
    });
  });
  it("pins cwd identity but does not recursively ingest a repository's task data", async () => {
    const first = await fingerprint();
    await fs.writeFile(
      path.join(cwd, "ordinary-owned-task.txt"),
      "Synthetic user task data",
    );
    expect(await fingerprint()).toBe(first);
    await fs.rename(cwd, `${cwd}-old`);
    await fs.mkdir(cwd);
    expect(await fingerprint()).not.toBe(first);
  });
  it("never leaks a missing private path in its error message", async () => {
    input.runtimeFilePaths = [
      path.join(directory, "private-name-not-in-errors"),
    ];
    try {
      await fingerprint();
      throw new Error("Expected refusal");
    } catch (error) {
      expect(String(error)).not.toContain(directory);
      expect(error).toMatchObject({
        code: "intelligent_routing_runtime_material_missing",
      });
    }
  });
});

describe("static native delivery", () => {
  it.each(["codex_local", "claude_local"] as const)(
    "accepts a fixed local %s working directory without injected dynamic tools",
    async (adapterType) => {
      delivery.adapterType = adapterType;
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).resolves.toBeUndefined();
    },
  );
  it.each(["runtimeToolsPresent", "managedMcpPresent"] as const)(
    "denies %s even when config fields otherwise match",
    async (key) => {
      delivery[key] = true;
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).rejects.toMatchObject({
        code: "intelligent_routing_runtime_dynamic_delivery_denied",
      });
    },
  );
  it.each([1, -1, Number.NaN])(
    "denies nonzero or malformed MCP delivery counts",
    async (count) => {
      delivery.runtimeMcpServerCount = count;
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).rejects.toMatchObject({
        code: "intelligent_routing_runtime_dynamic_delivery_denied",
      });
    },
  );
  it.each([
    "paperclipRuntimeSkills",
    "paperclipManagedMcp",
    "paperclipRuntimeTools",
    "paperclipRuntimeMcp",
  ])(
    "denies actual delivery of %s through config or context",
    async (field) => {
      if (field === "paperclipRuntimeSkills")
        delivery.config[field] = [{ key: "new-skill" }];
      else delivery.context[field] = { enabled: true };
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).rejects.toMatchObject({
        code: "intelligent_routing_runtime_dynamic_delivery_denied",
      });
    },
  );
  it.each(["ssh", "sandbox", "cloud"])(
    "denies remote execution target %s",
    async (kind) => {
      delivery.executionTarget = { kind };
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).rejects.toMatchObject({
        code: "intelligent_routing_runtime_remote_denied",
      });
    },
  );
  it.each(["codex_local", "claude_local"] as const)(
    "checks actual context cwd instead of trusting unchanged %s config.cwd",
    async (adapterType) => {
      delivery.adapterType = adapterType;
      delivery.context.paperclipWorkspace = {
        cwd: otherCwd,
        source: "project",
      };
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).rejects.toMatchObject({
        code: "intelligent_routing_runtime_cwd_changed",
      });
    },
  );
  it.each(["codex_local", "claude_local"] as const)(
    "preserves configured cwd over agent-home hints for %s",
    async (adapterType) => {
      delivery.adapterType = adapterType;
      delivery.context.paperclipWorkspace = {
        cwd: otherCwd,
        source: "agent_home",
      };
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).resolves.toBeUndefined();
    },
  );
  it("follows Codex authoritative-root priority and refuses a changed realised root", async () => {
    delivery.executionTarget = {
      kind: "local",
      workspaceRealization: { mode: "in_place", authoritativeRoot: cwd },
    };
    delivery.context.paperclipWorkspace = { cwd: otherCwd, source: "project" };
    await expect(
      assertStaticIntelligentRoutingDelivery(delivery),
    ).resolves.toBeUndefined();
    delivery.executionTarget.workspaceRealization!.authoritativeRoot = otherCwd;
    await expect(
      assertStaticIntelligentRoutingDelivery(delivery),
    ).rejects.toMatchObject({
      code: "intelligent_routing_runtime_cwd_changed",
    });
  });
  it("does not incorrectly apply Codex's authoritative-root override to Claude's actual cwd", async () => {
    delivery.adapterType = "claude_local";
    delivery.executionTarget = {
      kind: "local",
      workspaceRealization: { mode: "in_place", authoritativeRoot: cwd },
    };
    delivery.context.paperclipWorkspace = { cwd: otherCwd, source: "project" };
    await expect(
      assertStaticIntelligentRoutingDelivery(delivery),
    ).rejects.toMatchObject({
      code: "intelligent_routing_runtime_cwd_changed",
    });
  });
  it.each(["codex_local", "claude_local"] as const)(
    "accepts unchanged local copy metadata while guarding the actual %s cwd",
    async (adapterType) => {
      delivery.adapterType = adapterType;
      delivery.executionTarget = {
        kind: "local",
        workspaceRealization: { mode: "copy", authoritativeRoot: otherCwd },
      };
      delivery.context.paperclipWorkspace = {
        cwd: otherCwd,
        source: "agent_home",
      };
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).resolves.toBeUndefined();
      delivery.context.paperclipWorkspace = {
        cwd: otherCwd,
        source: "project",
      };
      await expect(
        assertStaticIntelligentRoutingDelivery(delivery),
      ).rejects.toMatchObject({
        code: "intelligent_routing_runtime_cwd_changed",
      });
    },
  );
  it("rejects unknown workspace realisation modes", async () => {
    delivery.executionTarget = {
      kind: "local",
      workspaceRealization: {
        mode: "unqualified_mode",
        authoritativeRoot: cwd,
      },
    };
    await expect(
      assertStaticIntelligentRoutingDelivery(delivery),
    ).rejects.toMatchObject({
      code: "intelligent_routing_runtime_workspace_mode_denied",
    });
  });
  it("rejects a symlinked effective cwd", async () => {
    delivery.executionTarget = { kind: "local" };
    const alias = path.join(directory, "cwd-alias");
    await fs.symlink(cwd, alias);
    delivery.context.paperclipWorkspace = { cwd: alias, source: "project" };
    await expect(
      assertStaticIntelligentRoutingDelivery(delivery),
    ).rejects.toMatchObject({ code: "intelligent_routing_runtime_symlink" });
  });
});
