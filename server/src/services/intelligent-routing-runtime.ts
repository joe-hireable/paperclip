import { createHash } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExecutionBinding } from "@paperclipai/shared/execution-bindings";
import { HttpError } from "../errors.js";

const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_RUNTIME_BYTES = 512 * 1024 * 1024;
const MAX_RUNTIME_FILES = 8;
const CHUNK_BYTES = 64 * 1024;
const APPROVED_ROOT_ENTRIES = ["AGENTS.md", "ROLE.md"] as const;

export class IntelligentRoutingRuntimeError extends HttpError {
  constructor(readonly code: string) {
    super(409, `Intelligent routing runtime: ${code}`, { code });
  }
}
function deny(code: string): never {
  throw new IntelligentRoutingRuntimeError(code);
}
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function missing(error: unknown): boolean {
  return object(error).code === "ENOENT";
}
function canonicalAbsolute(value: unknown): string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.resolve(value) !== value ||
    value.includes("\0")
  ) {
    deny("intelligent_routing_runtime_path_invalid");
  }
  return value;
}

// No recursive directory discovery, provider commands, auth files or network calls.
// Every returned value is a digest; source contents never leave this helper.
async function pathIdentity(value: string, optional: boolean) {
  const absolute = canonicalAbsolute(value);
  const root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]!);
    let info;
    try {
      info = await fs.lstat(current);
    } catch (error) {
      if (missing(error) && optional) return null;
      throw error;
    }
    if (info.isSymbolicLink()) deny("intelligent_routing_runtime_symlink");
    if (index < parts.length - 1 && !info.isDirectory())
      deny("intelligent_routing_runtime_path_invalid");
  }
  if ((await fs.realpath(absolute)) !== absolute)
    deny("intelligent_routing_runtime_path_invalid");
  return fs.lstat(absolute);
}
async function directoryIdentity(value: string) {
  const info = await pathIdentity(value, false);
  if (!info?.isDirectory())
    deny("intelligent_routing_runtime_directory_invalid");
  return { path: value, device: String(info.dev), inode: String(info.ino) };
}
function denyCredentialFile(value: string) {
  if (
    /^(?:\.?auth(?:\..*)?|\.?credentials?(?:\..*)?|\.?tokens?(?:\..*)?|application_default_credentials\.json|\.?netrc|\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa)|.*\.(?:pem|p12|pfx|key))$/iu.test(
      path.basename(value),
    )
  ) {
    deny("intelligent_routing_runtime_credential_file_denied");
  }
}
interface MaterialFingerprint {
  label: string;
  path: string;
  sha256: string | null;
  mode: number | null;
}
async function fingerprintFile(
  label: string,
  value: string,
  optional: boolean,
  maxBytes: number,
): Promise<MaterialFingerprint> {
  const absolute = canonicalAbsolute(value);
  denyCredentialFile(absolute);
  const namedBefore = await pathIdentity(absolute, optional);
  if (!namedBefore) return { label, path: absolute, sha256: null, mode: null };
  if (!namedBefore.isFile() || namedBefore.nlink !== 1)
    deny("intelligent_routing_runtime_regular_file_required");
  if (namedBefore.size > maxBytes)
    deny("intelligent_routing_runtime_file_limit");
  const file = await fs.open(
    absolute,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await file.stat();
    if (
      before.dev !== namedBefore.dev ||
      before.ino !== namedBefore.ino ||
      !before.isFile() ||
      before.nlink !== 1 ||
      before.size > maxBytes
    ) {
      deny("intelligent_routing_runtime_material_changed");
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let total = 0;
    while (true) {
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) deny("intelligent_routing_runtime_file_limit");
      hash.update(chunk.subarray(0, bytesRead));
    }
    const after = await file.stat();
    const namedAfter = await pathIdentity(absolute, false);
    if (
      !namedAfter ||
      after.dev !== namedAfter.dev ||
      after.ino !== namedAfter.ino ||
      after.nlink !== 1 ||
      before.size !== after.size ||
      total !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      deny("intelligent_routing_runtime_material_changed");
    }
    return {
      label,
      path: absolute,
      sha256: hash.digest("hex"),
      mode: after.mode & 0o777,
    };
  } finally {
    await file.close();
  }
}

