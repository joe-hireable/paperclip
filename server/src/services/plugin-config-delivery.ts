import { JsonRpcCallError, PLUGIN_RPC_ERROR_CODES } from "@paperclipai/plugin-sdk";
import type { PluginWorkerHandle, PluginWorkerManager } from "./plugin-worker-manager.js";

interface ConfigRow {
  companyId: string;
  configJson: Record<string, unknown> | null;
}

// Shared by startup/recovery and live saves. Store ordering only, never config.
// Weak keys let an unregistered handle and its completed queue be collected.
const deliveries = new WeakMap<PluginWorkerHandle, { generation: number; tail: Promise<void>; quarantined: boolean }>();

export class PluginConfigDeliveryError extends Error {
  constructor(
    readonly failures: Array<{ companyId: string; error: unknown }>,
    readonly workerUnavailable = false,
  ) {
    super(workerUnavailable
      ? "Configuration delivery is unavailable; reload the plugin with a new worker."
      : "Some company settings could not be applied to the worker.");
  }
}

/** Refresh the complete persisted configuration on this exact worker handle. */
export function deliverPluginConfig(
  manager: PluginWorkerManager,
  worker: PluginWorkerHandle,
  readConfigs: () => Promise<readonly ConfigRow[]>,
  onError?: (error: unknown, companyId: string) => void,
): Promise<void> {
  let state = deliveries.get(worker);
  if (!state) {
    state = { generation: 0, tail: Promise.resolve(), quarantined: false };
    deliveries.set(worker, state);
  }
  const generation = ++state.generation;
  const current = () => generation === state.generation
    && manager.getWorker(worker.pluginId) === worker
    && worker.status === "running";
  const delivery = state.tail.then(async () => {
    if (state.quarantined) throw new PluginConfigDeliveryError([], true);
    if (!current()) return;
    const rows = await readConfigs();
    if (!current()) return;
    const failures: Array<{ companyId: string; error: unknown }> = [];
    worker.setProactiveCompanyScopes(rows.map((row) => row.companyId));
    for (const row of rows) {
      if (!current()) break;
      try {
        // Never resolve the target again by plugin ID: an unload/reload may
        // replace the manager's handle while a preceding RPC is pending.
        await worker.call("configChanged", { companyId: row.companyId, config: row.configJson ?? {} });
      } catch (error) {
        failures.push({ companyId: row.companyId, error });
        // Native TIMEOUT settles only the host promise. An interrupted transport
        // can likewise leave the callback alive. Never reuse that process: clear
        // scopes and await the manager's bounded shutdown before releasing the
        // queue. An explicit lifecycle reload must create a fresh handle.
        const uncertain = error instanceof JsonRpcCallError
          ? error.code === PLUGIN_RPC_ERROR_CODES.TIMEOUT
          : worker.status === "running";
        if (uncertain) {
          state.quarantined = true;
          worker.setProactiveCompanyScopes([]);
          try {
            await worker.stop();
            if (worker.diagnostics().pid !== null) throw new Error("Worker exit was not confirmed after configuration timeout.");
          } catch (stopError) {
            failures.push({ companyId: row.companyId, error: stopError });
          }
          for (const failure of failures) onError?.(failure.error, failure.companyId);
          throw new PluginConfigDeliveryError(failures, true);
        }
        onError?.(error, row.companyId);
      }
    }
    // Completed callback rejections do not block other companies. Report the
    // collected failures only after their remaining settings were attempted.
    if (failures.length && !onError) throw new PluginConfigDeliveryError(failures);
  });
  // Completed rejections/read failures do not poison the queue. A timed-out
  // handle remains explicitly quarantined when a later request reaches it.
  state.tail = delivery.catch(() => {});
  return delivery;
}
