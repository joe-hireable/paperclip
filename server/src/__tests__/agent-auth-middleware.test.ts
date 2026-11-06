import { createHash, createHmac, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activityLog,
  agentApiKeys,
  agents,
  authUsers,
  boardApiKeys,
  companyMemberships,
  heartbeatRuns,
} from "@paperclipai/db";
import { actorMiddleware } from "../middleware/auth.js";
import { errorHandler } from "../middleware/error-handler.js";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { assertCompanyAccess } from "../routes/authz.js";
import { createAgentKeySchema } from "@paperclipai/shared";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function createSelectChain(rowsForTable: (table: unknown) => unknown[]) {
  return {
    from(table: unknown) {
      return {
        where() {
          return Promise.resolve(rowsForTable(table));
        },
      };
    },
  };
}

function createDbState(input: {
  agent: { id: string; companyId: string; status?: string; lifecycleHolds?: string[] };
  agentKey?: { id: string; agentId: string; companyId: string; keyHash: string; responsibleUserId?: string | null; scopeConfig?: unknown };
  run?: { id: string; companyId: string; agentId: string; responsibleUserId?: string | null;
    status?: string; contextSnapshot?: Record<string, unknown>; resultJson?: Record<string, unknown> };
  responsibleMembership?: { companyId: string; status: string; membershipRole: string };
}) {
  const activity: Array<Record<string, unknown>> = [];
  const agentRow = {
    id: input.agent.id,
    companyId: input.agent.companyId,
    status: input.agent.status ?? "active",
    lifecycleHolds: input.agent.lifecycleHolds ?? [],
  };
  const keyRow = input.agentKey
    ? {
        id: input.agentKey.id,
        agentId: input.agentKey.agentId,
        companyId: input.agentKey.companyId,
        keyHash: input.agentKey.keyHash,
        responsibleUserId: input.agentKey.responsibleUserId ?? null,
        revokedAt: null,
        scopeConfig: input.agentKey.scopeConfig ?? null,
      }
    : null;
  const runRow = input.run
    ? {
        id: input.run.id,
        companyId: input.run.companyId,
        agentId: input.run.agentId,
        responsibleUserId: input.run.responsibleUserId ?? null,
        status: input.run.status ?? "running",
        contextSnapshot: input.run.contextSnapshot ?? {},
        resultJson: input.run.resultJson ?? {},
      }
    : null;

  const db = {
    select: () =>
      createSelectChain((table) => {
        if (table === boardApiKeys) return [];
        if (table === agentApiKeys) return keyRow ? [keyRow] : [];
        if (table === agents) return [agentRow];
        if (table === heartbeatRuns) return runRow ? [runRow] : [];
        if (table === authUsers && input.responsibleMembership) return [{ id: "synthetic-owner" }];
        if (table === companyMemberships && input.responsibleMembership) return [input.responsibleMembership];
        return [];
      }),
    update: () => ({
      set() {
        return {
          where() {
            return Promise.resolve([]);
          },
        };
      },
    }),
    insert: (table: unknown) => ({
      values(values: Record<string, unknown>) {
        if (table === activityLog) activity.push(values);
        return Promise.resolve([]);
      },
    }),
  } as any;

  return { db, activity };
}

function createApp(db: any, deploymentMode: "authenticated" | "local_trusted" = "authenticated") {
  const app = express();
  app.use(express.json());
  app.use(
    actorMiddleware(db, {
      deploymentMode,
      resolveSession: async () => null,
    }),
  );
  app.get("/actor", (req, res) => {
    res.json(req.actor);
  });
  app.post("/api/routine-triggers/public/:publicId/fire", (req, res) => {
    res.json({ reachedWebhook: true, actorType: req.actor.type });
  });
  app.post("/mcp/gateways/:gatewayPublicId", (req, res) => {
    res.json({ reachedGatewayProtocol: true, actorType: req.actor.type });
  });
  app.get("/companies/:companyId/protected", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ ok: true });
  });
  app.get("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, readable: true });
  });
  app.patch("/companies/:companyId/issues/:issueId", (req, res) => {
    assertCompanyAccess(req, req.params.companyId);
    res.json({ id: req.params.issueId, writable: true });
  });
  app.use(errorHandler);
  return app;
}

