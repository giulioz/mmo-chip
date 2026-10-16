import type { DieMetadata } from "shared";
import type { Rect } from "../../lib/geometry";
import type { Layer, TileBounds } from "../types";

const MAX_IMAGE_TILES_CACHED = 256;

interface CachedImageTile {
  z: number;
  x: number;
  y: number;
  image: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
  lastUsed: number;
}

/**
 * Renders the backend-tiled die image into the tiled renderer's offscreen
 * canvases. World coordinates == source image pixel coordinates.
 *
 * Backend `levels[z].scale` is **source pixels per level pixel** — level 0 is
 * the coarsest (largest scale, one tile covering the whole die), and
 * `levels[maxZoomLevel]` is full resolution (scale = 1). So:
 *
 *   sourceCoord = levelCoord * scale
 *   levelCoord  = sourceCoord / scale
 *
 * One level pixel rendered at display zoom Z spans `scale * Z` CSS pixels.
 * We pick the coarsest level whose `scale ≤ 1/Z` so each level pixel is at
 * most one CSS pixel (no upsampling), keeping tile count small.
 */
/** Live display controls for the base image (read fresh each draw so pref
 *  changes take effect on the next invalidate without rebuilding the layer). */
export interface DieImageDisplay {
  /** True → don't paint the image at all. */
  getHidden?: () => boolean;
  /** 0..1 multiplier applied to the painted image. */
  getOpacity?: () => number;
}

/** Alternate tile source sharing the die's pyramid geometry — lets the same
 *  layer render derived RGBA overlays (e.g. the wire-likelihood map). */
export interface DieImageSource {
  /** Layer id (must be unique among a renderer's layers). */
  id: string;
  tileUrl: (z: number, x: number, y: number) => string;
  /** Draw cached coarser levels underneath the target level. Right for the
   *  opaque base image (no flash while finer tiles load); wrong for a
   *  translucent overlay, where stacked levels would compound. Default true. */
  pyramid?: boolean;
  /** Lowest level that has tiles; at coarser zooms nothing is drawn. */
  minLevel?: number;
}

export class DieImageLayer implements Layer {
  readonly id: string;
  private readonly source: DieImageSource | null;
  private readonly metadata: DieMetadata;
  private readonly cache = new Map<string, CachedImageTile>();
  private useCounter = 0;
  private invalidateCb: ((rect?: Rect) => void) | null = null;
  private readonly display: DieImageDisplay;
  /** Reused scratch canvas for opacity compositing (tiles render serially, so
   *  one is safe). Lazily created / resized to the tile's device size. */
  private scratch: HTMLCanvasElement | null = null;

  constructor(
    metadata: DieMetadata,
    display: DieImageDisplay = {},
    source: DieImageSource | null = null
  ) {
    this.metadata = metadata;
    this.display = display;
    this.source = source;
    this.id = source?.id ?? "die-image";
  }

  subscribe(invalidate: (worldRect?: Rect) => void): () => void {
    this.invalidateCb = invalidate;
    return () => {
      this.invalidateCb = null;
    };
  }

  draw(ctx: CanvasRenderingContext2D, bounds: TileBounds): void {
    if (this.display.getHidden?.()) return;
    const opacity = this.display.getOpacity?.() ?? 1;
    if (opacity <= 0) return;

    const { world, zoom } = bounds;
    const targetLevel = this.pickLevel(zoom);

    // Progressive enhancement: draw every coarser level whose tiles we already
    // have in cache, then overdraw the target level. This means there's always
    // some content visible while finer tiles are still loading — no black
    // flash when zooming in. We only fire network requests for the target
    // level, so coarser levels are pure-cache reads.
    if (this.source?.minLevel !== undefined && targetLevel < this.source.minLevel) return;
    const stackLevels = this.source?.pyramid !== false;
    const drawPyramid = (g: CanvasRenderingContext2D) => {
      for (let level = 0; stackLevels && level < targetLevel; level++) {
        this.drawLevel(g, level, world, false);
      }
      this.drawLevel(g, targetLevel, world, true);
    };

    if (opacity >= 1) {
      drawPyramid(ctx);
      this.evictIfNeeded();
      return;
    }

    // Partial opacity: the pyramid stacks several semi-transparent levels, so
    // applying `globalAlpha` per `drawImage` would compound (more so the more
    // zoomed-in we are — more coarse levels underneath). Composite the whole
    // pyramid opaque into a scratch canvas, then blit it once at `opacity`.
    const px = Math.max(1, Math.round(bounds.size * bounds.dpr));
    let scratch = this.scratch;
    if (!scratch) scratch = this.scratch = document.createElement("canvas");
    if (scratch.width !== px || scratch.height !== px) {
      scratch.width = px;
      scratch.height = px;
    }
    const sctx = scratch.getContext("2d");
    if (!sctx) {
      // No 2D context for the scratch canvas — fall back to the (slightly
      // zoom-dependent) direct path rather than drawing nothing.
      ctx.save();
      ctx.globalAlpha = opacity;
      drawPyramid(ctx);
      ctx.restore();
      this.evictIfNeeded();
      return;
    }

    // Mirror the tile transform (see TiledRenderer.renderTile) so world-space
    // drawing lands in the same pixels as the real tile canvas.
    sctx.setTransform(1, 0, 0, 1, 0, 0);
    sctx.clearRect(0, 0, px, px);
    sctx.scale(bounds.dpr * zoom, bounds.dpr * zoom);
    sctx.translate(-world.x, -world.y);
    drawPyramid(sctx);

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0); // blit 1:1 in device pixels
    ctx.globalAlpha = opacity;
    ctx.drawImage(scratch, 0, 0);
    ctx.restore();

