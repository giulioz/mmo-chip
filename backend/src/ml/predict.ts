import { randomUUID } from "node:crypto";
import { checkRegion, dataPath, DEV_TOKEN, limits, safeId } from "../security.js";
import { mlWork } from "../workQueue.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type {
  MLPrediction,
  MLRegion,
  MLTracePolyline,
  MLVia
} from "shared";
import type { DieRecord } from "../types.js";

const HEALTH_TIMEOUT_MS = 3000;
const PREDICT_TIMEOUT_MS = 60000; // first call includes model warmup + tiling
const HASH_TTL_MS = 10000;
/** In-memory LRU of parsed tile predictions — repeated viewport fetches then
 *  skip disk entirely. A tile prediction is a few KB, so this holds a big
 *  die's worth comfortably. */
const MEM_CACHE_MAX = 16384;

/**
 * Inference always runs at this low fixed threshold so the cached prediction
 * keeps *every* detection together with its score. The confidence slider in
 * the UI then filters cached results client-side by `score` — the model is
 * never re-run when the user drags the slider.
 */
export const INFERENCE_THRESHOLD = 0.3;
export const INFERENCE_MIN_DISTANCE = 4;

export class SidecarUnavailable extends Error {}

export type PredictBox = [number, number, number, number];

/** Native-resolution tile → source bbox, or a reason it has no prediction. */
export function resolveTile(
  record: DieRecord,
  z: number,
  tx: number,
  ty: number
):
  | { kind: "non-native" }
  | { kind: "oob" }
  | { kind: "ok"; box: PredictBox } {
  if (z !== record.maxZoomLevel) return { kind: "non-native" };
  const ts = record.tileSize;
  const x0 = tx * ts;
  const y0 = ty * ts;
  if (x0 >= record.width || y0 >= record.height) return { kind: "oob" };
  const x1 = Math.min(x0 + ts, record.width);
  const y1 = Math.min(y0 + ts, record.height);
  return { kind: "ok", box: [x0, y0, x1, y1] };
}

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

export interface RunPredictionResult {
  pointVias: MLVia[];
  irregularVias: MLRegion[];
  traces: MLTracePolyline[];
  heatmapTilePng?: Buffer;
}

export interface MLPredictor {
  /** Sidecar checkpoint hash (memoized ~10s) — drives the cache keys. */
  getCheckpointHash(): Promise<string | null>;
  /** Run inference for a source-pixel keep-box. */
  runPrediction(params: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    keep: PredictBox;
    threshold: number;
    minDistance: number;
    wantHeatmap: boolean;
  }): Promise<RunPredictionResult>;
  /** Directory holding cached predictions for a die at a checkpoint. */
  cacheDirFor(dieId: string, hash: string | null): string;
  /** Cached prediction JSON path for a native-zoom tile. */
  tileCachePath(dieId: string, hash: string | null, z: number, tx: number, ty: number): string;
  /** Write a file atomically (tmp + rename). */
  atomicWrite(filePath: string, data: Buffer | string): Promise<void>;
  /** Read a tile's cached prediction (memory LRU → disk), or null on miss. */
  readCachedTile(
    dieId: string,
    hash: string | null,
    z: number,
    tx: number,
    ty: number
  ): Promise<MLPrediction | null>;
  /** Persist a tile prediction to disk + the memory LRU. */
  writeCachedTile(
    dieId: string,
    hash: string | null,
    z: number,
    tx: number,
    ty: number,
    prediction: MLPrediction
  ): Promise<void>;
  /** Drop the in-memory prediction cache (e.g. after a model switch). */
  clearMemCache(): void;
}

