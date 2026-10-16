import type { Cell, CellType } from "shared";
import {
  applyParams,
  bestShift,
  channelStats,
  extractInner,
  fitToReference,
  flipPadded,
  grayOf,
  matchStats,
  paddedDieBox,
  registerInstance,
  resampleBand,
  sharpnessOf,
  stackCentre,
  toCanonicalImageScaled,
  unsharp,
  type ChannelStats,
  type PhotoParams,
  type Registration
} from "./pixels.js";
import type { TileReader } from "./tileReader.js";

/**
 * Padding around each crop, which is also the largest placement error the
 * registration can absorb. Scales with the cell: a big cell drawn by hand is
 * off by more pixels than a small one, and on a poor scan the annotation can
 * miss by 20–30 px — a fixed 10 px margin then leaves the instance
 * unregistrable and blurs the median.
 */
export function marginFor(W: number, H: number): number {
  return Math.min(48, Math.max(10, Math.round(0.03 * Math.max(W, H))));
}
/** Instances stacked per type. The median converges long before this; the
 *  cap bounds memory (N × W × H × 3 floats) and time on huge types. */
export const MAX_INSTANCES = 128;

/** The display specimen is reconstructed at this multiple of the source
 *  resolution. Instances land at random sub-pixel phases, so once each is
 *  registered to a fraction of a pixel the stack genuinely samples the cell
 *  more finely than any single crop. */
export const DISPLAY_SCALE = 2;
/** Fraction of instances (best-focused first) used for the display specimen —
 *  "lucky imaging": focus varies across the mosaic, and a median over blurry
 *  and sharp copies lands in between. */
const LUCKY_FRACTION = 0.35;
const LUCKY_MIN = 12;
const LUCKY_MAX = 48;
/** Unsharp mask on the 2× median (σ in output px): matched to the ~half-pixel
 *  registration jitter that survives the affine fit. */
const SHARPEN_SIGMA = 2.5;
const SHARPEN_AMOUNT = 1.3;
/** Output rows per band when building the high-resolution median. */
const BAND_ROWS = 48;

export interface SpecimenResult {
  width: number;
  height: number;
  centre: Float32Array;
  mad: Float32Array;
  instancesUsed: number;
  /** Sharpened (width·DISPLAY_SCALE)×(height·DISPLAY_SCALE) rendering. */
  display: Float32Array;
  displayInstances: number;
  /** Instances that registered only when mirrored vs their annotation. */
  orientationMismatches: number;
  orientationMismatchIds: string[];
}

/** Deterministic spread of up to `max` members across the list (stable
 *  between runs so re-generating doesn't reshuffle the result). */
export function pickInstances<T>(members: ReadonlyArray<T>, max: number): T[] {
  if (members.length <= max) return [...members];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(members[Math.floor((i * members.length) / max)]);
  return out;
}

/** An instance of the type on another die (cell library): read through that
 *  die's `reader`; `k` = this die's pixels per that die's pixel. */
export interface ForeignInstance {
  cell: Cell;
  reader: TileReader;
  k: number;
}

function meanStats(all: ChannelStats[]): ChannelStats {
  const mean: [number, number, number] = [0, 0, 0];
  const std: [number, number, number] = [0, 0, 0];
  for (const s of all) for (let c = 0; c < 3; c++) { mean[c] += s.mean[c] / all.length; std[c] += s.std[c] / all.length; }
  return { mean, std };
}

/**
 * Clean specimen of one cell type: crop every (sampled) instance into the
 * canonical frame, register it (first against one instance, then against the
 * running centre), equalise brightness/contrast per channel, and take the
 * per-pixel percentile. Whatever differs between instances — wires routed
 * over the cell, debris — is a minority at any given pixel and drops out.
 */
