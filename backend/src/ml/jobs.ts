import { promises as fs } from "node:fs";
import type { MLInferenceJob } from "shared";
import {
  listMLJobs,
  readDieRecord,
  readMLJob,
  writeMLJob
} from "../store.js";
import type { DieRecord } from "../types.js";
import {
  INFERENCE_MIN_DISTANCE,
  INFERENCE_THRESHOLD,
  resolveTile,
  SidecarUnavailable,
  toPrediction,
  type MLPredictor
} from "./predict.js";

/** In-flight tile requests. The sidecar serializes GPU work anyway; a small
 *  pool just overlaps Node-side cropping with the sidecar's inference. */
const SWEEP_CONCURRENCY = 2;
/** Don't flood WS clients — coalesce progress to at most one per interval. */
const BROADCAST_THROTTLE_MS = 700;

/** The sidecar's resident checkpoint changed while a sweep was running. */
export class ModelChangedDuringSweep extends Error {}

export interface MLJobManager {
  /** Current job state for a die (recomputed against the cache on disk). */
  getJob(dieId: string): Promise<MLInferenceJob>;
  /** True while any die's sweep is in flight (model switches must wait). */
  hasActiveJobs(): boolean;
  /** Every persisted job (stale "running" jobs reconciled to "stopped"). */
  listJobs(): Promise<MLInferenceJob[]>;
  /** Begin (or resume) a die-wide inference sweep. */
  startJob(dieId: string): Promise<MLInferenceJob>;
  /** Request the running sweep to stop after the current tile. */
  stopJob(dieId: string): Promise<MLInferenceJob>;
}

interface ActiveSweep {
  cancel: boolean;
}

function nativeGrid(record: DieRecord): { columns: number; rows: number } {
  const level = record.levels.find((l) => l.z === record.maxZoomLevel);
  if (level) return { columns: level.columns, rows: level.rows };
  // Fallback: derive from dimensions if the level list is unexpectedly sparse.
  return {
    columns: Math.ceil(record.width / record.tileSize),
    rows: Math.ceil(record.height / record.tileSize)
  };
}

function pct(completed: number, total: number): number {
  return total > 0 ? Math.round((completed / total) * 100) : 0;
}

