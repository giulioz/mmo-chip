import type {
  CellType,
  CellLayers,
  ForcedDiffusionType,
  LayerPolygon,
  LayerPoint,
  LayerRect,
  LayerShape,
  LayerType,
  ShapeLabel
} from "shared";
import type { AnnotationAction } from "../api/actions";
import {
  distancePointToSegment,
  normalizeRect,
  pointInPolygon,
  pointInRect,
  pointInRectTolerant,
  polygonBounds,
  rectCorners,
  rectFromCornerDrag,
  rectsIntersect,
  segmentIntersectsRect
} from "./geometry";
import type { Point, Rect } from "./geometry";

/**
 * Generic geometry / mutation helpers for `CellType.layers`. Anything in here
 * is page-agnostic: it knows about `LayerShape` and `CellType.layers`, but not
 * about which page (die viewer, cells RE, merge cells, …) is doing the edit.
 *
 * `drawShape` and `LAYER_DRAW_ORDER` live in `renderer/annotations/shapes.ts`
 * because they're renderer-coupled; everything here is data-only.
 */

// ── Shape constructors ────────────────────────────────────────────────

export function makeRect(rect: Rect): LayerRect {
  const r = normalizeRect(rect);
  return {
    id: crypto.randomUUID(),
    kind: "rect",
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height)
  };
}

export function makePolygon(points: Point[]): LayerPolygon {
  return {
    id: crypto.randomUUID(),
    kind: "polygon",
    points: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
  };
}

/** Via points carry a `size` (world units, diameter); default to 4 for
 *  comfortable visibility at typical cell zooms. */
export function makePoint(p: Point, size = 4): LayerPoint {
  return {
    id: crypto.randomUUID(),
    kind: "point",
    x: Math.round(p.x),
    y: Math.round(p.y),
    size
  };
}

// ── Hit-test / containment ────────────────────────────────────────────

/** True if cell-local `pt` lands on the visible body of `shape`. `tol` is in
 *  cell-local units — typically derived from a few CSS px at current zoom. */
export function shapeHit(shape: LayerShape, pt: Point, tol: number): boolean {
  switch (shape.kind) {
    case "rect":
      return pointInRectTolerant(pt, shape, tol);
    case "point": {
      const r = Math.max(shape.size / 2, tol);
      return Math.hypot(pt.x - shape.x, pt.y - shape.y) <= r;
    }
    case "polygon": {
      // Bound-box first to skip obvious misses cheaply.
      const b = polygonBounds(shape.points);
      if (b && !pointInRectTolerant(pt, b, tol)) return false;
      return pointInPolygon(pt, shape.points);
    }
    case "circle":
      return Math.hypot(pt.x - shape.x, pt.y - shape.y) <= shape.radius + tol;
    case "line":
      return (
        distancePointToSegment(
          pt,
          { x: shape.x1, y: shape.y1 },
          { x: shape.x2, y: shape.y2 }
        ) <=
        shape.width / 2 + tol
      );
  }
}

/** True if `shape` overlaps `r` at all — even partial overlap counts. Used
 *  by the Cells-RE marquee, which deliberately picks generously so the user
 *  doesn't have to fully enclose long polygons / wires to grab them. */
