import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import type { Cell, CellType } from "shared";
import { footprint, orientOf } from "../ml/cellDetect.js";
import type { DieRecord } from "../types.js";
import {
  canonicalIndexForDiePixel,
  channelStats,
  deviationMap,
  fitToReference,
  flipPadded,
  grayOf,
  paddedDieBox,
  registerInstance,
  resampleBand,
  toCanonicalImage,
  wireLikelihood
} from "./pixels.js";
import { marginFor } from "./specimen.js";
import { wireTilePath } from "./store.js";
import type { TileReader } from "./tileReader.js";

/** Overlay colour (alpha carries the likelihood). Saturated orange-red: the
 *  die itself is cream metal on grey-green, so anything yellowish vanishes;
 *  this also stays clear of ML vias (green), ML cells (pink) and nets (blue). */
export const WIRE_RGB: [number, number, number] = [255, 60, 0];
/** Pyramid levels generated below native (each halves the resolution). Below
 *  that the overlay is sub-pixel noise, so it simply isn't drawn. */
export const PYRAMID_LEVELS_BELOW_NATIVE = 4;
/** MAD floor in 8-bit units: keeps flat, low-variance pixels from turning
 *  JPEG noise into huge z-scores. */
const MAD_FLOOR = 6;

export interface LoadedSpecimen {
  width: number;
  height: number;
  centre: Float32Array;
  mad: Float32Array;
  gray: Float32Array;
  stats: ReturnType<typeof channelStats>;
}

export function prepareSpecimen(width: number, height: number, centre: Float32Array, mad: Float32Array): LoadedSpecimen {
  return { width, height, centre, mad, gray: grayOf(centre, width, height), stats: channelStats(centre) };
}

/** 0..1 likelihood, in the cell's canonical frame, that each pixel shows
 *  something that isn't part of the cell. Null when the crop leaves the die. */
export async function cellWireLikelihood(
  cell: Cell,
  spec: LoadedSpecimen,
  reader: TileReader
): Promise<Float32Array | null> {
  const { width: W, height: H } = spec;
  const MARGIN = marginFor(W, H);
  const SHIFT_RADIUS = MARGIN;
  const box = paddedDieBox(cell, W, H, MARGIN);
  const region = await reader.region(box.x0, box.y0, box.w, box.h);
  if (!region) return null;
  const padded = toCanonicalImage(region, cell, W, H, MARGIN);
  // Same registration as the specimen build (mirror check + affine), so a
  // squished or mis-annotated instance compares against the specimen
  // properly instead of lighting up everywhere.
  const pw = W + 2 * MARGIN;
  const ph = H + 2 * MARGIN;
  const reg = registerInstance(spec.gray, W, H, padded, MARGIN, { detectFlips: true, shiftRadius: SHIFT_RADIUS });
  const inner = resampleBand(flipPadded(padded, pw, ph, reg.flipH, reg.flipV), pw, ph, reg.warp, W, 1, 0, H);
  fitToReference(inner, spec.centre);
  return wireLikelihood(deviationMap(inner, spec.centre, spec.mad, MAD_FLOOR), W, H);
}

/**
 * Accumulates per-cell likelihoods into native-resolution tile buffers and
 * flushes them as RGBA PNGs. Cells must be fed in ascending order of the tile
 * row of their footprint's top edge; `flushRowsBefore` then bounds memory to
 * the few tile rows a cell can still reach.
 */
