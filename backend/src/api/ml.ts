import { dataPath, DEV_TOKEN, HttpError } from "../security.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Router } from "express";
import type {
  MLJobStatus,
  MLModelsResponse,
  MLPrediction,
  MLSelectModelRequest,
  MLServiceStatus,
  MLTrainRequest,
  MLViasTileResult,
  MLViasTilesResponse
} from "shared";
import { createMLJobManager } from "../ml/jobs.js";
import {
  createMLPredictor,
  INFERENCE_MIN_DISTANCE,
  INFERENCE_THRESHOLD,
  resolveTile,
  SidecarUnavailable,
  toPrediction,
  type MLPredictor
} from "../ml/predict.js";
import { readDieRecord } from "../store.js";
import type { AnnotationBroadcaster } from "../ws.js";

const HEALTH_TIMEOUT_MS = 3000;
const SIDECAR_RW_TIMEOUT_MS = 10000;
/** Hard cap on a single batched range request (the frontend fetches in
 *  blocks well under this; the cap just guards against a pathological URL). */
const MAX_RANGE_TILES = 4096;

async function fetchSidecar(
  url: string,
  timeoutMs: number,
  init?: RequestInit
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = new Headers(init?.headers); headers.set("x-chiptool-token", DEV_TOKEN);
    return await fetch(url, { ...init, headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function createMLRouter(config: {
  mlSidecarUrl: string;
  dataRoot: string;
  mlPredictPad: number;
  broadcaster?: AnnotationBroadcaster;
  /** Share one predictor (and its memory cache) with other routers. */
  predictor?: MLPredictor;
}) {
  const router = Router();
  const predictor = config.predictor ?? createMLPredictor(config);
  const jobs = createMLJobManager({
    dataRoot: config.dataRoot,
    predictor,
    onJobChange: (job) => config.broadcaster?.emitMLJob(job)
  });

  function send503IfUnavailable(
    error: unknown,
    response: import("express").Response
  ): boolean {
    if (error instanceof SidecarUnavailable) {
      response.status(503).json({ error: error.message });
      return true;
    }
    return false;
  }

  // ── GET /api/ml/status ──────────────────────────────────────────────
  router.get("/api/ml/status", async (_request, response) => {
    try {
      const res = await fetchSidecar(
        `${config.mlSidecarUrl}/health`,
        HEALTH_TIMEOUT_MS
      );
      if (!res.ok) {
        response.json({ reachable: false } satisfies MLServiceStatus);
        return;
      }
      const body = (await res.json()) as Record<string, unknown>;
      response.json({
        reachable: true,
        status: body.status as string,
        device: body.device as string,
        checkpoint: (body.checkpoint as string | null) ?? null,
        checkpointHash: (body.checkpoint_hash as string | null) ?? null,
        encoder: body.encoder as string,
        modelLoaded: Boolean(body.model_loaded),
        trainingActive: Boolean(body.training_active)
      } satisfies MLServiceStatus);
    } catch {
      response.json({ reachable: false } satisfies MLServiceStatus);
    }
  });

  // ── GET /api/ml/models ──────────────────────────────────────────────
  router.get("/api/ml/models", async (_request, response, next) => {
    try {
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/models`,
          HEALTH_TIMEOUT_MS
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `sidecar /models ${res.status}` });
        return;
      }
      const body = (await res.json()) as {
        models?: {
          name: string;
          hash: string | null;
          size_bytes: number;
          resident: boolean;
        }[];
      };
      response.json({
        models: (body.models ?? []).map((m) => ({
          name: m.name,
          hash: m.hash ?? null,
          sizeBytes: m.size_bytes,
          resident: m.resident
        }))
      } satisfies MLModelsResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/model { name } ─────────────────────────────────────
  // Switches the sidecar's resident checkpoint. Every cached prediction is
  // tied to the old checkpoint's hash and stays on disk for when it's reselected.
  router.post("/api/ml/model", async (request, response, next) => {
    try {
      const body = (request.body ?? {}) as Partial<MLSelectModelRequest>;
      if (!body.name || typeof body.name !== "string") {
        response.status(400).json({ error: "name is required" });
        return;
      }
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.pt$/.test(body.name)) {
        response.status(400).json({ error: "Expected a checkpoint basename ending in .pt" }); return;
      }
      // A running sweep files tiles under the checkpoint it started with;
      // switching underneath it would corrupt that cache and race the wipe
      // below (rm on a directory being written to fails with ENOTEMPTY).
      if (jobs.hasActiveJobs()) {
        response.status(409).json({
          error: "cannot switch model while an inference sweep is running — stop it first"
        });
        return;
      }
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/model/reload`,
          SIDECAR_RW_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ checkpoint_path: body.name })
          }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 409) {
        response
          .status(409)
          .json({ error: "cannot switch model while training" });
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        response
          .status(502)
          .json({ error: `sidecar /model/reload ${res.status}`, detail });
        return;
      }
      // Caches (and the per-die job records that count them) are keyed by
      // checkpoint hash, so the previous model's predictions simply become
      // invisible until it's selected again — nothing is deleted. Only the
      // in-memory tile LRU is dropped, to free the old model's entries.
      const data = (await res.json()) as {
        checkpoint: string | null;
        checkpoint_hash: string | null;
        model_loaded: boolean;
      };
      if (!data.model_loaded) throw new HttpError(502, "Sidecar failed to load checkpoint");
      predictor.clearMemCache();
      response.json({
        checkpoint: data.checkpoint,
        checkpointHash: data.checkpoint_hash,
        modelLoaded: data.model_loaded
      });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/ml/inference-jobs ──────────────────────────────────────
  // All per-die inference jobs — drives the library page's status badges.
  router.get("/api/ml/inference-jobs", async (_request, response, next) => {
    try {
      response.json(await jobs.listJobs());
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/ml/job ─────────────────────────────────────
  router.get("/api/dies/:dieId/ml/job", async (request, response, next) => {
    try {
      response.json(await jobs.getJob(request.params.dieId));
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/dies/:dieId/ml/job/start ──────────────────────────────
  router.post(
    "/api/dies/:dieId/ml/job/start",
    async (request, response, next) => {
      try {
        response.json(await jobs.startJob(request.params.dieId));
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        next(error);
      }
    }
  );

  // ── POST /api/dies/:dieId/ml/job/stop ───────────────────────────────
  router.post(
    "/api/dies/:dieId/ml/job/stop",
    async (request, response, next) => {
      try {
        response.json(await jobs.stopJob(request.params.dieId));
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/vias/tile/:z/:x/:y (cached) ────────────────
  router.get(
    "/api/dies/:dieId/vias/tile/:z/:x/:y",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const z = Number(request.params.z);
        const tx = Number(request.params.x);
        const ty = Number(request.params.y);
        if (![z, tx, ty].every(Number.isInteger)) {
          response.status(400).json({ error: "Invalid tile coordinates" });
          return;
        }
        const record = await readDieRecord(config.dataRoot, dieId);
        const resolved = resolveTile(record, z, tx, ty);
        if (resolved.kind === "non-native") {
          response.json({
            pointVias: [],
            irregularVias: [],
            traces: [],
            bbox: [0, 0, 0, 0],
            checkpointHash: null
          } satisfies MLPrediction);
          return;
        }
        if (resolved.kind === "oob") {
          response.status(404).json({ error: "Tile out of range" });
          return;
        }
        const box = resolved.box;

        // `cachedOnly` → return only what's already on disk; never trigger a
        // sidecar inference run. The die-viewer overlay uses this so merely
        // panning the view doesn't kick off inference — that's the job's
        // role. A miss answers 204 so the client can retry once the job
        // computes the tile.
        const cachedOnly =
          request.query.cachedOnly === "1" ||
          request.query.cachedOnly === "true";

        let checkpointHash: string | null;
        try {
          checkpointHash = await predictor.getCheckpointHash();
        } catch (error) {
          // Without the sidecar we can't resolve the cache dir. For a
          // cached-only request that's just "no result available".
          if (cachedOnly) {
            response.status(204).end();
            return;
          }
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const cachedTile = await predictor.readCachedTile(
          dieId,
          checkpointHash,
          z,
          tx,
          ty
        );
        if (cachedTile) {
          response.json(cachedTile);
          return;
        }

        if (cachedOnly) {
          response.status(204).end();
          return;
        }

        let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
        try {
          result = await predictor.runPrediction({
            originalPath: record.originalPath,
            dieWidth: record.width,
            dieHeight: record.height,
            keep: box,
            threshold: INFERENCE_THRESHOLD,
            minDistance: INFERENCE_MIN_DISTANCE,
            wantHeatmap: false
          });
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const prediction = toPrediction(result, box, checkpointHash);
        await predictor.writeCachedTile(dieId, checkpointHash, z, tx, ty, prediction);
        response.json(prediction);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/vias/tiles?z&x0&y0&x1&y1 (cached, batched) ──
  // One request for a whole native-tile range — replaces N per-tile calls
  // when the overlay loads a zoomed-out view. Cached-only by nature: a tile
  // with no cached prediction is omitted from `tiles`.
  router.get("/api/dies/:dieId/vias/tiles", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const z = Number(request.query.z);
      const x0 = Number(request.query.x0);
      const y0 = Number(request.query.y0);
      const x1 = Number(request.query.x1);
      const y1 = Number(request.query.y1);
      if (![z, x0, y0, x1, y1].every(Number.isInteger)) {
        response
          .status(400)
          .json({ error: "z, x0, y0, x1, y1 (tile coords) required" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      if (z !== record.maxZoomLevel) {
        // Predictions only exist at the native level.
        response.json({
          z,
          checkpointHash: null,
          tiles: []
        } satisfies MLViasTilesResponse);
        return;
      }
      const level = record.levels.find((l) => l.z === z);
      const cols = level?.columns ?? Math.ceil(record.width / record.tileSize);
      const rows = level?.rows ?? Math.ceil(record.height / record.tileSize);
      const minTx = Math.max(0, Math.min(x0, x1));
      const minTy = Math.max(0, Math.min(y0, y1));
      const maxTx = Math.min(cols - 1, Math.max(x0, x1));
      const maxTy = Math.min(rows - 1, Math.max(y0, y1));

      let checkpointHash: string | null;
      try {
        checkpointHash = await predictor.getCheckpointHash();
      } catch {
        // No sidecar → can't resolve the cache dir; nothing to return.
        response.json({
          z,
          checkpointHash: null,
          tiles: []
        } satisfies MLViasTilesResponse);
        return;
      }

      const coords: { tx: number; ty: number }[] = [];
      for (let ty = minTy; ty <= maxTy; ty += 1) {
        for (let tx = minTx; tx <= maxTx; tx += 1) coords.push({ tx, ty });
      }
      if (coords.length > MAX_RANGE_TILES) {
        response.status(400).json({
          error: `range too large (${coords.length} > ${MAX_RANGE_TILES})`
        });
        return;
      }

      const results = await Promise.all(
        coords.map(async ({ tx, ty }) => {
          const prediction = await predictor.readCachedTile(
            dieId,
            checkpointHash,
            z,
            tx,
            ty
          );
          return prediction ? { x: tx, y: ty, prediction } : null;
        })
      );
      response.json({
        z,
        checkpointHash,
        tiles: results.filter((t): t is MLViasTileResult => t !== null)
      } satisfies MLViasTilesResponse);
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/vias?bbox=x0,y0,x1,y1 (uncached) ───────────
  router.get("/api/dies/:dieId/vias", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(parts[0], parts[2]));
      const y0 = Math.max(0, Math.min(parts[1], parts[3]));
      const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
      const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
      if (x1 <= x0 || y1 <= y0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }

      let checkpointHash: string | null;
      try {
        checkpointHash = await predictor.getCheckpointHash();
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
      try {
        result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: false
        });
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      response.json(
        toPrediction(result, [x0, y0, x1, y1], checkpointHash)
      );
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/dies/:dieId/heatmap/tile/:z/:x/:y (cached PNG) ──────────
  router.get(
    "/api/dies/:dieId/heatmap/tile/:z/:x/:y",
    async (request, response, next) => {
      try {
        const { dieId } = request.params;
        const z = Number(request.params.z);
        const tx = Number(request.params.x);
        const ty = Number(request.params.y);
        if (![z, tx, ty].every(Number.isInteger)) {
          response.status(400).json({ error: "Invalid tile coordinates" });
          return;
        }
        const record = await readDieRecord(config.dataRoot, dieId);
        const resolved = resolveTile(record, z, tx, ty);
        if (resolved.kind === "non-native") {
          response.status(204).end();
          return;
        }
        if (resolved.kind === "oob") {
          response.status(404).json({ error: "Tile out of range" });
          return;
        }
        const box = resolved.box;

        let checkpointHash: string | null;
        try {
          checkpointHash = await predictor.getCheckpointHash();
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }

        const pngPath = path.join(
          predictor.cacheDirFor(dieId, checkpointHash),
          `${z}_${tx}_${ty}.png`
        );
        try {
          const cached = await fs.readFile(pngPath);
          response.type("image/png").send(cached);
          return;
        } catch {
          /* miss */
        }

        let result: Awaited<ReturnType<typeof predictor.runPrediction>>;
        try {
          result = await predictor.runPrediction({
            originalPath: record.originalPath,
            dieWidth: record.width,
            dieHeight: record.height,
            keep: box,
            threshold: INFERENCE_THRESHOLD,
            minDistance: INFERENCE_MIN_DISTANCE,
            wantHeatmap: true
          });
        } catch (error) {
          if (send503IfUnavailable(error, response)) return;
          throw error;
        }
        if (!result.heatmapTilePng) {
          response.status(502).json({ error: "sidecar returned no heatmap" });
          return;
        }

        // One forward pass yielded both — write the prediction through the
        // predictor so the mem cache is warmed (an `fs.access` guard is
        // cheaper than re-encoding JSON, but `writeCachedTile` is idempotent
        // and the extra disk write is negligible vs. the inference itself).
        await predictor.writeCachedTile(
          dieId,
          checkpointHash,
          z,
          tx,
          ty,
          toPrediction(result, box, checkpointHash)
        );
        await predictor.atomicWrite(pngPath, result.heatmapTilePng);
        response.type("image/png").send(result.heatmapTilePng);
      } catch (error) {
        next(error);
      }
    }
  );

  // ── GET /api/dies/:dieId/heatmap?bbox=x0,y0,x1,y1 (uncached PNG) ────
  router.get("/api/dies/:dieId/heatmap", async (request, response, next) => {
    try {
      const { dieId } = request.params;
      const parts = String(request.query.bbox ?? "")
        .split(",")
        .map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        response.status(400).json({ error: "bbox must be x0,y0,x1,y1" });
        return;
      }
      const record = await readDieRecord(config.dataRoot, dieId);
      const x0 = Math.max(0, Math.min(parts[0], parts[2]));
      const y0 = Math.max(0, Math.min(parts[1], parts[3]));
      const x1 = Math.min(record.width, Math.max(parts[0], parts[2]));
      const y1 = Math.min(record.height, Math.max(parts[1], parts[3]));
      if (x1 <= x0 || y1 <= y0) {
        response.status(400).json({ error: "Empty or out-of-bounds bbox" });
        return;
      }

      try {
        await predictor.getCheckpointHash();
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }

      let result: { heatmapTilePng?: Buffer };
      try {
        result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: [x0, y0, x1, y1],
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: true
        });
      } catch (error) {
        if (send503IfUnavailable(error, response)) return;
        throw error;
      }
      if (!result.heatmapTilePng) {
        response.status(502).json({ error: "sidecar returned no heatmap" });
        return;
      }
      response.type("image/png").send(result.heatmapTilePng);
    } catch (error) {
      next(error);
    }
  });

  // ── POST /api/ml/train ──────────────────────────────────────────────
  router.post("/api/ml/train", async (request, response, next) => {
    try {
      if (process.env.CHIPTOOL_ENABLE_TRAINING !== "1") throw new HttpError(403, "Training is disabled; set CHIPTOOL_ENABLE_TRAINING=1 to enable it");
      const body = (request.body ?? {}) as Partial<MLTrainRequest>;
      if (!body.dataDir || typeof body.dataDir !== "string") {
        response.status(400).json({ error: "dataDir is required" });
        return;
      }
      const exportsRoot = dataPath(config.dataRoot, "ml_exports");
      const selected = path.resolve(config.dataRoot, body.dataDir);
      if (selected !== exportsRoot && !selected.startsWith(exportsRoot + path.sep)) throw new HttpError(400, "Training data must be an ML export directory");
      dataPath(config.dataRoot, path.relative(path.resolve(config.dataRoot), selected));
      if (!(await fs.stat(selected)).isDirectory()) throw new HttpError(400, "Training directory not found");
      if (body.output != null) throw new HttpError(400, "Checkpoint output is generated by the server");
      const numeric = (value: unknown, min: number, max: number, integer = true) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value));
      for (const [key, min, max] of [["epochs", 1, 200], ["stepsPerEpoch", 1, 1000], ["batchSize", 1, 16], ["cropSize", 32, 512]] as const) {
        if (body[key] != null && !numeric(body[key], min, max)) throw new HttpError(400, `Invalid ${key}`);
      }
      if (body.cropSize != null && body.cropSize % 32 !== 0) throw new HttpError(400, "cropSize must be a multiple of 32");
      if ((body.epochs ?? 50) * (body.stepsPerEpoch ?? 100) * (body.batchSize ?? 8) > 1_000_000) throw new HttpError(400, "Training workload exceeds limit");
      if (body.lr != null && !numeric(body.lr, 1e-6, 0.1, false)) throw new HttpError(400, "Invalid learning rate");
      if (body.encoder != null && !["resnet18", "resnet34"].includes(body.encoder)) throw new HttpError(400, "Unsupported training encoder");
      const sidecarBody: Record<string, unknown> = { data_dir: path.relative(path.resolve(config.dataRoot), selected) };
      if (body.epochs != null) sidecarBody.epochs = body.epochs;
      if (body.encoder != null) sidecarBody.encoder = body.encoder;
      if (body.lr != null) sidecarBody.lr = body.lr;
      if (body.cropSize != null) sidecarBody.crop_size = body.cropSize;
      if (body.stepsPerEpoch != null)
        sidecarBody.steps_per_epoch = body.stepsPerEpoch;
      if (body.batchSize != null) sidecarBody.batch_size = body.batchSize;

      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/train`,
          SIDECAR_RW_TIMEOUT_MS,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(sidecarBody)
          }
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 409) {
        response.status(409).json({ error: "training already in progress" });
        return;
      }
      if (!res.ok) {
        const detail = await res.text();
        response
          .status(502)
          .json({ error: `sidecar /train ${res.status}`, detail });
        return;
      }
      const data = (await res.json()) as { job_id: string };
      response.status(202).json({ jobId: data.job_id });
    } catch (error) {
      next(error);
    }
  });

  // ── GET /api/ml/jobs/:jobId ─────────────────────────────────────────
  router.get("/api/ml/jobs/:jobId", async (request, response, next) => {
    try {
      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/jobs/${encodeURIComponent(
            request.params.jobId
          )}`,
          HEALTH_TIMEOUT_MS
        );
      } catch {
        response.status(503).json({ error: "sidecar unreachable" });
        return;
      }
      if (res.status === 404) {
        response.status(404).json({ error: "job not found" });
        return;
      }
      if (!res.ok) {
        response.status(502).json({ error: `sidecar /jobs ${res.status}` });
        return;
      }
      const j = (await res.json()) as Record<string, unknown>;
      response.json({
        jobId: j.job_id as string,
        kind: j.kind as MLJobStatus["kind"],
        status: j.status as MLJobStatus["status"],
        epoch: j.epoch as number,
        epochs: j.epochs as number,
        loss: (j.loss as number | null) ?? null,
        checkpointPath: (j.checkpoint_path as string | null) ?? null,
        error: (j.error as string | null) ?? null,
        startedAt: j.started_at as string,
        updatedAt: j.updated_at as string
      } satisfies MLJobStatus);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