export function createMLPredictor(config: {
  mlSidecarUrl: string;
  dataRoot: string;
  mlPredictPad: number;
}): MLPredictor {
  // Memoized checkpoint hash — refreshed every HASH_TTL_MS so a retrain (new
  // hash) invalidates the cache within ~10s without a /health call per tile.
  let hashCache: { hash: string | null; at: number } | null = null;

  async function getCheckpointHash(): Promise<string | null> {
    const now = Date.now();
    if (hashCache && now - hashCache.at < HASH_TTL_MS) return hashCache.hash;
    let res: Response;
    try {
      res = await fetchSidecar(`${config.mlSidecarUrl}/health`, HEALTH_TIMEOUT_MS);
    } catch {
      throw new SidecarUnavailable("sidecar unreachable");
    }
    if (!res.ok) throw new SidecarUnavailable(`sidecar /health ${res.status}`);
    const body = (await res.json()) as {
      checkpoint_hash?: string | null;
      model_loaded?: boolean;
    };
    if (!body.model_loaded) throw new SidecarUnavailable("model not loaded");
    hashCache = { hash: body.checkpoint_hash ?? null, at: now };
    return hashCache.hash;
  }

  async function runPrediction(params: {
    originalPath: string;
    dieWidth: number;
    dieHeight: number;
    keep: PredictBox;
    threshold: number;
    minDistance: number;
    wantHeatmap: boolean;
  }): Promise<RunPredictionResult> {
    return mlWork(async () => {
      const [kx0, ky0, kx1, ky1] = params.keep;
      const pad = config.mlPredictPad;
      const px0 = Math.max(0, Math.floor(kx0 - pad));
      const py0 = Math.max(0, Math.floor(ky0 - pad));
      const px1 = Math.min(params.dieWidth, Math.ceil(kx1 + pad));
      const py1 = Math.min(params.dieHeight, Math.ceil(ky1 + pad));
      const cropW = px1 - px0;
      const cropH = py1 - py0;
      if (cropW <= 0 || cropH <= 0) {
        return { pointVias: [], irregularVias: [], traces: [] };
      }

      checkRegion(cropW, cropH);
      dataPath(config.dataRoot, path.relative(path.resolve(config.dataRoot), params.originalPath));
      const buf = await sharp(params.originalPath, { limitInputPixels: limits.imagePixels })
        .extract({ left: px0, top: py0, width: cropW, height: cropH })
        .png()
        .toBuffer();

      const fd = new FormData();
      fd.append(
        "image",
        new Blob([new Uint8Array(buf)], { type: "image/png" }),
        "crop.png"
      );
      fd.append("threshold", String(params.threshold));
      fd.append("min_distance", String(params.minDistance));
      fd.append("return_heatmap", params.wantHeatmap ? "true" : "false");

      let res: Response;
      try {
        res = await fetchSidecar(
          `${config.mlSidecarUrl}/predict/region`,
          PREDICT_TIMEOUT_MS,
          { method: "POST", body: fd }
        );
      } catch {
        throw new SidecarUnavailable("sidecar unreachable");
      }
      if (res.status === 503) {
        throw new SidecarUnavailable("model not loaded or training");
      }
      if (!res.ok) throw new SidecarUnavailable(`sidecar /predict ${res.status}`);

      const body = (await res.json()) as {
        point_vias: { x: number; y: number; score: number }[];
        irregular_vias: {
          bbox: [number, number, number, number];
          centroid: [number, number];
          area: number;
          score: number;
        }[];
        traces: { points?: number[][] }[] | number[][][];
        heatmap_png_b64?: string;
      };

      const inKeep = (x: number, y: number) =>
        x >= kx0 && x < kx1 && y >= ky0 && y < ky1;

      const pointVias: MLVia[] = [];
      for (const v of body.point_vias ?? []) {
        const sx = v.x + px0;
        const sy = v.y + py0;
        if (inKeep(sx, sy)) pointVias.push({ x: sx, y: sy, score: v.score });
      }

      const irregularVias: MLRegion[] = [];
      for (const r of body.irregular_vias ?? []) {
        const cx = r.centroid[0] + px0;
        const cy = r.centroid[1] + py0;
        if (!inKeep(cx, cy)) continue; // dedupe at tile seams by centroid
        irregularVias.push({
          bbox: [r.bbox[0] + px0, r.bbox[1] + py0, r.bbox[2], r.bbox[3]],
          centroid: [cx, cy],
          area: r.area,
          score: r.score
        });
      }

      const traces: MLTracePolyline[] = [];
      for (const t of (body.traces ?? []) as unknown[]) {
        const raw = Array.isArray(t)
          ? (t as number[][])
          : ((t as { points?: number[][] }).points ?? []);
        if (raw.length < 2) continue;
        const pts = raw.map(([x, y]) => [x + px0, y + py0] as [number, number]);
        let minx = Infinity;
        let miny = Infinity;
        let maxx = -Infinity;
        let maxy = -Infinity;
        for (const [x, y] of pts) {
          if (x < minx) minx = x;
          if (y < miny) miny = y;
          if (x > maxx) maxx = x;
          if (y > maxy) maxy = y;
        }
        const overlaps = !(maxx <= kx0 || minx >= kx1 || maxy <= ky0 || miny >= ky1);
        if (overlaps) traces.push({ points: pts });
      }

      let heatmapTilePng: Buffer | undefined;
      if (params.wantHeatmap && body.heatmap_png_b64) {
        const full = Buffer.from(body.heatmap_png_b64, "base64");
        heatmapTilePng = await sharp(full)
          .extract({
            left: kx0 - px0,
            top: ky0 - py0,
            width: kx1 - kx0,
            height: ky1 - ky0
          })
          .png()
          .toBuffer();
      }

      return { pointVias, irregularVias, traces, heatmapTilePng };
    });
  }

  function cacheDirFor(dieId: string, hash: string | null): string {
    return dataPath(config.dataRoot, "predictions", safeId(dieId), hash == null ? "nohash" : safeId(hash));
  }

  function tileCachePath(
    dieId: string,
    hash: string | null,
    z: number,
    tx: number,
    ty: number
  ): string {
    return dataPath(config.dataRoot, "predictions", safeId(dieId), hash == null ? "nohash" : safeId(hash), `${z}_${tx}_${ty}.json`);
  }

  async function atomicWrite(
    filePath: string,
    data: Buffer | string
  ): Promise<void> {
    dataPath(config.dataRoot, path.relative(path.resolve(config.dataRoot), filePath));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, filePath);
  }

  // ── In-memory tile prediction LRU ──────────────────────────────────
  // Map iteration order is insertion order — re-inserting on read keeps the
  // most-recently-used keys last, so evicting the first key is true LRU.
  const memCache = new Map<string, MLPrediction>();

  function memKey(
    dieId: string,
    hash: string | null,
    z: number,
    tx: number,
    ty: number
  ): string {
    return `${dieId}/${hash ?? "nohash"}/${z}_${tx}_${ty}`;
  }

  function memGet(key: string): MLPrediction | undefined {
    const v = memCache.get(key);
    if (v !== undefined) {
      memCache.delete(key);
      memCache.set(key, v);
    }
    return v;
  }

  function memSet(key: string, value: MLPrediction): void {
    memCache.delete(key);
    memCache.set(key, value);
    if (memCache.size > MEM_CACHE_MAX) {
      const oldest = memCache.keys().next().value;
      if (oldest !== undefined) memCache.delete(oldest);
    }
  }

  async function readCachedTile(
    dieId: string,
    hash: string | null,
    z: number,
    tx: number,
    ty: number
  ): Promise<MLPrediction | null> {
    const key = memKey(dieId, hash, z, tx, ty);
    const cached = memGet(key);
    if (cached !== undefined) return cached;
    try {
      const raw = await fs.readFile(tileCachePath(dieId, hash, z, tx, ty), "utf8");
      const parsed = JSON.parse(raw) as MLPrediction;
      memSet(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  async function writeCachedTile(
    dieId: string,
    hash: string | null,
    z: number,
    tx: number,
    ty: number,
    prediction: MLPrediction
  ): Promise<void> {
    await atomicWrite(
      tileCachePath(dieId, hash, z, tx, ty),
      JSON.stringify(prediction)
    );
    memSet(memKey(dieId, hash, z, tx, ty), prediction);
  }

  function clearMemCache(): void {
    hashCache = null;
    memCache.clear();
  }

  return {
    getCheckpointHash,
    runPrediction,
    cacheDirFor,
    tileCachePath,
    atomicWrite,
    readCachedTile,
    writeCachedTile,
    clearMemCache
  };
}

/** Build a cached `MLPrediction` payload for a tile keep-box. */
export function toPrediction(
  result: RunPredictionResult,
  box: PredictBox,
  checkpointHash: string | null
): MLPrediction {
  return {
    pointVias: result.pointVias,
    irregularVias: result.irregularVias,
    traces: result.traces,
    bbox: box,
    checkpointHash
  };
}
