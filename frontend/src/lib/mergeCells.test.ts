import assert from "node:assert/strict";
import test from "node:test";
import type { Cell, CellType, DieAnnotations, LayerPolygon } from "shared";
import type { AnnotationAction } from "../api/actions";
import { cellFootprint, memberSignature, sameFrame } from "./cellDetection";
import { rotateShape } from "./cellLayers";
import { applyOrientation, toCanonical, type Orientation, type Point } from "./geometry";
import {
  buildFlipCellTypeAction,
  buildMarkMatchedAction,
  buildRotateCellTypeAction,
  orientOf,
  orientOnDie,
  rotateView,
  type Orient
} from "./mergeCells";

const ORIENTS: Orient[] = [];
for (const flippedH of [false, true]) {
  for (const flippedV of [false, true]) {
    for (const rotation of [0, 90, 180, 270] as const) {
      ORIENTS.push({ flippedH, flippedV, rotation });
    }
  }
}

const W = 30;
const H = 17; // odd W − H: rotated origins land on half pixels
const SAMPLES: Point[] = [
  { x: 0, y: 0 },
  { x: W, y: 0 },
  { x: W, y: H },
  { x: 3, y: 11 },
  { x: 21.5, y: 4 }
];

/** Die position of a canonical point for a placement. */
function toDie(p: Point, cell: Cell, ct: CellType): Point {
  const o = applyOrientation(p, cell, ct.cropRect.width, ct.cropRect.height);
  return { x: cell.x + o.x, y: cell.y + o.y };
}

function near(a: Point, b: Point, msg: string) {
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9, `${msg}: ${JSON.stringify(a)} vs ${JSON.stringify(b)}`);
}

function fixture(): { annotations: DieAnnotations; cellType: CellType } {
  const poly: LayerPolygon = {
    id: "p1",
    kind: "polygon",
    points: SAMPLES.slice(3).concat({ x: 7, y: 2 }),
    label: "vcc"
  };
  const cellType: CellType = {
    id: "t1",
    name: "NAND2",
    cropRect: { x: 5, y: 6, width: W, height: H },
    matched: true,
    layers: {
      metal1: [{ id: "r1", kind: "rect", x: 2, y: 3, width: 10, height: 4, customName: "A" }],
      diffusion: [poly],
      contact: [{ id: "c1", kind: "point", x: 4, y: 5, size: 3 }],
      polysilicon: [{ id: "l1", kind: "line", x1: 1, y1: 1, x2: 20, y2: 9, width: 2 }]
    }
  };
  const cells: Cell[] = ORIENTS.map((o, i) => {
    const c: Cell = { id: `m${i}`, cellTypeId: "t1", x: 100 + i * 50, y: 40 + (i % 3) * 7 };
    if (o.flippedH) c.flippedH = true;
    if (o.flippedV) c.flippedV = true;
    if (o.rotation) c.rotation = o.rotation;
    return c;
  });
  cells.push({ id: "other", cellTypeId: "t2", x: 1, y: 2, rotation: 90 });
  const annotations: DieAnnotations = {
    version: 2,
    rev: 1,
    nets: [],
    grids: [],
    cellTypes: [cellType, { id: "t2", name: "INV", cropRect: { x: 0, y: 0, width: 9, height: 4 } }],
    cells
  };
  return { annotations, cellType };
}

function unpack(action: AnnotationAction | null): { cellType: CellType; cells: Cell[] } {
  assert.ok(action && action.kind === "batch");
  const [first, ...rest] = action.actions;
  assert.equal(first.kind, "upsertCellType");
  const cells = rest.map((a) => {
    assert.equal(a.kind, "upsertCell");
    return a.cell;
  });
  return { cellType: first.cellType, cells };
}

function applyTo(annotations: DieAnnotations, action: AnnotationAction | null): DieAnnotations {
  const { cellType, cells } = unpack(action);
  const byId = new Map(cells.map((c) => [c.id, c]));
  return {
    ...annotations,
    cellTypes: annotations.cellTypes.map((t) => (t.id === cellType.id ? cellType : t)),
    cells: annotations.cells.map((c) => byId.get(c.id) ?? c)
  };
}

test("toCanonical inverts applyOrientation for every orientation", () => {
  for (const o of ORIENTS) {
    for (const p of SAMPLES) {
      near(toCanonical(applyOrientation(p, o, W, H), o, W, H), p, JSON.stringify(o));
    }
  }
});

