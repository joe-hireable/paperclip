import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareRemoteManagedRuntime } from "./remote-managed-runtime.js";
import {
  buildSshEnvLabFixtureConfig,
  getSshEnvLabSupport,
  prepareWorkspaceForSshExecution,
  startSshEnvLabFixture,
  stopSshEnvLabFixture,
  syncDirectoryToSsh,
  type SshEnvLabFixtureState,
  type SshRemoteExecutionSpec,
} from "./ssh.js";

const TEST_TIMEOUT_MS = 30_000;
let unsupportedReason: string | null = null;

interface FixtureEntry {
  rootDir: string;
  state: SshEnvLabFixtureState | null;
}

const teardowns: FixtureEntry[] = [];

async function createRoot(): Promise<string> {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "paperclip-ssh-bounds-"));
  teardowns.push({ rootDir, state: null });
  return rootDir;
}

async function git(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error, stdout, stderr) => {
      if (error) reject(new Error((stderr || stdout || error.message).trim()));
      else resolve();
    });
  });
}

async function startFixture(rootDir: string, label: string): Promise<SshEnvLabFixtureState | null> {
  const entry = teardowns.find((candidate) => candidate.rootDir === rootDir);
  if (!entry) throw new Error("missing fixture teardown entry");
  if (unsupportedReason) {
    console.warn(`Skipping ${label}: ${unsupportedReason}`);
    return null;
  }
  const support = await getSshEnvLabSupport();
  if (!support.supported) {
    unsupportedReason = support.reason ?? "unsupported environment";
    console.warn(`Skipping ${label}: ${unsupportedReason}`);
    return null;
  }
  try {
    const state = await startSshEnvLabFixture({ statePath: path.join(rootDir, "state.json") });
    entry.state = state;
    return state;
  } catch (error) {
    unsupportedReason = error instanceof Error ? error.message : String(error);
    console.warn(`Skipping ${label}: ${unsupportedReason}`);
    return null;
  }
}

function specFor(config: Awaited<ReturnType<typeof buildSshEnvLabFixtureConfig>>, workspaceDir: string): SshRemoteExecutionSpec {
  return { ...config, remoteCwd: workspaceDir };
}

async function commandLines(): Promise<string[]> {
  const entries = await readdir("/proc");
  const lines: string[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const raw = await readFile(`/proc/${entry}/cmdline`);
      lines.push(raw.toString("utf8").replaceAll("\0", " "));
    } catch {
      // The process exited between readdir and read.
    }
  }
  return lines;
}

