import type { Cell } from "shared";
import { applyOrient, orientOf, toCanonical, type Orient } from "../ml/cellDetect.js";

/**
 * Pixel math for cell imaging. Pure functions over typed arrays so they can
 * be unit-tested without a die on disk.
 *
 * Conventions: RGB images are interleaved Float32Array (or Uint8Array for raw
 * tile bytes), row-major. "Canonical" = the cell type's own frame (an
 * unflipped, unrotated instance); a padded canonical image carries `margin`
 * extra pixels on every side so small alignment shifts never run out of data.
 */

export interface Region {
  x0: number;
  y0: number;
  w: number;
  h: number;
  /** Interleaved RGB bytes. */
  data: Uint8Array;
}

/** Integer die-pixel box that covers a cell's padded canonical box. */
export function paddedDieBox(
  cell: Pick<Cell, "x" | "y" | "flippedH" | "flippedV" | "rotation">,
  W: number,
  H: number,
  margin: number
): { x0: number; y0: number; w: number; h: number } {
  const o = orientOf(cell);
  const corners = [
    { x: -margin, y: -margin },
    { x: W + margin, y: -margin },
    { x: W + margin, y: H + margin },
    { x: -margin, y: H + margin }
  ].map((p) => applyOrient(p, o, W, H));
  const xs = corners.map((p) => p.x + cell.x);
  const ys = corners.map((p) => p.y + cell.y);
  const x0 = Math.floor(Math.min(...xs));
  const y0 = Math.floor(Math.min(...ys));
  return { x0, y0, w: Math.ceil(Math.max(...xs)) - x0, h: Math.ceil(Math.max(...ys)) - y0 };
}

/**
 * Resample a die region into the cell's padded canonical frame (undoing the
 * instance's flip / rotation). Orientations are multiples of 90° with
 * mirrors, so this is an exact pixel permutation — no interpolation.
 */
export function toCanonicalImage(
  region: Region,
  cell: Pick<Cell, "x" | "y" | "flippedH" | "flippedV" | "rotation">,
  W: number,
  H: number,
  margin: number
): Float32Array {
  const o = orientOf(cell);
  const pw = W + 2 * margin;
  const ph = H + 2 * margin;
  const out = new Float32Array(pw * ph * 3);
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      const p = applyOrient({ x: px - margin + 0.5, y: py - margin + 0.5 }, o, W, H);
      const dx = Math.floor(p.x + cell.x) - region.x0;
      const dy = Math.floor(p.y + cell.y) - region.y0;
      if (dx < 0 || dy < 0 || dx >= region.w || dy >= region.h) continue;
      const s = (dy * region.w + dx) * 3;
      const d = (py * pw + px) * 3;
      out[d] = region.data[s];
      out[d + 1] = region.data[s + 1];
      out[d + 2] = region.data[s + 2];
    }
  }
  return out;
}

/**
 * `toCanonicalImage` for an instance on another die whose pixels are 1/`k` of
 * this die's: the padded canonical frame is in this die's pixels (the type's
 * W×H box here, `margin` around it), sampled bilinearly from `region` — the
 * instance's own die, covering `paddedDieBox(cell, W / k, H / k, margin / k)`
 * plus a pixel. `k` 1 is the exact permutation of `toCanonicalImage`.
 */
export function toCanonicalImageScaled(
  region: Region,
  cell: Pick<Cell, "x" | "y" | "flippedH" | "flippedV" | "rotation">,
  W: number,
  H: number,
  margin: number,
  k: number
): Float32Array {
  if (k === 1) return toCanonicalImage(region, cell, W, H, margin);
  const o = orientOf(cell);
  const w = W / k;
  const h = H / k;
  const pw = W + 2 * margin;
  const ph = H + 2 * margin;
  const out = new Float32Array(pw * ph * 3);
  const rw = region.w;
  for (let py = 0; py < ph; py++) {
    for (let px = 0; px < pw; px++) {
      // This die's canonical pixel centre → that die's canonical point → die.
      const p = applyOrient({ x: (px - margin + 0.5) / k, y: (py - margin + 0.5) / k }, o, w, h);
      const fx = p.x + cell.x - region.x0 - 0.5;
      const fy = p.y + cell.y - region.y0 - 0.5;
      if (fx < 0 || fy < 0 || fx > rw - 1 || fy > region.h - 1) continue;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const x1 = Math.min(rw - 1, x0 + 1);
      const y1 = Math.min(region.h - 1, y0 + 1);
      const ax = fx - x0;
      const ay = fy - y0;
      const d = (py * pw + px) * 3;
      for (let c = 0; c < 3; c++) {
        const top = region.data[(y0 * rw + x0) * 3 + c] * (1 - ax) + region.data[(y0 * rw + x1) * 3 + c] * ax;
        const bot = region.data[(y1 * rw + x0) * 3 + c] * (1 - ax) + region.data[(y1 * rw + x1) * 3 + c] * ax;
        out[d + c] = top * (1 - ay) + bot * ay;
      }
    }
  }
  return out;
}

/** Inverse lookup used when pasting canonical data back onto the die:
 *  canonical pixel index for a die pixel, or -1 outside the cell. */
