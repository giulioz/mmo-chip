import sharp from "sharp";
import type { createTileScheduler } from "../tileScheduler.js";
import type { DieRecord } from "../types.js";
import type { Region } from "./pixels.js";

type TileScheduler = ReturnType<typeof createTileScheduler>;

interface DecodedTile {
  w: number;
  h: number;
  data: Buffer;
}

/**
 * Reads arbitrary source-pixel regions of a die by stitching its native
 * (full-resolution) tiles. Goes through the tile scheduler, so tiles that
 * were never viewed are generated on demand exactly like a viewer request.
 * Far cheaper than extracting from the original image per crop: a JPEG has
 * no random access, so every extract would decode down to the crop's rows.
 */
export function createTileReader(record: DieRecord, scheduler: TileScheduler, maxCached = 96) {
  const z = record.maxZoomLevel;
  const ts = record.tileSize;
  const cache = new Map<string, DecodedTile>();

  async function tile(tx: number, ty: number): Promise<DecodedTile> {
    const key = `${tx}/${ty}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    const tilePath = await scheduler.requestTile(record, z, tx, ty);
    const { data, info } = await sharp(tilePath).removeAlpha().toColourspace("srgb").raw().toBuffer({ resolveWithObject: true });
    const decoded = { w: info.width, h: info.height, data };
    cache.set(key, decoded);
    if (cache.size > maxCached) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return decoded;
  }

  /** RGB bytes for the box, or null when it isn't fully inside the die. */
  async function region(x0: number, y0: number, w: number, h: number): Promise<Region | null> {
    if (x0 < 0 || y0 < 0 || w <= 0 || h <= 0 || x0 + w > record.width || y0 + h > record.height) return null;
    const out = new Uint8Array(w * h * 3);
    for (let ty = Math.floor(y0 / ts); ty <= Math.floor((y0 + h - 1) / ts); ty++) {
      for (let tx = Math.floor(x0 / ts); tx <= Math.floor((x0 + w - 1) / ts); tx++) {
        const t = await tile(tx, ty);
        const sx0 = Math.max(x0, tx * ts);
        const sy0 = Math.max(y0, ty * ts);
        const sx1 = Math.min(x0 + w, tx * ts + t.w);
        const sy1 = Math.min(y0 + h, ty * ts + t.h);
        for (let y = sy0; y < sy1; y++) {
          const src = ((y - ty * ts) * t.w + (sx0 - tx * ts)) * 3;
          out.set(t.data.subarray(src, src + (sx1 - sx0) * 3), ((y - y0) * w + (sx0 - x0)) * 3);
        }
      }
    }
    return { x0, y0, w, h, data: out };
  }

  return { region };
}

export type TileReader = ReturnType<typeof createTileReader>;
