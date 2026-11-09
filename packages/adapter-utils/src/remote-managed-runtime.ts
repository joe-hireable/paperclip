import path from "node:path";
import { GIT_ARCHIVE_EXCLUDES, PROJECT_REPOSITORIES_DIR } from "./git-workspace-sync.js";
import {
  type SshRemoteExecutionSpec,
  prepareWorkspaceForSshExecution,
  runSshCommand,
  restoreWorkspaceFromSshExecution,
  syncDirectoryToSsh,
  validateExistingRemoteWorkspace,
  type WorkspaceTransferLimits,
} from "./ssh.js";
import {
  mergeExcludes,
  referencedSourceIgnoreExcludeEntries,
  type SandboxAdditionalSource,
  type SandboxManagedRuntimeAssetRestoreContext,
} from "./sandbox-managed-runtime.js";
import { captureDirectorySnapshot, WorkspaceOperationAbortedError, type DirectorySnapshot } from "./workspace-restore-merge.js";
import type { RuntimeProgressSink } from "./runtime-progress.js";

// The fixed heavy-directory excludes every referenced project drops,
// regardless of its ignore resolution. A `git`-resolved project additionally
// drops its own resolved ignored paths (see `referencedSourceIgnoreExcludeEntries`
// and the per-project merge below); an `other` project keeps only this set.
const REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES = [
  "node_modules",
  "vendor",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".cache",
  ".git",
].flatMap((entry) => [entry, `${entry}/*`, `*/${entry}`, `*/${entry}/*`]);

export interface RemoteManagedRuntimeAsset {
  key: string;
  localDir: string;
  followSymlinks?: boolean;
  exclude?: string[];
  restore?: (ctx: SandboxManagedRuntimeAssetRestoreContext) => Promise<void>;
}

