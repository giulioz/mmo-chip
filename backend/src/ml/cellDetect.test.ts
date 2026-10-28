import assert from "node:assert/strict";
import test from "node:test";
import type { Cell, CellType } from "shared";
import {
  applyOrient,
  buildTemplate,
  detectCells,
  existingFootprints,
  footprint,
  ORIENTATIONS,
  orientationsFor,
  orientOf,
  resolveAcrossTypes,
  scorePlacement,
  toCanonical,
  ViaIndex,
  type Orient
} from "./cellDetect.js";

const W = 60;
const H = 100;
const TYPE: CellType = {
  id: "t",
  name: "T",
  cropRect: { x: 0, y: 0, width: W, height: H }
};
// An asymmetric constellation so every orientation is distinguishable.
const PATTERN = [
  { x: 8, y: 10 },
  { x: 30, y: 12 },
  { x: 52, y: 20 },
  { x: 14, y: 48 },
  { x: 40, y: 60 },
  { x: 10, y: 88 },
  { x: 50, y: 92 }
];

function place(x: number, y: number, o: Orient) {
  return PATTERN.map((p) => {
    const q = applyOrient(p, o, W, H);
    return { x: x + q.x, y: y + q.y, score: 0.9 };
  });
}

test("toCanonical inverts applyOrient for every orientation", () => {
  for (const o of ORIENTATIONS) {
    for (const p of PATTERN) {
      const back = toCanonical(applyOrient(p, o, W, H), o, W, H);
      assert.ok(Math.abs(back.x - p.x) < 1e-9 && Math.abs(back.y - p.y) < 1e-9);
    }
  }
  // flippedV is expressible as flippedH + 180°, and must round-trip too.
  const fv: Orient = { flippedH: false, flippedV: true, rotation: 90 };
  const back = toCanonical(applyOrient(PATTERN[0], fv, W, H), fv, W, H);
  assert.ok(Math.abs(back.x - PATTERN[0].x) < 1e-9);
});

test("footprint swaps extents for 90° rotations about the centre", () => {
  const f = footprint(100, 200, { flippedH: false, flippedV: false, rotation: 90 }, W, H);
  assert.equal(Math.round(f.x1 - f.x0), H);
  assert.equal(Math.round(f.y1 - f.y0), W);
  // Centre is preserved.
  assert.equal((f.x0 + f.x1) / 2, 100 + W / 2);
  assert.equal((f.y0 + f.y1) / 2, 200 + H / 2);
});

test("buildTemplate pools members and drops low-support vias", () => {
  const o1: Orient = { flippedH: false, flippedV: false, rotation: 0 };
  const o2: Orient = { flippedH: true, flippedV: false, rotation: 180 };
  const o3: Orient = { flippedH: false, flippedV: false, rotation: 90 };
  const vias = [
    ...place(100, 100, o1),
    ...place(400, 100, o2),
    ...place(700, 100, o3),
    // A stray via inside member 1 only (1 of 3 members → below 50% support).
    { x: 100 + 25, y: 100 + 25, score: 0.6 }
  ];
  const index = new ViaIndex(vias);
  const members: Cell[] = [
    { id: "a", cellTypeId: "t", x: 100, y: 100 },
    { id: "b", cellTypeId: "t", x: 400, y: 100, flippedH: true, rotation: 180 },
    { id: "c", cellTypeId: "t", x: 700, y: 100, rotation: 90 }
  ];
  const tpl = buildTemplate(members, TYPE, index);
  assert.equal(tpl.length, PATTERN.length);
  for (const p of PATTERN) {
    const hit = tpl.find((t) => Math.abs(t.x - p.x) < 0.5 && Math.abs(t.y - p.y) < 0.5);
    assert.ok(hit, `pattern via ${p.x},${p.y} missing from template`);
    assert.equal(hit.weight, 1);
  }
});