export interface IntelligentRoutingRuntimeFingerprintInput {
  adapterConfig: Record<string, unknown>;
  binding: Pick<
    ExecutionBinding,
    "adapterType" | "command" | "nativeProfileHome"
  >;
  runtimeFilePaths?: readonly string[];
}

export async function collectIntelligentRoutingRuntimeFingerprint(
  input: IntelligentRoutingRuntimeFingerprintInput,
): Promise<string> {
  try {
    // Native Codex config merges empty MCP tables and has no qualified public
    // equivalent of Claude's safe mode. Legacy explicit bindings are unchanged.
    if (
      input.adapterConfig.intelligentRoutingDeliveryMode === "static_native" &&
      input.binding.adapterType === "codex_local"
    )
      deny("intelligent_routing_runtime_static_harness_unqualified");
    if (
      !input.runtimeFilePaths?.length ||
      input.runtimeFilePaths.length > MAX_RUNTIME_FILES
    )
      deny("intelligent_routing_runtime_artifacts_required");
    if (!["codex_local", "claude_local"].includes(input.binding.adapterType))
      deny("intelligent_routing_runtime_harness_unsupported");
    const cwd = await directoryIdentity(
      canonicalAbsolute(input.adapterConfig.cwd),
    );
    const nativeHome = await directoryIdentity(
      canonicalAbsolute(input.binding.nativeProfileHome),
    );
    const materials: MaterialFingerprint[] = [];
    materials.push(
      await fingerprintFile(
        "launcher",
        input.binding.command,
        false,
        MAX_CONFIG_BYTES,
      ),
    );
    for (const runtimeFile of [...new Set(input.runtimeFilePaths)].sort()) {
      materials.push(
        await fingerprintFile("runtime", runtimeFile, false, MAX_RUNTIME_BYTES),
      );
    }
    const instructionsFile = input.adapterConfig.instructionsFilePath;
    if (instructionsFile !== undefined && instructionsFile !== null) {
      materials.push(
        await fingerprintFile(
          "instructions-file",
          canonicalAbsolute(instructionsFile),
          false,
          MAX_CONFIG_BYTES,
        ),
      );
    }
    const instructionsRoot = input.adapterConfig.instructionsRootPath;
    if (instructionsRoot !== undefined && instructionsRoot !== null) {
      const directory = canonicalAbsolute(instructionsRoot);
      await directoryIdentity(directory);
      const explicitEntry = input.adapterConfig.instructionsEntryFile;
      if (
        explicitEntry !== undefined &&
        !APPROVED_ROOT_ENTRIES.includes(
          explicitEntry as (typeof APPROVED_ROOT_ENTRIES)[number],
        )
      ) {
        deny("intelligent_routing_runtime_instruction_entry_unsupported");
      }
      const entries = await Promise.all(
        APPROVED_ROOT_ENTRIES.map((entry) =>
          fingerprintFile(
            `instructions-root:${entry}`,
            path.join(directory, entry),
            explicitEntry !== entry,
            MAX_CONFIG_BYTES,
          ),
        ),
      );
      if (!entries.some((entry) => entry.sha256 !== null))
        deny("intelligent_routing_runtime_instructions_missing");
      materials.push(...entries);
    } else if (input.adapterConfig.instructionsEntryFile !== undefined) {
      deny("intelligent_routing_runtime_instruction_entry_unsupported");
    }
    const nativeFiles =
      input.binding.adapterType === "codex_local"
        ? ["config.toml", "AGENTS.md"]
        : ["settings.json", "CLAUDE.md", ".mcp.json"];
    for (const file of nativeFiles)
      materials.push(
        await fingerprintFile(
          `native:${file}`,
          path.join(nativeHome.path, file),
          true,
          MAX_CONFIG_BYTES,
        ),
      );
    for (const file of [
      "AGENTS.md",
      "AGENTS.override.md",
      "CLAUDE.md",
      "CLAUDE.local.md",
      ".claude/settings.json",
      ".claude/settings.local.json",
      ".codex/config.toml",
      ".mcp.json",
    ]) {
      materials.push(
        await fingerprintFile(
          `cwd:${file}`,
          path.join(cwd.path, file),
          true,
          MAX_CONFIG_BYTES,
        ),
      );
    }
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          harness: input.binding.adapterType,
          cwd,
          nativeHome,
          materials,
        }),
      )
      .digest("hex");
  } catch (error) {
    if (error instanceof IntelligentRoutingRuntimeError) throw error;
    deny(
      missing(error)
        ? "intelligent_routing_runtime_material_missing"
        : "intelligent_routing_runtime_material_unreadable",
    );
  }
}

