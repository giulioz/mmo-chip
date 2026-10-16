import { dataPath, limits } from "../security.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import multer from "multer";
import type { DieUpdateRequest } from "shared";
import { normalizeCellLibrary } from "shared/cellLibrary";
import type { createImportJobManager } from "../dieImport/jobs.js";
import {
  deleteDieRecord,
  deleteImportJobsForDie,
  ensureDataStore,
  listDieRecords,
  readDieRecord,
  withDieLock,
  writeDieRecord
} from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";
import type { DieRecord } from "../types.js";
import type { AnnotationBroadcaster } from "../ws.js";
import { toPublicImportJob } from "./jobs.js";

/** Bounds on `cellScale` — a die photographed 1000× larger or smaller than
 *  another of its library is a typo, not a scale. */
const MIN_CELL_SCALE = 1e-3;
const MAX_CELL_SCALE = 1e3;

export function createDiesRouter(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
  importJobManager: ReturnType<typeof createImportJobManager>;
  broadcaster?: AnnotationBroadcaster;
}) {
  const router = Router();
  const uploadDirectory = dataPath(config.dataRoot, "tmp");
  const upload = multer({ dest: uploadDirectory, limits: { fileSize: limits.uploadBytes, files: 1, fields: 8, parts: 9, fieldSize: 4096 } });

  router.get("/api/dies", async (_request, response, next) => {
    try {
      const records = await listDieRecords(config.dataRoot);
      response.json(
        records.map((record) => toSummary(record, config.tileScheduler.getProgress(record.id)))
      );
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/dies/:dieId", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      response.json(toPublicRecord(record, config.tileScheduler.getProgress(record.id)));
    } catch (error) {
      next(error);
    }
  });

  // Die properties: the cell library it belongs to and its scale in it.
  router.patch("/api/dies/:dieId", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      const patch = parseDieUpdate(request.body);
      if (typeof patch === "string") {
        response.status(400).json({ error: patch });
        return;
      }
      const record = await withDieLock(dieId, async () => {
        const current = await readDieRecord(config.dataRoot, dieId);
        const next: DieRecord = { ...current, updatedAt: new Date().toISOString() };
        if ("cellLibrary" in patch) {
          if (patch.cellLibrary) next.cellLibrary = patch.cellLibrary;
          else delete next.cellLibrary;
        }
        if ("cellScale" in patch) {
          if (patch.cellScale != null) next.cellScale = patch.cellScale;
          else delete next.cellScale;
        }
        await writeDieRecord(config.dataRoot, next);
        return next;
      });
      config.broadcaster?.emitDieChange(dieId);
      response.json(toPublicRecord(record, config.tileScheduler.getProgress(record.id)));
    } catch (error) {
      next(error);
    }
  });

  router.delete("/api/dies/:dieId", async (request, response, next) => {
    try {
      const record = await readDieRecord(config.dataRoot, request.params.dieId);
      await config.tileScheduler.removeDie(request.params.dieId);
      await deleteDieRecord(config.dataRoot, request.params.dieId);
      await deleteImportJobsForDie(config.dataRoot, request.params.dieId);
      response.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  let uploads = 0;
  const uploadAdmission: import("express").RequestHandler = (_request, response, next) => {
    if (uploads >= 2) { response.status(429).json({ error: "Upload slots are busy; retry later" }); return; }
    uploads++;
    let released = false;
    const release = () => { if (!released) { uploads--; released = true; } };
    response.once("finish", release); response.once("close", release);
    next();
  };
  router.post("/api/dies/import", uploadAdmission, upload.single("file"), async (request, response, next) => {
    if (!request.file) {
      response.status(400).send("Expected one uploaded file.");
      return;
    }

    try {
      await ensureDataStore(config.dataRoot);
      const job = await config.importJobManager.enqueueImportJob(request.file);
      response.status(202).json(toPublicImportJob(job));
    } catch (error) {
      next(error);
    } finally {
      await fs.rm(request.file.path, { force: true });
    }
  });

  return router;
}

/** Validate a `PATCH /api/dies/:dieId` body. Returns the fields to change
 *  (library name normalised, empty ⇒ cleared) or an error message. */
export function parseDieUpdate(body: unknown): DieUpdateRequest | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "Expected a JSON object";
  const input = body as Record<string, unknown>;
  const out: DieUpdateRequest = {};
  if ("cellLibrary" in input) {
    const v = input.cellLibrary;
    if (v !== null && typeof v !== "string") return "cellLibrary must be a string or null";
    out.cellLibrary = normalizeCellLibrary(v);
  }
  if ("cellScale" in input) {
    const v = input.cellScale;
    if (v === null) out.cellScale = null;
    else if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < MIN_CELL_SCALE ||
      v > MAX_CELL_SCALE
    ) {
      return `cellScale must be a number in [${MIN_CELL_SCALE}, ${MAX_CELL_SCALE}] or null`;
    } else out.cellScale = v;
  }
  if (!("cellLibrary" in out) && !("cellScale" in out)) return "Nothing to update";
  return out;
}

function toSummary(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>
) {
  const { originalPath, levels, tileFormat, ...summary } = record;
  return tileProgress ? { ...summary, tileProgress } : summary;
}

function toPublicRecord(
  record: DieRecord,
  tileProgress: ReturnType<ReturnType<typeof createTileScheduler>["getProgress"]>
) {
  const { originalPath, ...publicRecord } = record;
  return tileProgress ? { ...publicRecord, tileProgress } : publicRecord;
}