export function canonicalIndexForDiePixel(
  dieX: number,
  dieY: number,
  cell: Pick<Cell, "x" | "y">,
  o: Orient,
  W: number,
  H: number
): number {
  const c = toCanonical({ x: dieX + 0.5 - cell.x, y: dieY + 0.5 - cell.y }, o, W, H);
  const cx = Math.floor(c.x);
  const cy = Math.floor(c.y);
  if (cx < 0 || cy < 0 || cx >= W || cy >= H) return -1;
  return cy * W + cx;
}

export function grayOf(rgb: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 3) g[i] = (rgb[j] + rgb[j + 1] + rgb[j + 2]) / 3;
  return g;
}

export function halve(g: Float32Array, w: number, h: number): { g: Float32Array; w: number; h: number } {
  const hw = w >> 1;
  const hh = h >> 1;
  const out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < hw; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * hw + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
    }
  }
  return { g: out, w: hw, h: hh };
}

/** NCC between `ref` (rw×rh) and the same-sized window of `img` whose
 *  top-left is (ox, oy). Windows falling outside `img` score -1. */
function nccAt(
  ref: Float32Array,
  rw: number,
  rh: number,
  img: Float32Array,
  iw: number,
  ih: number,
  ox: number,
  oy: number
): number {
  if (ox < 0 || oy < 0 || ox + rw > iw || oy + rh > ih) return -1;
  const n = rw * rh;
  let sa = 0;
  let sb = 0;
  for (let y = 0; y < rh; y++) {
    const ro = y * rw;
    const io = (y + oy) * iw + ox;
    for (let x = 0; x < rw; x++) {
      sa += ref[ro + x];
      sb += img[io + x];
    }
  }
  const ma = sa / n;
  const mb = sb / n;
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let y = 0; y < rh; y++) {
    const ro = y * rw;
    const io = (y + oy) * iw + ox;
    for (let x = 0; x < rw; x++) {
      const a = ref[ro + x] - ma;
      const b = img[io + x] - mb;
      sab += a * b;
      saa += a * a;
      sbb += b * b;
    }
  }
  const d = Math.sqrt(saa * sbb);
  return d > 0 ? sab / d : -1;
}

export interface Shift {
  dx: number;
  dy: number;
  score: number;
}

/**
 * Integer shift that best registers `img` (a padded gray image whose nominal
 * content starts at (margin, margin)) onto `ref` (the unpadded W×H gray
 * reference). Coarse search at half resolution, then ±1 at full resolution —
 * ~10× cheaper than an exhaustive full-res search for the same radius.
 * A positive dx means the instance's content sits dx pixels to the right of
 * where its annotation says.
 */
export function bestShift(
  ref: Float32Array,
  W: number,
  H: number,
  img: Float32Array,
  margin: number,
  radius: number
): Shift {
  const iw = W + 2 * margin;
  const ih = H + 2 * margin;
  const r = Math.min(radius, margin);
  const hr = halve(ref, W, H);
  const hi = halve(img, iw, ih);
  const hm = margin >> 1;
  let cx = 0;
  let cy = 0;
  let cs = -2;
  const cr = Math.ceil(r / 2);
  for (let dy = -cr; dy <= cr; dy++) {
    for (let dx = -cr; dx <= cr; dx++) {
      const s = nccAt(hr.g, hr.w, hr.h, hi.g, hi.w, hi.h, hm + dx, hm + dy);
      if (s > cs) {
        cs = s;
        cx = dx;
        cy = dy;
      }
    }
  }
  let best: Shift = { dx: 0, dy: 0, score: -2 };
  for (let dy = 2 * cy - 1; dy <= 2 * cy + 1; dy++) {
    for (let dx = 2 * cx - 1; dx <= 2 * cx + 1; dx++) {
      if (Math.abs(dx) > r || Math.abs(dy) > r) continue;
      const s = nccAt(ref, W, H, img, iw, ih, margin + dx, margin + dy);
      if (s > best.score) best = { dx, dy, score: s };
    }
  }
  return best;
}

/** The W×H interior of a padded canonical RGB image, displaced by `shift`. */
export function extractInner(
  padded: Float32Array,
  W: number,
  H: number,
  margin: number,
  shift: { dx: number; dy: number }
): Float32Array {
  const pw = W + 2 * margin;
  const out = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    const src = ((y + margin + shift.dy) * pw + margin + shift.dx) * 3;
    out.set(padded.subarray(src, src + W * 3), y * W * 3);
  }
  return out;
}

export interface ChannelStats {
  mean: [number, number, number];
  std: [number, number, number];
}

export function channelStats(rgb: Float32Array): ChannelStats {
  const n = rgb.length / 3;
  const mean: [number, number, number] = [0, 0, 0];
  const std: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 3) {
    mean[0] += rgb[i];
    mean[1] += rgb[i + 1];
    mean[2] += rgb[i + 2];
  }
  for (let c = 0; c < 3; c++) mean[c] /= n;
  for (let i = 0; i < rgb.length; i += 3) {
    for (let c = 0; c < 3; c++) {
      const d = rgb[i + c] - mean[c];
      std[c] += d * d;
    }
  }
  for (let c = 0; c < 3; c++) std[c] = Math.sqrt(std[c] / n);
  return { mean, std };
}

