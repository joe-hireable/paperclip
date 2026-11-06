import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { runChildProcess, runningProcesses, signalRunningProcess } from "./server-utils.js";

const disappearingProcess = vi.hoisted(() => ({ code: null as string | null, reads: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      const entries = actual.readdirSync(...args);
      return args[0] === "/proc" && disappearingProcess.code
        ? ["2147483647", ...entries]
        : entries;
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (args[0] === "/proc/2147483647/stat" && disappearingProcess.code) {
        disappearingProcess.reads++;
        throw Object.assign(new Error("synthetic proc read failure"), { code: disappearingProcess.code });
      }
      return actual.readFileSync(...args);
    },
  };
});

function live(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch { return false; }
}

async function until(check: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
}

function fixture(ignoreTerm: boolean, keepParent = false, stripOwnership = false) {
  const descendant = `process.on('SIGTERM', () => { ${ignoreTerm ? "" : "process.exit(0)"} }); process.send('ready'); setInterval(() => {}, 1000);`;
  return `
    const { spawn } = require('node:child_process');
    const env = { ...process.env };
    ${stripOwnership ? "delete env.PAPERCLIP_OWNED_PROCESS_GROUP;" : ""}
    const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], { env, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    child.once('message', () => {
      process.stdout.write(JSON.stringify({ parent: process.pid, descendant: child.pid }) + '\\n');
      child.disconnect(); child.unref();
      ${keepParent ? "setInterval(() => {}, 1000);" : "setTimeout(() => process.exit(0), 50);"}
    });
  `;
}

