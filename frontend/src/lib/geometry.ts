/**
 * Agnostic 2D geometry primitives and predicates. No renderer dependencies —
 * pure math over `Point` and `Rect`. Used by hit-testing, marquee selection,
 * tile-bounds math, etc. Keep this file free of canvas / DOM / framework imports.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Point ↔ Rect ─────────────────────────────────────────────────────

export function pointInRect(p: Point, r: Rect): boolean {
  return (
    p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height
  );
}

/** Like `pointInRect`, but inflates the rect by `tol` on every side. */
export function pointInRectTolerant(p: Point, r: Rect, tol: number): boolean {
  return (
    p.x >= r.x - tol &&
    p.x <= r.x + r.width + tol &&
    p.y >= r.y - tol &&
    p.y <= r.y + r.height + tol
  );
}

// ── Rect ↔ Rect ──────────────────────────────────────────────────────

export function rectsIntersect(a: Rect, b: Rect): boolean {
  return !(
    a.x + a.width <= b.x ||
    b.x + b.width <= a.x ||
    a.y + a.height <= b.y ||
    b.y + b.height <= a.y
  );
}

/** Axis-aligned bounding rect of two points. Order-agnostic. */
export function rectFromPoints(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y)
  };
}

/** Like `rectFromPoints` but forced square: the side is the larger of the two
 *  spans, growing away from `a` in whichever direction `b` was dragged. */
export function squareFromPoints(a: Point, b: Point): Rect {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const side = Math.max(Math.abs(dx), Math.abs(dy));
  return rectFromPoints(a, {
    x: a.x + (dx < 0 ? -side : side),
    y: a.y + (dy < 0 ? -side : side)
  });
}

/** Rebuild a rect with a non-negative width/height (origin at the top-left),
 *  collapsing negative-extent rects produced by dragging up/left. */
export function normalizeRect(r: Rect): Rect {
  return {
    x: r.width >= 0 ? r.x : r.x + r.width,
    y: r.height >= 0 ? r.y : r.y + r.height,
    width: Math.abs(r.width),
    height: Math.abs(r.height)
  };
}

/** The four corners of a rect, clockwise from the top-left:
 *  [0]=TL, [1]=TR, [2]=BR, [3]=BL. The opposite of corner `i` is `(i + 2) % 4`. */
export function rectCorners(r: Rect): Point[] {
  const n = normalizeRect(r);
  return [
    { x: n.x, y: n.y },
    { x: n.x + n.width, y: n.y },
    { x: n.x + n.width, y: n.y + n.height },
    { x: n.x, y: n.y + n.height }
  ];
}

/** Resize `rect` by dragging its `cornerIdx`-th corner to `newCorner`. The
 *  opposite corner stays fixed. Used by handle-drag rect edits — the returned
 *  rect may have negative dimensions, normalize at the call site if needed. */
export function rectFromCornerDrag(
  rect: { x: number; y: number; width: number; height: number },
  cornerIdx: number,
  newCorner: Point
): Rect {
  const corners = rectCorners(rect);
  const fixed = corners[(cornerIdx + 2) % 4];
  return rectFromPoints(fixed, newCorner);
}

/** Index (0=TL,1=TR,2=BR,3=BL) of the rect corner within `tol` of `p`, or
 *  null. The opposite (anchor) corner when resizing is `(i + 2) % 4`. */
export function rectCornerAt(r: Rect, p: Point, tol: number): number | null {
  const cs = rectCorners(r);
  let best: number | null = null;
  let bestD = tol;
  for (let i = 0; i < 4; i++) {
    const d = Math.hypot(cs[i].x - p.x, cs[i].y - p.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

/** Index of the polygon vertex within `tol` of `p` (nearest), or null. */
export function polyVertexAt(
  points: ReadonlyArray<Point>,
  p: Point,
  tol: number
): number | null {
  let best: number | null = null;
  let bestD = tol;
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - p.x, points[i].y - p.y);
    if (d <= bestD) {
      best = i;
      bestD = d;
    }
  }
  return best;
}

// ── Segment / polyline ───────────────────────────────────────────────

/**
 * Snap `free` to the nearest 45° ray from `anchor`, preserving distance.
 * Used while drawing wires (hold Shift to bypass at the call site).
 */
export function snapTo45(anchor: Point, free: Point): Point {
  const dx = free.x - anchor.x;
  const dy = free.y - anchor.y;
  const dist = Math.hypot(dx, dy);
  if (dist === 0) return { x: anchor.x, y: anchor.y };
  const step = Math.PI / 4;
  const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
  return {
    x: anchor.x + dist * Math.cos(snapped),
    y: anchor.y + dist * Math.sin(snapped)
  };
}

/**
 * Corner of an axis-aligned (Manhattan) L-route from `a` to `b`. The longer
 * axis is travelled first. Returns `null` when `a`/`b` already share a row or
 * column (a single orthogonal segment — no elbow needed).
 */
export function orthoElbow(a: Point, b: Point): Point | null {
  if (a.x === b.x || a.y === b.y) return null;
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y)
    ? { x: b.x, y: a.y } // horizontal run first, then vertical
    : { x: a.x, y: b.y }; // vertical run first, then horizontal
}

