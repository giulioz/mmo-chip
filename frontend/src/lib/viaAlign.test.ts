import assert from "node:assert/strict";
import test from "node:test";
import { applyOrientation, type Point } from "./geometry";
import type { Orient } from "./mergeCells";
import { alignVias, viasToCanonical } from "./viaAlign";

// A lopsided constellation: no symmetry, so every orientation is distinct.
// Any two vias sit ≥ 10 px apart on some axis, so a mismatched pair never
// votes inside the 3×3-bin window around the true translation (the vote's
// centroid would drift otherwise).
const CANON: Point[] = [
  { x: 4, y: 5 },
  { x: 30, y: 8 },
  { x: 15, y: 28 },
  { x: 52, y: 22 },
  { x: 44, y: 3 },
  { x: 25, y: 18 }
];
const W = 60;
const H = 35; // non-square, odd W − H

const ORIENTS: Orient[] = [];
for (const flippedH of [false, true]) {
  for (const flippedV of [false, true]) {
    for (const rotation of [0, 90, 180, 270] as const) {
      ORIENTS.push({ flippedH, flippedV, rotation });
    }
  }
}

/** Die positions of the canonical vias for a placement (die-viewer math). */
function placed(o: Orient, origin: Point): Point[] {
  return CANON.map((p) => {
    const q = applyOrientation(p, o, W, H);
    return { x: origin.x + q.x, y: origin.y + q.y };
  });
}

test("specimen vias project back to the canonical frame for every orientation", () => {
  const origin = { x: 200, y: 90 };
  for (const o of ORIENTS) {
    const raw = placed(o, origin).map((v) => ({ x: v.x - origin.x, y: v.y - origin.y }));
    viasToCanonical(raw, o, W, H).forEach((p, i) => {
      assert.ok(Math.abs(p.x - CANON[i].x) < 1e-9 && Math.abs(p.y - CANON[i].y) < 1e-9, JSON.stringify(o));
    });
  }
});

test("auto-align recovers the placement the die viewer would draw", () => {
  const truth = { x: 500, y: 300 };
  for (const o of ORIENTS) {
    // The candidate starts unrotated and a little off.
    const start = { x: truth.x - 7, y: truth.y + 4 };
    const raw = placed(o, truth).map((v) => ({ x: v.x - start.x, y: v.y - start.y }));
    const result = alignVias(CANON, raw, W, H);
    assert.ok(result, `no alignment for ${JSON.stringify(o)}`);
    // Same linear map (the search spans D4 without flippedV, so compare the
    // matrices rather than the flags).
    for (const v of [{ x: 1, y: 0 }, { x: 0, y: 1 }]) {
      assert.deepEqual(applyOrientation(v, result, 0, 0), applyOrientation(v, o, 0, 0), JSON.stringify(o));
    }
    assert.deepEqual({ x: start.x + result.dx, y: start.y + result.dy }, truth, JSON.stringify(o));
    assert.equal(result.matched, CANON.length);
  }
});
