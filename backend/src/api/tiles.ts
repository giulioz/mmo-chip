import { checkRegion, dataPath, limits, safeId } from "../security.js";
import { imageWork } from "../workQueue.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import sharp from "sharp";
import { resolveCellType } from "../cellLibrary.js";
import { footprint, orientOf } from "../ml/cellDetect.js";
import { readAnnotations, readDieRecord } from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";

export function createTilesRouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
}) {
  const router = Router();

  router.get("/api/dies/:dieId/cells/:cellId/crop", async (request, response, next) => {
    try {
      const { dieId, cellId } = request.params;
      safeId(cellId);
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);

      const cell = annotations.cells.find((c) => c.id === cellId);
      if (!cell) { response.status(404).json({ error: "Cell not found" }); return; }
      // Own type, or a library type owned by another die (in this die's px).
      const cellType = (
        await resolveCellType(config.dataRoot, record, annotations, cell.cellTypeId, cell.cellTypeDieId)
      )?.type;
      if (!cellType) { response.status(404).json({ error: "Cell type not found" }); return; }

      // Crop region = the instance's die footprint: the W×H box oriented about
      // its centre, so a quarter turn swaps its extent.
      const { width: cropW, height: cropH } = cellType.cropRect;
      const fp = footprint(cell.x, cell.y, orientOf(cell), cropW, cropH);
      const quarter = cell.rotation === 90 || cell.rotation === 270;
      const fullW = Math.round(quarter ? cropH : cropW);
      const fullH = Math.round(quarter ? cropW : cropH);
      const left = Math.max(0, Math.round(fp.x0));
      const top = Math.max(0, Math.round(fp.y0));
      const width = Math.min(fullW, record.width - left);
      const height = Math.min(fullH, record.height - top);

      // Check cache. The key includes coords so re-aligning invalidates the old
      // cache; a footprint the shape of the type's box keeps the original key
      // (existing crops stay valid), a quarter-turned one adds its size.
      const cacheDir = dataPath(config.dataRoot, "dies", safeId(dieId), "cell-crops");
      const shape =
        fullW === Math.round(cropW) && fullH === Math.round(cropH) ? "" : `-${fullW}x${fullH}`;
      const cachePath = path.join(cacheDir, `${cellId}-${left}-${top}${shape}.jpg`);
      dataPath(config.dataRoot, path.relative(config.dataRoot, cachePath));
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      // Find original image
      const originalPath = record.originalPath;

      if (width <= 0 || height <= 0) { response.status(400).json({ error: "Invalid crop region" }); return; }

      checkRegion(width, height);
      dataPath(config.dataRoot, path.relative(config.dataRoot, cachePath));
      await fs.mkdir(cacheDir, { recursive: true });
      await imageWork(() => sharp(originalPath, { limitInputPixels: limits.imagePixels })
        .extract({ left, top, width, height })
        .jpeg({ quality: 90 })
        .toFile(cachePath));

      response.sendFile(cachePath);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/cell-types/:cellTypeId/crop", async (request, response, next) => {
    try {
      const { dieId, cellTypeId } = request.params;
      safeId(cellTypeId);
      const record = await readDieRecord(config.dataRoot, dieId);
      const annotations = await readAnnotations(config.dataRoot, dieId);

      const cellType = annotations.cellTypes.find((ct) => ct.id === cellTypeId);
      if (!cellType) { response.status(404).json({ error: "Cell type not found" }); return; }

      // For cell types created via "extract cell type", cropRect has the actual image position.
      // For cell types from "add cell", cropRect is at (0,0) — use the first cell instance.
      let cropX = cellType.cropRect.x;
      let cropY = cellType.cropRect.y;
      if (cropX === 0 && cropY === 0 && cellType.cropRect.width > 0) {
        const cell = annotations.cells.find((c) => c.cellTypeId === cellTypeId);
        if (cell) { cropX = cell.x; cropY = cell.y; }
      }

      // Check cache
      const cacheDir = dataPath(config.dataRoot, "dies", safeId(dieId), "cell-crops");
      const cachePath = path.join(cacheDir, `ct-${cellTypeId}.jpg`);
      dataPath(config.dataRoot, path.relative(config.dataRoot, cachePath));
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      const originalPath = record.originalPath;

      const left = Math.max(0, Math.round(cropX));
      const top = Math.max(0, Math.round(cropY));
      const width = Math.min(Math.round(cellType.cropRect.width), record.width - left);
      const height = Math.min(Math.round(cellType.cropRect.height), record.height - top);

      if (width <= 0 || height <= 0) { response.status(400).json({ error: "Invalid crop region" }); return; }

      checkRegion(width, height);
      dataPath(config.dataRoot, path.relative(config.dataRoot, cachePath));
      await fs.mkdir(cacheDir, { recursive: true });
      await imageWork(() => sharp(originalPath, { limitInputPixels: limits.imagePixels })
        .extract({ left, top, width, height })
        .jpeg({ quality: 90 })
        .toFile(cachePath));

      response.sendFile(cachePath);
    } catch (error) {
      next(error);
    }
  });

  // Crop an arbitrary source rect — thumbnails for ML cell proposals, which
  // have no cell id yet. Cached like cell crops (keyed by the rect).
  router.get("/api/dies/:dieId/crop", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const q = request.query;
      const x = Math.round(Number(q.x));
      const y = Math.round(Number(q.y));
      const w = Math.round(Number(q.w));
      const h = Math.round(Number(q.h));
      if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || w > 4096 || h > 4096) {
        response.status(400).json({ error: "x, y, w, h (source px, w/h ≤ 4096) required" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      const left = Math.max(0, x);
      const top = Math.max(0, y);
      const width = Math.min(w, record.width - left);
      const height = Math.min(h, record.height - top);
      if (width <= 0 || height <= 0) { response.status(400).json({ error: "Invalid crop region" }); return; }

      const cacheDir = dataPath(config.dataRoot, "dies", safeId(dieId), "cell-crops");
      const cachePath = path.join(cacheDir, `rect-${left}-${top}-${width}-${height}.jpg`);
      dataPath(config.dataRoot, path.relative(config.dataRoot, cachePath));
      try {
        await fs.access(cachePath);
        response.sendFile(cachePath);
        return;
      } catch { /* cache miss */ }

      const originalPath = record.originalPath;

      checkRegion(width, height);
      dataPath(config.dataRoot, path.relative(config.dataRoot, cachePath));
      await fs.mkdir(cacheDir, { recursive: true });
      await imageWork(() => sharp(originalPath, { limitInputPixels: limits.imagePixels })
        .extract({ left, top, width, height })
        .jpeg({ quality: 90 })
        .toFile(cachePath));
      response.sendFile(cachePath);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId/tiles/:z/:x/:y", async (request, response, next) => {
    try {
      const { dieId, z, x, y } = request.params;
      const record = await readDieRecord(config.dataRoot, dieId);
      const zIndex = Number(z);
      const xIndex = Number(x);
      const yIndex = Number(y);

      if (
        !Number.isInteger(zIndex) ||
        !Number.isInteger(xIndex) ||
        !Number.isInteger(yIndex)
      ) {
        response.status(400).json({ error: "Invalid tile coordinates" });
        return;
      }

      const tilePath = await config.tileScheduler.requestTile(record, zIndex, xIndex, yIndex);
      response.sendFile(tilePath);
    } catch (error) {
      if (
        error instanceof Error &&
        /Tile (level|coordinates) out of range/.test(error.message)
      ) {
        response.status(404).json({ error: "Tile not found" });
        return;
      }

      next(error);
    }
  });

  return router;
}
