import type { PluginContext } from "@paperclipai/plugin-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { company, config, envelope, message } from "./helpers.js";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), info: vi.fn(), post: vi.fn(), start: vi.fn(), stop: vi.fn(), on: vi.fn(), web: vi.fn(), socket: vi.fn(),
}));
vi.mock("@slack/web-api", () => ({ WebClient: class {
  constructor(...args: unknown[]) { mocks.web(...args); }
  auth = { test: mocks.auth }; conversations = { info: mocks.info }; chat = { postMessage: mocks.post };
} }));
vi.mock("@slack/socket-mode", () => ({ LogLevel: { ERROR: "error" }, SocketModeClient: class {
  constructor(...args: unknown[]) { mocks.socket(...args); }
  on = mocks.on; start = mocks.start; disconnect = mocks.stop;
} }));
import { slackConnection } from "../src/worker.js";

beforeEach(() => {
  vi.clearAllMocks(); mocks.auth.mockResolvedValue({ team_id: config.workspaceId, bot_id: "BBOT" });
  mocks.info.mockResolvedValue({ channel: { is_im: true, user: message.userId } });
});
function context() {
  const api = { secrets: { resolve: vi.fn().mockResolvedValueOnce("xapp-synthetic").mockResolvedValueOnce("xoxb-synthetic") }, logger: { warn: vi.fn(), error: vi.fn() } };
  return { api, ctx: api as unknown as PluginContext };
}
describe("official Slack transport boundary", () => {
  it("receives an Events API envelope through the actual Socket Mode SDK dispatcher", async () => {
    const actual = await vi.importActual<typeof import("@slack/socket-mode")>("@slack/socket-mode");
    const connection = await slackConnection(context().ctx)(config, company);
    const receive = vi.fn(async (_body: unknown, ack: () => Promise<void>) => { await ack(); });
    await connection.start(receive);
    // Execute the installed SDK's real wire-message dispatcher without opening
    // a socket or authenticating. The old `events_api` listener receives nothing.
    const send = vi.fn().mockResolvedValue(undefined);
    const sdk = Object.assign(Object.create(actual.SocketModeClient.prototype), {
      logger: { debug() {}, getLevel: () => actual.LogLevel.ERROR }, send,
      emit(name: string, payload: unknown) {
        for (const [event, listener] of mocks.on.mock.calls) if (event === name) listener(payload);
      },
    }) as { onWebSocketMessage(data: string, isBinary: boolean): Promise<void> };
    await sdk.onWebSocketMessage(JSON.stringify({
      type: "events_api", envelope_id: "synthetic-envelope", accepts_response_payload: false,
      payload: envelope(), retry_attempt: 0,
    }), false);
    expect(receive).toHaveBeenCalledExactlyOnceWith(envelope(), expect.any(Function));
    expect(send).toHaveBeenCalledExactlyOnceWith("synthetic-envelope", undefined);
  });
  it("resolves only company-bound references and checks the authenticated workspace before starting", async () => {
    const { ctx, api } = context(); const connection = await slackConnection(ctx)(config, company);
    expect(api.secrets.resolve).toHaveBeenNthCalledWith(1, config.appToken, { companyId: company, configPath: "appToken" });
    expect(api.secrets.resolve).toHaveBeenNthCalledWith(2, config.botToken, { companyId: company, configPath: "botToken" });
    expect(mocks.web).toHaveBeenCalledWith("xoxb-synthetic", expect.objectContaining({ retryConfig: { retries: 0 }, rejectRateLimitedCalls: true }));
    expect(connection.isConnected()).toBe(false);
    await connection.start(vi.fn()); expect(mocks.start).toHaveBeenCalledTimes(1);
    expect(mocks.on).toHaveBeenCalledWith("slack_event", expect.any(Function));
    await connection.stop(); expect(mocks.stop).toHaveBeenCalledTimes(1);
  });
  it("exposes only bot identity metadata from the existing authentication check", async () => {
    mocks.auth.mockResolvedValue({ team_id: config.workspaceId, bot_id: "BBOT", user_id: "UBOT", token: "synthetic-private-token", response_metadata: { headers: "synthetic-private-headers" } });
    const connection = await slackConnection(context().ctx)(config, company);
    expect(connection.authenticatedIdentity).toEqual({ workspaceId: config.workspaceId, botId: "BBOT", botUserId: "UBOT" });
    expect(mocks.auth).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(connection.authenticatedIdentity)).not.toContain("private");
  });
  it("acknowledges non-Events-API envelopes without dispatching commands", async () => {
    const connection = await slackConnection(context().ctx)(config, company);
    const receive = vi.fn(); const ack = vi.fn().mockResolvedValue(undefined);
    await connection.start(receive);
    const listener = mocks.on.mock.calls.find(([name]) => name === "slack_event")?.[1];
    listener({ type: "interactive", body: envelope(), ack });
    expect(receive).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalledOnce();
  });
  it("rejects another workspace or a user token", async () => {
    mocks.auth.mockResolvedValue({ team_id: "TOTHER", bot_id: "BBOT" });
    await expect(slackConnection(context().ctx)(config, company)).rejects.toThrow();
    mocks.auth.mockResolvedValue({ team_id: config.workspaceId });
    await expect(slackConnection(context().ctx)(config, company)).rejects.toThrow();
    expect(mocks.socket).not.toHaveBeenCalled();
  });
  it("requires an actual one-to-one conversation with the mapped user", async () => {
    const connection = await slackConnection(context().ctx)(config, company);
    expect(await connection.verifyDirectMessage(message)).toBe(true);
    for (const channel of [{ is_im: false, user: message.userId }, { is_im: true, is_mpim: true, user: message.userId }, { is_im: true, user: "UOTHER" }, { is_im: true }]) {
      mocks.info.mockResolvedValue({ channel }); expect(await connection.verifyDirectMessage(message)).toBe(false);
    }
  });
  it("replies only to the source IM/thread with mentions and URL unfurling disabled", async () => {
    const connection = await slackConnection(context().ctx)(config, company);
    await connection.reply(message, "<@UOTHER> https://example.org");
    expect(mocks.post).toHaveBeenCalledWith({ channel: message.channelId, thread_ts: message.ts, text: "&lt;@UOTHER&gt; https://example.org", unfurl_links: false, unfurl_media: false, parse: "none", mrkdwn: false });
    const socketOptions = mocks.socket.mock.calls[0]?.[0];
    socketOptions.logger.error("xapp-do-not-log"); socketOptions.logger.debug({ text: "private body" });
  });
});
