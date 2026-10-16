import assert from "node:assert/strict";
import test from "node:test";
import type { CellType, LayerShape, LayerType } from "shared";
import type { AnnotationAction } from "../api/actions";
import {
  buildFlipShapesAction,
  buildReplaceShapesAction,
  buildRotateShapesAction,
  cornerScale,
  mapShapePoints,
  scaleAbout,
  shapesBounds
} from "./cellLayers";

const rect: LayerShape = { id: "r", kind: "rect", x: 10, y: 20, width: 30, height: 10, label: "vcc" };
const via: LayerShape = { id: "v", kind: "point", x: 50, y: 45, size: 4 };
const poly: LayerShape = { id: "p", kind: "polygon", points: [{ x: 12, y: 32 }, { x: 22, y: 32 }, { x: 12, y: 40 }] };
const other: LayerShape = { id: "o", kind: "rect", x: 0, y: 0, width: 2, height: 2 };

const cellType: CellType = {
  id: "t",
  name: "T",
  cropRect: { x: 0, y: 0, width: 80, height: 60 },
  layers: { metal1: [rect, other], contact: [via], diffusion: [poly] }
};
const items: Array<{ layer: LayerType; shape: LayerShape }> = [
  { layer: "metal1", shape: rect },
  { layer: "contact", shape: via },
  { layer: "diffusion", shape: poly }
];

function upserted(action: AnnotationAction | null): CellType {
  assert.ok(action && action.kind === "upsertCellType");
  return action.cellType;
}

function nearShape(a: LayerShape | undefined, b: LayerShape | undefined) {
  const flat = (s: LayerShape | undefined) => JSON.stringify(s, (_k, v) => (typeof v === "number" ? Math.round(v * 1e9) / 1e9 : v));
  assert.equal(flat(a), flat(b));
}

test("shapesBounds spans the vertices of every shape", () => {
  assert.deepEqual(shapesBounds([rect, via, poly]), { x: 10, y: 20, width: 40, height: 25 });
  assert.equal(shapesBounds([]), null);
});

test("a group turns a quarter turn about the centre of its bounds", () => {
  // Bounds 10..50 × 20..45 → centre (30, 32.5).
  const cw = upserted(buildRotateShapesAction(cellType, items, 90));
  // (x, y) → (30 − (y − 32.5), 32.5 + (x − 30)): the rect's corners (10,20)
  // and (40,30) land on (42.5,12.5) and (32.5,42.5).
  assert.deepEqual(cw.layers?.metal1?.[0], { id: "r", kind: "rect", x: 32.5, y: 12.5, width: 10, height: 30, label: "vcc" });
  assert.deepEqual(cw.layers?.contact?.[0], { id: "v", kind: "point", x: 17.5, y: 52.5, size: 4 });
  assert.deepEqual(shapesBounds([cw.layers!.metal1![0], cw.layers!.contact![0], cw.layers!.diffusion![0]]), {
    x: 17.5,
    y: 12.5,
    width: 25,
    height: 40
  });
  // Shapes outside the selection stay put.
  assert.equal(cw.layers?.metal1?.[1], other);
});

test("turning back, or four times, returns the group to where it was", () => {
  const selected = (ct: CellType) => items.map((i) => ({ layer: i.layer, shape: ct.layers![i.layer]!.find((s) => s.id === i.shape.id)! }));
  const cw = upserted(buildRotateShapesAction(cellType, items, 90));
  const back = upserted(buildRotateShapesAction(cw, selected(cw), -90));
  for (const i of items) nearShape(back.layers?.[i.layer]?.find((s) => s.id === i.shape.id), i.shape);
  let spun = cellType;
  for (let k = 0; k < 4; k++) spun = upserted(buildRotateShapesAction(spun, selected(spun), 90));
  for (const i of items) nearShape(spun.layers?.[i.layer]?.find((s) => s.id === i.shape.id), i.shape);
});

test("a lone point or square has nothing to turn", () => {
  assert.equal(buildRotateShapesAction(cellType, [{ layer: "contact", shape: via }], 90), null);
  assert.equal(buildRotateShapesAction(cellType, [], 90), null);
  const square: LayerShape = { id: "o", kind: "rect", x: 0, y: 0, width: 2, height: 2 };
  assert.equal(buildRotateShapesAction(cellType, [{ layer: "metal1", shape: square }], 90), null);
  assert.ok(buildRotateShapesAction(cellType, [{ layer: "metal1", shape: rect }], 90), "a lone non-square rect turns");
});

