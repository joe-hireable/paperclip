import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { executionBindingRoutes } from "../routes/execution-bindings.js";
import { errorHandler } from "../middleware/index.js";

const service = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  disable: vi.fn(),
  getRunBinding: vi.fn(),
  reconcile: vi.fn(),
}));
vi.mock("../services/execution-bindings.js", () => ({
  executionBindingService: () => service,
}));
const companyId = randomUUID();
const roleId = randomUUID();
const bindingId = randomUUID();
const definition = {
  name: "Test",
  accountKey: "native:one",
  adapterType: "codex_local",
  command: "/native/codex",
  nativeProfileHome: "/native/profile",
  models: ["model"],
  capabilities: ["text"],
  dataClasses: ["synthetic"],
  allowedAgentIds: [roleId],
  billingRoute: "native_subscription",
  evidenceRefs: ["test://proof"],
  verifiedUntil: "2099-01-01T00:00:00Z",
};
function appFor(actor: Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", executionBindingRoutes({} as never));
  app.use(errorHandler);
  return app;
}
const board = {
  type: "board",
  userId: "board",
  companyIds: [companyId],
  source: "session",
};
beforeEach(() => {
  vi.clearAllMocks();
  service.list.mockResolvedValue([]);
});
describe("execution binding board API", () => {
  it("allows only board members of the binding's company to create definitions", async () => {
    const path = `/api/companies/${companyId}/execution-bindings`;
    expect(
      (
        await request(appFor({ type: "agent", companyId, agentId: roleId }))
          .post(path)
          .send(definition)
      ).status,
    ).toBe(403);
    expect(
      (
        await request(appFor({ ...board, companyIds: [randomUUID()] }))
          .post(path)
          .send(definition)
      ).status,
    ).toBe(403);
    expect(service.create).not.toHaveBeenCalled();
    service.create.mockResolvedValue({ ...definition, id: bindingId });
    expect(
      (await request(appFor(board)).post(path).send(definition)).status,
    ).toBe(201);
    expect(service.create).toHaveBeenCalledOnce();
  });
  it("keeps run snapshots and native profile metadata behind board access", async () => {
    const app = appFor({ type: "agent", companyId, agentId: roleId });
    expect(
      (await request(app).get(`/api/companies/${companyId}/execution-bindings`))
        .status,
    ).toBe(403);
    expect(
      (
        await request(app).get(
          `/api/companies/${companyId}/runs/${randomUUID()}/execution-binding`,
        )
      ).status,
    ).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
    expect(service.getRunBinding).not.toHaveBeenCalled();
  });
  it("does not expose reservation owner capabilities", async () => {
    service.getRunBinding.mockResolvedValue({
      runId: "run",
      ownerId: "private-owner",
      snapshot: { bindingId },
    });
    const response = await request(appFor(board)).get(
      `/api/companies/${companyId}/runs/${randomUUID()}/execution-binding`,
    );
    expect(response.status).toBe(200);
    expect(response.body.ownerId).toBeUndefined();
  });
  it("previews qualified selection without reserving capacity or starting a run", async () => {
    service.list.mockResolvedValue([
      {
        ...definition,
        id: bindingId,
        companyId,
        enabled: true,
        createdAt: new Date(),
      },
    ]);
    const response = await request(appFor(board))
      .post(`/api/companies/${companyId}/execution-bindings/preview`)
      .send({
        agentId: roleId,
        requirements: {
          model: "model",
          requiredCapabilities: ["text"],
          dataClass: "synthetic",
          reason: "Bounded synthetic work",
          evidenceRefs: ["test://task"],
          preferredBindingIds: [],
        },
      });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "selected",
      capacityReserved: false,
      quota: "unknown",
      selection: { bindingId },
    });
    expect(service.create).not.toHaveBeenCalled();
  });
  it("requires a board checkpoint and explicit effect review before orphan reconciliation", async () => {
    const path = `/api/companies/${companyId}/runs/${randomUUID()}/execution-binding/reconcile`;
    const response = await request(appFor(board)).post(path).send({
      checkpointRef: "task://checkpoint",
      pendingEffectsReviewed: false,
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(service.reconcile).not.toHaveBeenCalled();
    expect(
      (
        await request(appFor({ type: "agent", companyId, agentId: roleId }))
          .post(path)
          .send({
            checkpointRef: "task://checkpoint",
            pendingEffectsReviewed: true,
          })
      ).status,
    ).toBe(403);
  });
});