export interface PreparedRemoteManagedRuntime {
  spec: SshRemoteExecutionSpec;
  workspaceLocalDir: string;
  workspaceRemoteDir: string;
  runtimeRootDir: string;
  assetDirs: Record<string, string>;
  /**
   * Remote directory of each additional (referenced) project that staged
   * successfully, keyed by `projectId`. A project whose staging failed is
   * absent (per-project failure isolation).
   */
  additionalSourceDirs: Record<string, string>;
  restoreWorkspace(onProgress?: RuntimeProgressSink): Promise<void>;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asNumber(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

const REMOTE_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function absolutePosixDir(value: string): string | null {
  if (!value.startsWith("/") || value.includes("\0")) return null;
  const trimmed = value.length > 1 ? value.replace(/\/+$/, "") : value;
  if (path.posix.normalize(trimmed) !== trimmed) return null;
  if (trimmed.split("/").includes("..")) return null;
  return trimmed;
}

function remotePerRunDir(baseWorkspaceRemoteDir: string, runId: string): string | null {
  if (!REMOTE_RUN_ID_PATTERN.test(runId)) return null;
  const base = absolutePosixDir(baseWorkspaceRemoteDir);
  if (!base) return null;
  const runDir = `${base}/.paperclip-runtime/runs/${runId}`;
  return runDir.endsWith(`/.paperclip-runtime/runs/${runId}`) ? runDir : null;
}

function stagedAuthPath(assetDir: string): string | null {
  const dir = absolutePosixDir(assetDir);
  if (!dir || !dir.includes("/.paperclip-runtime/")) return null;
  const authPath = `${dir}/auth.json`;
  return authPath.endsWith("/auth.json") ? authPath : null;
}

async function removeOwnedRunStaging(spec: SshRemoteExecutionSpec, runDir: string): Promise<void> {
  const runId = path.posix.basename(runDir);
  const parent = path.posix.dirname(runDir);
  if (!REMOTE_RUN_ID_PATTERN.test(runId) || !parent.endsWith("/.paperclip-runtime/runs")) {
    throw new Error("Remote run staging cleanup refused an unowned path.");
  }
  // No trailing slash: GNU rm -rf on a symlink with a slash follows it and
  // would delete the target. The remote checks refuse a symlink outright.
  const script = [
    "set -e",
    `parent=${shellQuote(parent)}`,
    `run_id=${shellQuote(runId)}`,
    `run_dir=${shellQuote(runDir)}`,
    'case "$run_id" in',
    '  ""|-*|*[!A-Za-z0-9_-]*) echo "refused run id" >&2; exit 2 ;;',
    "esac",
    'case "$parent" in',
    '  */.paperclip-runtime/runs) ;;',
    '  *) echo "refused parent" >&2; exit 2 ;;',
    "esac",
    '[ "$parent/$run_id" = "$run_dir" ] || { echo "refused path" >&2; exit 2; }',
    'if [ ! -d "$parent" ]; then exit 0; fi',
    'if [ -L "$parent" ] || [ -L "$parent/$run_id" ]; then echo "refused symlink" >&2; exit 3; fi',
    'if [ ! -e "$parent/$run_id" ]; then exit 0; fi',
    'canonical_parent=$(cd -- "$parent" && pwd -P)',
    'case "$canonical_parent" in',
    '  */.paperclip-runtime/runs) ;;',
    '  *) echo "refused canonical parent" >&2; exit 2 ;;',
    "esac",
    'rm -rf -- "$canonical_parent/$run_id"',
  ].join("\n");
  try {
    await runSshCommand(spec, script, { timeoutMs: 30_000 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Remote run staging cleanup failed: ${message}`, { cause: error });
  }
}

async function bestEffortRemoteRemove(
  spec: SshRemoteExecutionSpec,
  remotePath: string,
  onProgress?: RuntimeProgressSink,
): Promise<void> {
  try {
    await runSshCommand(spec, `rm -rf -- ${shellQuote(remotePath)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const line = `[paperclip] Remote runtime cleanup failed for ${remotePath}: ${message}\n`;
    console.warn(line.trim());
    try {
      await onProgress?.(line);
    } catch {
      // A log sink failure must not turn cleanup into a run failure.
    }
  }
}

async function readRemoteFile(spec: SshRemoteExecutionSpec, remotePath: string): Promise<Buffer> {
  const result = await runSshCommand(spec, `base64 < ${shellQuote(remotePath)}`, {
    maxBuffer: 1024 * 1024,
  });
  return Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
}

export function buildRemoteExecutionSessionIdentity(spec: SshRemoteExecutionSpec | null) {
  if (!spec) return null;
  return {
    transport: "ssh",
    host: spec.host,
    port: spec.port,
    username: spec.username,
    remoteCwd: spec.remoteCwd,
  } as const;
}

export function remoteExecutionSessionMatches(saved: unknown, current: SshRemoteExecutionSpec | null): boolean {
  const currentIdentity = buildRemoteExecutionSessionIdentity(current);
  if (!currentIdentity) return false;

  const parsedSaved = asObject(saved);
  return (
    asString(parsedSaved.transport) === currentIdentity.transport &&
    asString(parsedSaved.host) === currentIdentity.host &&
    asNumber(parsedSaved.port) === currentIdentity.port &&
    asString(parsedSaved.username) === currentIdentity.username &&
    asString(parsedSaved.remoteCwd) === currentIdentity.remoteCwd
  );
}

export async function prepareRemoteManagedRuntime(input: {
  spec: SshRemoteExecutionSpec;
  runId: string;
  adapterKey: string;
  workspaceLocalDir: string;
  workspaceRemoteDir?: string;
  syncWorkspace?: boolean;
  workspaceFileMode?: "all";
  workspaceExclude?: string[];
  assets?: RemoteManagedRuntimeAsset[];
  /** Referenced (additional) projects to stage as plain, read-only trees. */
  additionalSources?: SandboxAdditionalSource[];
  // Upload progress sink. Threaded for the byte-counting transport rewrite; the
  // child task wires it into the workspace/asset transfers.
  onProgress?: RuntimeProgressSink;
  signal?: AbortSignal;
  transferLimits?: WorkspaceTransferLimits;
  /**
   * Attach this existing remote directory instead of uploading the controller
   * tree. A missing or invalid path fails before any transfer.
   */
  attachExistingRemoteCwd?: { remoteCwd: string; allowedRoot: string } | null;
}): Promise<PreparedRemoteManagedRuntime> {
  if (input.signal?.aborted) throw new WorkspaceOperationAbortedError();
  const baseWorkspaceRemoteDir = input.workspaceRemoteDir ?? input.spec.remoteCwd;
  let syncWorkspace = input.syncWorkspace !== false;
  let attachedRoot: string | null = null;
  if (input.attachExistingRemoteCwd) {
    attachedRoot = await validateExistingRemoteWorkspace({
      spec: input.spec,
      remoteCwd: input.attachExistingRemoteCwd.remoteCwd,
      allowedRoot: input.attachExistingRemoteCwd.allowedRoot,
      signal: input.signal,
    });
    syncWorkspace = false;
  }
  const workspaceRemoteDir = attachedRoot ?? (syncWorkspace
    ? path.posix.join(
        baseWorkspaceRemoteDir,
        ".paperclip-runtime",
        "runs",
        input.runId,
        "workspace",
      )
    : baseWorkspaceRemoteDir);
  const runtimeRootDir = path.posix.join(workspaceRemoteDir, ".paperclip-runtime", input.adapterKey);
  const ownedRunDir = syncWorkspace ? remotePerRunDir(baseWorkspaceRemoteDir, input.runId) : null;

  try {
  const preparedWorkspace = syncWorkspace
    ? await prepareWorkspaceForSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        onProgress: input.onProgress,
        workspaceFileMode: input.workspaceFileMode,
        workspaceExclude: input.workspaceExclude,
        signal: input.signal,
        transferLimits: input.transferLimits,
      })
    : null;
  const projectRepositories = preparedWorkspace?.repositories ?? [];
  const baselineSnapshot = preparedWorkspace
    ? await captureDirectorySnapshot(input.workspaceLocalDir, {
        exclude: preparedWorkspace.transferExcludes ?? (
          preparedWorkspace.gitBacked
            ? [
                ...GIT_ARCHIVE_EXCLUDES,
                ".paperclip-runtime",
                ...(projectRepositories.length > 0 ? [PROJECT_REPOSITORIES_DIR] : preparedWorkspace.excludedPaths ?? []),
              ]
            : [".paperclip-runtime", ...(preparedWorkspace.excludedPaths ?? []), ...(input.workspaceFileMode === "all" ? input.workspaceExclude ?? [] : [])]
        ),
        signal: input.signal,
      })
    : null;
  const repositoryBaselines: Array<{ path: string; baselineSnapshot: DirectorySnapshot }> = [];
  for (const repository of projectRepositories) {
    repositoryBaselines.push({
      path: repository,
      baselineSnapshot: await captureDirectorySnapshot(path.join(input.workspaceLocalDir, repository), {
        exclude: [...GIT_ARCHIVE_EXCLUDES, ".paperclip-runtime"],
      }),
    });
  }

  const assetDirs: Record<string, string> = {};
  try {
    for (const asset of input.assets ?? []) {
      const remoteDir = path.posix.join(runtimeRootDir, asset.key);
      assetDirs[asset.key] = remoteDir;
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: asset.localDir,
        remoteDir,
        followSymlinks: asset.followSymlinks,
        exclude: asset.exclude,
        onProgress: input.onProgress,
        progressLabel: asset.key,
        signal: input.signal,
      });
    }
  } catch (error) {
    if (preparedWorkspace && baselineSnapshot) {
      await restoreWorkspaceFromSshExecution({
        spec: input.spec,
        localDir: input.workspaceLocalDir,
        remoteDir: workspaceRemoteDir,
        baselineSnapshot,
        restoreGitHistory: preparedWorkspace.gitBacked,
        onProgress: input.onProgress,
        repositories: repositoryBaselines,
        signal: input.signal,
      });
    }
    throw error;
  }

  // Stage each referenced (additional) project as a plain, read-only tree in its
  // OWN isolated remote directory (`project-<projectId>`). Additional sources
  // never get the anchor's git-history/overlay semantics. Per-project failure
  // isolation: one project's failure logs a warning and is skipped; the run and
  // the other projects continue (no workspace restore, unlike an asset failure).
  const additionalSourceDirs: Record<string, string> = {};
  for (const source of input.additionalSources ?? []) {
    const { localPath, projectId, ignoreResolution } = source;
    try {
      if (!path.posix.isAbsolute(localPath)) {
        throw new Error(`additional source localPath is not an absolute path: ${localPath}`);
      }
      if (
        projectId.length === 0 ||
        projectId.includes("/") ||
        projectId.includes("\\") ||
        projectId.includes("..")
      ) {
        throw new Error(`additional source projectId is not a simple path segment: ${projectId}`);
      }
      // Fail closed: a project whose ignore resolution failed is not staged at
      // all — the existing per-project skip-and-warn path below handles it.
      if (ignoreResolution.kind === "failed") {
        throw new Error(`referenced project ignore resolution failed: ${ignoreResolution.reason}`);
      }
      const remoteDir = path.posix.join(runtimeRootDir, `project-${projectId}`);
      const exclude = mergeExcludes(
        REMOTE_ADDITIONAL_SOURCE_HEAVY_DIR_EXCLUDES,
        referencedSourceIgnoreExcludeEntries(ignoreResolution),
      );
      await syncDirectoryToSsh({
        spec: input.spec,
        localDir: localPath,
        remoteDir,
        exclude,
        onProgress: input.onProgress,
        progressLabel: `project-${projectId}`,
        signal: input.signal,
      });
      additionalSourceDirs[projectId] = remoteDir;
    } catch (error) {
      if (error instanceof WorkspaceOperationAbortedError) throw error;
      console.warn(
        `[paperclip] Failed to stage referenced project ${projectId}; skipping it. ${String(error)}`,
      );
    }
  }

  return {
    spec: input.spec,
    workspaceLocalDir: input.workspaceLocalDir,
    workspaceRemoteDir,
    runtimeRootDir,
    assetDirs,
    additionalSourceDirs,
    restoreWorkspace: async (onProgress?: RuntimeProgressSink) => {
      // Copy workspace edits and refreshed credentials back before removing
      // the remote run directory. Cleanup is best-effort: a failed `rm` is
      // logged and does not change the run result. A failed restore still
      // removes staged auth.json files, and leaves the run directory in place
      // so the workspace copy is not discarded before the error is reported.
      let restoreError: unknown = null;
      try {
        if (preparedWorkspace && baselineSnapshot) {
          await restoreWorkspaceFromSshExecution({
            spec: input.spec,
            localDir: input.workspaceLocalDir,
            remoteDir: workspaceRemoteDir,
            baselineSnapshot,
            restoreGitHistory: preparedWorkspace.gitBacked,
            onProgress,
            repositories: repositoryBaselines,
            signal: input.signal,
          });
        }
        for (const asset of input.assets ?? []) {
          if (!asset.restore) continue;
          await asset.restore({
            assetDir: path.posix.join(runtimeRootDir, asset.key),
            readFile: (remotePath) => readRemoteFile(input.spec, remotePath),
          });
        }
      } catch (error) {
        restoreError = error;
      }

      const runDir = syncWorkspace ? remotePerRunDir(baseWorkspaceRemoteDir, input.runId) : null;
      if (!restoreError && runDir) {
        await bestEffortRemoteRemove(input.spec, runDir, onProgress);
      } else {
        for (const assetDir of Object.values(assetDirs)) {
          const authPath = stagedAuthPath(assetDir);
          if (!authPath) continue;
          await bestEffortRemoteRemove(input.spec, authPath, onProgress);
        }
      }

      if (restoreError) throw restoreError;
    },
  };
  } catch (error) {
    if (error instanceof WorkspaceOperationAbortedError && ownedRunDir) {
      await removeOwnedRunStaging(input.spec, ownedRunDir);
    }
    throw error;
  }
}
