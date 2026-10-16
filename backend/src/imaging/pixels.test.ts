import assert from "node:assert/strict";
import test from "node:test";
import { ORIENTATIONS, toCanonical, orientOf } from "../ml/cellDetect.js";
import {
  bestShift,
  canonicalIndexForDiePixel,
  deviationMap,
  extractInner,
  fitToReference,
  grayOf,
  matchStats,
  channelStats,
  paddedDieBox,
  registerAffine,
  registerInstance,
  resampleBand,
  sharpnessOf,
  stackCentre,
  unsharp,
  toCanonicalImage,
  toCanonicalImageScaled,
  wireLikelihood,
  type Region
} from "./pixels.js";

const W = 40;
const H = 30;
const M = 8;

/** A deterministic, asymmetric texture so every orientation is distinct. */
function texture(x: number, y: number): [number, number, number] {
  const v = ((x * 7 + y * 13) % 97) + (x > 25 ? 60 : 0) + (y < 8 ? 40 : 0);
  return [v, (v * 3) % 251, (x * y) % 200];
}

/** Paint a cell instance (texture in canonical coords) onto a die region. */
function dieWith(cell: { x: number; y: number; flippedH?: boolean; rotation?: 0 | 90 | 180 | 270 }, size = 160): Region {
  const data = new Uint8Array(size * size * 3);
  const o = { flippedH: !!cell.flippedH, flippedV: false, rotation: (cell.rotation ?? 0) as 0 };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = canonicalIndexForDiePixel(x, y, cell, o, W, H);
      if (idx < 0) continue;
      const [r, g, b] = texture(idx % W, Math.floor(idx / W));
      data.set([r, g, b], (y * size + x) * 3);
    }
  }
  return { x0: 0, y0: 0, w: size, h: size, data };
}

test("toCanonicalImage undoes every orientation exactly", () => {
  for (const o of ORIENTATIONS) {
    const cell = { x: 50, y: 60, flippedH: o.flippedH, rotation: o.rotation };
    const region = dieWith(cell);
    const box = paddedDieBox(cell, W, H, M);
    assert.ok(box.x0 >= 0 && box.y0 >= 0);
    const canon = toCanonicalImage(region, cell, W, H, M);
    const inner = extractInner(canon, W, H, M, { dx: 0, dy: 0 });
    for (const [x, y] of [[0, 0], [W - 1, 0], [5, 20], [W - 1, H - 1], [30, 3]]) {
      const [r, g, b] = texture(x, y);
      const i = (y * W + x) * 3;
      assert.deepEqual([inner[i], inner[i + 1], inner[i + 2]], [r, g, b], `orient ${JSON.stringify(o)} @${x},${y}`);
    }
  }
});

test("bestShift recovers a known misregistration", () => {
  const ref = grayOf(extractInner(toCanonicalImage(dieWith({ x: 50, y: 60 }), { x: 50, y: 60 }, W, H, M), W, H, M, { dx: 0, dy: 0 }), W, H);
  // The annotation says (50,60) but the pixels really sit at (53,58).
  const canon = toCanonicalImage(dieWith({ x: 53, y: 58 }), { x: 50, y: 60 }, W, H, M);
  const s = bestShift(ref, W, H, grayOf(canon, W + 2 * M, H + 2 * M), M, 6);
  assert.deepEqual([s.dx, s.dy], [3, -2]);
  assert.ok(s.score > 0.99);
});

test("stackCentre votes out a minority stripe; matchStats cancels gain/offset", () => {
  const base = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) base.set(texture(x, y), (y * W + x) * 3);
  const stack: Float32Array[] = [];
  for (let k = 0; k < 15; k++) {
    const im = Float32Array.from(base);
    // A bright vertical "wire" at a different column in 1/3 of the instances,
    // plus a per-instance brightness/contrast change.
    if (k % 3 === 0) for (let y = 0; y < H; y++) im.set([250, 250, 250], (y * W + 5 + k) * 3);
    for (let i = 0; i < im.length; i++) im[i] = im[i] * (0.8 + 0.03 * k) + (k - 7) * 2;
    stack.push(im);
  }
  const target = channelStats(base);
  for (const im of stack) matchStats(im, target);
  const { centre, mad } = stackCentre(stack, 50);
  let worst = 0;
  for (let i = 0; i < base.length; i++) worst = Math.max(worst, Math.abs(centre[i] - base[i]));
  assert.ok(worst < 6, `median strayed ${worst} from the clean image`);
  // The wired instance deviates on its wire column, and only there.
  const z = deviationMap(stack[0], centre, mad, 6);
  const lik = wireLikelihood(z, W, H, { runLength: 9 });
  let onWire = 0;
  let offWire = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) (x === 5 ? (onWire += lik[y * W + x]) : (offWire += lik[y * W + x]));
  assert.ok(onWire / H > 0.8, `wire column likelihood ${onWire / H}`);
  assert.ok(offWire / (H * (W - 1)) < 0.02, `background likelihood ${offWire / (H * (W - 1))}`);
});

