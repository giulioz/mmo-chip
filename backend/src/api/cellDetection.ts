import { Router } from "express";
import type {
  CellDetectionDismissRequest,
  CellDetectionStartRequest
} from "shared";
import {
  CellJobBadRequest,
  CellJobBusy,
  createCellJobManager
} from "../ml/cellJobs.js";
import {
  clearCellDetections,
  deleteCellDetection,
  listCellDetections,
  setCellDetectionsDismissed
} from "../ml/cellDetectionStore.js";
import type { MLPredictor } from "../ml/predict.js";
import type { AnnotationBroadcaster } from "../ws.js";

/**
 * Cell detection: propose placements of an annotated cell type across the
 * die from the cached ML vias. Results are per (die, cell type) files the
 * frontend overlays as "ML cells" and approves from merge-cells.
 */
export function createCellDetectionRouter(config: {
  dataRoot: string;
  predictor: MLPredictor;
  broadcaster?: AnnotationBroadcaster;
}) {
  const router = Router();
  const jobs = createCellJobManager({
    dataRoot: config.dataRoot,
    predictor: config.predictor,
    onJobChange: (job) => config.broadcaster?.emitCellJob(job)
  });

  // ── GET /api/dies/:dieId/cell-detections ────────────────────────────
  router.get("/api/dies/:dieId/cell-detections", async (request, response, next) => {
    try {
      response.json(await listCellDetections(config.dataRoot, request.params.dieId));
    } catch (error) {
      next(error);
    }
  });

  // ── DELETE /api/dies/:dieId/cell-detections (all types) ─────────────
  router.delete("/api/dies/:dieId/cell-detections", async (request, response, next) => {
    try {
      await clearCellDetections(config.dataRoot, request.params.dieId);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  // ── Job endpoints (declared before `/:cellTypeId` so "job" isn't an id) ─
  router.get("/api/dies/:dieId/cell-detections/job", (request, response) => {
    response.json(jobs.getJob(request.params.dieId));
  });

  router.post(
    "/api/dies/:dieId/cell-detections/job/start",
    async (request, response, next) => {
      try {
        const body = (request.body ?? {}) as Partial<CellDetectionStartRequest>;
        if (!body.cellTypeId || typeof body.cellTypeId !== "string") {
          response.status(400).json({ error: "cellTypeId is required" });
          return;
        }
        const flag = (v: unknown) => (typeof v === "boolean" ? v : undefined);
        response.json(
          await jobs.startJob(request.params.dieId, body.cellTypeId, {
            allowFlipX: flag(body.allowFlipX),
            allowFlipY: flag(body.allowFlipY),
            avoidExistingCells: flag(body.avoidExistingCells),
            allDies: flag(body.allDies)
          })
        );
      } catch (error) {
        if (error instanceof CellJobBusy) {
          response.status(409).json({ error: error.message });
          return;
        }
        if (error instanceof CellJobBadRequest) {
          response.status(400).json({ error: error.message });
          return;
        }
        next(error);
      }
    }
  );

  router.post("/api/dies/:dieId/cell-detections/job/stop", (request, response) => {
    response.json(jobs.stopJob(request.params.dieId));
  });

  // ── DELETE /api/dies/:dieId/cell-detections/:cellTypeId ─────────────
  router.delete(
    "/api/dies/:dieId/cell-detections/:cellTypeId",
    async (request, response, next) => {
      try {
        const { dieId, cellTypeId } = request.params;
        await deleteCellDetection(config.dataRoot, dieId, cellTypeId);
        response.json({ ok: true });
      } catch (error) {
        next(error);
      }
    }
  );

  // ── POST /api/dies/:dieId/cell-detections/:cellTypeId/dismiss ───────
  router.post(
    "/api/dies/:dieId/cell-detections/:cellTypeId/dismiss",
    async (request, response, next) => {
      try {
        const { dieId, cellTypeId } = request.params;
        const body = (request.body ?? {}) as Partial<CellDetectionDismissRequest>;
        if (!Array.isArray(body.ids) || !body.ids.every((id) => typeof id === "string")) {
          response.status(400).json({ error: "ids must be a string array" });
          return;
        }
        const updated = await setCellDetectionsDismissed(
          config.dataRoot,
          dieId,
          cellTypeId,
          body.ids,
          body.dismissed !== false
        );
        if (!updated) {
          response.status(404).json({ error: "No detection results for this cell type" });
          return;
        }
        response.json(updated);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}
