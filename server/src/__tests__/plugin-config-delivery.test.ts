import { describe, expect, it } from "vitest";
import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import { deliverPluginConfig } from "../services/plugin-config-delivery.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import type { PluginWorkerHandle, PluginWorkerManager, WorkerStartOptions } from "../services/plugin-worker-manager.js";

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture() {
  const applied: Array<{ companyId: string; config: Record<string, unknown> }> = [];
  let scopes: readonly string[] = [];
  const worker = {
    pluginId: "plugin", status: "running",
    setProactiveCompanyScopes(ids: readonly string[]) { scopes = ids; },
    async call(_method: string, params: typeof applied[number]) { applied.push(params); },
  } as unknown as PluginWorkerHandle;
  let current = worker;
  const manager = {
    getWorker() { return current; },
    call(_id: string, method: never, params: never) { return current.call(method, params); },
  } as unknown as PluginWorkerManager;
  return { worker, manager, applied, scopes: () => scopes, replace(next: PluginWorkerHandle) { current = next; } };
}

async function nativeFixture(definition: string, rpcTimeoutMs = 1000) {
  const manager = createPluginWorkerManager();
  const sdkUrl = new URL("../../../packages/plugins/sdk/dist/index.js", import.meta.url).href;
  const tsxUrl = new URL("../../../cli/node_modules/tsx/dist/loader.mjs", import.meta.url).href;
  const code = `import { definePlugin, startWorkerRpcHost } from ${JSON.stringify(sdkUrl)}; ${definition}`;
  const options: WorkerStartOptions = {
    entrypointPath: fileURLToPath(sdkUrl), execArgv: ["--import", tsxUrl, "--import", `data:text/javascript,${encodeURIComponent(code)}`],
    manifest: { id: "paperclip.config-delivery-fixture", apiVersion: 1, version: "0.0.1", displayName: "Config fixture", description: "Synthetic test", author: "Test", categories: ["automation"], capabilities: [], entrypoints: { worker: "./worker.js" } },
    config: {}, apiVersion: 1, instanceInfo: { instanceId: "test", hostVersion: "1.0.0" }, hostHandlers: {}, rpcTimeoutMs, autoRestart: false,
  };
  const worker = await manager.startWorker("config-delivery-fixture", options);
  return { manager, worker, options };
}