export function shapeIntersectsRect(shape: LayerShape, r: Rect): boolean {
  switch (shape.kind) {
    case "rect":
      return rectsIntersect(shape, r);
    case "point": {
      // Treat the via dot as a circle of radius size/2: it "touches" the
      // rect when the nearest point of the rect is within that radius.
      const radius = Math.max(shape.size / 2, 0);
      const nx = Math.max(r.x, Math.min(shape.x, r.x + r.width));
      const ny = Math.max(r.y, Math.min(shape.y, r.y + r.height));
      return Math.hypot(shape.x - nx, shape.y - ny) <= radius;
    }
    case "polygon": {
      if (shape.points.length === 0) return false;
      const b = polygonBounds(shape.points);
      if (b && !rectsIntersect(b, r)) return false;
      // Any vertex inside the rect → overlap.
      for (const p of shape.points) {
        if (pointInRect(p, r)) return true;
      }
      // Any rect corner inside the polygon → overlap (rect sits inside).
      for (const c of rectCorners(r)) {
        if (pointInPolygon(c, shape.points)) return true;
      }
      // Edge cross — polygon and rect overlap without containing each
      // other's vertices (rare but possible for thin slivers).
      for (let i = 0, j = shape.points.length - 1; i < shape.points.length; j = i++) {
        if (segmentIntersectsRect(shape.points[j], shape.points[i], r)) return true;
      }
      return false;
    }
    case "circle": {
      const nx = Math.max(r.x, Math.min(shape.x, r.x + r.width));
      const ny = Math.max(r.y, Math.min(shape.y, r.y + r.height));
      return Math.hypot(shape.x - nx, shape.y - ny) <= shape.radius;
    }
    case "line":
      return segmentIntersectsRect(
        { x: shape.x1, y: shape.y1 },
        { x: shape.x2, y: shape.y2 },
        r
      );
  }
}

/** True if every part of the shape lies inside the rect `r`. Used by marquee
 *  selection — partial overlaps deliberately don't count (matches the die
 *  viewer's marquee semantics). */
export function shapeInRect(shape: LayerShape, r: Rect): boolean {
  switch (shape.kind) {
    case "rect":
      return (
        shape.x >= r.x &&
        shape.y >= r.y &&
        shape.x + shape.width <= r.x + r.width &&
        shape.y + shape.height <= r.y + r.height
      );
    case "point":
      return pointInRect(shape, r);
    case "polygon":
      return shape.points.every((p) => pointInRect(p, r));
    case "circle":
      return (
        shape.x - shape.radius >= r.x &&
        shape.y - shape.radius >= r.y &&
        shape.x + shape.radius <= r.x + r.width &&
        shape.y + shape.radius <= r.y + r.height
      );
    case "line":
      return (
        pointInRect({ x: shape.x1, y: shape.y1 }, r) &&
        pointInRect({ x: shape.x2, y: shape.y2 }, r)
      );
  }
}

// ── Transforms ────────────────────────────────────────────────────────

/** Translate every coordinate in a shape by `(dx, dy)`. Pure: returns a new
 *  shape with the same id. */
export function translateShape(shape: LayerShape, dx: number, dy: number): LayerShape {
  switch (shape.kind) {
    case "rect":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "point":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "polygon":
      return {
        ...shape,
        points: shape.points.map((p) => ({ x: p.x + dx, y: p.y + dy }))
      };
    case "circle":
      return { ...shape, x: shape.x + dx, y: shape.y + dy };
    case "line":
      return {
        ...shape,
        x1: shape.x1 + dx,
        y1: shape.y1 + dy,
        x2: shape.x2 + dx,
        y2: shape.y2 + dy
      };
  }
}

/** Map every vertex of a shape through `f`; sizes, widths and radii stay as
 *  they are. Rects map two opposite corners and re-normalise, so `f` must
 *  keep axes axis-aligned (translations, scales, quarter turns). Pure: same
 *  id and metadata. */