export async function buildSpecimen(
  cellType: CellType,
  members: ReadonlyArray<Cell>,
  reader: TileReader,
  options: {
    percentile?: number;
    /** Instances on other dies of the library, resampled to this die's
     *  pixels and stacked with this die's own (which go first). */
    foreign?: ReadonlyArray<ForeignInstance>;
  } = {},
  hooks: { onProgress?: (fraction: number) => void; shouldCancel?: () => boolean; yieldToLoop?: () => Promise<void> } = {}
): Promise<SpecimenResult | null> {
  const W = Math.round(cellType.cropRect.width);
  const H = Math.round(cellType.cropRect.height);
  if (W < 8 || H < 8) return null;
  const MARGIN = marginFor(W, H);
  const SHIFT_RADIUS = MARGIN;
  const percentile = options.percentile ?? 50;
  const tick = hooks.yieldToLoop ?? (() => Promise.resolve());

  const padded: Float32Array[] = [];
  /** Cell behind each entry of `padded` (instances leaving the die are skipped). */
  const used: Cell[] = [];
  // This die's instances first; the rest of the budget goes to other dies',
  // sharper photos (smaller k) ahead of coarser ones.
  const own = pickInstances(members, MAX_INSTANCES).map((cell) => ({ cell, reader, k: 1 }));
  const others = [...(options.foreign ?? [])].sort((a, b) => a.k - b.k);
  const picked = [...own, ...pickInstances(others, MAX_INSTANCES - own.length)];
  const ownIds = new Set(members.map((c) => c.id));
  for (let i = 0; i < picked.length; i++) {
    if (hooks.shouldCancel?.()) return null;
    const { cell, reader: from, k } = picked[i];
    const box = paddedDieBox(cell, W / k, H / k, MARGIN / k);
    // One more pixel around a resampled one, for the bilinear taps.
    const pad = k === 1 ? 0 : 1;
    const region = await from.region(box.x0 - pad, box.y0 - pad, box.w + 2 * pad, box.h + 2 * pad);
    if (region) {
      padded.push(toCanonicalImageScaled(region, cell, W, H, MARGIN, k));
      used.push(cell);
    }
    hooks.onProgress?.((0.3 * (i + 1)) / picked.length);
    await tick();
  }
  if (padded.length === 0) return null;

  const pw = W + 2 * MARGIN;
  const ph = H + 2 * MARGIN;
  const grays = padded.map((p) => grayOf(p, pw, ph));
  let ref = grayOf(extractInner(padded[0], W, H, MARGIN, { dx: 0, dy: 0 }), W, H);
  let result: { centre: Float32Array; mad: Float32Array } = {
    centre: new Float32Array(0),
    mad: new Float32Array(0)
  };
  const photo: PhotoParams[] = padded.map(() => ({ a: [1, 1, 1], b: [0, 0, 0] }));
  const regs: (Registration | null)[] = padded.map(() => null);
  let lastInner: Float32Array[] = [];
  const passes = padded.length > 1 ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const inner: Float32Array[] = [];
    for (let i = 0; i < padded.length; i++) {
      if (hooks.shouldCancel?.()) return null;
      if (pass === 0) {
        // Pass 0 has only one instance as reference: a cheap integer shift
        // gets a first centre to register everything against properly.
        const s = padded.length > 1 ? bestShift(ref, W, H, grays[i], MARGIN, SHIFT_RADIUS) : { dx: 0, dy: 0 };
        inner.push(extractInner(padded[i], W, H, MARGIN, s));
      } else {
        // Full registration against the first-pass median: orientation
        // check (mis-annotated flips), then affine (scale / shear / squish).
        const reg = registerInstance(ref, W, H, padded[i], MARGIN, { detectFlips: true, shiftRadius: SHIFT_RADIUS });
        regs[i] = reg;
        const src = flipPadded(padded[i], pw, ph, reg.flipH, reg.flipV);
        inner.push(resampleBand(src, pw, ph, reg.warp, W, 1, 0, H));
      }
      hooks.onProgress?.(0.3 + (0.35 * (pass + (i + 1) / padded.length)) / passes);
      await tick();
    }
    if (pass === 0) {
      // No reference yet: equalise global brightness / contrast.
      const target = meanStats(inner.map(channelStats));
      for (const im of inner) matchStats(im, target);
    } else {
      // With a first centre in hand, fit each instance to it robustly so
      // wires over an instance don't skew its normalisation.
      inner.forEach((im, i) => {
        photo[i] = fitToReference(im, result.centre);
      });
    }
    result = stackCentre(inner, percentile);
    ref = grayOf(result.centre, W, H);
    lastInner = inner;
    await tick();
  }

  // ── Display rendering: sharpest instances, affine-registered, 2× ──────
  const n = padded.length;
  const wanted = n <= LUCKY_MIN ? n : Math.min(LUCKY_MAX, Math.max(LUCKY_MIN, Math.round(LUCKY_FRACTION * n)));
  const bySharpness = lastInner
    .map((im, i) => ({ i, s: sharpnessOf(im, result.centre, W, H) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, wanted)
    .map((x) => x.i);
  // Single-instance types never ran pass 1: identity registration.
  const regOf = (i: number): Registration =>
    regs[i] ?? {
      flipH: false,
      flipV: false,
      warp: { x: [MARGIN, 1, 0], y: [MARGIN, 0, 1] },
      affine: { x: [MARGIN, 1, 0], y: [MARGIN, 0, 1] },
      score: 1
    };
  const ow = W * DISPLAY_SCALE;
  const oh = H * DISPLAY_SCALE;
  const hi = new Float32Array(ow * oh * 3);
  for (let row0 = 0; row0 < oh; row0 += BAND_ROWS) {
    if (hooks.shouldCancel?.()) return null;
    const row1 = Math.min(oh, row0 + BAND_ROWS);
    const band = bySharpness.map((i) => {
      const reg = regOf(i);
      const src = flipPadded(padded[i], pw, ph, reg.flipH, reg.flipV);
      const b = resampleBand(src, pw, ph, reg.warp, W, DISPLAY_SCALE, row0, row1);
      // Same photometric correction as the 1× pass (pass 0 only matched
      // global stats, so a single-pass stack carries identity params).
      applyParams(b, photo[i]);
      return b;
    });
    hi.set(stackCentre(band, percentile).centre, row0 * ow * 3);
    hooks.onProgress?.(0.65 + 0.33 * (row1 / oh));
    await tick();
  }
  const display = unsharp(hi, ow, oh, SHARPEN_SIGMA, SHARPEN_AMOUNT);
  hooks.onProgress?.(1);
  return {
    width: W,
    height: H,
    centre: result.centre,
    mad: result.mad,
    instancesUsed: n,
    display,
    displayInstances: bySharpness.length,
    // This die's instances only: the ids are for flagging them here.
    orientationMismatches: used.filter((c, i) => ownIds.has(c.id) && regs[i] && (regs[i]!.flipH || regs[i]!.flipV)).length,
    orientationMismatchIds: used
      .filter((c, i) => ownIds.has(c.id) && regs[i] && (regs[i]!.flipH || regs[i]!.flipV))
      .map((c) => c.id)
  };
}

export function toBytes(f: Float32Array, scale = 1): Buffer {
  const out = Buffer.alloc(f.length);
  for (let i = 0; i < f.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i] * scale)));
  return out;
}