test("a group mirrors across the centre line of its bounds", () => {
  // Bounds 10..50 × 20..45 → centre (30, 32.5).
  const h = upserted(buildFlipShapesAction(cellType, items, "h"));
  assert.deepEqual(h.layers?.metal1?.[0], { ...rect, x: 20 });
  assert.deepEqual(h.layers?.contact?.[0], { ...via, x: 10 });
  assert.deepEqual(h.layers?.diffusion?.[0], { ...poly, points: [{ x: 48, y: 32 }, { x: 38, y: 32 }, { x: 48, y: 40 }] });
  assert.equal(h.layers?.metal1?.[1], other, "unselected shapes stay put");
  const v = upserted(buildFlipShapesAction(cellType, items, "v"));
  assert.deepEqual(v.layers?.metal1?.[0], { ...rect, y: 35 });
  assert.deepEqual(v.layers?.contact?.[0], { ...via, y: 20 });
  // Twice restores it.
  const selected = (ct: CellType) => items.map((i) => ({ layer: i.layer, shape: ct.layers![i.layer]!.find((s) => s.id === i.shape.id)! }));
  const back = upserted(buildFlipShapesAction(h, selected(h), "h"));
  for (const i of items) nearShape(back.layers?.[i.layer]?.find((s) => s.id === i.shape.id), i.shape);
});

test("a lone rect or point has nothing to flip; a lone polygon does", () => {
  for (const axis of ["h", "v"] as const) {
    assert.equal(buildFlipShapesAction(cellType, [{ layer: "metal1", shape: rect }], axis), null);
    assert.equal(buildFlipShapesAction(cellType, [{ layer: "contact", shape: via }], axis), null);
    assert.ok(buildFlipShapesAction(cellType, [{ layer: "diffusion", shape: poly }], axis));
  }
});

test("cornerScale: the dragged corner follows, the anchor holds", () => {
  const anchor = { x: 0, y: 0 };
  const corner = { x: 10, y: 20 };
  assert.deepEqual(cornerScale(anchor, corner, { x: 15, y: 30 }, false), { sx: 1.5, sy: 1.5 });
  assert.deepEqual(cornerScale(anchor, corner, { x: 5, y: 30 }, false), { sx: 0.5, sy: 1.5 });
  // Dragged through the anchor: clamped to one unit of extent, never flipped.
  assert.deepEqual(cornerScale(anchor, corner, { x: -8, y: -4 }, false), { sx: 0.1, sy: 0.05 });
  // Top-left corner of the same box (anchor bottom-right).
  assert.deepEqual(cornerScale({ x: 10, y: 20 }, { x: 0, y: 0 }, { x: -10, y: 10 }, false), { sx: 2, sy: 0.5 });
  // A zero-extent axis can't scale.
  assert.deepEqual(cornerScale(anchor, { x: 10, y: 0 }, { x: 20, y: 9 }, false), { sx: 2, sy: 1 });
  // Uniform: the axis that changed most wins.
  assert.deepEqual(cornerScale(anchor, corner, { x: 30, y: 22 }, true), { sx: 3, sy: 3 });
  assert.deepEqual(cornerScale(anchor, { x: 10, y: 0 }, { x: 20, y: 9 }, true), { sx: 2, sy: 2 });
});

test("scaling maps positions and keeps via sizes", () => {
  const f = scaleAbout({ x: 10, y: 20 }, 2, 0.5);
  assert.deepEqual(mapShapePoints(rect, f), { ...rect, x: 10, y: 20, width: 60, height: 5 });
  assert.deepEqual(mapShapePoints(via, f), { ...via, x: 90, y: 32.5 });
  assert.deepEqual(mapShapePoints(poly, f), { ...poly, points: [{ x: 14, y: 26 }, { x: 34, y: 26 }, { x: 14, y: 30 }] });
});

test("buildReplaceShapesAction swaps listed shapes in one upsert", () => {
  const moved = { ...via, x: 1 };
  const next = upserted(buildReplaceShapesAction(cellType, [{ layer: "contact", shape: moved }]));
  assert.deepEqual(next.layers?.contact, [moved]);
  assert.equal(next.layers?.metal1, cellType.layers?.metal1);
  // A shape that isn't there (wrong layer) changes nothing.
  assert.equal(buildReplaceShapesAction(cellType, [{ layer: "metal2", shape: moved }]), null);
});
