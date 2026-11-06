import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { intelligentRoutingRoutes } from "../routes/intelligent-routing.js";
import { errorHandler } from "../middleware/index.js";

const service = vi.hoisted(() => ({
  context: vi.fn(),
  latest: vi.fn(),
  preview: vi.fn(),
  create: vi.fn(),
}));
vi.mock(
  "../services/intelligent-routing-contracts.js",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    intelligentRoutingContractService: () => service,
  }),
);
const companyId = "11111111-1111-4111-8111-111111111111";
const issueId = "22222222-2222-4222-8222-222222222222";
const board = {
  type: "board",
  userId: "owner",
  companyIds: [companyId],
  source: "session",
};
const base = `/api/companies/${companyId}/issues/${issueId}/intelligent-routing`;
const digest = "a".repeat(64);
const input = {
  expectedInputDigest: digest,
  expectedRevision: 0,
  requirements: {
    version: 1,
    taskFamily: "synthetic",
    benchmarkDigest: digest,
    benchmarkCaseDigests: [digest],
    rubricDigest: digest,
    evaluationPolicyDigest: digest,
    trustedEvaluatorProfileDigests: [digest],
    frontierReviewerProfileDigests: [],
    requiredCapabilities: ["text"],
    requiredModalities: ["text"],
    requiredContextTokens: 100,
    dataClass: "synthetic",
    risk: "low",
    minimumQualityLowerBound: 0.9,
    minimumSampleCount: 1,
    requireFrontierReview: true,
    maximumObservationAgeMs: 1000,
    frontierBaselineProfileDigests: [],
  },
  candidates: [
    {
      profile: {
        version: 1,
        bindingId: issueId,
        accountKey: "fixture",
        harness: "codex_local",
        model: "exact",
        expectedServedModelId: "exact",
        effort: "high",
        configurationDigest: digest,
        modelDeployment: "frontier",
        deliveryMode: "static_native",
      },
      advertisedCapabilities: [],
      evaluations: [],
      baseline: null,
      observation: {
        version: 1,
        profileDigest: digest,
        observedAt: "2026-09-07T12:00:00Z",
        expiresAt: "2026-09-08T12:00:00Z",
        available: true,
        availableCapacity: 1,
        remainingQuota: null,
        billingRoute: "native_subscription",
        billingApproved: true,
      },
    },
  ],
};
function appFor(actor = board as Record<string, unknown>) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    intelligentRoutingRoutes({} as never, { resolveSnapshot: vi.fn() }),
  );
  app.use(errorHandler);
  return app;
}
beforeEach(() => vi.clearAllMocks());
describe("intelligent routing board authority", () => {
  it.each(["context", "contracts/latest"])(
    "keeps %s behind same-company board access",
    async (suffix) => {
      expect(
        (
          await request(
            appFor({ type: "agent", companyId, agentId: issueId }),
          ).get(`${base}/${suffix}`)
        ).status,
      ).toBe(403);
      expect(
        (
          await request(appFor({ ...board, companyIds: [issueId] })).get(
            `${base}/${suffix}`,
          )
        ).status,
      ).toBe(403);
      expect(service.context).not.toHaveBeenCalled();
      expect(service.latest).not.toHaveBeenCalled();
    },
  );
  it("returns digest-only context through the authorised service", async () => {
    service.context.mockResolvedValue({
      inputDigest: "frozen",
      latestRevision: 0,
      profiles: [],
    });
    const result = await request(appFor()).get(`${base}/context`);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ inputDigest: "frozen" });
    expect(service.context).toHaveBeenCalledWith(companyId, issueId);
  });
  it.each(["preview", "contracts"])(
    "rejects unauthorised writes to %s before service dispatch",
    async (suffix) => {
      expect(
        (
          await request(appFor({ type: "agent", companyId, agentId: issueId }))
            .post(`${base}/${suffix}`)
            .send({})
        ).status,
      ).toBe(403);
      expect(
        (
          await request(appFor({ ...board, companyIds: [issueId] }))
            .post(`${base}/${suffix}`)
            .send({})
        ).status,
      ).toBe(403);
      expect(service.preview).not.toHaveBeenCalled();
      expect(service.create).not.toHaveBeenCalled();
    },
  );
  it("rejects raw training content and client-supplied binding definitions", async () => {
    expect(
      (
        await request(appFor())
          .post(`${base}/contracts`)
          .send({
            trainingData: "raw local sample",
            candidates: [{ binding: { command: "/attacker" } }],
          })
      ).status,
    ).toBe(400);
    expect(service.create).not.toHaveBeenCalled();
  });
  it("attributes a valid contract to the authenticated board owner", async () => {
    service.create.mockResolvedValue({ id: "created" });
    expect(
      (await request(appFor()).post(`${base}/contracts`).send(input)).status,
    ).toBe(201);
    expect(service.create).toHaveBeenCalledWith(
      companyId,
      issueId,
      input,
      "owner",
    );
    expect(service.preview).not.toHaveBeenCalled();
    expect(
      (
        await request(appFor())
          .post(`${base}/contracts`)
          .send({ ...input, createdByUserId: "another-owner" })
      ).status,
    ).toBe(400);
    expect(service.create).toHaveBeenCalledOnce();
  });
  it("keeps a valid preview separate from contract creation", async () => {
    service.preview.mockResolvedValue({ decision: { status: "no_selection" } });
    const result = await request(appFor()).post(`${base}/preview`).send(input);
    expect(result.status).toBe(200);
    expect(service.preview).toHaveBeenCalledWith(companyId, issueId, input);
    expect(service.create).not.toHaveBeenCalled();
  });
});
