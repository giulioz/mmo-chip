import { imageWork } from "../workQueue.js";
import { Router } from "express";
import type { MLExportRequest } from "shared";
import { runMLExport } from "../mlExport/exporter.js";
import { readDieRecord } from "../store.js";

export function createMLExportRouter(config: { dataRoot: string }) {
  const router = Router();

  router.post("/api/dies/:dieId/ml-export", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      // Validate the die exists before kicking off the background job.
      await readDieRecord(config.dataRoot, dieId);

      const body = (request.body ?? {}) as Partial<MLExportRequest>;
      const approxViaRadiusPx = Number(body.approxViaRadiusPx);
      if (!Number.isFinite(approxViaRadiusPx) || approxViaRadiusPx <= 0) {
        response.status(400).json({ error: "approxViaRadiusPx must be a positive number" });
        return;
      }

      // Fire-and-forget. Errors are logged but not surfaced to the client —
      // the client gets 202 once the job is scheduled.
      void imageWork(() => runMLExport({
        dataRoot: config.dataRoot,
        dieId,
        approxViaRadiusPx,
        logger: (message) => console.log(message),
      })).catch((error) => {
        console.error(`[ml-export] ${dieId} failed`, error);
      });

      response.status(202).json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