test("detectCells finds oriented copies, skips existing cells, ignores noise", async () => {
  const placements: { x: number; y: number; o: Orient }[] = [
    { x: 100, y: 100, o: ORIENTATIONS[0] },
    { x: 300, y: 120, o: ORIENTATIONS[1] },
    { x: 520, y: 90, o: ORIENTATIONS[4] },
    { x: 130, y: 400, o: ORIENTATIONS[7] },
    // A copy missing one via (an ML miss).
    { x: 700, y: 400, o: ORIENTATIONS[2] }
  ];
  const vias: { x: number; y: number; score: number }[] = [];
  placements.forEach((p, i) => {
    const pts = place(p.x, p.y, p.o);
    if (i === 4) pts.pop();
    vias.push(...pts);
  });
  // Deterministic pseudo-random noise across the die.
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < 300; i++) {
    vias.push({ x: Math.floor(rnd() * 1000), y: Math.floor(rnd() * 600), score: 0.5 });
  }
  const index = new ViaIndex(vias);
  const members: Cell[] = [{ id: "a", cellTypeId: "t", x: 100, y: 100 }];
  const tpl = buildTemplate(members, TYPE, index);
  assert.ok(tpl.length >= PATTERN.length);

  const existing = existingFootprints(members, [TYPE]);
  const phases: string[] = [];
  const found = await detectCells(tpl, TYPE, index, existing, { minScore: 0.5 }, {
    onProgress: (phase) => phases.push(phase)
  });
  assert.ok(phases.includes("matching") && phases.includes("scoring"));

  // The member itself is an existing cell → not proposed.
  assert.ok(!found.some((d) => Math.abs(d.x - 100) < 5 && Math.abs(d.y - 100) < 5));

  for (const p of placements.slice(1)) {
    const hit = found.find((d) => Math.abs(d.x - p.x) <= 2 && Math.abs(d.y - p.y) <= 2);
    assert.ok(hit, `placement at ${p.x},${p.y} not detected`);
    const o = orientOf(hit);
    assert.deepEqual(o, p.o, `orientation mismatch at ${p.x},${p.y}`);
    assert.ok(hit.score >= 0.7, `score ${hit.score} too low at ${p.x},${p.y}`);
  }
  // One proposal per physical location.
  for (const p of placements.slice(1)) {
    const near = found.filter((d) => Math.abs(d.x - p.x) <= 30 && Math.abs(d.y - p.y) <= 30);
    assert.equal(near.length, 1, `duplicate proposals near ${p.x},${p.y}`);
  }
  // Sorted by score, descending.
  for (let i = 1; i < found.length; i++) assert.ok(found[i - 1].score >= found[i].score);
});

test("orientationsFor gates the reflections by axis", () => {
  const rot = (os: Orient[]) => os.map((o) => `${o.flippedH ? "H" : "-"}${o.rotation}`).sort();
  assert.deepEqual(rot(orientationsFor({})), rot([...ORIENTATIONS]));
  assert.deepEqual(rot(orientationsFor({ allowFlipX: false, allowFlipY: false })), ["-0", "-180", "-270", "-90"]);
  assert.deepEqual(rot(orientationsFor({ allowFlipX: true, allowFlipY: false })), ["-0", "-180", "-270", "-90", "H0", "H90"]);
  assert.deepEqual(rot(orientationsFor({ allowFlipX: false, allowFlipY: true })), ["-0", "-180", "-270", "-90", "H180", "H270"]);
});

test("flip options suppress mirrored placements but keep rotations", async () => {
  const upright = ORIENTATIONS[0];
  const rot180 = ORIENTATIONS[2];
  const flipX = ORIENTATIONS[4]; // {flippedH, 0}
  const flipY = ORIENTATIONS[6]; // {flippedH, 180} ≡ vertical mirror
  const vias = [
    ...place(100, 100, upright),
    ...place(300, 100, rot180),
    ...place(500, 100, flipX),
    ...place(700, 100, flipY)
  ];
  const index = new ViaIndex(vias);
  const tpl = buildTemplate([{ id: "a", cellTypeId: "t", x: 100, y: 100 }], TYPE, index);
  // A confident proposal at (x, 100). Weak partial alignments (a few vias of
  // this 7-via toy pattern lining up) are expected and sit below the UI's
  // default 0.5 confidence threshold — not what these assertions are about.
  const at = (found: Awaited<ReturnType<typeof detectCells>>, x: number) =>
    found.find((d) => Math.abs(d.x - x) <= 2 && Math.abs(d.y - 100) <= 2 && d.score >= 0.7);

  const none = await detectCells(tpl, TYPE, index, [], { allowFlipX: false, allowFlipY: false });
  assert.ok(at(none, 300), "rotation still found");
  assert.ok(!at(none, 500) && !at(none, 700), "no mirrored copies");

  const onlyX = await detectCells(tpl, TYPE, index, [], { allowFlipX: true, allowFlipY: false });
  assert.ok(at(onlyX, 500) && !at(onlyX, 700));

  const onlyY = await detectCells(tpl, TYPE, index, [], { allowFlipX: false, allowFlipY: true });
  assert.ok(!at(onlyY, 500) && at(onlyY, 700));
});

