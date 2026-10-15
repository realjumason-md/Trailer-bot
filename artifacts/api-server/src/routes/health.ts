import { Router, type IRouter } from "express";
import { HealthCheckResponse } from "@workspace/api-zod";
import { isApplicationReady } from "../lib/readiness";

const router: IRouter = Router();

router.get("/healthz", (_req, res) => {
  if (!isApplicationReady()) {
    res.sendStatus(503);
    return;
  }

  const data = HealthCheckResponse.parse({ status: "ok" });
  res.json(data);
});

export default router;
