import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { createExecutionBindingSchema } from "@paperclipai/shared/execution-bindings";
import { validate } from "../middleware/validate.js";
import { executionBindingService } from "../services/execution-bindings.js";
import {
  executionBindingRequirementsSchema,
  selectExecutionBinding,
} from "../services/execution-binding-policy.js";
import { isProcessGroupAlive } from "../services/local-service-supervisor.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

function processMayBeAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function executionBindingRoutes(db: Db) {
  const router = Router();
  const service = executionBindingService(db);
  router.get("/companies/:companyId/execution-bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.json(await service.list(companyId));
  });
  router.post(
    "/companies/:companyId/execution-bindings",
    validate(createExecutionBindingSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      res
        .status(201)
        .json(await service.create(companyId, req.body, getActorInfo(req)));
    },
  );
  router.post(
    "/companies/:companyId/execution-bindings/preview",
    validate(
      z
        .object({
          agentId: z.string().uuid(),
          requirements: executionBindingRequirementsSchema,
        })
        .strict(),
    ),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      res.json(
        selectExecutionBinding({
          companyId,
          agentId: req.body.agentId,
          requirements: req.body.requirements,
          candidates: await service.list(companyId),
          now: new Date(),
        }),
      );
    },
  );
  router.post(
    "/companies/:companyId/execution-bindings/:bindingId/disable",
    validate(z.object({}).strict()),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      res.json(
        await service.disable(
          companyId,
          req.params.bindingId as string,
          getActorInfo(req),
        ),
      );
    },
  );
  router.get(
    "/companies/:companyId/runs/:runId/execution-binding",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      const record = await service.getRunBinding(
        companyId,
        req.params.runId as string,
      );
      // The boot-local owner token is never an API credential or public record.
      res.json(record ? { ...record, ownerId: undefined } : null);
    },
  );
  router.post(
    "/companies/:companyId/runs/:runId/execution-binding/reconcile",
    validate(
      z
        .object({
          checkpointRef: z.string().trim().min(1).max(500),
          pendingEffectsReviewed: z.literal(true),
        })
        .strict(),
    ),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoard(req);
      assertCompanyAccess(req, companyId);
      res.json(
        await service.reconcile({
          companyId,
          runId: req.params.runId as string,
          checkpointRef: req.body.checkpointRef,
          isProcessAlive: processMayBeAlive,
          isProcessGroupAlive,
          activity: getActorInfo(req),
        }),
      );
    },
  );
  return router;
}