function alive(pid: number | undefined): boolean {
  if (!pid || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timed out waiting for condition");
}

afterAll(async () => {
  while (teardowns.length > 0) {
    const entry = teardowns.pop();
    if (!entry) continue;
    if (entry.state) {
      await stopSshEnvLabFixture(entry.state).catch(() => undefined);
    }
    await rm(entry.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("bounded SSH workspace sync", () => {
  it("uses an existing remote cwd in place and uploads nothing", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "in-place remote cwd");
    if (!started) return;
    const remoteTree = path.join(started.workspaceDir, "existing-worktree");
    const localDir = path.join(rootDir, "local");
    await mkdir(remoteTree, { recursive: true });
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(remoteTree, "canary.txt"), "remote\n");
    await writeFile(path.join(localDir, "SHOULD_NOT_UPLOAD.txt"), "local\n");
    const config = await buildSshEnvLabFixtureConfig(started);

    const prepared = await prepareRemoteManagedRuntime({
      spec: specFor(config, started.workspaceDir),
      runId: "run-attach",
      adapterKey: "codex",
      workspaceLocalDir: localDir,
      attachExistingRemoteCwd: { remoteCwd: remoteTree, allowedRoot: started.workspaceDir },
    });

    expect(prepared.workspaceRemoteDir).toBe(remoteTree);
    expect(await readFile(path.join(remoteTree, "canary.txt"), "utf8")).toBe("remote\n");
    await expect(stat(path.join(started.workspaceDir, "SHOULD_NOT_UPLOAD.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(remoteTree, "SHOULD_NOT_UPLOAD.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await prepared.restoreWorkspace();
    expect(await readFile(path.join(localDir, "SHOULD_NOT_UPLOAD.txt"), "utf8")).toBe("local\n");
  }, TEST_TIMEOUT_MS);

  it("fails before transfer when the remote cwd is missing or outside the allowed root", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "missing remote cwd");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "SHOULD_NOT_UPLOAD.txt"), "local\n");
    await writeFile(path.join(started.workspaceDir, "sentinel.txt"), "stay\n");
    const config = await buildSshEnvLabFixtureConfig(started);
    const spec = specFor(config, started.workspaceDir);
    const input = {
      spec,
      runId: "run-missing",
      adapterKey: "codex",
      workspaceLocalDir: localDir,
    };

    await expect(prepareRemoteManagedRuntime({
      ...input,
      attachExistingRemoteCwd: {
        remoteCwd: path.posix.join(started.workspaceDir, "does-not-exist"),
        allowedRoot: started.workspaceDir,
      },
    })).rejects.toMatchObject({ code: "REMOTE_WORKSPACE_UNAVAILABLE" });
    await expect(prepareRemoteManagedRuntime({
      ...input,
      runId: "run-outside",
      attachExistingRemoteCwd: { remoteCwd: "/tmp", allowedRoot: started.workspaceDir },
    })).rejects.toMatchObject({ code: "REMOTE_WORKSPACE_UNAVAILABLE" });

    expect(await readFile(path.join(started.workspaceDir, "sentinel.txt"), "utf8")).toBe("stay\n");
    await expect(stat(path.join(started.workspaceDir, "SHOULD_NOT_UPLOAD.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, TEST_TIMEOUT_MS);

  it("omits heavy, secret, and git paths, and ignores a forced re-include", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "copy exclusions");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    await mkdir(path.join(localDir, "node_modules"), { recursive: true });
    await mkdir(path.join(localDir, ".git"), { recursive: true });
    await writeFile(path.join(localDir, "keep.txt"), "keep\n");
    await writeFile(path.join(localDir, "skip-me.txt"), "skip\n");
    await writeFile(path.join(localDir, ".env.local"), "LOCAL_ENV_CANARY\n");
    await writeFile(path.join(localDir, ".npmrc"), "LOCAL_NPM_CANARY\n");
    await writeFile(path.join(localDir, "node_modules", "canary.txt"), "modules\n");
    await writeFile(path.join(localDir, ".git", "canary"), "git\n");
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "copied");

    await prepareWorkspaceForSshExecution({
      spec: specFor(config, started.workspaceDir),
      localDir,
      remoteDir,
      workspaceExclude: ["!.env.local", "skip-me.txt"],
    });

    expect(await readFile(path.join(remoteDir, "keep.txt"), "utf8")).toBe("keep\n");
    for (const relative of [".env.local", ".npmrc", "skip-me.txt", "node_modules/canary.txt", ".git/canary"]) {
      await expect(stat(path.join(remoteDir, relative))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, TEST_TIMEOUT_MS);

  it("keeps secrets and heavy directories out when gitignore tries to re-include them", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "gitignore re-include");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    await mkdir(path.join(localDir, "node_modules"), { recursive: true });
    await git(localDir, ["init"]);
    await writeFile(path.join(localDir, ".gitignore"), "*\n!.gitignore\n!keep.txt\n!.env.local\n!node_modules\n!node_modules/**\n");
    await writeFile(path.join(localDir, "keep.txt"), "keep\n");
    await writeFile(path.join(localDir, "ignored.txt"), "ignored\n");
    await writeFile(path.join(localDir, ".env.local"), "LOCAL_ENV_CANARY\n");
    await writeFile(path.join(localDir, "node_modules", "canary.txt"), "modules\n");
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "git-copied");

    await prepareWorkspaceForSshExecution({
      spec: specFor(config, started.workspaceDir),
      localDir,
      remoteDir,
      workspaceExclude: ["!.env.local"],
    });

    expect(await readFile(path.join(remoteDir, "keep.txt"), "utf8")).toBe("keep\n");
    for (const relative of ["ignored.txt", ".env.local", "node_modules/canary.txt"]) {
      await expect(stat(path.join(remoteDir, relative))).rejects.toMatchObject({ code: "ENOENT" });
    }
  }, TEST_TIMEOUT_MS);

  it("fails closed before transfer when the copy exceeds the limit", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "size limit");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "payload.txt"), "0123456789");
    await writeFile(path.join(started.workspaceDir, "sentinel.txt"), "stay\n");
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "limited");

    await expect(prepareWorkspaceForSshExecution({
      spec: specFor(config, started.workspaceDir),
      localDir,
      remoteDir,
      transferLimits: { maxBytes: 1 },
    })).rejects.toMatchObject({ code: "WORKSPACE_SYNC_LIMIT" });

    expect(await readFile(path.join(started.workspaceDir, "sentinel.txt"), "utf8")).toBe("stay\n");
    await expect(stat(path.join(remoteDir, "payload.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  }, TEST_TIMEOUT_MS);

  it("leaves excluded local files untouched when included files are restored", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "restore exclusions");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    await mkdir(path.join(localDir, "node_modules"), { recursive: true });
    await writeFile(path.join(localDir, "keep.txt"), "local keep\n");
    await writeFile(path.join(localDir, ".env.local"), "LOCAL_ENV_CANARY\n");
    await writeFile(path.join(localDir, ".npmrc"), "LOCAL_NPM_CANARY\n");
    await writeFile(path.join(localDir, "node_modules", "canary.txt"), "modules\n");
    const config = await buildSshEnvLabFixtureConfig(started);
    const prepared = await prepareRemoteManagedRuntime({
      spec: specFor(config, started.workspaceDir),
      runId: "run-restore",
      adapterKey: "codex",
      workspaceLocalDir: localDir,
    });
    await writeFile(path.join(prepared.workspaceRemoteDir, "keep.txt"), "from remote\n");
    await writeFile(path.join(localDir, ".env.local"), "LOCAL_ENV_CANARY\n");

    await prepared.restoreWorkspace();

    expect(await readFile(path.join(localDir, "keep.txt"), "utf8")).toBe("from remote\n");
    expect(await readFile(path.join(localDir, ".env.local"), "utf8")).toBe("LOCAL_ENV_CANARY\n");
    expect(await readFile(path.join(localDir, ".npmrc"), "utf8")).toBe("LOCAL_NPM_CANARY\n");
    expect(await readFile(path.join(localDir, "node_modules", "canary.txt"), "utf8")).toBe("modules\n");
  }, TEST_TIMEOUT_MS);

  it("spawns nothing when the signal is already aborted", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "abort before spawn");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    await mkdir(localDir, { recursive: true });
    await writeFile(path.join(localDir, "keep.txt"), "keep\n");
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, "never-created");
    const controller = new AbortController();
    controller.abort();

    await expect(syncDirectoryToSsh({
      spec: specFor(config, started.workspaceDir),
      localDir,
      remoteDir,
      signal: controller.signal,
    })).rejects.toMatchObject({ code: "WORKSPACE_SYNC_ABORTED" });

    await expect(stat(remoteDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await commandLines()).some((line) => line.includes(remoteDir))).toBe(false);
  }, TEST_TIMEOUT_MS);

  it("kills the owned local and remote sync processes on abort and ignores a second cancel", async () => {
    const rootDir = await createRoot();
    const started = await startFixture(rootDir, "abort mid upload");
    if (!started) return;
    const localDir = path.join(rootDir, "local");
    const binDir = path.join(rootDir, "bin");
    await mkdir(localDir, { recursive: true });
    await mkdir(binDir, { recursive: true });
    await writeFile(path.join(localDir, "keep.txt"), "keep\n");
    const realTar = await new Promise<string>((resolve, reject) => {
      execFile("bash", ["-lc", "command -v tar"], (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout.trim());
      });
    });
    await writeFile(path.join(binDir, "tar"), `#!/bin/sh
prev=
to_stdout=0
cdir=
for arg in "$@"; do
  if [ "$prev" = "-cf" ] && [ "$arg" = "-" ]; then to_stdout=1; fi
  if [ "$prev" = "-C" ]; then cdir=$arg; fi
  prev=$arg
done
if [ "$to_stdout" = 1 ]; then
  tmp=$(mktemp)
  ${realTar} -C "$cdir" --exclude '._*' -cf "$tmp" .
  size=$(wc -c < "$tmp")
  # Drop the end-of-archive trailer so the remote extractor blocks on read.
  if [ "$size" -gt 1024 ]; then head -c $((size - 1024)) "$tmp"; fi
  rm -f "$tmp"
  exec sleep 60
fi
exec ${realTar} "$@"
`, { mode: 0o755 });
    const config = await buildSshEnvLabFixtureConfig(started);
    const remoteDir = path.posix.join(started.workspaceDir, `blocked-${Date.now()}`);
    const decoy = spawn("bash", ["-c", "exec -a tar sleep 60"], { stdio: "ignore" });
    const pathDecoy = spawn("bash", ["-c", "sleep 60", "bash", remoteDir], { stdio: "ignore" });
    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}:${previousPath ?? ""}`;
    const controller = new AbortController();
    const pending = syncDirectoryToSsh({
      spec: specFor(config, started.workspaceDir),
      localDir,
      remoteDir,
      signal: controller.signal,
    });
    let early: unknown = null;
    pending.then(() => { early = new Error("sync resolved before abort"); }, (error) => { early = error; });
    const markerGlob = () => readdir(started.workspaceDir).then((entries) => entries.filter((entry) => entry.startsWith(".paperclip-sync-") && entry.endsWith(".pgid")));
    try {
      let markerPid = 0;
      await waitFor(async () => {
        if (early) return true;
        const markers = await markerGlob();
        if (markers.length === 0) return false;
        const raw = await readFile(path.join(started.workspaceDir, markers[0]!), "utf8");
        markerPid = Number.parseInt(raw.trim(), 10);
        return alive(markerPid);
      }, 10_000);
      if (early) throw early;
      controller.abort();
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: "WORKSPACE_SYNC_ABORTED" });
      await waitFor(() => !alive(markerPid), 8_000);
      await waitFor(async () => !(await commandLines()).some((line) => line.includes("tar -xf") && line.includes(remoteDir)), 8_000);
      expect(alive(started.pid)).toBe(true);
      expect(alive(decoy.pid)).toBe(true);
      expect(alive(pathDecoy.pid)).toBe(true);
    } finally {
      process.env.PATH = previousPath;
      controller.abort();
      for (const child of [decoy, pathDecoy]) {
        if (!child.pid) continue;
        try { process.kill(child.pid, "SIGKILL"); } catch { /* already gone */ }
      }
      await pending.catch(() => undefined);
    }
  }, TEST_TIMEOUT_MS);
});