/** Per-channel gain/offset so `rgb` matches `target`'s mean and contrast —
 *  cancels the illumination / stain drift across the die. In place. */
export function matchStats(rgb: Float32Array, target: ChannelStats): void {
  const s = channelStats(rgb);
  for (let c = 0; c < 3; c++) {
    const g = s.std[c] > 1e-3 ? target.std[c] / s.std[c] : 1;
    const m = s.mean[c];
    const t = target.mean[c];
    for (let i = c; i < rgb.length; i += 3) rgb[i] = (rgb[i] - m) * g + t;
  }
}

/**
 * Robust photometric registration: per channel, the gain/offset that maps
 * `rgb` onto `ref` (same size). In place.
 *
 * The gain is the ratio of spreads and the offset aligns the means — but
 * computed over inliers only: after each round the 15% of pixels that
 * disagree most with the current fit (the wire, debris) are dropped and the
 * statistics recomputed on the rest, for both images over the same pixels.
 *
 * Why this estimator and not the obvious ones:
 *  - Plain mean / standard-deviation matching (`matchStats`) is biased by
 *    exactly what we want to isolate: a bright wire inflates the instance's
 *    contrast and drags every other pixel off the reference.
 *  - Regressing `ref` on `rgb` (least squares, IRLS, Theil–Sen alike)
 *    under-estimates the gain because the noise is in the regressor — an
 *    instance is sharp and noisy, the reference a smooth median of many —
 *    which washes the instance out and hides every residual.
 *  - Quantile matching breaks when the wire shifts which population a
 *    quantile lands in.
 * A spread ratio is symmetric in the two images (no attenuation), and
 * trimming removes the contamination.
 */
export function fitToReference(rgb: Float32Array, ref: Float32Array): PhotoParams {
  const n = rgb.length / 3;
  const resid = new Float32Array(n);
  const keep = new Uint8Array(n);
  const params: PhotoParams = { a: [1, 1, 1], b: [0, 0, 0] };
  const ROUNDS = 4;
  const TRIM = 0.15;
  for (let c = 0; c < 3; c++) {
    keep.fill(1);
    let a = 1;
    let b = 0;
    for (let round = 0; round < ROUNDS; round++) {
      let m = 0, sx = 0, sy = 0;
      for (let i = 0, j = c; i < n; i++, j += 3) {
        if (!keep[i]) continue;
        m += 1; sx += rgb[j]; sy += ref[j];
      }
      if (m < 16) break;
      const mx = sx / m;
      const my = sy / m;
      let vx = 0, vy = 0;
      for (let i = 0, j = c; i < n; i++, j += 3) {
        if (!keep[i]) continue;
        vx += (rgb[j] - mx) * (rgb[j] - mx);
        vy += (ref[j] - my) * (ref[j] - my);
      }
      if (vx < 1e-6 || vy < 1e-6) break; // flat channel: leave as is
      const na = Math.sqrt(vy / vx);
      if (!(na > 0.2 && na < 5)) break;
      a = na;
      b = my - a * mx;
      if (round === ROUNDS - 1) break;
      for (let i = 0, j = c; i < n; i++, j += 3) resid[i] = Math.abs(a * rgb[j] + b - ref[j]);
      const cut = Float32Array.from(resid).sort()[Math.floor((1 - TRIM) * (n - 1))];
      for (let i = 0; i < n; i++) keep[i] = resid[i] <= cut ? 1 : 0;
    }
    for (let j = c; j < rgb.length; j += 3) rgb[j] = a * rgb[j] + b;
    params.a[c] = a;
    params.b[c] = b;
  }
  return params;
}

/**
 * Per-pixel robust centre and spread of a stack of equally-sized RGB images:
 * the `percentile`-th value (50 = median) and the median absolute deviation
 * around it. Anything present in a minority of the stack at a given pixel —
 * a wire crossing some instances, dust, a scratch — doesn't move the centre.
 */
export function stackCentre(
  stack: ReadonlyArray<Float32Array>,
  percentile: number
): { centre: Float32Array; mad: Float32Array } {
  const n = stack.length;
  const len = stack[0].length;
  const centre = new Float32Array(len);
  const mad = new Float32Array(len);
  const buf = new Float32Array(n);
  const q = Math.min(n - 1, Math.max(0, Math.round((percentile / 100) * (n - 1))));
  const mid = (n - 1) >> 1;
  for (let i = 0; i < len; i++) {
    for (let k = 0; k < n; k++) buf[k] = stack[k][i];
    buf.sort();
    const c = buf[q];
    centre[i] = c;
    for (let k = 0; k < n; k++) buf[k] = Math.abs(stack[k][i] - c);
    buf.sort();
    mad[i] = buf[mid];
  }
  return { centre, mad };
}

/** Robust per-pixel deviation of one instance from its type's specimen:
 *  mean over channels of |Δ| / (1.4826·MAD + floor). */
export function deviationMap(
  inst: Float32Array,
  centre: Float32Array,
  mad: Float32Array,
  floor: number
): Float32Array {
  const n = inst.length / 3;
  const z = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    let s = 0;
    for (let c = 0; c < 3; c++) s += Math.abs(inst[j + c] - centre[j + c]) / (1.4826 * mad[j + c] + floor);
    z[i] = s / 3;
  }
  return z;
}