/** Point on segment `a`-`b` closest to `p` (clamped to the segment ends). */
export function closestPointOnSegment(p: Point, a: Point, b: Point): Point {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return { x: a.x, y: a.y };
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return { x: a.x + t * abx, y: a.y + t * aby };
}

/** Shortest distance from point `p` to segment `a`-`b`. */
export function distancePointToSegment(p: Point, a: Point, b: Point): number {
  const c = closestPointOnSegment(p, a, b);
  return Math.hypot(p.x - c.x, p.y - c.y);
}

/** True if open segments `p1`-`p2` and `p3`-`p4` cross (not just touch). */
export function segmentsIntersect(
  p1: Point,
  p2: Point,
  p3: Point,
  p4: Point
): boolean {
  const d1 = cross(p4.x - p3.x, p4.y - p3.y, p1.x - p3.x, p1.y - p3.y);
  const d2 = cross(p4.x - p3.x, p4.y - p3.y, p2.x - p3.x, p2.y - p3.y);
  const d3 = cross(p2.x - p1.x, p2.y - p1.y, p3.x - p1.x, p3.y - p1.y);
  const d4 = cross(p2.x - p1.x, p2.y - p1.y, p4.x - p1.x, p4.y - p1.y);
  return (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  );
}

/** True if segment `a`-`b` intersects axis-aligned rect `r`. */
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (pointInRect(a, r) || pointInRect(b, r)) return true;
  const x1 = r.x;
  const y1 = r.y;
  const x2 = r.x + r.width;
  const y2 = r.y + r.height;
  return (
    segmentsIntersect(a, b, { x: x1, y: y1 }, { x: x2, y: y1 }) ||
    segmentsIntersect(a, b, { x: x2, y: y1 }, { x: x2, y: y2 }) ||
    segmentsIntersect(a, b, { x: x2, y: y2 }, { x: x1, y: y2 }) ||
    segmentsIntersect(a, b, { x: x1, y: y2 }, { x: x1, y: y1 })
  );
}

// ── Polygon ──────────────────────────────────────────────────────────

/** Axis-aligned bounding rect of a ring/polygon. `null` for an empty ring. */
export function polygonBounds(ring: ReadonlyArray<Point>): Rect | null {
  if (ring.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Standard ray-casting point-in-polygon. Polygon is closed implicitly. */
export function pointInPolygon(p: Point, poly: ReadonlyArray<Point>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const intersect =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

// ── Cell orientation ─────────────────────────────────────────────────

/** A cell instance's placement orientation within its W×H footprint. */
export interface Orientation {
  flippedH?: boolean;
  flippedV?: boolean;
  rotation?: 0 | 90 | 180 | 270;
}

/**
 * Map a point from canonical cell-local coordinates into oriented cell-local
 * coordinates (still relative to the cell's top-left origin): mirror about
 * the box centre, then rotate about it — `O = R(θ)·S`, the placement
 * convention shared with the die-viewer cell renderer and the backend. The
 * cell-RE / merge canvases show die pixels in the canonical frame through
 * the inverse, `toCanonical`.
 *
 * Add the cell's `(x, y)` to the result for die/world coordinates.
 */
export function applyOrientation(
  p: Point,
  o: Orientation,
  boxW: number,
  boxH: number
): Point {
  let qx = p.x - boxW / 2;
  let qy = p.y - boxH / 2;
  if (o.flippedH) qx = -qx;
  if (o.flippedV) qy = -qy;
  // Exact 90° steps (canvas convention: math-CCW, visually CW under y-down).
  let rx = qx;
  let ry = qy;
  switch (o.rotation ?? 0) {
    case 90:
      rx = -qy;
      ry = qx;
      break;
    case 180:
      rx = -qx;
      ry = -qy;
      break;
    case 270:
      rx = qy;
      ry = -qx;
      break;
  }
  return { x: rx + boxW / 2, y: ry + boxH / 2 };
}

/** Inverse of `applyOrientation`: oriented cell-local → canonical (un-rotate,
 *  then un-flip). Subtract the cell's `(x, y)` from a die point first. */
export function toCanonical(
  p: Point,
  o: Orientation,
  boxW: number,
  boxH: number
): Point {
  const rx = p.x - boxW / 2;
  const ry = p.y - boxH / 2;
  let qx = rx;
  let qy = ry;
  switch (o.rotation ?? 0) {
    case 90:
      qx = ry;
      qy = -rx;
      break;
    case 180:
      qx = -rx;
      qy = -ry;
      break;
    case 270:
      qx = -ry;
      qy = rx;
      break;
  }
  if (o.flippedH) qx = -qx;
  if (o.flippedV) qy = -qy;
  return { x: qx + boxW / 2, y: qy + boxH / 2 };
}

// ── Internal ─────────────────────────────────────────────────────────

function cross(ax: number, ay: number, bx: number, by: number): number {
  return ax * by - ay * bx;
}