    this.evictIfNeeded();
  }

  private drawLevel(
    ctx: CanvasRenderingContext2D,
    level: number,
    world: Rect,
    fetchMissing: boolean
  ): void {
    const meta = this.metadata;
    const levelMeta = meta.levels[level];
    if (!levelMeta) return;

    const ts = meta.tileSize;
    const scale = levelMeta.scale;
    const tileWorldSize = ts * scale;

    const minTx = Math.max(0, Math.floor(world.x / tileWorldSize));
    const minTy = Math.max(0, Math.floor(world.y / tileWorldSize));
    const maxTx = Math.min(
      levelMeta.columns - 1,
      Math.floor((world.x + world.width - 1e-6) / tileWorldSize)
    );
    const maxTy = Math.min(
      levelMeta.rows - 1,
      Math.floor((world.y + world.height - 1e-6) / tileWorldSize)
    );
    if (minTx > maxTx || minTy > maxTy) return;

    for (let tx = minTx; tx <= maxTx; tx++) {
      for (let ty = minTy; ty <= maxTy; ty++) {
        const key = `${level}/${tx}/${ty}`;
        let tile = this.cache.get(key);
        if (!tile) {
          if (!fetchMissing) continue;
          tile = this.getOrLoadTile(level, tx, ty);
        }
        if (!tile.loaded || tile.failed) continue;
        const worldX = tx * tileWorldSize;
        const worldY = ty * tileWorldSize;
        const worldW = tile.image.naturalWidth * scale;
        const worldH = tile.image.naturalHeight * scale;
        ctx.drawImage(tile.image, worldX, worldY, worldW, worldH);
        tile.lastUsed = ++this.useCounter;
      }
    }
  }

  /** Coarsest level whose scale is ≤ 1/zoom (so each level pixel is ≤ 1 CSS pixel). */
  private pickLevel(zoom: number): number {
    const levels = this.metadata.levels;
    const maxScale = 1 / Math.max(zoom, 1e-6);
    for (let z = 0; z < levels.length; z++) {
      if (levels[z].scale <= maxScale) return z;
    }
    return levels.length - 1;
  }

  private getOrLoadTile(z: number, x: number, y: number): CachedImageTile {
    const key = `${z}/${x}/${y}`;
    const existing = this.cache.get(key);
    if (existing) return existing;

    const image = new Image();
    image.decoding = "async";
    const entry: CachedImageTile = {
      z,
      x,
      y,
      image,
      loaded: false,
      failed: false,
      lastUsed: ++this.useCounter
    };
    this.cache.set(key, entry);

    const levelMeta = this.metadata.levels[z];
    const tileWorldSize = this.metadata.tileSize * levelMeta.scale;
    const worldX = x * tileWorldSize;
    const worldY = y * tileWorldSize;

    image.addEventListener("load", () => {
      entry.loaded = true;
      // We can't know natural dimensions until load, so invalidate using
      // the worst-case full tile rect — slightly conservative is fine.
      this.invalidateCb?.({
        x: worldX,
        y: worldY,
        width: tileWorldSize,
        height: tileWorldSize
      });
    });
    image.addEventListener("error", () => {
      entry.failed = true;
    });

    image.src = this.source
      ? this.source.tileUrl(z, x, y)
      : `/api/dies/${this.metadata.id}/tiles/${z}/${x}/${y}`;
    return entry;
  }

  private evictIfNeeded() {
    if (this.cache.size <= MAX_IMAGE_TILES_CACHED) return;
    const entries = [...this.cache.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const drop = this.cache.size - MAX_IMAGE_TILES_CACHED;
    for (let i = 0; i < drop; i++) this.cache.delete(entries[i][0]);
  }
}
