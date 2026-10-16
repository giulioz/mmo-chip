import type { DieMetadata } from "shared";
import type { Rect } from "../lib/geometry";

/**
 * Die pixels for an arbitrary region (a cell's footprint) straight from the
 * die's tile pyramid — the same tiles the die viewer shows — instead of a
 * crop cut from the original image per cell. Tiles are shared by every
 * consumer (cell-RE canvas, merge canvas, thumbnails) through one cache, and
 * neighbouring cells share tiles.
 *
 * A region is composed once into an offscreen canvas at its level's native
 * resolution (tiles land on whole pixels, so no seams), and callers draw that
 * canvas in one `drawImage` — alpha / blend modes apply to the cell as a
 * whole, not tile by tile.
 */

export interface DieRegion {
  /** Level pixels covering `rect`. */
  canvas: HTMLCanvasElement;
  /** Die-space rect the canvas covers (the requested one, snapped out to the
   *  level's pixel grid). */
  rect: Rect;
  /** Every tile of the chosen level had arrived (else coarser stand-ins, or
   *  nothing, show through). */
  complete: boolean;
}

/** Tiles kept decoded-on-demand across consumers (LRU). */
const MAX_TILES = 384;
/** Composed regions kept (LRU) — thumbnails of a long candidate list. */
const MAX_REGIONS = 256;
/** Coarser levels (already cached) drawn under the target while it loads. */
const STANDIN_LEVELS = 3;

interface TileEntry {
  image: HTMLImageElement;
  settled: boolean;
  failed: boolean;
  waiters: Set<() => void>;
  lastUsed: number;
}

const tiles = new Map<string, TileEntry>();
const regions = new Map<string, DieRegion>();
let useCounter = 0;

/** Coarsest level whose pixels are no bigger than a display pixel, given
 *  `pxPerDiePx` display pixels per die pixel (the die viewer's rule). */
export function levelForScale(die: DieMetadata, pxPerDiePx: number): number {
  const maxScale = 1 / Math.max(pxPerDiePx, 1e-6);
  for (let z = 0; z < die.levels.length; z++) {
    if (die.levels[z].scale <= maxScale) return z;
  }
  return die.levels.length - 1;
}

/**
 * The die pixels of `want` (die coords) at the level `pxPerDiePx` calls for.
 * Missing tiles of that level are requested and `onLoad` fires as each one
 * lands — call again to get the fuller composition. Null for a region
 * entirely off the die.
 */
export function dieRegion(
  die: DieMetadata,
  want: Rect,
  pxPerDiePx: number,
  onLoad: () => void
): DieRegion | null {
  const z = levelForScale(die, pxPerDiePx);
  const level = die.levels[z];
  if (!level) return null;
  const s = level.scale;
  // Level-pixel rect covering `want`, clamped to the level.
  const lx0 = Math.max(0, Math.floor(want.x / s));
  const ly0 = Math.max(0, Math.floor(want.y / s));
  const lx1 = Math.min(level.width, Math.ceil((want.x + want.width) / s));
  const ly1 = Math.min(level.height, Math.ceil((want.y + want.height) / s));
  if (lx1 <= lx0 || ly1 <= ly0) return null;
  const w = lx1 - lx0;
  const h = ly1 - ly0;

  const key = `${die.id}|${z}|${lx0},${ly0},${w}x${h}`;
  const cached = regions.get(key);
  if (cached?.complete) {
    regions.delete(key); // refresh LRU position
    regions.set(key, cached);
    return cached;
  }

  const canvas = cached?.canvas ?? document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  ctx.clearRect(0, 0, w, h);

  let complete = true;
  for (let lz = Math.max(0, z - STANDIN_LEVELS); lz <= z; lz++) {
    const lv = die.levels[lz];
    // Target-level pixels per pixel of this level.
    const f = lv.scale / s;
    const span = die.tileSize * lv.scale; // die px per tile
    const tx0 = Math.max(0, Math.floor((lx0 * s) / span));
    const ty0 = Math.max(0, Math.floor((ly0 * s) / span));
    const tx1 = Math.min(lv.columns - 1, Math.floor((lx1 * s - 1e-6) / span));
    const ty1 = Math.min(lv.rows - 1, Math.floor((ly1 * s - 1e-6) / span));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = `/api/dies/${die.id}/tiles/${lz}/${tx}/${ty}`;
        const entry = lz === z ? requestTile(url, onLoad) : tiles.get(url);
        if (!entry || !entry.settled) {
          if (lz === z) complete = false;
          continue;
        }
        entry.lastUsed = ++useCounter;
        if (entry.failed) continue;
        ctx.drawImage(
          entry.image,
          tx * die.tileSize * f - lx0,
          ty * die.tileSize * f - ly0,
          entry.image.naturalWidth * f,
          entry.image.naturalHeight * f
        );
      }
    }
  }

  const region: DieRegion = {
    canvas,
    rect: { x: lx0 * s, y: ly0 * s, width: w * s, height: h * s },
    complete
  };
  regions.delete(key);
  regions.set(key, region);
  evict();
  return region;
}

function requestTile(url: string, onLoad: () => void): TileEntry {
  let entry = tiles.get(url);
  if (!entry) {
    const image = new Image();
    image.decoding = "async";
    const created: TileEntry = {
      image,
      settled: false,
      failed: false,
      waiters: new Set(),
      lastUsed: ++useCounter
    };
    const settle = (failed: boolean) => {
      created.settled = true;
      created.failed = failed;
      const waiters = [...created.waiters];
      created.waiters.clear();
      for (const w of waiters) w();
    };
    image.addEventListener("load", () => settle(false));
    image.addEventListener("error", () => settle(true));
    image.src = url;
    tiles.set(url, created);
    entry = created;
  }
  if (!entry.settled) entry.waiters.add(onLoad);
  return entry;
}

function evict(): void {
  // Map iteration is insertion order: regions are re-inserted on use, so the
  // first ones are the least recently used.
  while (regions.size > MAX_REGIONS) {
    const oldest = regions.keys().next().value;
    if (oldest === undefined) break;
    regions.delete(oldest);
  }
  if (tiles.size <= MAX_TILES) return;
  const settled = [...tiles.entries()]
    .filter(([, t]) => t.settled)
    .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (let i = 0; i < settled.length && tiles.size > MAX_TILES; i++) {
    tiles.delete(settled[i][0]);
  }
}