/** Mean of `src` along a centred line of `len` pixels (vertical or
 *  horizontal). Outside the image counts as "same as the edge pixel" so a run
 *  that enters from the cell boundary isn't diluted. */
function meanAlong(src: Float32Array, w: number, h: number, len: number, vertical: boolean): Float32Array {
  const half = len >> 1;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let k = -half; k <= half; k++) {
        const xx = vertical ? x : Math.min(w - 1, Math.max(0, x + k));
        const yy = vertical ? Math.min(h - 1, Math.max(0, y + k)) : y;
        sum += src[yy * w + xx];
      }
      out[y * w + x] = sum / (2 * half + 1);
    }
  }
  return out;
}

/**
 * Turn a deviation map into a 0..1 wire likelihood: soft-threshold, then
 * score each pixel by how much of a line through it (vertical or horizontal,
 * whichever is fuller) also deviates. Wires are long and axis-aligned;
 * registration fuzz along feature edges and specks of debris are short, so
 * their lines are mostly empty and they fall below `minFill`. A mean rather
 * than a strict morphological opening on purpose: real wire residue is
 * fragmented (the wire only differs from the cell where the cell isn't already
 * bright metal), and one weak pixel must not erase a whole run.
 */
export function wireLikelihood(
  z: Float32Array,
  w: number,
  h: number,
  opts: { lo?: number; hi?: number; runLength?: number; minFill?: number; fullFill?: number } = {}
): Float32Array {
  const lo = opts.lo ?? 1.6;
  const hi = opts.hi ?? 3.5;
  const len = opts.runLength ?? 15;
  const minFill = opts.minFill ?? 0.35;
  const fullFill = opts.fullFill ?? 0.7;
  const soft = new Float32Array(z.length);
  const hit = new Float32Array(z.length);
  for (let i = 0; i < z.length; i++) {
    soft[i] = Math.min(1, Math.max(0, (z[i] - lo) / (hi - lo)));
    hit[i] = z[i] > lo ? 1 : 0;
  }
  // The line votes on "does this pixel deviate at all", not on how strongly:
  // a faint but continuous wire should count as much as a bright one.
  const v = meanAlong(hit, w, h, len, true);
  const hz = meanAlong(hit, w, h, len, false);
  const out = new Float32Array(z.length);
  for (let i = 0; i < out.length; i++) {
    if (hit[i] === 0) continue; // only deviating pixels light up (no smearing along the line)
    const fill = Math.max(v[i], hz[i]);
    const line = Math.min(1, Math.max(0, (fill - minFill) / (fullFill - minFill)));
    out[i] = line * (0.45 + 0.55 * soft[i]);
  }
  return out;
}

// ── High-resolution specimen: local registration, resampling, sharpening ──

/** Gain/offset per channel as computed by `fitToReference`, for re-applying
 *  the same photometric correction to another rendering of the instance. */
export interface PhotoParams {
  a: [number, number, number];
  b: [number, number, number];
}

/** `fitToReference` without touching the input: returns the correction. */
export function fitParams(rgb: Float32Array, ref: Float32Array): PhotoParams {
  return fitToReference(Float32Array.from(rgb), ref);
}

export function applyParams(rgb: Float32Array, p: PhotoParams): void {
  for (let c = 0; c < 3; c++) for (let j = c; j < rgb.length; j += 3) rgb[j] = p.a[c] * rgb[j] + p.b[c];
}

/** Focus measure of an instance: mean gradient *energy* (squared finite
 *  differences — the Tenengrad idea) over the pixels where it agrees with the
 *  reference, so wires over it don't count as "sharpness". Squared on purpose:
 *  the plain sum of |gradient| is the total variation, which blur leaves
 *  almost unchanged (an edge spread over five pixels still climbs the same
 *  height), whereas its energy falls steeply. Higher = better focused. */
export function sharpnessOf(inst: Float32Array, centre: Float32Array, W: number, H: number): number {
  const g = grayOf(inst, W, H);
  const m = grayOf(centre, W, H);
  let sum = 0;
  let cnt = 0;
  for (let y = 0; y < H - 1; y++) {
    for (let x = 0; x < W - 1; x++) {
      const i = y * W + x;
      if (Math.abs(g[i] - m[i]) > 12) continue;
      const gx = g[i + 1] - g[i];
      const gy = g[i + W] - g[i];
      sum += gx * gx + gy * gy;
      cnt += 1;
    }
  }
  return cnt > 0 ? sum / cnt : 0;
}

/** Source-coordinate model for one instance: a canonical point (u, v) (pixel
 *  centres at integers) is found in the padded image at
 *  (x0 + x1·u + x2·v, y0 + y1·u + y2·v). */
export interface Affine {
  x: [number, number, number];
  y: [number, number, number];
}

function parabolicPeak(sm: number, s0: number, sp: number): number {
  const curv = sm - 2 * s0 + sp;
  if (!(curv < 0)) return 0;
  return Math.min(0.5, Math.max(-0.5, (sm - sp) / (2 * curv)));
}

