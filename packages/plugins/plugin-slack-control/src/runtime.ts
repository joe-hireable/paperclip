import type { PluginContext } from "@paperclipai/plugin-sdk";
import { parseConfig, parseMessage, uuid, type Config, type Message } from "./config.js";
import { createControl, type Transport } from "./control.js";
import { createStore, type Store } from "./store.js";

export interface Connection extends Transport {
  readonly authenticatedIdentity?: { workspaceId: string; botUserId: string | null; botId: string };
  isConnected(): boolean;
  start(receive: (body: unknown, ack: () => Promise<void>) => Promise<void>): Promise<void>;
  stop(): Promise<void>;
}
export type Connect = (config: Config, companyId: string) => Promise<Connection>;

export interface TransportDiagnostics {
  received: number;
  accepted: number;
  ignored: number;
  failed: number;
  lastReason: "accepted" | "unsupported_or_untrusted_event" | "delivery_failed" | null;
}
const emptyDiagnostics = (): TransportDiagnostics => ({ received: 0, accepted: 0, ignored: 0, failed: 0, lastReason: null });

/** Persist before acknowledgement; never hold Slack's acknowledgement open for agent work. */
export async function receiveEvent(body: unknown, ack: () => Promise<void>, config: Config, enqueue: (message: Message) => Promise<void>, diagnostics?: TransportDiagnostics) {
  const message = parseMessage(body, config);
  if (diagnostics) {
    diagnostics.received++;
    diagnostics[message ? "accepted" : "ignored"]++;
    diagnostics.lastReason = message ? "accepted" : "unsupported_or_untrusted_event";
  }
  try {
    if (message) await enqueue(message);
    await ack();
  } catch (error) {
    if (diagnostics) { diagnostics.failed++; diagnostics.lastReason = "delivery_failed"; }
    throw error;
  }
}

export function createRuntime(ctx: PluginContext, connect: Connect) {
  let generation = 0;
  let configuredCompany: string | null = null;
  let connection: Connection | null = null;
  let store: Store | null = null;
  let activeControl: ReturnType<typeof createControl> | null = null;
  let state: "disabled" | "connecting" | "connected" | "error" = "disabled";
  let diagnostics = emptyDiagnostics();
  let changing: Promise<void> = Promise.resolve();
  // createRuntime runs synchronously in setup, outside configChanged's company
  // invocation. Its timer therefore uses the host-authorised proactive company
  // scope instead of inheriting an invocation that expires when config returns.
  const timer = setInterval(() => {
    void activeControl?.drain().catch(() => ctx.logger.warn("Slack inbox could not be processed; inspect plugin status."));
  }, 10_000);
  timer.unref();
  const health = () => state === "connected" && !connection?.isConnected() ? "connecting" : state;
  async function stop() {
    activeControl = null;
    const previous = connection; connection = null;
    if (previous) { try { await previous.stop(); } catch { ctx.logger.warn("Slack connection shutdown could not be confirmed."); } }
  }
  return {
    configure(value: unknown, companyId: string | null) {
      const version = ++generation;
      changing = changing.catch(() => {}).then(async () => {
        await stop();
        state = "disabled";
        if (version !== generation) return;
        const config = parseConfig(value);
        if (!config) return;
        if (!uuid(companyId) || (configuredCompany && configuredCompany !== companyId)) throw new Error("Slack Control requires one company-scoped configuration.");
        configuredCompany = companyId;
        diagnostics = emptyDiagnostics();
        store = createStore(ctx.db, companyId);
        state = "connecting";
        const next = await connect(config, companyId);
        if (version !== generation) { await next.stop(); return; }
        connection = next;
        const current = () => generation === version && connection === next;
        const control = createControl(ctx, companyId, config, store, next, current);
        await next.start(async (body, ack) => {
          if (!current()) return; // Leave old-connection events unacknowledged for redelivery.
          await receiveEvent(body, ack, config, control.enqueue, diagnostics);
        });
        if (!current()) { await next.stop(); return; }
        activeControl = control;
        state = "connected";
      }).catch(async () => {
        state = "error";
        await stop();
        ctx.logger.error("Slack Control configuration or connection failed; inspect secret references and workspace mapping.");
        throw new Error("Slack Control could not connect. No credential or provider response is included in diagnostics.");
      });
      return changing;
    },
    async status(companyId: string) {
      if (!uuid(companyId) || (configuredCompany && configuredCompany !== companyId)) throw new Error("Company scope mismatch");
      const identity = connection?.authenticatedIdentity;
      return { state: health(), authenticatedIdentity: identity ? {
        workspaceId: identity.workspaceId, botUserId: identity.botUserId, botId: identity.botId,
      } : null, diagnostics: { ...diagnostics }, recent: store ? await store.recent() : [] };
    },
    health,
    async shutdown() { ++generation; clearInterval(timer); await changing.catch(() => {}); await stop(); state = "disabled"; },
  };
}