export function createWireTileWriter(dataRoot: string, record: DieRecord) {
  const ts = record.tileSize;
  const z = record.maxZoomLevel;
  const buffers = new Map<string, { tx: number; ty: number; a: Uint8Array }>();
  const written = new Set<string>();

  function paste(cell: Cell, cellType: CellType, lik: Float32Array): void {
    const W = Math.round(cellType.cropRect.width);
    const H = Math.round(cellType.cropRect.height);
    const o = orientOf(cell);
    const f = footprint(cell.x, cell.y, o, W, H);
    const x0 = Math.max(0, Math.floor(f.x0));
    const y0 = Math.max(0, Math.floor(f.y0));
    const x1 = Math.min(record.width, Math.ceil(f.x1));
    const y1 = Math.min(record.height, Math.ceil(f.y1));
    for (let y = y0; y < y1; y++) {
      const ty = Math.floor(y / ts);
      for (let x = x0; x < x1; x++) {
        const idx = canonicalIndexForDiePixel(x, y, cell, o, W, H);
        if (idx < 0) continue;
        const v = Math.round(lik[idx] * 255);
        if (v === 0) continue;
        const tx = Math.floor(x / ts);
        const key = `${tx}_${ty}`;
        let b = buffers.get(key);
        if (!b) {
          b = { tx, ty, a: new Uint8Array(ts * ts) };
          buffers.set(key, b);
        }
        const i = (y - ty * ts) * ts + (x - tx * ts);
        if (v > b.a[i]) b.a[i] = v;
      }
    }
  }

  async function flush(b: { tx: number; ty: number; a: Uint8Array }): Promise<void> {
    const w = Math.min(ts, record.width - b.tx * ts);
    const h = Math.min(ts, record.height - b.ty * ts);
    const rgba = Buffer.alloc(w * h * 4);
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const v = b.a[y * ts + x];
        if (v === 0) continue;
        any = true;
        const d = (y * w + x) * 4;
        rgba[d] = WIRE_RGB[0];
        rgba[d + 1] = WIRE_RGB[1];
        rgba[d + 2] = WIRE_RGB[2];
        rgba[d + 3] = v;
      }
    }
    if (!any) return;
    const file = wireTilePath(dataRoot, record.id, z, b.tx, b.ty);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).png({ compressionLevel: 6 }).toFile(file);
    written.add(`${b.tx}_${b.ty}`);
  }

  async function flushRowsBefore(tileRow: number): Promise<void> {
    for (const [key, b] of [...buffers]) {
      if (b.ty >= tileRow) continue;
      buffers.delete(key);
      await flush(b);
    }
  }

  return { paste, flushRowsBefore, flushAll: () => flushRowsBefore(Infinity), nativeTiles: written };
}

/**
 * Build the coarser overlay levels by halving: each tile is its four children
 * composited on a 2×-size canvas and resized down. Returns the lowest level
 * written.
 */
export async function buildWirePyramid(
  dataRoot: string,
  record: DieRecord,
  nativeTiles: ReadonlySet<string>,
  hooks: { shouldCancel?: () => boolean; yieldToLoop?: () => Promise<void> } = {}
): Promise<number> {
  const ts = record.tileSize;
  let present = new Set(nativeTiles);
  let lowest = record.maxZoomLevel;
  for (let z = record.maxZoomLevel - 1; z >= Math.max(0, record.maxZoomLevel - PYRAMID_LEVELS_BELOW_NATIVE); z--) {
    const level = record.levels[z];
    if (!level) break;
    const parents = new Set<string>();
    for (const key of present) {
      const [cx, cy] = key.split("_").map(Number);
      parents.add(`${cx >> 1}_${cy >> 1}`);
    }
    for (const key of parents) {
      if (hooks.shouldCancel?.()) return lowest;
      const [px, py] = key.split("_").map(Number);
      const w = Math.min(ts, level.width - px * ts);
      const h = Math.min(ts, level.height - py * ts);
      if (w <= 0 || h <= 0) continue;
      const layers: sharp.OverlayOptions[] = [];
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const ck = `${px * 2 + ox}_${py * 2 + oy}`;
        if (!present.has(ck)) continue;
        layers.push({ input: wireTilePath(dataRoot, record.id, z + 1, px * 2 + ox, py * 2 + oy), left: ox * ts, top: oy * ts });
      }
      const canvas = await sharp({ create: { width: ts * 2, height: ts * 2, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite(layers)
        .png()
        .toBuffer();
      const file = wireTilePath(dataRoot, record.id, z, px, py);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await sharp(canvas).extract({ left: 0, top: 0, width: Math.min(ts * 2, w * 2), height: Math.min(ts * 2, h * 2) }).resize(w, h, { kernel: "cubic" }).png().toFile(file);
      await hooks.yieldToLoop?.();
    }
    present = parents;
    lowest = z;
  }
  return lowest;
}
