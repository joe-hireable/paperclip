import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { SocketModeClient, LogLevel, type Logger } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { parseConfig } from "./config.js";
import { createRuntime, type Connect } from "./runtime.js";

// SDK debug logs contain incoming message bodies. Never forward them to host logs.
const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {}, setLevel() {}, getLevel: () => LogLevel.ERROR, setName() {} };
export function slackConnection(ctx: PluginContext): Connect {
  return async (config, companyId) => {
    const [appToken, botToken] = await Promise.all([
      ctx.secrets.resolve(config.appToken, { companyId, configPath: "appToken" }),
      ctx.secrets.resolve(config.botToken, { companyId, configPath: "botToken" }),
    ]);
    const web = new WebClient(botToken, { logger: quiet, retryConfig: { retries: 0 }, rejectRateLimitedCalls: true, timeout: 10_000 });
    const auth = await web.auth.test();
    if (auth.team_id !== config.workspaceId || !auth.bot_id) throw new Error("Slack workspace does not match configuration");
    const socket = new SocketModeClient({ appToken, logger: quiet, logLevel: LogLevel.ERROR, clientOptions: { retryConfig: { retries: 0 }, timeout: 10_000 } });
    let connected = false;
    socket.on("connected", () => { connected = true; });
    for (const event of ["connecting", "reconnecting", "disconnecting", "disconnected"]) socket.on(event, () => { connected = false; });
    socket.on("error", () => ctx.logger.warn("Slack connection reported an error; no provider payload was logged."));
    return {
      // Reuse the existing verified auth.test result; never expose its full
      // response or make another provider call just to inspect board status.
      authenticatedIdentity: {
        workspaceId: auth.team_id,
        botUserId: typeof auth.user_id === "string" && /^[UW][A-Z0-9]{2,32}$/.test(auth.user_id) ? auth.user_id : null,
        botId: auth.bot_id,
      },
      isConnected: () => connected,
      async start(receive) {
        // The SDK emits the inner event name (e.g. `message`) and `slack_event`,
        // not `events_api`. Keep the envelope filter at this transport boundary.
        socket.on("slack_event", ({ type, body, ack }: { type: string; body: unknown; ack: () => Promise<void> }) => {
          if (type !== "events_api") {
            void ack().catch(() => ctx.logger.warn("Unsupported Slack event acknowledgement failed."));
            return;
          }
          void receive(body, ack).catch(() => ctx.logger.warn("Slack event was not acknowledged; a provider retry may follow."));
        });
        await socket.start();
      },
      async stop() { await socket.disconnect(); },
      async verifyDirectMessage(message) {
        const result = await web.conversations.info({ channel: message.channelId });
        const channel = result.channel;
        return channel?.is_im === true && channel.is_mpim !== true && "user" in channel && channel.user === message.userId;
      },
      async reply(message, text) {
        const plain = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        await web.chat.postMessage({ channel: message.channelId, thread_ts: message.threadTs ?? message.ts, text: plain,
          unfurl_links: false, unfurl_media: false, parse: "none", mrkdwn: false });
      },
    };
  };
}

let runtime: ReturnType<typeof createRuntime>;
const plugin = definePlugin({
  async setup(ctx) { runtime = createRuntime(ctx, slackConnection(ctx)); },
  async onConfigChanged(config, scope) { await runtime.configure(config, scope?.companyId ?? null); },
  async onValidateConfig(config) {
    try { parseConfig(config); return { ok: true }; }
    catch { return { ok: false, errors: ["Use the documented workspace, user/project mappings and company secret references."] }; }
  },
  async onApiRequest(input) {
    if (input.routeKey !== "status") return { status: 404, body: { error: "Unknown route" } };
    if (input.actor.actorType !== "user" || !input.companyId) return { status: 403, body: { error: "An authenticated company operator is required." } };
    try { return { body: await runtime.status(input.companyId) }; }
    catch { return { status: 403, body: { error: "Company scope mismatch" } }; }
  },
  async onHealth() {
    const state = runtime.health();
    return { status: state === "error" ? "error" : state === "connecting" ? "degraded" : "ok", message: `Slack Control: ${state}` };
  },
  async onShutdown() { await runtime.shutdown(); },
});
export default plugin;
runWorker(plugin, import.meta.url);