function craftAgentJwtWithoutResponsibleClaim(input: {
  secret: string;
  agentId: string;
  companyId: string;
  adapterType: string;
  runId: string;
  expiresInSeconds?: number;
}) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims = {
    sub: input.agentId,
    company_id: input.companyId,
    adapter_type: input.adapterType,
    run_id: input.runId,
    iat: now,
    exp: now + (input.expiresInSeconds ?? 3600),
    iss: "paperclip",
    aud: "paperclip-api",
  };
  const headerB64 = Buffer.from(JSON.stringify(header), "utf8").toString("base64url");
  const claimsB64 = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${headerB64}.${claimsB64}`;
  // Sign with the same per-instance, per-company key the server derives. The
  // instance defaults to "default" (beforeEach clears PAPERCLIP_INSTANCE_ID),
  // matching the live control plane this middleware test exercises. This helper
  // only omits the responsible_user_id claim — it is not a cross-instance token.
  const signingKey = createHmac("sha256", input.secret).update(`jwt:default:${input.companyId}`).digest("hex");
  const signature = createHmac("sha256", signingKey).update(signingInput).digest("base64url");
  return `${signingInput}.${signature}`;
}

describe("agent auth middleware", () => {
  const originalSecret = process.env.PAPERCLIP_AGENT_JWT_SECRET;
  const originalTtl = process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
  const originalInstanceId = process.env.PAPERCLIP_INSTANCE_ID;

  beforeEach(() => {
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "auth-middleware-secret";
    process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = "3600";
    // Pin the control-plane instance so mint/verify (and the hand-crafted
    // legacy token helper) all derive keys under the "default" live instance.
    delete process.env.PAPERCLIP_INSTANCE_ID;
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
    else process.env.PAPERCLIP_AGENT_JWT_SECRET = originalSecret;
    if (originalTtl === undefined) delete process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS;
    else process.env.PAPERCLIP_AGENT_JWT_TTL_SECONDS = originalTtl;
    if (originalInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalInstanceId;
  });

  it.each([
    { status: "cancelled", conversationMode: false, requested: false },
    { status: "running", conversationMode: false, requested: true },
    { status: "cancelled", conversationMode: true, requested: false },
    { status: "running", conversationMode: true, requested: true },
  ])("revokes writes but preserves reads for a stopped run: %j", async ({ status, conversationMode, requested }) => {
    const agentId = randomUUID();
    const companyId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId }, run: {
      id: runId, companyId, agentId, status, contextSnapshot: { conversationMode },
      resultJson: requested ? { executionCancellation: { state: "requested" } } : {},
    } });
    const token = createLocalAgentJwt(agentId, companyId, "grok_local", runId, null);
    const client = createApp(db);
    const endpoint = `/companies/${companyId}/issues/${randomUUID()}`;
    const write = await request(client).patch(endpoint).set("Authorization", `Bearer ${token}`).send({ status: "done" });
    expect(write.status).toBe(403);
    expect(write.body.code).toBe(conversationMode ? "conversation_turn_cancelled" : "agent_run_cancelled");
    const read = await request(client).get(endpoint).set("Authorization", `Bearer ${token}`);
    expect(read.status).toBe(200);
    expect(read.body.readable).toBe(true);
  });

  it("keeps header-less local requests as the implicit board actor with their run id", async () => {
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ type: "board", userId: "local-board", runId });
  });

  it.each([
    ["empty bearer token", "Bearer   ", "Empty bearer token"],
    ["unverified token", "Bearer not-a-token", "Agent token did not verify"],
  ])("rejects %s instead of retaining the implicit local-board actor", async (_label, authorization, error) => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    let commentWrites = 0;
    const app = createApp(db, "local_trusted");
    app.post("/comments", (_req, res) => {
      commentWrites += 1;
      res.status(201).json({ ok: true });
    });

    const res = await request(app).post("/comments").set("Authorization", authorization).send({ body: "reply" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain(error);
    expect(commentWrites).toBe(0);
  });

  it.each(["authenticated", "local_trusted"] as const)(
    "leaves webhook authentication to the trigger in %s mode",
    async (deploymentMode) => {
      const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
      const res = await request(createApp(db, deploymentMode))
        .post(`/api/routine-triggers/public/${"a".repeat(24)}/fire`)
        .set("Authorization", "Bearer routine-secret")
        .send({ event: "created" });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ reachedWebhook: true, actorType: "none" });
    },
  );

  it.each([
    `/api/routine-triggers/public/${"a".repeat(24)}/rotate-secret`,
    "/api/routine-triggers/public/not-a-public-id/fire",
    `/api/routine-triggers/public/${"a".repeat(24)}/fire/extra`,
  ])("does not bypass actor authentication for %s", async (path) => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    const res = await request(createApp(db)).post(path).set("Authorization", "Bearer routine-secret");
    expect(res.status).toBe(401);
  });

  it("leaves public MCP gateway bearers for the gateway protocol to validate", async () => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });
    const publicId = `gw_${"a".repeat(32)}`;

    const res = await request(createApp(db, "local_trusted"))
      .post(`/mcp/gateways/${publicId}`)
      .set("Authorization", "Bearer pcgw_runtime_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachedGatewayProtocol: true });
  });

  it("does not bypass actor authentication for lookalike MCP gateway paths", async () => {
    const { db } = createDbState({ agent: { id: randomUUID(), companyId: randomUUID() } });

    const res = await request(createApp(db, "local_trusted"))
      .post("/mcp/gateways/not-a-public-id")
      .set("Authorization", "Bearer pcgw_runtime_token")
      .send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Agent token did not verify");
  });

  it.each([
    ["terminated", "Agent is terminated"],
    ["pending_approval", "Agent is pending approval"],
  ])("rejects a %s agent JWT instead of retaining local-board", async (status, error) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId, status } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain(error);
  });

  it.each(["key", "jwt"])("rejects unfinished setup authentication with a %s", async kind => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = kind === "jwt" ? createLocalAgentJwt(agentId, companyId, "codex_local", randomUUID(), "user-1")! : "pcp_setup-test-token";
    const { db } = createDbState({
      agent: { id: agentId, companyId, status: "paused", lifecycleHolds: ["setup"] },
      ...(kind === "key" ? { agentKey: { id: randomUUID(), agentId, companyId, keyHash: hashToken(token), responsibleUserId: "user-1" } } : {}),
    });
    const res = await request(createApp(db, "local_trusted")).get("/actor").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("setup is incomplete");
  });

  it("rejects an agent JWT when the agent record belongs to another company", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId: randomUUID() } });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-1");

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("missing or belongs to another company");
  });

  it("reports an expired agent JWT specifically", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({ agent: { id: agentId, companyId } });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
      expiresInSeconds: -1,
    });

    const res = await request(createApp(db, "local_trusted"))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toContain("Expired agent token");
  });

  it("uses the signed responsible_user_id claim and keeps the signed run id authoritative", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-row" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      runId,
      onBehalfOfUserId: "user-claim",
      source: "agent_jwt",
    });
  });

  it("preserves signed skill_test JWT scope on the request actor", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim", {
      kind: "skill_test",
      issueId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", runId);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      keyScope: { kind: "skill_test", issueId },
      source: "agent_jwt",
    });
  });

  it("rejects mismatched run headers for agent JWTs and audits the spoof attempt", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const spoofedRunId = randomUUID();
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", spoofedRunId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("agent_jwt_run_id_mismatch");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: runId,
      runId,
      details: { claimRunId: runId, headerRunId: spoofedRunId },
    });
  });

  it("audits a run header mismatch even when the claimed run does not exist", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const claimedRunId = randomUUID();
    const spoofedRunId = randomUUID();
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
    });
    const token = createLocalAgentJwt(agentId, companyId, "codex_local", claimedRunId, "user-claim");

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`)
      .set("X-Paperclip-Run-Id", spoofedRunId);

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("agent_jwt_run_id_mismatch");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_jwt_run_header_mismatch",
      entityType: "heartbeat_run",
      entityId: claimedRunId,
      details: { claimRunId: claimedRunId, headerRunId: spoofedRunId },
    });
    // run_id carries a real FK to heartbeat_runs; a nonexistent claim must not
    // be written into it or the whole audit row is lost to the FK violation.
    expect(activity[0].runId).toBeUndefined();
  });

  it("falls back to the run row responsible user for legacy claim-less agent JWTs", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-legacy" },
    });
    const token = craftAgentJwtWithoutResponsibleClaim({
      secret: process.env.PAPERCLIP_AGENT_JWT_SECRET!,
      agentId,
      companyId,
      adapterType: "codex_local",
      runId,
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      runId,
      onBehalfOfUserId: "user-legacy",
      source: "agent_jwt",
    });
  });

  it("rejects fork-minted run JWTs before issue reads or writes reach live issue data", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      run: { id: runId, companyId, agentId, responsibleUserId: "user-claim" },
    });

    process.env.PAPERCLIP_INSTANCE_ID = "pap-12899-worktree";
    const forkToken = createLocalAgentJwt(agentId, companyId, "codex_local", runId, "user-claim");
    expect(forkToken).not.toBeNull();

    process.env.PAPERCLIP_INSTANCE_ID = "default";
    const app = createApp(db);
    const readRes = await request(app)
      .get(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId);
    const writeRes = await request(app)
      .patch(`/companies/${companyId}/issues/${issueId}`)
      .set("Authorization", `Bearer ${forkToken}`)
      .set("X-Paperclip-Run-Id", runId)
      .send({ title: "should not write" });

    expect(readRes.status).toBe(401);
    expect(writeRes.status).toBe(401);
  });

  it.each([
    "standard",
    [],
    {},
    { kind: "unknown" },
    { kind: "skill_test" },
    { kind: "task_bridge", projectId: "invalid" },
    { kind: "standard", extra: true },
  ].map((scopeConfig) => ({ scopeConfig })))("rejects malformed stored key scope $scopeConfig before protected writes", async ({ scopeConfig }) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_invalid_scope";
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
        scopeConfig,
      },
    });
    let writes = 0;
    const app = createApp(db, "local_trusted");
    app.post("/protected-write", (_req, res) => {
      writes += 1;
      res.status(201).json({ ok: true });
    });
    const res = await request(app).post("/protected-write").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toContain("scope");
    expect(writes).toBe(0);
  });

  it.each([
    null,
    { kind: "standard" },
    { kind: "skill_test", issueId: "11111111-1111-4111-8111-111111111111" },
    { kind: "task_bridge", projectId: "11111111-1111-4111-8111-111111111111" },
  ])("populates valid agent-key actors with scope %j", async (scopeConfig) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const token = "pcp_test_agent_key";
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: randomUUID(),
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: "user-key",
        scopeConfig,
      },
    });

    const res = await request(createApp(db))
      .get("/actor")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      type: "agent",
      agentId,
      companyId,
      onBehalfOfUserId: "user-key",
      source: "agent_key",
      keyScope: scopeConfig ?? { kind: "standard" },
    });
  });

  it("rejects agent keys that lack a responsible user binding and audits the denial", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const keyId = randomUUID();
    const token = "pcp_test_agent_key_without_user";
    const { db, activity } = createDbState({
      agent: { id: agentId, companyId },
      agentKey: {
        id: keyId,
        agentId,
        companyId,
        keyHash: hashToken(token),
        responsibleUserId: null,
      },
    });

    const res = await request(createApp(db))
      .get(`/companies/${companyId}/protected`)
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("RESPONSIBLE_USER_UNAVAILABLE");
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({
      companyId,
      actorType: "agent",
      actorId: agentId,
      action: "auth.agent_key_missing_responsible_user",
      entityType: "agent_api_key",
      entityId: keyId,
      details: { method: "GET", url: `/companies/${companyId}/protected` },
    });
  });
});