describe.skipIf(process.platform !== "linux")("owned local process-group cleanup", () => {
  it.each(["ENOENT", "ESRCH", "EACCES", "EPERM", "EIO"])(
    "classifies a process disappearing during inspection without masking uncertainty (%s)", async (code) => {
      const runId = randomUUID();
      let parent = 0, descendant = 0;
      const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
      try {
        const resultPromise = runChildProcess(runId, process.execPath, ["-e", fixture(false, true)], {
          cwd: process.cwd(), env: {}, timeoutSec: 4, graceSec: 1,
          cleanupOwnedProcessGroup: true, onSpawn: async () => {},
          onLog: async (_stream, text) => { ({ parent, descendant } = JSON.parse(text)); },
        });
        void resultPromise.catch(() => {});
        await until(() => descendant > 0);
        // Only an injected /proc directory entry/read is synthetic: the owned
        // group, drain, registry settlement and unrelated sentinel are real.
        disappearingProcess.code = code;
        disappearingProcess.reads = 0;
        const drain = signalRunningProcess(runningProcesses.get(runId)!, "SIGTERM");
        if (code === "ENOENT" || code === "ESRCH") {
          await drain;
          const result = await resultPromise;
          expect(result.ownedProcessGroupCleanup).toEqual({ status: "gone", forceKilled: false });
          expect(live(descendant)).toBe(false);
          expect(runningProcesses.has(runId)).toBe(false);
        } else {
          await expect(drain).rejects.toMatchObject({ code: "owned_process_group_cleanup_incomplete" });
          await expect(resultPromise).rejects.toMatchObject({ code: "owned_process_group_cleanup_incomplete" });
          expect(live(descendant)).toBe(true);
          expect(runningProcesses.has(runId)).toBe(true);
        }
        expect(disappearingProcess.reads).toBeGreaterThan(0);
        expect(live(sentinel.pid!)).toBe(true);
      } finally {
        disappearingProcess.code = null;
        if (descendant && live(descendant)) process.kill(descendant, "SIGKILL");
        if (parent && live(parent)) process.kill(parent, "SIGKILL");
        sentinel.kill("SIGKILL");
        runningProcesses.delete(runId);
      }
    },
  );

  it.each([false, true])("drains a detached-stdio survivor before settling (ignores TERM: %s)", async (ignoreTerm) => {
    const runId = randomUUID();
    let parent = 0, descendant = 0;
    const sentinel = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    const started = Date.now();
    try {
      const resultPromise = runChildProcess(runId, process.execPath, ["-e", fixture(ignoreTerm)], {
        cwd: process.cwd(), env: {}, timeoutSec: 4, graceSec: 1,
        cleanupOwnedProcessGroup: true,
        onSpawn: async () => {},
        onLog: async (_stream, text) => { ({ parent, descendant } = JSON.parse(text)); },
      });
      if (ignoreTerm) {
        await until(() => parent > 0 && !live(parent));
        expect(live(descendant)).toBe(true);
        expect(runningProcesses.has(runId)).toBe(true);
      }
      const result = await resultPromise;
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.ownedProcessGroupCleanup).toMatchObject({ status: "gone", forceKilled: ignoreTerm });
      expect(live(descendant)).toBe(false);
      expect(runningProcesses.has(runId)).toBe(false);
      expect(live(sentinel.pid!)).toBe(true);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      if (descendant && live(descendant)) process.kill(descendant, "SIGKILL");
      if (parent && live(parent)) process.kill(parent, "SIGKILL");
      sentinel.kill("SIGKILL");
      runningProcesses.delete(runId);
    }
  });

  it("leaves an unbound detached-stdio descendant unchanged", async () => {
    let descendant = 0;
    try {
      const result = await runChildProcess(randomUUID(), process.execPath, ["-e", fixture(false)], {
        cwd: process.cwd(), env: {}, timeoutSec: 2, graceSec: 1,
        onLog: async (_stream, text) => { descendant = JSON.parse(text).descendant; },
      });
      expect(result.exitCode).toBe(0);
      expect(live(descendant)).toBe(true);
      expect(result.ownedProcessGroupCleanup).toBeUndefined();
    } finally { if (descendant && live(descendant)) process.kill(descendant, "SIGKILL"); }
  });

  it.each(["timeout", "cancel"])("converges %s and close while draining a TERM-resistant survivor", async (mode) => {
    const runId = randomUUID();
    let parent = 0, descendant = 0;
    try {
      const resultPromise = runChildProcess(runId, process.execPath, ["-e", fixture(true, true)], {
        cwd: process.cwd(), env: {}, timeoutSec: mode === "timeout" ? 0.4 : 3, graceSec: 1,
        cleanupOwnedProcessGroup: true, onSpawn: async () => {},
        onLog: async (_stream, text) => { ({ parent, descendant } = JSON.parse(text)); },
      });
      if (mode === "cancel") {
        await until(() => descendant > 0);
        signalRunningProcess(runningProcesses.get(runId)!, "SIGTERM");
      }
      const result = await resultPromise;
      expect(result.timedOut).toBe(mode === "timeout");
      expect(result.ownedProcessGroupCleanup).toMatchObject({ status: "gone", forceKilled: true });
      expect(live(descendant)).toBe(false);
      expect(runningProcesses.has(runId)).toBe(false);
    } finally {
      if (descendant && live(descendant)) process.kill(descendant, "SIGKILL");
      if (parent && live(parent)) process.kill(parent, "SIGKILL");
      runningProcesses.delete(runId);
    }
  });

  it("retains uncertain ownership instead of signalling a descendant without its marker", async () => {
    const runId = randomUUID();
    let descendant = 0;
    try {
      await expect(runChildProcess(runId, process.execPath, ["-e", fixture(false, false, true)], {
        cwd: process.cwd(), env: {}, timeoutSec: 2, graceSec: 1,
        cleanupOwnedProcessGroup: true, onSpawn: async () => {},
        onLog: async (_stream, text) => { descendant = JSON.parse(text).descendant; },
      })).rejects.toMatchObject({ code: "owned_process_group_cleanup_incomplete" });
      expect(live(descendant)).toBe(true);
      expect(runningProcesses.has(runId)).toBe(true);
    } finally {
      if (descendant && live(descendant)) process.kill(descendant, "SIGKILL");
      runningProcesses.delete(runId);
    }
  });

  it("keeps the whole-process deadline after parent close", async () => {
    const runId = randomUUID();
    let descendant = 0;
    try {
      const result = await runChildProcess(runId, process.execPath, ["-e", fixture(true)], {
        cwd: process.cwd(), env: {}, timeoutSec: 0.3, graceSec: 1,
        cleanupOwnedProcessGroup: true, onSpawn: async () => {},
        onLog: async (_stream, text) => { descendant = JSON.parse(text).descendant; },
      });
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(true);
      expect(result.ownedProcessGroupCleanup).toEqual({ status: "gone", forceKilled: true });
    } finally {
      if (descendant && live(descendant)) process.kill(descendant, "SIGKILL");
      runningProcesses.delete(runId);
    }
  });

  it("cleans a spawned process but retains uncertainty when metadata persistence throws synchronously", async () => {
    const runId = randomUUID();
    let pid = 0;
    try {
      await expect(runChildProcess(runId, process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
        cwd: process.cwd(), env: {}, timeoutSec: 0.2, graceSec: 1,
        cleanupOwnedProcessGroup: true,
        onSpawn: (meta) => { pid = meta.pid; throw new Error("synthetic persistence failure"); },
        onLogError: () => {}, onLog: async () => {},
      })).rejects.toMatchObject({ code: "owned_process_group_cleanup_incomplete" });
      expect(live(pid)).toBe(false);
      expect(runningProcesses.has(runId)).toBe(true);
    } finally {
      if (pid && live(pid)) process.kill(pid, "SIGKILL");
      runningProcesses.delete(runId);
    }
  });

  it("bounds unresolved metadata persistence after the process group is gone", async () => {
    const runId = randomUUID();
    try {
      const result = runChildProcess(runId, process.execPath, ["-e", "process.exit(0)"], {
        cwd: process.cwd(), env: {}, timeoutSec: 0.2, graceSec: 1,
        cleanupOwnedProcessGroup: true, onSpawn: () => new Promise(() => {}),
        onLog: async () => {},
      });
      await expect(Promise.race([result, new Promise((_, reject) => setTimeout(() => reject(new Error("fixture deadline exceeded")), 600))]))
        .rejects.toMatchObject({ code: "owned_process_group_cleanup_incomplete" });
      expect(runningProcesses.has(runId)).toBe(true);
    } finally { runningProcesses.delete(runId); }
  });
});