test("rotateView turns the canonical view a quarter turn, whatever the flips", () => {
  // The view of a die offset v is O⁻¹·v (a zero-size box makes the helpers
  // pure linear maps). Turning the view clockwise must give R(90)·O⁻¹·v.
  const cw = (p: Point): Point => ({ x: -p.y, y: p.x });
  const ccw = (p: Point): Point => ({ x: p.y, y: -p.x });
  for (const o of ORIENTS) {
    for (const v of [{ x: 1, y: 0 }, { x: 0, y: 1 }, { x: 3, y: -2 }]) {
      const view = toCanonical(v, o, 0, 0);
      near(toCanonical(v, rotateView(o, 90), 0, 0), cw(view), `cw ${JSON.stringify(o)}`);
      near(toCanonical(v, rotateView(o, -90), 0, 0), ccw(view), `ccw ${JSON.stringify(o)}`);
    }
    // Flips are untouched.
    assert.equal(rotateView(o, 90).flippedH, o.flippedH);
    assert.equal(rotateView(o, 90).flippedV, o.flippedV);
  }
});

test("turning a type keeps every member and every shape on the same die pixels", () => {
  const { annotations, cellType } = fixture();
  for (const deg of [90, -90] as const) {
    const next = unpack(buildRotateCellTypeAction(annotations, cellType, deg));
    assert.deepEqual(
      [next.cellType.cropRect.width, next.cellType.cropRect.height],
      [H, W],
      "box swaps"
    );
    assert.deepEqual([next.cellType.cropRect.x, next.cellType.cropRect.y], [5, 6]);
    assert.equal(next.cells.length, ORIENTS.length, "only the type's own members");
    const before = annotations.cells.filter((c) => c.cellTypeId === cellType.id);
    for (const [i, cell] of before.entries()) {
      const moved = next.cells[i];
      assert.equal(moved.id, cell.id);
      assert.equal(moved.flippedH, cell.flippedH);
      assert.equal(moved.flippedV, cell.flippedV);
      assert.deepEqual(cellFootprint(moved, next.cellType), cellFootprint(cell, cellType));
      for (const p of SAMPLES) {
        const turned = rotateShape({ id: "s", kind: "point", x: p.x, y: p.y, size: 1 }, deg, W, H);
        assert.equal(turned.kind, "point");
        if (turned.kind !== "point") continue;
        near(toDie(turned, moved, next.cellType), toDie(p, cell, cellType), `${deg} ${cell.id}`);
      }
      // Every stored shape vertex follows the silicon too.
      const poly = next.cellType.layers?.diffusion?.[0];
      assert.ok(poly && poly.kind === "polygon");
      const orig = cellType.layers!.diffusion![0] as LayerPolygon;
      poly.points.forEach((q, k) =>
        near(toDie(q, moved, next.cellType), toDie(orig.points[k], cell, cellType), `poly ${k}`)
      );
    }
    // Metadata rides along untouched.
    assert.equal(next.cellType.layers?.diffusion?.[0].label, "vcc");
    assert.equal(next.cellType.layers?.metal1?.[0].customName, "A");
  }
});

test("flipping a type keeps every member and every shape on the same die pixels", () => {
  const { annotations, cellType } = fixture();
  const mirror = (p: Point, axis: "h" | "v"): Point => (axis === "h" ? { x: W - p.x, y: p.y } : { x: p.x, y: H - p.y });
  for (const axis of ["h", "v"] as const) {
    const next = unpack(buildFlipCellTypeAction(annotations, cellType, axis));
    assert.deepEqual(next.cellType.cropRect, cellType.cropRect, "a mirror keeps the box");
    const before = annotations.cells.filter((c) => c.cellTypeId === cellType.id);
    for (const [i, cell] of before.entries()) {
      const flipped = next.cells[i];
      assert.deepEqual([flipped.x, flipped.y, flipped.rotation], [cell.x, cell.y, cell.rotation]);
      for (const p of SAMPLES) {
        near(toDie(mirror(p, axis), flipped, next.cellType), toDie(p, cell, cellType), `${axis} ${cell.id}`);
      }
      const poly = next.cellType.layers?.diffusion?.[0];
      assert.ok(poly && poly.kind === "polygon");
      const orig = cellType.layers!.diffusion![0] as LayerPolygon;
      poly.points.forEach((q, k) =>
        near(toDie(q, flipped, next.cellType), toDie(orig.points[k], cell, cellType), `poly ${k}`)
      );
    }
    // Twice is the exact original.
    const once = applyTo(annotations, buildFlipCellTypeAction(annotations, cellType, axis));
    assert.deepEqual(applyTo(once, buildFlipCellTypeAction(once, once.cellTypes[0], axis)), annotations);
  }
  assert.equal(buildFlipCellTypeAction({ ...annotations, cells: [] }, cellType, "h"), null);
});