test("scorePlacement rates a true member high and a misfit low", () => {
  const vias = [
    ...place(100, 100, ORIENTATIONS[4]), // mirrored copy at its stored orientation
    // A "member" that is really a different cell: unrelated via layout.
    { x: 405, y: 110, score: 0.9 },
    { x: 440, y: 150, score: 0.9 },
    { x: 420, y: 190, score: 0.9 }
  ];
  const index = new ViaIndex(vias);
  const good: Cell = { id: "g", cellTypeId: "t", x: 100, y: 100, flippedH: true };
  const bad: Cell = { id: "b", cellTypeId: "t", x: 400, y: 100 };
  const tpl = buildTemplate([good], TYPE, index);
  const sg = scorePlacement(tpl, TYPE, index, good);
  assert.equal(sg.score, 1);
  assert.equal(sg.matched, PATTERN.length);
  assert.equal(sg.extra, 0);
  const sb = scorePlacement(tpl, TYPE, index, bad);
  assert.ok(sb.score < 0.3, `misfit scored ${sb.score}`);
  // Wrong orientation of a true copy scores below the right one.
  const wrong = scorePlacement(tpl, TYPE, index, { ...good, flippedH: false });
  assert.ok(wrong.score < sg.score);
});

test("existing-cell avoidance: any-type block vs same-type near-duplicate bar", async () => {
  const vias = [
    ...place(100, 100, ORIENTATIONS[0]),
    ...place(400, 100, ORIENTATIONS[0]) // copy sitting under a cell of another type
  ];
  const index = new ViaIndex(vias);
  const member: Cell = { id: "a", cellTypeId: "t", x: 100, y: 100 };
  const other: CellType = { id: "o", name: "O", cropRect: { x: 0, y: 0, width: W, height: H } };
  const otherCell: Cell = { id: "z", cellTypeId: "o", x: 400, y: 100 };
  const tpl = buildTemplate([member], TYPE, index);
  const at = (found: Awaited<ReturnType<typeof detectCells>>, x: number) =>
    found.find((d) => Math.abs(d.x - x) <= 2 && Math.abs(d.y - 100) <= 2);

  // Avoid any placed cell → the copy under the other type's cell is dropped.
  const avoid = await detectCells(
    tpl, TYPE, index, existingFootprints([member, otherCell], [TYPE, other]),
    { maxExistingOverlap: 0.3 }
  );
  assert.ok(!at(avoid, 400) && !at(avoid, 100));

  // Overlaps allowed → only the type's own member blocks (near-duplicate bar),
  // so the copy under the other type is proposed and the member itself isn't.
  const allow = await detectCells(
    tpl, TYPE, index, existingFootprints([member], [TYPE]),
    { maxExistingOverlap: 0.6 }
  );
  assert.ok(at(allow, 400), "copy under another type proposed");
  assert.ok(!at(allow, 100), "own member not re-proposed");
});