describe("approval-reader key scope", () => {
  const companyId = "11111111-1111-4111-8111-111111111111";
  const foreignCompanyId = "22222222-2222-4222-8222-222222222222";
  const approvalId = "33333333-3333-4333-8333-333333333333";
  const foreignApprovalId = "44444444-4444-4444-8444-444444444444";
  const agentId = "55555555-5555-4555-8555-555555555555";
  const token = "pcp_owned_synthetic_approval_reader";
  function readerApp(scopeConfig: unknown = { kind: "approval_reader" }, jwt = false) {
    const { db } = createDbState({
      agent: { id: agentId, companyId },
      ...(!jwt ? { agentKey: { id: randomUUID(), agentId, companyId, keyHash: hashToken(token), responsibleUserId: "synthetic-owner", scopeConfig } } : {}),
      responsibleMembership: { companyId, status: "active", membershipRole: "viewer" },
    });
    const app = express();
    let reached = 0;
    app.use(actorMiddleware(db, { deploymentMode: "authenticated", resolveSession: async () => null }));
    app.get(["/api/approvals/:id", "/api/approvals/:id/issues"], (req, res) => {
      assertCompanyAccess(req, req.params.id === foreignApprovalId ? foreignCompanyId : companyId);
      reached += 1;
      res.json({ id: req.params.id, actor: req.actor.type });
    });
    app.use((_req, res) => { reached += 1; res.json({ otherwiseReached: true }); });
    app.use(errorHandler);
    return { app, reached: () => reached };
  }
  it("accepts only the strict persistent reader scope", () => {
    expect(createAgentKeySchema.parse({ scope: { kind: "approval_reader" } }).scope).toEqual({ kind: "approval_reader" });
    expect(createAgentKeySchema.safeParse({ scope: { kind: "approval_reader", canWrite: true } }).success).toBe(false);
  });
  it.each(["", "/issues"])("reads same-company approval endpoint %s", async (suffix) => {
    const { app, reached } = readerApp();
    const result = await request(app).get(`/api/approvals/${approvalId}${suffix}`).set("Authorization", `Bearer ${token}`);
    expect(result.status).toBe(200);expect(result.body.actor).toBe("agent");expect(reached()).toBe(1);
  });
  it.each(["", "/issues"])("preserves company isolation for endpoint %s", async (suffix) => {
    const { app, reached } = readerApp();
    const result = await request(app).get(`/api/approvals/${foreignApprovalId}${suffix}`).set("Authorization", `Bearer ${token}`);
    expect(result.status).toBe(403);expect(reached()).toBe(0);
  });
  it.each([
    ["post", `/api/approvals/${approvalId}/approve`],
    ["post", `/api/companies/${companyId}/approvals`],
    ["post", `/api/approvals/${approvalId}/comments`],
    ["patch", `/api/agents/${agentId}`],
    ["delete", `/api/agents/${agentId}/keys/synthetic`],
    ["put", `/api/plugins/synthetic/run`],
    ["head", `/api/approvals/${approvalId}`],
    ["options", `/api/approvals/${approvalId}`],
    ["get", `/api/companies/${companyId}/approvals`],
    ["get", `/api/approvals/${approvalId}/comments`],
    ["get", `/api/approvals/${approvalId}/issues/`],
    ["get", `/api/approvals/${approvalId}?extra=1`],
    ["get", `/api/approvals/${approvalId}%2Fissues`],
    ["get", "/api/approvals/not-a-uuid"],
    ["get", "/api/agents/me"],
    ["get", "/api/secrets"],
    ["get", "/api/plugins/synthetic"],
  ] as const)("denies %s %s before any router", async (method, url) => {
    const { app, reached } = readerApp();
    const result = await request(app)[method](url).set("Authorization", `Bearer ${token}`);
    expect(result.status).toBe(403);expect(reached()).toBe(0);
  });
  it("keeps an existing standard key's route access unchanged", async () => {
    const { app, reached } = readerApp({ kind: "standard" });
    const result = await request(app).get("/api/agents/me").set("Authorization", `Bearer ${token}`);
    expect(result.status).toBe(200);expect(reached()).toBe(1);
  });
  it("applies the same narrow gate to a signed reader JWT", async () => {
    const previous = process.env.PAPERCLIP_AGENT_JWT_SECRET;
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "owned-synthetic-reader-jwt-secret";
    try {
      const signed = createLocalAgentJwt(agentId, companyId, "process", randomUUID(), "synthetic-owner", { kind: "approval_reader" });
      expect(signed).toBeTruthy();
      const { app, reached } = readerApp({ kind: "approval_reader" }, true);
      const allowed = await request(app).get(`/api/approvals/${approvalId}`).set("Authorization", `Bearer ${signed}`);
      expect(allowed.status).toBe(200);
      const denied = await request(app).post(`/api/approvals/${approvalId}/approve`).set("Authorization", `Bearer ${signed}`);
      expect(denied.status).toBe(403);expect(reached()).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
      else process.env.PAPERCLIP_AGENT_JWT_SECRET = previous;
    }
  });
});