export function mapShapePoints(shape: LayerShape, f: (p: Point) => Point): LayerShape {
  switch (shape.kind) {
    case "rect": {
      const a = f({ x: shape.x, y: shape.y });
      const b = f({ x: shape.x + shape.width, y: shape.y + shape.height });
      return {
        ...shape,
        ...normalizeRect({ x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y })
      };
    }
    case "point":
    case "circle":
      return { ...shape, ...f({ x: shape.x, y: shape.y }) };
    case "polygon":
      return { ...shape, points: shape.points.map((p) => f(p)) };
    case "line": {
      const a = f({ x: shape.x1, y: shape.y1 });
      const b = f({ x: shape.x2, y: shape.y2 });
      return { ...shape, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
    }
  }
}

/** Turn a shape a quarter turn inside its W×H cell box (`deg` 90 = clockwise
 *  on screen, −90 = counter-clockwise), landing in the H×W box the turn
 *  produces. Pure: same id and metadata. */
export function rotateShape(
  shape: LayerShape,
  deg: 90 | -90,
  boxW: number,
  boxH: number
): LayerShape {
  return mapShapePoints(shape, boxTurn(deg, boxW, boxH));
}

/** `rotateShape` over every layer of a cell type. */
export function rotateLayers(
  layers: CellLayers,
  deg: 90 | -90,
  boxW: number,
  boxH: number
): CellLayers {
  return mapLayerPoints(layers, boxTurn(deg, boxW, boxH));
}

/** Point map: a quarter turn of a W×H cell box into the H×W box it becomes. */
function boxTurn(deg: 90 | -90, boxW: number, boxH: number): (p: Point) => Point {
  return deg === 90 ? (p) => ({ x: boxH - p.y, y: p.x }) : (p) => ({ x: p.y, y: boxW - p.x });
}

/** `mapShapePoints` over every layer of a cell type. */
export function mapLayerPoints(layers: CellLayers, f: (p: Point) => Point): CellLayers {
  const out: CellLayers = {};
  for (const [layer, shapes] of Object.entries(layers) as Array<
    [LayerType, LayerShape[] | undefined]
  >) {
    if (shapes) out[layer] = shapes.map((s) => mapShapePoints(s, f));
  }
  return out;
}

// ── Group transforms (a multi-selection edited as one) ────────────────

/** Joint bounds of the shapes' vertices (their `shapeHandles`) — the box a
 *  group rotates and scales by. Null when there are no shapes. */
export function shapesBounds(shapes: Iterable<LayerShape>): Rect | null {
  const pts: Point[] = [];
  for (const s of shapes) pts.push(...shapeHandles(s));
  return polygonBounds(pts);
}

/** Point map: a quarter turn about `c` (90 = clockwise on screen). */
export function quarterTurnAbout(c: Point, deg: 90 | -90): (p: Point) => Point {
  return deg === 90
    ? (p) => ({ x: c.x - (p.y - c.y), y: c.y + (p.x - c.x) })
    : (p) => ({ x: c.x + (p.y - c.y), y: c.y - (p.x - c.x) });
}

/** Point map: a mirror across the vertical (`"h"`: flips left↔right) or
 *  horizontal (`"v"`: top↔bottom) line through `c`. */
export function mirrorAbout(c: Point, axis: "h" | "v"): (p: Point) => Point {
  return axis === "h"
    ? (p) => ({ x: 2 * c.x - p.x, y: p.y })
    : (p) => ({ x: p.x, y: 2 * c.y - p.y });
}

/** Point map: scale by `(sx, sy)` about `anchor`. */
export function scaleAbout(anchor: Point, sx: number, sy: number): (p: Point) => Point {
  return (p) => ({
    x: anchor.x + (p.x - anchor.x) * sx,
    y: anchor.y + (p.y - anchor.y) * sy
  });
}

/**
 * Scale factors that carry a box's `corner` to `target` while the opposite
 * `anchor` corner stays put. A zero-extent axis stays at 1, and each axis
 * keeps at least one unit of extent (no collapsing or flipping through the
 * anchor). `uniform` keeps the aspect ratio, following the axis that changed
 * most.
 */
export function cornerScale(
  anchor: Point,
  corner: Point,
  target: Point,
  uniform: boolean
): { sx: number; sy: number } {
  const extX = corner.x - anchor.x;
  const extY = corner.y - anchor.y;
  const minX = extX === 0 ? 0 : 1 / Math.abs(extX);
  const minY = extY === 0 ? 0 : 1 / Math.abs(extY);
  let sx = extX === 0 ? 1 : Math.max((target.x - anchor.x) / extX, minX);
  let sy = extY === 0 ? 1 : Math.max((target.y - anchor.y) / extY, minY);
  if (uniform) {
    const s =
      extX === 0 ? sy : extY === 0 ? sx : Math.abs(sx - 1) >= Math.abs(sy - 1) ? sx : sy;
    sx = sy = Math.max(s, minX, minY);
  }
  return { sx, sy };
}

/** Replace several existing shapes (matched by layer + id) in one cell-type
 *  upsert — a single undo step for a group edit. Null when none of them
 *  exist. */
export function buildReplaceShapesAction(
  cellType: CellType,
  replacements: ReadonlyArray<{ layer: LayerType; shape: LayerShape }>
): AnnotationAction | null {
  const byLayer = new Map<LayerType, Map<string, LayerShape>>();
  for (const r of replacements) {
    let m = byLayer.get(r.layer);
    if (!m) {
      m = new Map();
      byLayer.set(r.layer, m);
    }
    m.set(r.shape.id, r.shape);
  }
  let layers = cellType.layers;
  let touched = false;
  for (const [layer, next] of byLayer) {
    layers = withLayer(layers, layer, (cur) =>
      cur.map((s) => {
        const r = next.get(s.id);
        if (!r) return s;
        touched = true;
        return r;
      })
    );
  }
  if (!touched) return null;
  return { kind: "upsertCellType", cellType: { ...cellType, layers }, prevCellType: cellType };
}

/** Quarter-turn a group of shapes about the centre of their joint bounds, in
 *  one undo step. Null when that changes nothing (no shapes, a lone point, a
 *  lone square). */
export function buildRotateShapesAction(
  cellType: CellType,
  items: ReadonlyArray<{ layer: LayerType; shape: LayerShape }>,
  deg: 90 | -90
): AnnotationAction | null {
  return buildGroupMapAction(cellType, items, (c) => quarterTurnAbout(c, deg));
}

/** Mirror a group of shapes across the centre line of their joint bounds
 *  (`"h"` left↔right, `"v"` top↔bottom), in one undo step. Null when that
 *  changes nothing (no shapes, a lone rect or point). */
export function buildFlipShapesAction(
  cellType: CellType,
  items: ReadonlyArray<{ layer: LayerType; shape: LayerShape }>,
  axis: "h" | "v"
): AnnotationAction | null {
  return buildGroupMapAction(cellType, items, (c) => mirrorAbout(c, axis));
}

/** Map a group's vertices through `mapFor(centre of their joint bounds)` as
 *  one replace; null when every vertex stays where it was. */
function buildGroupMapAction(
  cellType: CellType,
  items: ReadonlyArray<{ layer: LayerType; shape: LayerShape }>,
  mapFor: (centre: Point) => (p: Point) => Point
): AnnotationAction | null {
  const b = shapesBounds(items.map((i) => i.shape));
  if (!b) return null;
  const f = mapFor({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
  let moved = false;
  const replacements = items.map((i) => {
    const shape = mapShapePoints(i.shape, f);
    const before = shapeHandles(i.shape);
    const after = shapeHandles(shape);
    if (after.some((p, k) => Math.abs(p.x - before[k].x) > 1e-9 || Math.abs(p.y - before[k].y) > 1e-9)) {
      moved = true;
    }
    return { layer: i.layer, shape };
  });
  return moved ? buildReplaceShapesAction(cellType, replacements) : null;
}

// ── Per-vertex handles ────────────────────────────────────────────────

/** Vertices to render as drag handles for `shape` — corners for rect-likes,
 *  vertices for polygons, the centre for point/circle, both endpoints for
 *  line. Returned in stable order; callers may index into the array. */
export function shapeHandles(shape: LayerShape): Point[] {
  switch (shape.kind) {
    case "rect":
      return rectCorners(shape);
    case "polygon":
      return shape.points;
    case "point":
    case "circle":
      return [{ x: shape.x, y: shape.y }];
    case "line":
      return [
        { x: shape.x1, y: shape.y1 },
        { x: shape.x2, y: shape.y2 }
      ];
  }
}

/** Index of the handle on `shape` within `tol` of `pt`, or null. Index
 *  semantics are shape-kind specific — see `shapeHandles`. */
export function shapeHandleAt(shape: LayerShape, pt: Point, tol: number): number | null {
  const handles = shapeHandles(shape);
  let best: number | null = null;
  let bestD = tol;
  for (let i = 0; i < handles.length; i++) {
    const d = Math.hypot(handles[i].x - pt.x, handles[i].y - pt.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Reshape `shape` so its `vIdx`-th handle moves to `newPt`. `vIdx` is
 *  whatever `shapeHandleAt` returned for the same shape. */
export function moveShapeVertex(
  shape: LayerShape,
  vIdx: number,
  newPt: Point
): LayerShape {
  switch (shape.kind) {
    case "rect":
      return { ...shape, ...normalizeRect(rectFromCornerDrag(shape, vIdx, newPt)) };
    case "polygon":
      return {
        ...shape,
        points: shape.points.map((p, i) => (i === vIdx ? { x: newPt.x, y: newPt.y } : p))
      };
    case "point":
    case "circle":
      return { ...shape, x: newPt.x, y: newPt.y };
    case "line":
      return vIdx === 0
        ? { ...shape, x1: newPt.x, y1: newPt.y }
        : { ...shape, x2: newPt.x, y2: newPt.y };
  }
}

// ── CellType.layers action builders ───────────────────────────────────
//
// Cell-layer shapes don't have their own action kind: they live inside
// `CellType.layers`, so every layer edit dispatches a whole-cell-type upsert.
// These helpers package that pattern so callers don't reinvent the immutable
// update + prev-snapshot dance.

/** Pure layer mutator: return a new `CellLayers` with `mutate` applied to the
 *  named layer's shape array. Always produces a fresh object so the resulting
 *  CellType is a distinct identity (drives React + cache invalidation). */
function withLayer(
  layers: CellLayers | undefined,
  layer: LayerType,
  mutate: (shapes: LayerShape[]) => LayerShape[]
): CellLayers {
  const cur = layers?.[layer] ?? [];
  const next = mutate(cur);
  const out: CellLayers = { ...(layers ?? {}) };
  if (next.length === 0) delete out[layer];
  else out[layer] = next;
  return out;
}

/** Rename a cell type — sets `cellType.name`. Returns null when the
 *  new name is empty after trimming or matches the current name (no
 *  state change). */
export function buildRenameCellTypeAction(
  cellType: CellType,
  newName: string
): AnnotationAction | null {
  const trimmed = newName.trim();
  if (trimmed.length === 0) return null;
  if (trimmed === cellType.name) return null;
  const next: CellType = { ...cellType, name: trimmed };
  return { kind: "upsertCellType", cellType: next, prevCellType: cellType };
}

/** Insert (or update by id) a single shape into a layer. */
export function buildUpsertShapeAction(
  cellType: CellType,
  layer: LayerType,
  shape: LayerShape
): AnnotationAction {
  const next: CellType = {
    ...cellType,
    layers: withLayer(cellType.layers, layer, (cur) => {
      const i = cur.findIndex((s) => s.id === shape.id);
      if (i < 0) return [...cur, shape];
      const copy = cur.slice();
      copy[i] = shape;
      return copy;
    })
  };
  return { kind: "upsertCellType", cellType: next, prevCellType: cellType };
}

/** Remove many shapes (across layers) in one undoable step. */
export function buildRemoveShapesAction(
  cellType: CellType,
  removals: Array<{ layer: LayerType; id: string }>
): AnnotationAction | null {
  if (removals.length === 0) return null;
  const byLayer = new Map<LayerType, Set<string>>();
  for (const r of removals) {
    let set = byLayer.get(r.layer);
    if (!set) {
      set = new Set();
      byLayer.set(r.layer, set);
    }
    set.add(r.id);
  }
  let layers = cellType.layers;
  for (const [layer, ids] of byLayer) {
    layers = withLayer(layers, layer, (cur) => cur.filter((s) => !ids.has(s.id)));
  }
  const next: CellType = { ...cellType, layers };
  return { kind: "upsertCellType", cellType: next, prevCellType: cellType };
}

/** Apply `label` to one shape's record, dropping the property when `null`. */
function withLabel(shape: LayerShape, label: ShapeLabel | null): LayerShape {
  if (label == null) {
    const { label: _drop, ...rest } = shape;
    return rest as LayerShape;
  }
  return { ...shape, label } as LayerShape;
}

/**
 * Set / clear `shape.label` on a single shape in a layer. The label is what
 * downstream extraction reads to override automatic inference (e.g. labelling
 * a metal net as VCC, or a diffusion body as P-type via its VCC contact).
 * Pass `null` to clear the label entirely (the property is dropped, not set
 * to `null`, so the persisted JSON stays clean).
 */
export function buildSetShapeLabelAction(
  cellType: CellType,
  layer: LayerType,
  shapeId: string,
  label: ShapeLabel | null
): AnnotationAction | null {
  const cur = cellType.layers?.[layer];
  const idx = cur?.findIndex((s) => s.id === shapeId) ?? -1;
  if (!cur || idx < 0) return null;
  const existing = cur[idx];
  // Skip the dispatch if the requested state matches what we already have —
  // saves an undo entry for a no-op click.
  if ((existing.label ?? null) === (label ?? null)) return null;
  return buildUpsertShapeAction(cellType, layer, withLabel(existing, label));
}

/**
 * Batched variant: set / clear `label` on many shapes (across layers) in one
 * undoable step. Targets pointing at missing shapes are silently skipped; if
 * every target is already in the requested state, returns `null` so the
 * caller can avoid an empty dispatch.
 */
export function buildSetShapeLabelsAction(
  cellType: CellType,
  targets: ReadonlyArray<{ layer: LayerType; id: string }>,
  label: ShapeLabel | null
): AnnotationAction | null {
  if (targets.length === 0) return null;
  const byLayer = new Map<LayerType, Set<string>>();
  for (const t of targets) {
    let ids = byLayer.get(t.layer);
    if (!ids) {
      ids = new Set();
      byLayer.set(t.layer, ids);
    }
    ids.add(t.id);
  }
  let layers = cellType.layers;
  let touched = false;
  for (const [layer, ids] of byLayer) {
    layers = withLayer(layers, layer, (cur) =>
      cur.map((s) => {
        if (!ids.has(s.id)) return s;
        if ((s.label ?? null) === (label ?? null)) return s; // already there
        touched = true;
        return withLabel(s, label);
      })
    );
  }
  if (!touched) return null;
  const next: CellType = { ...cellType, layers };
  return { kind: "upsertCellType", cellType: next, prevCellType: cellType };
}

/** Apply `customName` to one shape, dropping the property when `null`
 *  or empty after trimming. */
function withCustomName(shape: LayerShape, name: string | null): LayerShape {
  const trimmed = name?.trim() ?? "";
  if (trimmed.length === 0) {
    const { customName: _drop, ...rest } = shape;
    return rest as LayerShape;
  }
  return { ...shape, customName: trimmed } as LayerShape;
}

/**
 * Set / clear `customName` on a single shape — the user's arbitrary
 * net name (e.g. "CLK", "Qbar"). The extractor propagates it to the
 * net via the same mechanism as `label`, so labelling ANY shape on
 * the net suffices to rename it everywhere.
 *
 * Pass `null` or an empty string to clear. Returns null on no-op.
 */
export function buildSetShapeCustomNameAction(
  cellType: CellType,
  layer: LayerType,
  shapeId: string,
  name: string | null,
): AnnotationAction | null {
  const list = cellType.layers?.[layer];
  if (!list) return null;
  const cur = list.find((s) => s.id === shapeId);
  if (!cur) return null;
  const trimmed = name?.trim() ?? "";
  const currentName = cur.customName ?? "";
  if (trimmed === currentName) return null; // no-op
  const next: CellType = {
    ...cellType,
    layers: withLayer(cellType.layers, layer, (xs) =>
      xs.map((s) =>
        s.id === shapeId ? withCustomName(s, trimmed.length > 0 ? trimmed : null) : s,
      ),
    ),
  };
  return { kind: "upsertCellType", cellType: next, prevCellType: cellType };
}

/** Apply a forced-type override to one shape, dropping the field on `null`. */
function withForcedType(
  shape: LayerShape,
  type: ForcedDiffusionType | null,
): LayerShape {
  if (type == null) {
    const { forcedType: _drop, ...rest } = shape;
    return rest as LayerShape;
  }
  return { ...shape, forcedType: type } as LayerShape;
}

/**
 * Set / clear `forcedType` on a single shape — the diffusion-only P/N
 * override. Independent of `label` so a forced type doesn't accidentally
 * propagate as a net role (which was the previous data model's bug).
 * No-op + null return when the requested state already matches.
 */
export function buildSetShapeForcedTypeAction(
  cellType: CellType,
  layer: LayerType,
  shapeId: string,
  type: ForcedDiffusionType | null,
): AnnotationAction | null {
  const cur = cellType.layers?.[layer];
  const idx = cur?.findIndex((s) => s.id === shapeId) ?? -1;
  if (!cur || idx < 0) return null;
  const existing = cur[idx];
  if ((existing.forcedType ?? null) === (type ?? null)) return null;
  return buildUpsertShapeAction(cellType, layer, withForcedType(existing, type));
}

/**
 * Batched variant of `buildSetShapeForcedTypeAction`. Mirrors the labels
 * batch builder: groups targets by layer, skips no-ops, returns `null` when
 * every target is already in the requested state.
 */
export function buildSetShapeForcedTypesAction(
  cellType: CellType,
  targets: ReadonlyArray<{ layer: LayerType; id: string }>,
  type: ForcedDiffusionType | null,
): AnnotationAction | null {
  if (targets.length === 0) return null;
  const byLayer = new Map<LayerType, Set<string>>();
  for (const t of targets) {
    let ids = byLayer.get(t.layer);
    if (!ids) {
      ids = new Set();
      byLayer.set(t.layer, ids);
    }
    ids.add(t.id);
  }
  let layers = cellType.layers;
  let touched = false;
  for (const [layer, ids] of byLayer) {
    layers = withLayer(layers, layer, (cur) =>
      cur.map((s) => {
        if (!ids.has(s.id)) return s;
        if ((s.forcedType ?? null) === (type ?? null)) return s;
        touched = true;
        return withForcedType(s, type);
      }),
    );
  }
  if (!touched) return null;
  const next: CellType = { ...cellType, layers };
  return { kind: "upsertCellType", cellType: next, prevCellType: cellType };
}

/** Batch insert (paste) — gives every shape a fresh id, sites them in `layer`. */
export function buildInsertShapesAction(
  cellType: CellType,
  layer: LayerType,
  shapes: LayerShape[]
): { action: AnnotationAction; insertedIds: string[] } {
  const fresh = shapes.map((s) => ({ ...s, id: crypto.randomUUID() } as LayerShape));
  const next: CellType = {
    ...cellType,
    layers: withLayer(cellType.layers, layer, (cur) => [...cur, ...fresh])
  };
  return {
    action: { kind: "upsertCellType", cellType: next, prevCellType: cellType },
    insertedIds: fresh.map((s) => s.id)
  };
}