test("placements straddling a vote-bin corner are still found (jittered vias, coarse bins)", async () => {
  // Real dies force coarse bins (9px on a 33k die) and ML vias jitter by a
  // couple of px. A copy whose true offset sits at a bin corner used to have
  // its votes split four ways, each bin under the vote floor → never proposed.
  const bin = 9;
  const jitter = [-2, 2, -1, 1, 2, -2, 0];
  const member = { x: 90, y: 90 };
  const vias = place(member.x, member.y, ORIENTATIONS[0]);
  const copies: { x: number; y: number }[] = [];
  // Sweep every sub-bin phase on both axes so the corner cases are included.
  let k = 0;
  for (let px = 0; px < bin; px += 2) {
    for (let py = 0; py < bin; py += 2) {
      const x = 400 + (k % 6) * 200 + px;
      const y = 400 + Math.floor(k / 6) * 250 + py;
      k += 1;
      copies.push({ x, y });
      PATTERN.forEach((p, i) =>
        vias.push({ x: x + p.x + jitter[i % 7], y: y + p.y + jitter[(i + 3) % 7], score: 0.9 })
      );
    }
  }
  const index = new ViaIndex(vias);
  const tpl = buildTemplate([{ id: "a", cellTypeId: "t", ...member }], TYPE, index);
  const found = await detectCells(tpl, TYPE, index, [], {
    binSize: bin,
    minScore: 0.5,
    allowFlipX: false,
    allowFlipY: false
  });
  const missed = copies.filter(
    (c) => !found.some((d) => Math.abs(d.x - c.x) <= 3 && Math.abs(d.y - c.y) <= 3)
  );
  assert.deepEqual(missed, [], `${missed.length}/${copies.length} copies missed`);
});

test("detectCells honours cancellation", async () => {
  const vias = place(100, 100, ORIENTATIONS[0]);
  const index = new ViaIndex(vias);
  const tpl = buildTemplate([{ id: "a", cellTypeId: "t", x: 100, y: 100 }], TYPE, index);
  const found = await detectCells(tpl, TYPE, index, [], {}, { shouldCancel: () => true });
  assert.deepEqual(found, []);
});

test("ViaIndex queries match a brute-force scan, at the die edges too", () => {
  const vias: { x: number; y: number; score: number }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let i = 0; i < 2000; i++) vias.push({ x: rnd() * 1000, y: rnd() * 700, score: rnd() });
  vias.push({ x: 0, y: 0, score: 1 }, { x: 1000, y: 700, score: 1 });
  const index = new ViaIndex(vias);
  const at = (i: number) => ({ x: index.xs[i], y: index.ys[i] });
  for (const box of [
    { x0: -50, y0: -50, x1: 40, y1: 30 },
    { x0: 310, y0: 200, x1: 480, y1: 333 },
    { x0: 900, y0: 600, x1: 1200, y1: 900 },
    { x0: 2000, y0: 2000, x1: 2100, y1: 2100 }
  ]) {
    const want = vias.filter((v) => v.x >= box.x0 && v.x <= box.x1 && v.y >= box.y0 && v.y <= box.y1).length;
    const got = index.inBox(box);
    assert.equal(got.length, want);
    for (const i of got) {
      const p = at(i);
      assert.ok(p.x >= box.x0 && p.x <= box.x1 && p.y >= box.y0 && p.y <= box.y1);
    }
  }
  for (const [x, y, tol] of [[0, 0, 5], [500, 350, 40], [1003, 702, 8], [-20, 400, 30]]) {
    let want = Infinity;
    for (const v of vias) {
      const d = Math.hypot(v.x - x, v.y - y);
      if (d <= tol) want = Math.min(want, d);
    }
    const j = index.nearest(x, y, tol);
    if (want === Infinity) assert.equal(j, -1);
    else assert.ok(Math.abs(Math.hypot(at(j).x - x, at(j).y - y) - want) < 1e-9);
  }
});

test("resolveAcrossTypes keeps the cell that explains its footprint", () => {
  const box = (x0: number, w: number) => ({ x0, y0: 0, x1: x0 + w, y1: 100 });
  const kept = resolveAcrossTypes([
    // A big cell with every via found, and a small type's template matching
    // its left part: the big one wins.
    { box: box(0, 300), score: 0.95, matched: 40, extra: 2, templateVias: 42 },
    { box: box(10, 80), score: 1, matched: 10, extra: 0, templateVias: 10 },
    // A clean small cell, and a big type half-matching over it: the small
    // one wins, though both find the same 10 vias.
    { box: box(1000, 80), score: 1, matched: 10, extra: 0, templateVias: 10 },
    { box: box(940, 300), score: 0.6, matched: 10, extra: 0, templateVias: 20 },
    // Abutting the big cell with a sliver of overlap: kept.
    { box: box(295, 80), score: 0.9, matched: 9, extra: 1, templateVias: 10 }
  ]);
  assert.deepEqual([...kept].sort(), [0, 2, 4]);
});
