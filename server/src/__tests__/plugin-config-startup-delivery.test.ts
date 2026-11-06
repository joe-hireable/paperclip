import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, pluginConfig, plugins } from "@paperclipai/db";
import { pluginRegistryService } from "../services/plugin-registry.js";
import { pluginLoader } from "../services/plugin-loader.js";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { deliverPluginConfig } from "../services/plugin-config-delivery.js";
import { createPluginWorkerManager } from "../services/plugin-worker-manager.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

/**
 * LOOA-629: a plugin worker is spawned once per plugin (not per company) with
 * an empty bootstrap config, and can only read company-scoped config from
 * inside a company-scoped invocation. A proactive plugin (e.g. the chat
 * gateway) has no such invocation at setup(), so the loader must replay every
 * configured company's config to the freshly-started worker. That replay reads
 * the config rows via `registry.listConfigs(pluginId)`, which this exercises.
 */

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping plugin config startup-delivery tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function issuePrefix(id: string) {
  return `T${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("registry.listConfigs (startup config delivery)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-plugin-config-delivery-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(pluginConfig);
    await db.delete(plugins);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedPlugin(pluginKey: string, installOrder: number) {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey,
      packageName: `@paperclipai/${pluginKey}`,
      version: "0.0.1",
      apiVersion: 1,
      categories: ["automation"],
      manifestJson: {
        id: pluginKey,
        apiVersion: 1,
        version: "0.0.1",
        displayName: pluginKey,
        description: "Test plugin",
        author: "Paperclip",
        categories: ["automation"],
        capabilities: [],
        entrypoints: { worker: "./dist/worker.js" },
      },
      status: "ready",
      installOrder,
    });
    return pluginId;
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Co ${companyId.slice(0, 6)}`,
      issuePrefix: issuePrefix(companyId),
    });
    return companyId;
  }

  it("returns every company-scoped config row for a plugin", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const companyA = await seedCompany();
    const companyB = await seedCompany();

    await registry.upsertConfig(pluginId, companyA, {
      companyId: companyA,
      configJson: { slackBotToken: "xoxb-a", slackAppToken: "xapp-a" },
    });
    await registry.upsertConfig(pluginId, companyB, {
      companyId: companyB,
      configJson: { slackBotToken: "xoxb-b", slackAppToken: "xapp-b" },
    });

    const rows = await registry.listConfigs(pluginId);
    expect(rows).toHaveLength(2);

    const byCompany = new Map(rows.map((r) => [r.companyId, r]));
    expect(byCompany.get(companyA)?.configJson).toMatchObject({ slackBotToken: "xoxb-a" });
    expect(byCompany.get(companyB)?.configJson).toMatchObject({ slackBotToken: "xoxb-b" });
  });

  it("only returns rows for the requested plugin (no cross-plugin bleed)", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const otherPluginId = await seedPlugin("paperclip.other-test", 2);
    const companyA = await seedCompany();

    await registry.upsertConfig(pluginId, companyA, {
      companyId: companyA,
      configJson: { marker: "mine" },
    });
    await registry.upsertConfig(otherPluginId, companyA, {
      companyId: companyA,
      configJson: { marker: "theirs" },
    });

    const rows = await registry.listConfigs(pluginId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.configJson).toMatchObject({ marker: "mine" });
  });

  it("returns an empty list when the plugin has no configured companies", async () => {
    const registry = pluginRegistryService(db);
    const pluginId = await seedPlugin("paperclip.gateway-test", 1);
    const rows = await registry.listConfigs(pluginId);
    expect(rows).toEqual([]);
  });

  it("replays persisted config after an actual crash and an operator reload of a quarantined worker", async () => {
    const registry = pluginRegistryService(db);
    const pluginKey = "paperclip.config-replay-fixture";
    const pluginId = await seedPlugin(pluginKey, 1);
    const companyId = await seedCompany();
    const packageRoot = await mkdtemp(join(tmpdir(), "paperclip-config-replay-worker-"));
    const workerManager = createPluginWorkerManager();
    const manifest = {
      id: pluginKey, apiVersion: 1, version: "0.0.1", displayName: "Config replay fixture",
      description: "Tests persisted config delivery without external connections", author: "Test",
      categories: ["automation"], capabilities: ["plugin.state.read"], entrypoints: { worker: "./worker.mjs" },
    };
    const sdkUrl = new URL("../../../packages/plugins/sdk/dist/index.js", import.meta.url).href;
    try {
      await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "@paperclipai/config-replay-fixture", version: "0.0.1", type: "module", paperclipPlugin: { manifest: "./manifest.mjs", worker: "./worker.mjs" } }));
      await writeFile(join(packageRoot, "manifest.mjs"), `export default ${JSON.stringify(manifest)};`);
      await writeFile(join(packageRoot, "worker.mjs"), `
        import { definePlugin, runWorker } from ${JSON.stringify(sdkUrl)};
        let applied = null;
        const plugin = definePlugin({
          async setup() {},
          async onConfigChanged(config, scope) {
            if (config.stall) await new Promise(resolve => setTimeout(resolve, 250));
            applied = { config, companyId: scope?.companyId };
          },
          async onHealth() { return { status: "ok", details: { applied } }; },
        });
        runWorker(plugin, import.meta.url);
      `);
      await db.update(plugins).set({ packagePath: packageRoot, packageName: "@paperclipai/config-replay-fixture", manifestJson: manifest as never, status: "ready" }).where(eq(plugins.id, pluginId));
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true, revision: 1 } });
      const loader = pluginLoader(db, { enableLocalFilesystem: false, enableNpmDiscovery: false }, {
        workerManager,
        eventBus: { forPlugin: () => ({}), subscriptionCount: () => 0, clearPlugin() {} },
        jobScheduler: { stop() {}, async unregisterPlugin() {} }, jobStore: {}, toolDispatcher: { unregisterPluginTools() {} },
        lifecycleManager: { markError: vi.fn() }, buildHostHandlers: () => ({}),
        instanceInfo: { instanceId: "test", hostVersion: "1.0.0", deploymentMode: "local_trusted", deploymentExposure: "private" },
      } as never);
      expect((await loader.loadSingle(pluginId)).success).toBe(true);
      expect(await workerManager.call(pluginId, "health", {})).toMatchObject({ details: { applied: { companyId, config: { enabled: true, revision: 1 } } } });

      // Change persisted config without sending configChanged: recovery must re-read
      // current authority, not cache the startup payload or re-enable a disabled app.
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: false, revision: 2 } });
      const handle = workerManager.getWorker(pluginId)!;
      const pid = handle.diagnostics().pid;
      expect(pid).toBeTypeOf("number");
      process.kill(pid!, "SIGKILL");
      await vi.waitFor(async () => {
        expect(handle.diagnostics().totalCrashes).toBeGreaterThan(0);
        expect(await workerManager.call(pluginId, "health", {})).toMatchObject({ details: { applied: { companyId, config: { enabled: false, revision: 2 } } } });
      }, { timeout: 10_000, interval: 100 });

      // Exercise the real operator lifecycle, not just manager.stop/start:
      // a timed-out callback quarantines this handle, then reload must replace it.
      const originalCall = handle.call.bind(handle);
      handle.call = ((method: never, params: never) => originalCall(method, params, 50)) as typeof handle.call;
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: true, revision: 3, stall: true } });
      await expect(deliverPluginConfig(workerManager, handle, () => registry.listConfigs(pluginId))).rejects.toMatchObject({ workerUnavailable: true });
      expect(handle.status).toBe("stopped");
      expect(handle.diagnostics().pid).toBeNull();
      await registry.upsertConfig(pluginId, companyId, { companyId, configJson: { enabled: false, revision: 4 } });
      const lifecycle = pluginLifecycleManager(db, { loader, workerManager });
      await lifecycle.restartWorker(pluginId);
      const fresh = workerManager.getWorker(pluginId)!;
      expect(fresh).not.toBe(handle);
      expect(await fresh.call("health", {})).toMatchObject({ details: { applied: { companyId, config: { enabled: false, revision: 4 } } } });
    } finally {
      await workerManager.stopAll();
      await rm(packageRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
