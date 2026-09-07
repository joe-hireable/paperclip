import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  intelligentRoutingContractInputSchema,
  intelligentRoutingContractService,
  type IntelligentRoutingContractOptions,
} from "../services/intelligent-routing-contracts.js";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

export function intelligentRoutingRoutes(
  db: Db,
  options: IntelligentRoutingContractOptions,
) {
  const router = Router();
  const service = intelligentRoutingContractService(db, options);
  const base = "/companies/:companyId/issues/:issueId/intelligent-routing";
  router.use(base, (req, _res, next) => {
    assertBoard(req);
    assertCompanyAccess(req, req.params.companyId as string);
    next();
  });
  router.get(`${base}/context`, async (req, res) => {
    res.json(
      await service.context(
        req.params.companyId as string,
        req.params.issueId as string,
      ),
    );
  });
  router.get(`${base}/contracts/latest`, async (req, res) => {
    res.json(
      await service.latest(
        req.params.companyId as string,
        req.params.issueId as string,
      ),
    );
  });
  router.post(
    `${base}/preview`,
    validate(intelligentRoutingContractInputSchema),
    async (req, res) => {
      res.json(
        await service.preview(
          req.params.companyId as string,
          req.params.issueId as string,
          req.body,
        ),
      );
    },
  );
  router.post(
    `${base}/contracts`,
    validate(intelligentRoutingContractInputSchema),
    async (req, res) => {
      const actor = getActorInfo(req);
      res
        .status(201)
        .json(
          await service.create(
            req.params.companyId as string,
            req.params.issueId as string,
            req.body,
            actor.actorId,
          ),
        );
    },
  );
  return router;
}