/** Mirror a padded canonical RGB image in place-free fashion. */
export function flipPadded(padded: Float32Array, pw: number, ph: number, flipH: boolean, flipV: boolean): Float32Array {
  if (!flipH && !flipV) return padded;
  const out = new Float32Array(padded.length);
  for (let y = 0; y < ph; y++) {
    const sy = flipV ? ph - 1 - y : y;
    for (let x = 0; x < pw; x++) {
      const sx = flipH ? pw - 1 - x : x;
      const si = (sy * pw + sx) * 3;
      const di = (y * pw + x) * 3;
      out[di] = padded[si];
      out[di + 1] = padded[si + 1];
      out[di + 2] = padded[si + 2];
    }
  }
  return out;
}

/** NCC between the reference and a 1× rendering of the instance through an
 *  affine — the yardstick for "did this registration actually help". */
function renderedScore(ref: Float32Array, W: number, H: number, padded: Float32Array, pw: number, ph: number, aff: Warp): number {
  const g = grayOf(resampleBand(padded, pw, ph, aff, W, 1, 0, H), W, H);
  return nccAt(ref, W, H, g, W, H, 0, 0);
}

/** Displacement measured for one block of the cell: canonical block centre
 *  (u, v) and the extra source shift (sx, sy) beyond the base translation. */
interface BlockShift {
  u: number;
  v: number;
  sx: number;
  sy: number;
  w: number;
}

/**
 * Per-block sub-pixel shifts of the instance against the reference: coarse
 * search at half resolution, ±1 refinement at full, parabolic peak. The
 * search radius scales with the cell so a few percent of scale is reachable
 * at the block centres. Blocks without texture or under a wire score low and
 * are dropped.
 */
function blockShifts(
  ref: Float32Array,
  W: number,
  H: number,
  img: Float32Array,
  margin: number,
  base: { dx: number; dy: number },
  radius?: number
): { pts: BlockShift[]; gx: number; gy: number; bw: number; bh: number } {
  const iw = W + 2 * margin;
  const ih = H + 2 * margin;
  const r = radius ?? Math.min(40, Math.max(3, Math.ceil(0.05 * (Math.max(W, H) / 2))));
  const gx = Math.max(1, Math.min(5, Math.floor(W / 28)));
  const gy = Math.max(1, Math.min(4, Math.floor(H / 28)));
  const bw = Math.floor(W / gx);
  const bh = Math.floor(H / gy);
  const pts: BlockShift[] = [];
  const hr = halve(ref, W, H);
  const hi = halve(img, iw, ih);
  const hbw = bw >> 1;
  const hbh = bh >> 1;
  const hblock = new Float32Array(hbw * hbh);
  const block = new Float32Array(bw * bh);
  const cr = Math.ceil(r / 2);
  // Coarse pass over every block first; the quality bar is then set relative
  // to this instance's own median block score. A fixed threshold would throw
  // away every block of a blurry, low-contrast scan (where even correct
  // matches only reach ~0.25) and leave nothing to fit.
  const coarseAll: { x0: number; y0: number; s: number; dx: number; dy: number }[] = [];
  for (let by = 0; by < gy; by++) {
    for (let bx = 0; bx < gx; bx++) {
      const x0 = bx * bw;
      const y0 = by * bh;
      for (let y = 0; y < hbh; y++) hblock.set(hr.g.subarray(((y0 >> 1) + y) * hr.w + (x0 >> 1), ((y0 >> 1) + y) * hr.w + (x0 >> 1) + hbw), y * hbw);
      const hox = (margin + base.dx + x0) >> 1;
      const hoy = (margin + base.dy + y0) >> 1;
      let coarse = { s: -2, dx: 0, dy: 0 };
      for (let ddy = -cr; ddy <= cr; ddy++) {
        for (let ddx = -cr; ddx <= cr; ddx++) {
          const sc = nccAt(hblock, hbw, hbh, hi.g, hi.w, hi.h, hox + ddx, hoy + ddy);
          if (sc > coarse.s) coarse = { s: sc, dx: ddx, dy: ddy };
        }
      }
      coarseAll.push({ x0, y0, ...coarse });
    }
  }
  const medianScore = [...coarseAll].sort((p, q) => p.s - q.s)[coarseAll.length >> 1]?.s ?? 0;
  const bar = Math.max(0.1, 0.5 * medianScore);
  for (const { x0, y0, ...coarse } of coarseAll) {
    {
      if (coarse.s < bar) continue;
      for (let y = 0; y < bh; y++) block.set(ref.subarray((y0 + y) * W + x0, (y0 + y) * W + x0 + bw), y * bw);
      const at = (ddx: number, ddy: number) => nccAt(block, bw, bh, img, iw, ih, margin + base.dx + x0 + ddx, margin + base.dy + y0 + ddy);
      let best = { s: -2, dx: 0, dy: 0 };
      for (let ddy = 2 * coarse.dy - 1; ddy <= 2 * coarse.dy + 1; ddy++) {
        for (let ddx = 2 * coarse.dx - 1; ddx <= 2 * coarse.dx + 1; ddx++) {
          const sc = at(ddx, ddy);
          if (sc > best.s) best = { s: sc, dx: ddx, dy: ddy };
        }
      }
      if (best.s < bar) continue;
      const fx = parabolicPeak(at(best.dx - 1, best.dy), best.s, at(best.dx + 1, best.dy));
      const fy = parabolicPeak(at(best.dx, best.dy - 1), best.s, at(best.dx, best.dy + 1));
      pts.push({ u: x0 + (bw - 1) / 2, v: y0 + (bh - 1) / 2, sx: best.dx + fx, sy: best.dy + fy, w: best.s });
    }
  }
  return { pts, gx, gy, bw, bh };
}