export function createMLJobManager(config: {
  dataRoot: string;
  predictor: MLPredictor;
  /** Push a job-state change to subscribed WS clients. */
  onJobChange?: (job: MLInferenceJob) => void;
}): MLJobManager {
  const { dataRoot, predictor, onJobChange } = config;
  const active = new Map<string, ActiveSweep>();

  /** Count tiles already cached for a die at the given checkpoint. */
  async function countCachedTiles(
    dieId: string,
    hash: string | null,
    nativeZ: number
  ): Promise<number> {
    const dir = predictor.cacheDirFor(dieId, hash);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return 0;
    }
    const prefix = `${nativeZ}_`;
    return entries.filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
      .length;
  }

  // Job writes are serialized per die. Progress ticks are fired without
  // awaiting, so without a queue a tick that started before the sweep ended
  // could finish *after* the terminal write and overwrite "failed" /
  // "completed" with a stale "running".
  const writeQueue = new Map<string, Promise<void>>();
  function persistAndBroadcast(job: MLInferenceJob): Promise<void> {
    const prev = writeQueue.get(job.dieId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => writeMLJob(dataRoot, job))
      .then(() => {
        onJobChange?.(job);
      });
    writeQueue.set(job.dieId, next);
    return next;
  }

  async function getJob(dieId: string): Promise<MLInferenceJob> {
    // Sample this first: a sweep persists its terminal state *before* it
    // leaves `active`, so "not active" guarantees the file is final. Checking
    // after the reads below could pair a stale "running" record with an
    // already-finished sweep and report it as merely "stopped".
    const running = active.has(dieId);
    const record = await readDieRecord(dataRoot, dieId);
    const { columns, rows } = nativeGrid(record);
    const totalTiles = columns * rows;

    let checkpointHash: string | null = null;
    try {
      checkpointHash = await predictor.getCheckpointHash();
    } catch {
      // Sidecar down — fall back to the last hash we recorded.
      checkpointHash = null;
    }

    const persisted = await readMLJob(dataRoot, dieId);
    const hash = checkpointHash ?? persisted?.checkpointHash ?? null;
    const completedTiles = await countCachedTiles(
      dieId,
      hash,
      record.maxZoomLevel
    );
    const status: MLInferenceJob["status"] = running
      ? "running"
      : completedTiles >= totalTiles && totalTiles > 0
        ? "completed"
        : persisted?.status === "failed"
          ? "failed"
          : "stopped";

    return {
      dieId,
      status,
      totalTiles,
      completedTiles: Math.min(completedTiles, totalTiles),
      percentage: pct(Math.min(completedTiles, totalTiles), totalTiles),
      checkpointHash: hash,
      model: persisted?.model ?? null,
      error: status === "failed" ? (persisted?.error ?? null) : null,
      startedAt: persisted?.startedAt ?? null,
      updatedAt: persisted?.updatedAt ?? new Date().toISOString(),
      finishedAt: persisted?.finishedAt ?? null
    };
  }

  async function runSweep(
    record: DieRecord,
    hash: string | null,
    job: MLInferenceJob,
    sweep: ActiveSweep
  ): Promise<void> {
    const nativeZ = record.maxZoomLevel;
    const { columns, rows } = nativeGrid(record);
    const tiles: { tx: number; ty: number }[] = [];
    for (let ty = 0; ty < rows; ty += 1) {
      for (let tx = 0; tx < columns; tx += 1) tiles.push({ tx, ty });
    }

    let completed = 0;
    let lastBroadcast = 0;
    let cursor = 0;

    const emit = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastBroadcast < BROADCAST_THROTTLE_MS) return;
      lastBroadcast = now;
      job.completedTiles = Math.min(completed, job.totalTiles);
      job.percentage = pct(job.completedTiles, job.totalTiles);
      job.updatedAt = new Date().toISOString();
      void persistAndBroadcast({ ...job });
    };

    const worker = async (): Promise<void> => {
      while (!sweep.cancel) {
        const idx = cursor;
        cursor += 1;
        if (idx >= tiles.length) return;
        const { tx, ty } = tiles[idx];
        const cached = await predictor.readCachedTile(
          record.id,
          hash,
          nativeZ,
          tx,
          ty
        );
        if (cached) {
          completed += 1;
          emit(false);
          continue;
        }
        const resolved = resolveTile(record, nativeZ, tx, ty);
        if (resolved.kind !== "ok") {
          completed += 1;
          emit(false);
          continue;
        }
        // The cache dir is keyed by the checkpoint this sweep started with.
        // If the sidecar now serves a different model, every further tile
        // would be filed under the wrong hash — abort instead of mixing.
        // (`getCheckpointHash` is memoized for ~10s, so this is cheap.)
        const live = await predictor.getCheckpointHash();
        if (live !== hash) {
          throw new ModelChangedDuringSweep(
            `model changed during sweep (started with ${hash ?? "no hash"}, ` +
              `sidecar now serves ${live ?? "no hash"}) — restart inference`
          );
        }
        const result = await predictor.runPrediction({
          originalPath: record.originalPath,
          dieWidth: record.width,
          dieHeight: record.height,
          keep: resolved.box,
          threshold: INFERENCE_THRESHOLD,
          minDistance: INFERENCE_MIN_DISTANCE,
          wantHeatmap: false
        });
        await predictor.writeCachedTile(
          record.id,
          hash,
          nativeZ,
          tx,
          ty,
          toPrediction(result, resolved.box, hash)
        );
        completed += 1;
        emit(false);
      }
    };

    try {
      await Promise.all(
        Array.from({ length: SWEEP_CONCURRENCY }, () => worker())
      );
      job.status = sweep.cancel ? "stopped" : "completed";
      job.error = null;
    } catch (error) {
      job.status = "failed";
      job.error =
        error instanceof SidecarUnavailable || error instanceof ModelChangedDuringSweep
          ? error.message
          : error instanceof Error
            ? error.message
            : "inference failed";
    } finally {
      job.completedTiles = Math.min(completed, job.totalTiles);
      job.percentage = pct(job.completedTiles, job.totalTiles);
      job.finishedAt = new Date().toISOString();
      job.updatedAt = job.finishedAt;
      // Persist the terminal state *before* leaving the active set: `getJob`
      // reports "running" while active, and otherwise derives the status
      // from the persisted record — a reader in between would see the last
      // progress tick ("running") and report a completed/failed sweep as
      // merely "stopped".
      await persistAndBroadcast({ ...job });
      active.delete(record.id);
    }
  }

  async function startJob(dieId: string): Promise<MLInferenceJob> {
    if (active.has(dieId)) return getJob(dieId);

    const record = await readDieRecord(dataRoot, dieId);
    // Resolve the checkpoint up-front so an unreachable sidecar fails the
    // request loudly instead of spawning a doomed sweep.
    const hash = await predictor.getCheckpointHash();
    const { columns, rows } = nativeGrid(record);
    const totalTiles = columns * rows;
    const now = new Date().toISOString();

    const job: MLInferenceJob = {
      dieId,
      status: "running",
      totalTiles,
      completedTiles: 0,
      percentage: 0,
      checkpointHash: hash,
      model: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null
    };

    const sweep: ActiveSweep = { cancel: false };
    active.set(dieId, sweep);
    await persistAndBroadcast({ ...job });
    void runSweep(record, hash, job, sweep);
    return job;
  }

  async function listJobs(): Promise<MLInferenceJob[]> {
    const jobs = await listMLJobs(dataRoot);
    // A job persisted as "running" but absent from `active` is stale — the
    // server restarted mid-sweep. Report it as stopped.
    return jobs.map((j) =>
      j.status === "running" && !active.has(j.dieId)
        ? { ...j, status: "stopped" as const }
        : j
    );
  }

  async function stopJob(dieId: string): Promise<MLInferenceJob> {
    const sweep = active.get(dieId);
    if (sweep) sweep.cancel = true;
    // The sweep persists the final "stopped" state itself; return the live view.
    return getJob(dieId);
  }

  function hasActiveJobs(): boolean {
    return active.size > 0;
  }

  return { getJob, listJobs, startJob, stopJob, hasActiveJobs };
}