describe("plugin configuration delivery ordering", () => {
  it("applies later companies before reporting a completed rejection for an earlier company", async () => {
    const f = fixture();
    const original = f.worker.call;
    f.worker.call = (async (method: never, params: { companyId: string }) => {
      if (params.companyId === "a") throw new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "Invalid credentials" });
      return original(method, params as never);
    }) as typeof f.worker.call;
    const result = await deliverPluginConfig(f.manager, f.worker, async () => [
      { companyId: "a", configJson: { enabled: true } },
      { companyId: "b", configJson: { enabled: false } },
    ]).catch(error => error);
    expect(f.applied).toEqual([{ companyId: "b", config: { enabled: false } }]);
    expect(result.failures).toMatchObject([{ companyId: "a", error: { code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR } }]);
  });

  it("does not discard a completed rejection when a newer refresh supersedes the rest of its batch", async () => {
    const f = fixture();
    const started = barrier();
    const release = barrier();
    const original = f.worker.call;
    let first = true;
    f.worker.call = (async (method: never, params: never) => {
      if (first) {
        first = false;
        started.release();
        await release.promise;
        throw new JsonRpcCallError({ code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR, message: "Rejected config" });
      }
      return original(method, params);
    }) as typeof f.worker.call;
    const rows = [{ companyId: "a", configJson: {} }, { companyId: "b", configJson: { enabled: false } }];
    const old = deliverPluginConfig(f.manager, f.worker, async () => rows).catch(error => error);
    await started.promise;
    const latest = deliverPluginConfig(f.manager, f.worker, async () => rows);
    release.release();
    const [error] = await Promise.all([old, latest]);
    expect(error?.failures).toMatchObject([{ companyId: "a", error: { code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR } }]);
    expect(f.applied.at(-1)).toEqual({ companyId: "b", config: { enabled: false } });
  });

  it("quarantines and stops the real SDK process after a timeout before any later delivery", async () => {
    const { manager, worker, options } = await nativeFixture(`
      let applied = null;
      startWorkerRpcHost({ plugin: definePlugin({
        setup() {},
        async onConfigChanged(config) {
          if (config.revision === 1) await new Promise(resolve => setTimeout(resolve, 250));
          applied = config;
        },
        onHealth() { return { status: "ok", details: { applied } }; },
      }) });
    `, 50);
    const started = barrier();
    const original = worker.call.bind(worker);
    worker.call = ((method: never, params: never) => {
      const result = original(method, params);
      if (method === "configChanged") started.release();
      return result;
    }) as typeof worker.call;
    try {
      const old = deliverPluginConfig(manager, worker, async () => [{ companyId: "a", configJson: { revision: 1, enabled: true } }]).catch(error => error);
      await started.promise;
      const disabled = deliverPluginConfig(manager, worker, async () => [{ companyId: "a", configJson: { revision: 2, enabled: false } }]).catch(error => error);
      const [firstError, secondError] = await Promise.all([old, disabled]);
      expect(worker.status).toBe("stopped");
      expect(worker.diagnostics().pid).toBeNull();
      expect(firstError.failures[0].error.code).toBe(PLUGIN_RPC_ERROR_CODES.TIMEOUT);
      expect(secondError.workerUnavailable).toBe(true);
      await expect(deliverPluginConfig(manager, worker, async () => [{ companyId: "a", configJson: { revision: 3 } }])).rejects.toMatchObject({ workerUnavailable: true });
      // A bare process restart cannot silently bypass the handle quarantine.
      await worker.restart();
      await expect(deliverPluginConfig(manager, worker, async () => [])).rejects.toMatchObject({ workerUnavailable: true });
      // The production lifecycle's unload/load uses a new handle and can apply
      // the persisted correction without inheriting the previous uncertainty.
      await manager.stopWorker(worker.pluginId);
      const fresh = await manager.startWorker(worker.pluginId, { ...options, rpcTimeoutMs: 1000 });
      expect(fresh).not.toBe(worker);
      await deliverPluginConfig(manager, fresh, async () => [{ companyId: "a", configJson: { revision: 3, enabled: false } }]);
      expect(await fresh.call("health", {})).toMatchObject({ details: { applied: { revision: 3, enabled: false } } });
    } finally {
      await manager.stopAll();
    }
  }, 10_000);

  it("continues after an actual multi-company SDK rejection and reports its company", async () => {
    const { manager, worker } = await nativeFixture(`
      const applied = {};
      startWorkerRpcHost({ plugin: definePlugin({
        multiCompanyConfig: true, setup() {},
        async onConfigChanged(config, scope) {
          if (scope.companyId === "a") throw new Error("Invalid credentials");
          applied[scope.companyId] = config;
        },
        onHealth() { return { status: "ok", details: { applied } }; },
      }) });
    `);
    try {
      const result = await deliverPluginConfig(manager, worker, async () => [
        { companyId: "a", configJson: { enabled: true } },
        { companyId: "b", configJson: { enabled: false } },
      ]).catch(error => error);
      expect(result.failures).toMatchObject([{ companyId: "a", error: { code: PLUGIN_RPC_ERROR_CODES.WORKER_ERROR } }]);
      expect(await worker.call("health", {})).toMatchObject({ details: { applied: { b: { enabled: false } } } });
      expect(worker.status).toBe("running");
    } finally {
      await manager.stopAll();
    }
  }, 10_000);

  it("does not replay an older enable after an operator disable races a recovery read", async () => {
    const f = fixture();
    const readStarted = barrier();
    const releaseRead = barrier();
    const recovery = deliverPluginConfig(f.manager, f.worker, async () => {
      readStarted.release();
      await releaseRead.promise;
      return [{ companyId: "a", configJson: { enabled: true } }];
    });
    await readStarted.promise;
    const disabled = deliverPluginConfig(f.manager, f.worker, async () => [
      { companyId: "a", configJson: { enabled: false } },
    ]);
    releaseRead.release();
    await Promise.all([recovery, disabled]);
    expect(f.applied).toEqual([{ companyId: "a", config: { enabled: false } }]);
    expect(f.scopes()).toEqual(["a"]);
  });

  it("serializes an in-flight recovery RPC before applying newer persisted settings", async () => {
    const f = fixture();
    const started = barrier();
    const release = barrier();
    const originalCall = f.worker.call;
    let active = 0;
    let maxActive = 0;
    f.worker.call = (async (method: never, params: never) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (active === 1 && f.applied.length === 0) {
        started.release();
        await release.promise;
      }
      await originalCall(method, params);
      active -= 1;
    }) as typeof f.worker.call;
    const first = deliverPluginConfig(f.manager, f.worker, async () => [{ companyId: "a", configJson: { enabled: true } }]);
    await started.promise;
    const second = deliverPluginConfig(f.manager, f.worker, async () => [{ companyId: "a", configJson: { enabled: false } }]);
    release.release();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect(f.applied.at(-1)).toEqual({ companyId: "a", config: { enabled: false } });
  });

  it("stops a replay when its handle is replaced while the first company RPC is pending", async () => {
    const old = fixture();
    const replacement = fixture();
    const started = barrier();
    const release = barrier();
    old.worker.call = (async () => { started.release(); await release.promise; }) as typeof old.worker.call;
    const replay = deliverPluginConfig(old.manager, old.worker, async () => [
      { companyId: "a", configJson: { revision: 1 } },
      { companyId: "b", configJson: { revision: 1 } },
    ]);
    await started.promise;
    old.replace(replacement.worker);
    release.release();
    await replay;
    expect(replacement.applied).toEqual([]);
    expect(replacement.scopes()).toEqual([]);
  });

  it("does not restore scopes from a delayed read into a stopped handle", async () => {
    const f = fixture();
    const started = barrier();
    const release = barrier();
    const replay = deliverPluginConfig(f.manager, f.worker, async () => {
      started.release();
      await release.promise;
      return [{ companyId: "a", configJson: {} }];
    });
    await started.promise;
    Object.assign(f.worker, { status: "stopped" });
    release.release();
    await replay;
    expect(f.applied).toEqual([]);
    expect(f.scopes()).toEqual([]);
  });

  it("a rejected read does not poison the queue or grant company scopes", async () => {
    const f = fixture();
    await expect(deliverPluginConfig(f.manager, f.worker, async () => { throw new Error("database unavailable"); })).rejects.toThrow("database unavailable");
    expect(f.scopes()).toEqual([]);
    await deliverPluginConfig(f.manager, f.worker, async () => [{ companyId: "b", configJson: { enabled: false } }]);
    expect(f.applied).toEqual([{ companyId: "b", config: { enabled: false } }]);
    expect(f.scopes()).toEqual(["b"]);
  });
});
import { fileURLToPath } from "node:url";