test("data built before a type-wide flip or turn is out of frame; member edits aren't", () => {
  const { annotations, cellType } = fixture();
  const members = (a: DieAnnotations) => a.cells.filter((c) => c.cellTypeId === cellType.id);
  const built = memberSignature(members(annotations));
  const flipped = applyTo(annotations, buildFlipCellTypeAction(annotations, cellType, "h"));
  assert.equal(sameFrame(built, members(flipped)), false, "type flipped");
  const turned = applyTo(annotations, buildRotateCellTypeAction(annotations, cellType, 90));
  assert.equal(sameFrame(built, members(turned)), false, "type turned");
  // Moving, adding, or re-orienting one member keeps the frame.
  const [first, ...rest] = members(annotations);
  const edited = [{ ...first, x: first.x + 5, flippedH: !first.flippedH }, ...rest, { id: "new", cellTypeId: "t1", x: 0, y: 0 }];
  assert.equal(sameFrame(built, edited), true);
  assert.equal(sameFrame(undefined, members(flipped)), true, "no signature, nothing to judge");
  // A lone member re-oriented is the whole type re-oriented.
  const lone = memberSignature([first]);
  assert.equal(sameFrame(lone, [{ ...first, rotation: 180 }]), false);
});

test("clockwise shapes: the top-left corner lands top-right, rects stay normalised", () => {
  const r = rotateShape({ id: "r", kind: "rect", x: 2, y: 3, width: 10, height: 4 }, 90, W, H);
  // (x, y) → (H − y, x): the rect's bottom-left corner becomes its new top-left.
  assert.deepEqual(r, { id: "r", kind: "rect", x: H - 7, y: 2, width: 4, height: 10 });
  const back = rotateShape(r, -90, H, W);
  assert.deepEqual(back, { id: "r", kind: "rect", x: 2, y: 3, width: 10, height: 4 });
  const line = rotateShape({ id: "l", kind: "line", x1: 0, y1: 0, x2: W, y2: 0, width: 2 }, 90, W, H);
  assert.deepEqual(line, { id: "l", kind: "line", x1: H, y1: 0, x2: H, y2: W, width: 2 });
});

test("a turn and its inverse (or four turns) restore the exact original", () => {
  const { annotations, cellType } = fixture();
  const cw = applyTo(annotations, buildRotateCellTypeAction(annotations, cellType, 90));
  const back = applyTo(cw, buildRotateCellTypeAction(cw, cw.cellTypes[0], -90));
  assert.deepEqual(back, annotations);
  let spun = annotations;
  for (let i = 0; i < 4; i++) {
    spun = applyTo(spun, buildRotateCellTypeAction(spun, spun.cellTypes[0], 90));
  }
  assert.deepEqual(spun, annotations);
});

test("a type without members has nothing to turn", () => {
  const { annotations, cellType } = fixture();
  const empty = { ...annotations, cells: [] };
  assert.equal(buildRotateCellTypeAction(empty, cellType, 90), null);
});

test("orientOnDie turns and mirrors the instance as the die shows it", () => {
  // The die draws an instance through O (canonical → die), so each op must
  // compose on the left: O' = OP · O, whatever the current flips / rotation.
  const ops: Array<[Parameters<typeof orientOnDie>[1], (p: Point) => Point]> = [
    ["rotateCw", (p) => ({ x: -p.y, y: p.x })],
    ["rotateCcw", (p) => ({ x: p.y, y: -p.x })],
    ["flipH", (p) => ({ x: -p.x, y: p.y })],
    ["flipV", (p) => ({ x: p.x, y: -p.y })]
  ];
  for (const o of ORIENTS) {
    for (const [op, m] of ops) {
      for (const v of [{ x: 1, y: 0 }, { x: 0, y: 1 }]) {
        near(applyOrientation(v, orientOnDie(o, op), 0, 0), m(applyOrientation(v, o, 0, 0)), `${op} ${JSON.stringify(o)}`);
      }
    }
  }
});

test("marking a placeholder matched is one type upsert, and a no-op once matched", () => {
  const placeholder: CellType = { id: "p", name: "cell 1", cropRect: { x: 0, y: 0, width: 4, height: 2 }, matched: false };
  assert.deepEqual(buildMarkMatchedAction(placeholder), {
    kind: "upsertCellType",
    cellType: { ...placeholder, matched: true },
    prevCellType: placeholder
  });
  assert.equal(buildMarkMatchedAction({ ...placeholder, matched: true }), null);
});

test("orientOf defaults absent fields", () => {
  const o: Orientation = orientOf({ id: "c", cellTypeId: "t", x: 0, y: 0 });
  assert.deepEqual(o, { flippedH: false, flippedV: false, rotation: 0 });
});