function solveAffine(use: BlockShift[], key: "sx" | "sy"): [number, number, number] | null {
  let s1 = 0, su = 0, sv = 0, suu = 0, suv = 0, svv = 0, t0 = 0, tu = 0, tv = 0;
  for (const p of use) {
    const w = p.w;
    s1 += w; su += w * p.u; sv += w * p.v; suu += w * p.u * p.u; suv += w * p.u * p.v; svv += w * p.v * p.v;
    t0 += w * p[key]; tu += w * p.u * p[key]; tv += w * p.v * p[key];
  }
  const det = s1 * (suu * svv - suv * suv) - su * (su * svv - suv * sv) + sv * (su * suv - suu * sv);
  if (Math.abs(det) < 1e-9) return null;
  const c0 = (t0 * (suu * svv - suv * suv) - su * (tu * svv - suv * tv) + sv * (tu * suv - suu * tv)) / det;
  const c1 = (s1 * (tu * svv - tv * suv) - t0 * (su * svv - suv * sv) + sv * (su * tv - tu * sv)) / det;
  const c2 = (s1 * (suu * tv - suv * tu) - su * (su * tv - tu * sv) + t0 * (su * suv - suu * sv)) / det;
  return [c0, c1, c2];
}

function affineFrom(pts: BlockShift[], ox: number, oy: number, gx: number, gy: number): Affine | null {
  if (gx < 2 || gy < 2 || pts.length < 4) return null;
  let use = pts;
  let cx = solveAffine(use, "sx");
  let cy = solveAffine(use, "sy");
  if (cx && cy) {
    const inl = pts.filter((p) => Math.hypot(cx![0] + cx![1] * p.u + cx![2] * p.v - p.sx, cy![0] + cy![1] * p.u + cy![2] * p.v - p.sy) <= 1.5);
    if (inl.length >= 4 && inl.length < pts.length) {
      use = inl;
      cx = solveAffine(use, "sx") ?? cx;
      cy = solveAffine(use, "sy") ?? cy;
    }
  }
  // Beyond ~10% scale / shear the fit chased noise, not geometry.
  if (!cx || !cy || [cx[1], cx[2], cy[1], cy[2]].some((k) => Math.abs(k) > 0.1)) return null;
  return { x: [ox + cx[0], 1 + cx[1], cx[2]], y: [oy + cy[0], cy[1], 1 + cy[2]] };
}

function translationFrom(pts: BlockShift[], ox: number, oy: number): Affine {
  let sw = 0, sx = 0, sy = 0;
  for (const p of pts) { sw += p.w; sx += p.w * p.sx; sy += p.w * p.sy; }
  return { x: [ox + (sw ? sx / sw : 0), 1, 0], y: [oy + (sw ? sy / sw : 0), 0, 1] };
}

/**
 * Piecewise mapping: the block displacements interpolated bilinearly over the
 * block grid (clamped beyond the outer block centres). Handles what an affine
 * cannot — a scan that is squished by a different amount across the cell.
 * Missing blocks are filled from the affine so a dropped block doesn't tear
 * the field.
 */
export interface GridWarp {
  kind: "grid";
  gx: number;
  gy: number;
  /** Block-centre coordinates along each axis. */
  us: Float32Array;
  vs: Float32Array;
  /** Source position at each node, row-major (gy × gx). */
  X: Float32Array;
  Y: Float32Array;
}
export type Warp = Affine | GridWarp;

function gridFrom(pts: BlockShift[], fill: Affine, ox: number, oy: number, gx: number, gy: number, bw: number, bh: number): GridWarp | null {
  if (gx < 2 || gy < 2 || pts.length < Math.max(6, Math.ceil(0.6 * gx * gy))) return null;
  const us = new Float32Array(gx);
  const vs = new Float32Array(gy);
  for (let i = 0; i < gx; i++) us[i] = i * bw + (bw - 1) / 2;
  for (let j = 0; j < gy; j++) vs[j] = j * bh + (bh - 1) / 2;
  const X = new Float32Array(gx * gy);
  const Y = new Float32Array(gx * gy);
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      X[j * gx + i] = fill.x[0] + fill.x[1] * us[i] + fill.x[2] * vs[j];
      Y[j * gx + i] = fill.y[0] + fill.y[1] * us[i] + fill.y[2] * vs[j];
    }
  }
  for (const p of pts) {
    const i = Math.round((p.u - (bw - 1) / 2) / bw);
    const j = Math.round((p.v - (bh - 1) / 2) / bh);
    // A block that disagrees wildly with the affine is a bad match, not
    // geometry.
    if (Math.hypot(ox + p.sx - X[j * gx + i], oy + p.sy - Y[j * gx + i]) > 6) continue;
    X[j * gx + i] = ox + p.u + p.sx;
    Y[j * gx + i] = oy + p.v + p.sy;
  }
  return { kind: "grid", gx, gy, us, vs, X, Y };
}

