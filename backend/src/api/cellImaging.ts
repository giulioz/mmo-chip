import { promises as fs } from "node:fs";
import { Router } from "express";
import type { CellImagingStartRequest } from "shared";
import {
  createCellImagingJobManager,
  ImagingJobBadRequest,
  ImagingJobBusy
} from "../imaging/jobs.js";
import {
  clearSpecimens,
  clearWireMap,
  readSpecimenIndex,
  readWireMapInfo,
  specimenDisplayPath,
  specimenPath,
  wireTilePath
} from "../imaging/store.js";
import type { createTileScheduler } from "../tileScheduler.js";
import type { AnnotationBroadcaster } from "../ws.js";

/** 1×1 fully transparent PNG — served for overlay tiles with nothing in them
 *  so the viewer's <img> loads cleanly instead of logging a 404 per tile. */
const EMPTY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64"
);

/**
 * Cell imaging: clean per-type specimens and the wire-likelihood overlay.
 * Everything here is derived data in its own folders; clearing it never
 * touches the annotations.
 */
export function createCellImagingRouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
  broadcaster?: AnnotationBroadcaster;
}) {
  const router = Router();
  const jobs = createCellImagingJobManager({
    dataRoot: config.dataRoot,
    tileScheduler: config.tileScheduler,
    onJobChange: (job) => config.broadcaster?.emitImagingJob(job)
  });

  router.get("/api/dies/:dieId/cell-specimens", async (request, response, next) => {
    try {
      response.json(await readSpecimenIndex(config.dataRoot, request.params.dieId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/cell-specimens/:cellTypeId/image", async (request, response, next) => {
    try {
      const { dieId, cellTypeId } = request.params;
      if (!/^[\w-]+$/.test(cellTypeId)) {
        response.status(400).json({ error: "bad cell type id" });
        return;
      }
      // Default: the sharpened high-resolution rendering for display.
      // `?scale=1` returns the plain 1× median (the wire map's reference).
      const plain = specimenPath(config.dataRoot, dieId, cellTypeId);
      const display = specimenDisplayPath(config.dataRoot, dieId, cellTypeId);
      let file = plain;
      if (request.query.scale !== "1") {
        try {
          await fs.access(display);
          file = display;
        } catch {
          // older specimen set without a display rendering
        }
      }
      await fs.access(file);
      response.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/dies/:dieId/cell-specimens", async (request, response, next) => {
    try {
      await clearSpecimens(config.dataRoot, request.params.dieId);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/wire-map", async (request, response, next) => {
    try {
      response.json(await readWireMapInfo(config.dataRoot, request.params.dieId));
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/wire-map/tiles/:z/:x/:y", async (request, response, next) => {
    try {
      const z = Number(request.params.z);
      const x = Number(request.params.x);
      const y = Number(request.params.y);
      if (![z, x, y].every((n) => Number.isInteger(n) && n >= 0)) {
        response.status(400).json({ error: "Invalid tile coordinates" });
        return;
      }
      const file = wireTilePath(config.dataRoot, request.params.dieId, z, x, y);
      try {
        await fs.access(file);
        response.sendFile(file);
      } catch {
        response.type("png").send(EMPTY_PNG);
      }
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/dies/:dieId/wire-map", async (request, response, next) => {
    try {
      await clearWireMap(config.dataRoot, request.params.dieId);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/cell-imaging/job", (request, response) => {
    response.json(jobs.getJob(request.params.dieId));
  });

  router.post("/api/dies/:dieId/cell-imaging/job/start", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<CellImagingStartRequest>;
      if (body.kind !== "specimens" && body.kind !== "wireMap") {
        response.status(400).json({ error: 'kind must be "specimens" or "wireMap"' });
        return;
      }
      response.json(await jobs.start(request.params.dieId, body.kind, { allDies: body.allDies === true }));
    } catch (error) {
      if (error instanceof ImagingJobBusy) {
        response.status(409).json({ error: error.message });
        return;
      }
      if (error instanceof ImagingJobBadRequest) {
        response.status(400).json({ error: error.message });
        return;
      }
      next(error);
    }
  });

  router.post("/api/dies/:dieId/cell-imaging/job/stop", (request, response) => {
    response.json(jobs.stop(request.params.dieId));
  });

  return router;
}