test("wireLikelihood keeps long runs and drops specks", () => {
  const z = new Float32Array(W * H);
  for (let x = 4; x < 36; x++) z[12 * W + x] = 9; // a long horizontal run
  z[20 * W + 20] = 9; // a speck
  z[21 * W + 20] = 9;
  const lik = wireLikelihood(z, W, H, { runLength: 11 });
  assert.ok(lik[12 * W + 20] > 0.9);
  assert.equal(lik[20 * W + 20], 0);
});

test("fitToReference recovers gain/offset despite a wire and a large bright structure", () => {
  // Reference: mostly mid-grey, a 14% bright block, some dark detail.
  const ref = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = x > 4 && x < 16 && y > 5 && y < 25 ? 170 : (x + y) % 11 === 0 ? 40 : 70 + ((x * 3 + y) % 7);
    ref.fill(v, (y * W + x) * 3, (y * W + x) * 3 + 3);
  }
  // Instance: different gain/offset, plus a saturated wire right over the block.
  const inst = new Float32Array(ref.length);
  for (let i = 0; i < ref.length; i++) inst[i] = (ref[i] - 20) / 0.7;
  for (let y = 0; y < H; y++) for (let x = 6; x <= 8; x++) inst.fill(255, (y * W + x) * 3, (y * W + x) * 3 + 3);
  fitToReference(inst, ref);
  let worst = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (x >= 6 && x <= 8) continue; // the wire itself must stay different
    worst = Math.max(worst, Math.abs(inst[(y * W + x) * 3] - ref[(y * W + x) * 3]));
  }
  assert.ok(worst < 2, `clean pixels off by up to ${worst.toFixed(1)} after the fit`);
  assert.ok(inst[(10 * W + 7) * 3] - ref[(10 * W + 7) * 3] > 20, "wire pixel should still stand out");
});

/** Smooth, non-periodic test pattern sampled at continuous coordinates. */
function smooth(u: number, v: number): number {
  return 120 + 50 * Math.sin(u * 0.31 + v * 0.07) + 40 * Math.cos(v * 0.23 - u * 0.05) + 25 * Math.sin((u + v) * 0.11);
}

test("registerAffine + resampleBand undo a sub-pixel shift with a slight scale", () => {
  const BW = 96, BH = 84, BM = 10;
  const ref = new Float32Array(BW * BH);
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) ref[y * BW + x] = smooth(x, y);
  // The instance shows the same scene displaced by (0.4, -0.3) px and
  // magnified 0.6% — what neighbouring mosaic fields do to each other.
  const pw = BW + 2 * BM, ph = BH + 2 * BM;
  const truth = (u: number, v: number) => ({ x: BM + 0.4 + 1.006 * u, y: BM - 0.3 + 1.006 * v });
  const padded = new Float32Array(pw * ph * 3);
  for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
    // invert the truth map: canonical coords of this source pixel
    const u = (x - BM - 0.4) / 1.006, v = (y - BM + 0.3) / 1.006;
    padded.fill(smooth(u, v), (y * pw + x) * 3, (y * pw + x) * 3 + 3);
  }
  const aff = registerAffine(ref, BW, BH, grayOf(padded, pw, ph), BM, { dx: 0, dy: 0 });
  for (const [u, v] of [[5, 5], [90, 8], [48, 42], [6, 78], [88, 80]]) {
    const t = truth(u, v);
    const gx = aff.x[0] + aff.x[1] * u + aff.x[2] * v;
    const gy = aff.y[0] + aff.y[1] * u + aff.y[2] * v;
    assert.ok(Math.hypot(gx - t.x, gy - t.y) < 0.45, `registration off by ${Math.hypot(gx - t.x, gy - t.y).toFixed(2)}px at ${u},${v}`);
  }
  // Rendering through the affine at 1× reproduces the reference…
  const band = resampleBand(padded, pw, ph, aff, BW, 1, 0, BH);
  let worst = 0;
  for (let y = 4; y < BH - 4; y++) for (let x = 4; x < BW - 4; x++) worst = Math.max(worst, Math.abs(band[(y * BW + x) * 3] - ref[y * BW + x]));
  assert.ok(worst < 2.5, `resampled instance off by ${worst.toFixed(2)} grey levels`);
  // …and at 2× lands on the half-pixel grid.
  const hi = resampleBand(padded, pw, ph, aff, BW, 2, 40, 44);
  assert.equal(hi.length, BW * 2 * 4 * 3);
  const want = smooth((101 + 0.5) / 2 - 0.5, (41 + 0.5) / 2 - 0.5);
  assert.ok(Math.abs(hi[(1 * BW * 2 + 101) * 3] - want) < 2.5);
});