/** Source coordinates of canonical (u, v) under a warp. */
export function warpPoint(w: Warp, u: number, v: number): [number, number] {
  if (!("kind" in w)) return [w.x[0] + w.x[1] * u + w.x[2] * v, w.y[0] + w.y[1] * u + w.y[2] * v];
  const { gx, gy, us, vs, X, Y } = w;
  let i = 0;
  while (i < gx - 2 && u > us[i + 1]) i++;
  let j = 0;
  while (j < gy - 2 && v > vs[j + 1]) j++;
  const tu = Math.min(1.5, Math.max(-0.5, (u - us[i]) / (us[i + 1] - us[i])));
  const tv = Math.min(1.5, Math.max(-0.5, (v - vs[j]) / (vs[j + 1] - vs[j])));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const n = j * gx + i;
  const x = lerp(lerp(X[n], X[n + 1], tu), lerp(X[n + gx], X[n + gx + 1], tu), tv);
  const y = lerp(lerp(Y[n], Y[n + 1], tu), lerp(Y[n + gx], Y[n + gx + 1], tu), tv);
  return [x, y];
}

/**
 * Affine registration of a padded instance onto the reference, refined from
 * its integer shift, via the block-shift grid. Captures the slight scale,
 * shear and — on poorly stitched scans — several-percent anisotropic
 * "squish" between instances that a single translation cannot. Kept only
 * when a 1× rendering through it matches the reference better than the plain
 * translation; that gate is what keeps well-registered dies untouched.
 */
export function registerAffine(
  ref: Float32Array,
  W: number,
  H: number,
  img: Float32Array,
  margin: number,
  base: { dx: number; dy: number },
  radius?: number
): Affine {
  const { pts, gx, gy } = blockShifts(ref, W, H, img, margin, base, radius);
  const ox = margin + base.dx;
  const oy = margin + base.dy;
  const tr = translationFrom(pts, ox, oy);
  const aff = affineFrom(pts, ox, oy, gx, gy);
  if (!aff) return tr;
  const iw = W + 2 * margin;
  const ih = H + 2 * margin;
  const rgb = toRgb(img);
  const sTr = renderedScore(ref, W, H, rgb, iw, ih, tr);
  return renderedScore(ref, W, H, rgb, iw, ih, aff) > improved(sTr, AFFINE_GAIN) ? aff : tr;
}

/** Acceptance bar for a more flexible model: it must cut what the simpler
 *  one leaves unexplained (1 − NCC) by this fraction. Relative rather than
 *  absolute so the gate works both on a clean scan (scores ≈ 0.99, where any
 *  absolute margin would be unreachable) and on a poor one (scores ≈ 0.5). */
const AFFINE_GAIN = 0.1;
const GRID_GAIN = 0.2;
function improved(score: number, gain: number): number {
  return score + gain * (1 - score);
}

/**
 * Best of translation / affine / piecewise grid warp for one instance, each
 * verified by rendering. The grid warp is only offered when it explains the
 * blocks markedly better than the affine (a non-uniform squish); on a clean
 * scan all three render alike and the simplest wins.
 */
export function registerWarp(
  ref: Float32Array,
  W: number,
  H: number,
  img: Float32Array,
  margin: number,
  base: { dx: number; dy: number },
  radius?: number
): { warp: Warp; affine: Affine; score: number } {
  const { pts, gx, gy, bw, bh } = blockShifts(ref, W, H, img, margin, base, radius);
  const ox = margin + base.dx;
  const oy = margin + base.dy;
  const tr = translationFrom(pts, ox, oy);
  const aff = affineFrom(pts, ox, oy, gx, gy);
  const iw = W + 2 * margin;
  const ih = H + 2 * margin;
  const rgb = toRgb(img);
  let best: { warp: Warp; affine: Affine; score: number } = { warp: tr, affine: tr, score: renderedScore(ref, W, H, rgb, iw, ih, tr) };
  if (aff) {
    const s = renderedScore(ref, W, H, rgb, iw, ih, aff);
    if (s > improved(best.score, AFFINE_GAIN)) best = { warp: aff, affine: aff, score: s };
    const grid = gridFrom(pts, aff, ox, oy, gx, gy, bw, bh);
    if (grid) {
      const sg = renderedScore(ref, W, H, rgb, iw, ih, grid);
      if (sg > improved(best.score, GRID_GAIN)) best = { warp: grid, affine: aff, score: sg };
    }
  }
  return best;
}

/** Gray → interleaved RGB (for functions that only accept RGB). */
function toRgb(g: Float32Array): Float32Array {
  const out = new Float32Array(g.length * 3);
  for (let i = 0, j = 0; i < g.length; i++, j += 3) {
    out[j] = g[i];
    out[j + 1] = g[i];
    out[j + 2] = g[i];
  }
  return out;
}

export interface Registration {
  /** Mirror applied to the padded canonical image before `warp` — set when
   *  the instance is annotated in the wrong orientation. */
  flipH: boolean;
  flipV: boolean;
  /** The mapping to render through (translation, affine or grid warp). */
  warp: Warp;
  /** The affine fit (informational: scale / shear of this instance). */
  affine: Affine;
  /** NCC of the registered 1× rendering against the reference. */
  score: number;
}