export interface StaticIntelligentRoutingDeliveryInput {
  adapterType: "codex_local" | "claude_local";
  qualifiedCwd: string;
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  executionTarget?: {
    kind: string;
    workspaceRealization?: { mode: string; authoritativeRoot: string } | null;
  } | null;
  runtimeToolsPresent: boolean;
  runtimeMcpServerCount: number;
  managedMcpPresent: boolean;
}
function hasDelivery(value: unknown) {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** This first delivery mode qualifies native CLI tools only, not changing skills or connectors. */
export async function assertStaticIntelligentRoutingDelivery(
  input: StaticIntelligentRoutingDeliveryInput,
): Promise<void> {
  try {
    if (!["codex_local", "claude_local"].includes(input.adapterType))
      deny("intelligent_routing_runtime_harness_unsupported");
    if (
      input.runtimeToolsPresent !== false ||
      input.managedMcpPresent !== false ||
      input.runtimeMcpServerCount !== 0 ||
      hasDelivery(input.config.paperclipRuntimeSkills) ||
      hasDelivery(input.context.paperclipManagedMcp) ||
      hasDelivery(input.context.paperclipRuntimeTools) ||
      hasDelivery(input.context.paperclipRuntimeMcp)
    ) {
      deny("intelligent_routing_runtime_dynamic_delivery_denied");
    }
    if (input.executionTarget && input.executionTarget.kind !== "local")
      deny("intelligent_routing_runtime_remote_denied");
    const qualified = await directoryIdentity(
      canonicalAbsolute(input.qualifiedCwd),
    );
    const configuredCwd = canonicalAbsolute(input.config.cwd);
    const workspace = object(input.context.paperclipWorkspace);
    const workspaceCwd = string(workspace.cwd);
    const useConfigured =
      workspace.source === "agent_home" && configuredCwd.length > 0;
    const realization = input.executionTarget?.workspaceRealization;
    if (realization && !["in_place", "copy"].includes(realization.mode))
      deny("intelligent_routing_runtime_workspace_mode_denied");
    if (
      realization?.mode === "in_place" &&
      canonicalAbsolute(realization.authoritativeRoot) !== qualified.path
    )
      deny("intelligent_routing_runtime_cwd_changed");
    // The local environment driver labels its unchanged workspace "copy".
    // Native adapters ignore authoritativeRoot for that mode; guard the cwd
    // they actually use, including the configured override of agent-home hints.
    const effectiveCwd =
      input.adapterType === "codex_local" && realization?.mode === "in_place"
        ? realization.authoritativeRoot
        : (!useConfigured && workspaceCwd) || configuredCwd;
    const actual = await directoryIdentity(canonicalAbsolute(effectiveCwd));
    if (
      configuredCwd !== qualified.path ||
      actual.path !== qualified.path ||
      actual.device !== qualified.device ||
      actual.inode !== qualified.inode
    ) {
      deny("intelligent_routing_runtime_cwd_changed");
    }
  } catch (error) {
    if (error instanceof IntelligentRoutingRuntimeError) throw error;
    deny(
      missing(error)
        ? "intelligent_routing_runtime_material_missing"
        : "intelligent_routing_runtime_material_unreadable",
    );
  }
}