test("sharpnessOf ranks focus; unsharp restores edge contrast without shifting flat areas", () => {
  const SW = 64, SH = 40;
  const crisp = new Float32Array(SW * SH * 3);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) crisp.fill(Math.floor(x / 8) % 2 ? 180 : 60, (y * SW + x) * 3, (y * SW + x) * 3 + 3);
  // Box-blur horizontally to fake defocus.
  const soft = new Float32Array(crisp.length);
  for (let y = 0; y < SH; y++) for (let x = 0; x < SW; x++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += crisp[(y * SW + Math.min(SW - 1, Math.max(0, x + k))) * 3];
    soft.fill(s / 5, (y * SW + x) * 3, (y * SW + x) * 3 + 3);
  }
  // Compared against the soft image itself so every pixel "agrees".
  assert.ok(sharpnessOf(crisp, crisp, SW, SH) > 1.5 * sharpnessOf(soft, soft, SW, SH));
  const restored = unsharp(soft, SW, SH, 2, 1.3);
  const edge = (im: Float32Array) => Math.abs(im[(20 * SW + 17) * 3] - im[(20 * SW + 14) * 3]);
  assert.ok(edge(restored) > edge(soft) * 1.25, "edge contrast should increase");
  assert.ok(Math.abs(restored[(20 * SW + 4) * 3] - soft[(20 * SW + 4) * 3]) < 12, "flat interior barely moves");
});

test("registerInstance recovers a mirrored, 4%-squished instance; leaves a good one alone", () => {
  const BW = 140, BH = 90, BM = 12;
  const pw = BW + 2 * BM, ph = BH + 2 * BM;
  const ref = new Float32Array(BW * BH);
  for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) ref[y * BW + x] = smooth(x * 1.3, y * 1.7);
  const render = (map: (u: number, v: number) => [number, number]) => {
    const p = new Float32Array(pw * ph * 3);
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const [u, v] = map(x - BM, y - BM);
      p.fill(smooth(u * 1.3, v * 1.7), (y * pw + x) * 3, (y * pw + x) * 3 + 3);
    }
    return p;
  };
  // Instance A: annotated upright, really mirrored vertically and 4% narrower.
  const a = render((x, y) => [x / 0.96 - 1.5, BH - 1 - y + 0.4]);
  const ra = registerInstance(ref, BW, BH, a, BM, { detectFlips: true });
  assert.equal(ra.flipV, true);
  assert.equal(ra.flipH, false);
  assert.ok(Math.abs(ra.affine.x[1] - 0.96) < 0.01, `x scale ${ra.affine.x[1].toFixed(3)}`);
  assert.ok(ra.score > 0.97, `score ${ra.score.toFixed(3)}`);
  // Instance B: a plain sub-pixel shift, correctly annotated → no flip, unit scale.
  const b = render((x, y) => [x - 0.3, y + 0.6]);
  const rb = registerInstance(ref, BW, BH, b, BM, { detectFlips: true });
  assert.equal(rb.flipV || rb.flipH, false);
  assert.ok(Math.abs(rb.affine.x[1] - 1) < 0.005 && Math.abs(rb.affine.y[2] - 1) < 0.005, "unit scale kept");
  assert.ok(rb.score > 0.99);
});

test("toCanonicalImageScaled resamples an instance from a die at another resolution", () => {
  // The other die shows the cell at half this die's size (k = 2). A linear
  // ramp survives bilinear resampling exactly, so the crop must reproduce it.
  const ramp = (x: number, y: number) => 3 * x + 2 * y + 10;
  const k = 2;
  for (const o of ORIENTATIONS) {
    const cell = { x: 20, y: 24, flippedH: o.flippedH, rotation: o.rotation };
    const size = 80;
    const data = new Uint8Array(size * size * 3);
    for (let v = 0; v < size; v++) {
      for (let u = 0; u < size; u++) {
        // That die's pixel centre → its canonical point → this die's px.
        const c = toCanonical({ x: u + 0.5 - cell.x, y: v + 0.5 - cell.y }, orientOf(cell), W / k, H / k);
        data.fill(Math.max(0, Math.min(255, ramp(c.x * k, c.y * k))), (v * size + u) * 3, (v * size + u) * 3 + 3);
      }
    }
    const out = toCanonicalImageScaled({ x0: 0, y0: 0, w: size, h: size, data }, cell, W, H, M, k);
    const pw = W + 2 * M;
    for (const [x, y] of [[4, 4], [20, 15], [W - 5, H - 5], [33, 7]]) {
      const got = out[((y + M) * pw + x + M) * 3];
      assert.ok(Math.abs(got - ramp(x + 0.5, y + 0.5)) < 1.01, `${JSON.stringify(o)} @${x},${y}: ${got} vs ${ramp(x + 0.5, y + 0.5)}`);
    }
  }
});