/**
 * Full registration of one padded canonical instance onto the reference:
 * (optionally) which of the four mirror variants it really is, then the
 * affine. Orientation is re-detected because an instance annotated upright
 * that is really mirrored — easy to miss on a busy die — would otherwise
 * never align, and pollute the median. A flip is only adopted when it beats
 * the annotated orientation clearly.
 */
export function registerInstance(
  ref: Float32Array,
  W: number,
  H: number,
  padded: Float32Array,
  margin: number,
  opts: { detectFlips?: boolean; shiftRadius?: number } = {}
): Registration {
  const pw = W + 2 * margin;
  const ph = H + 2 * margin;
  const radius = opts.shiftRadius ?? 8;
  const variants: [boolean, boolean][] = opts.detectFlips ? [[false, false], [false, true], [true, false], [true, true]] : [[false, false]];
  let best: { flipH: boolean; flipV: boolean; gray: Float32Array; shift: Shift } | null = null;
  let annotated: Shift | null = null;
  for (const [fh, fv] of variants) {
    const g = grayOf(flipPadded(padded, pw, ph, fh, fv), pw, ph);
    const s = bestShift(ref, W, H, g, margin, radius);
    if (!fh && !fv) annotated = s;
    if (!best || s.score > best.shift.score) best = { flipH: fh, flipV: fv, gray: g, shift: s };
  }
  if (!best) throw new Error("no registration variant");
  if ((best.flipH || best.flipV) && annotated && best.shift.score < annotated.score + 0.08) {
    // Not convincingly better than the annotation — trust the annotation.
    best = { flipH: false, flipV: false, gray: grayOf(padded, pw, ph), shift: annotated };
  }
  const r = registerWarp(ref, W, H, best.gray, margin, { dx: best.shift.dx, dy: best.shift.dy });
  return { flipH: best.flipH, flipV: best.flipV, warp: r.warp, affine: r.affine, score: r.score };
}

function cubicWeights(t: number, out: Float32Array): void {
  // Catmull-Rom (a = -0.5): interpolating, mildly sharpening, no ringing to speak of.
  const t2 = t * t;
  const t3 = t2 * t;
  out[0] = -0.5 * t3 + t2 - 0.5 * t;
  out[1] = 1.5 * t3 - 2.5 * t2 + 1;
  out[2] = -1.5 * t3 + 2 * t2 + 0.5 * t;
  out[3] = 0.5 * t3 - 0.5 * t2;
}

/**
 * Render rows [row0, row1) of an instance at `scale`× through its affine,
 * with bicubic sampling. Output is (W·scale) wide, interleaved RGB. Bands keep
 * the high-resolution median's memory bounded on large cells.
 */
export function resampleBand(
  padded: Float32Array,
  pw: number,
  ph: number,
  aff: Warp,
  W: number,
  scale: number,
  row0: number,
  row1: number
): Float32Array {
  const ow = W * scale;
  const out = new Float32Array(ow * (row1 - row0) * 3);
  const wx = new Float32Array(4);
  const wy = new Float32Array(4);
  for (let oy = row0; oy < row1; oy++) {
    const v = (oy + 0.5) / scale - 0.5;
    for (let ox = 0; ox < ow; ox++) {
      const u = (ox + 0.5) / scale - 0.5;
      const [sx, sy] = warpPoint(aff, u, v);
      const ix = Math.floor(sx);
      const iy = Math.floor(sy);
      cubicWeights(sx - ix, wx);
      cubicWeights(sy - iy, wy);
      let r = 0, g = 0, b = 0;
      for (let ky = 0; ky < 4; ky++) {
        const yy = Math.min(ph - 1, Math.max(0, iy - 1 + ky));
        const wyk = wy[ky];
        for (let kx = 0; kx < 4; kx++) {
          const xx = Math.min(pw - 1, Math.max(0, ix - 1 + kx));
          const w = wyk * wx[kx];
          const s = (yy * pw + xx) * 3;
          r += w * padded[s];
          g += w * padded[s + 1];
          b += w * padded[s + 2];
        }
      }
      const d = ((oy - row0) * ow + ox) * 3;
      out[d] = r;
      out[d + 1] = g;
      out[d + 2] = b;
    }
  }
  return out;
}

/** Unsharp mask (separable Gaussian): out = img + amount·(img − blur). Used
 *  on the high-resolution median to undo the ~half-pixel registration jitter
 *  the stack still carries; the median is nearly noise-free, so there is no
 *  grain for it to amplify. */
export function unsharp(rgb: Float32Array, w: number, h: number, sigma: number, amount: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(rgb.length);
  const blur = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * rgb[(y * w + Math.min(w - 1, Math.max(0, x + i))) * 3 + c];
    tmp[(y * w + x) * 3 + c] = s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    let s = 0;
    for (let i = -r; i <= r; i++) s += k[i + r] * tmp[(Math.min(h - 1, Math.max(0, y + i)) * w + x) * 3 + c];
    blur[(y * w + x) * 3 + c] = s;
  }
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < out.length; i++) out[i] = rgb[i] + amount * (rgb[i] - blur[i]);
  return out;
}
