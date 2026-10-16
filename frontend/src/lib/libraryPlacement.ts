import type { Cell, CellType } from "shared";
import type { Point, Rect } from "./geometry";
import type { Rotation } from "./mergeCells";

/**
 * The "place library cell" tool's draft: another die's cell type laid over
 * this die, moved, scaled (uniformly — the scale is one number per die) and
 * oriented until it sits on an instance here. Accepting places a cell of
 * that type and sets this die's scale from the fit.
 */
export interface LibraryPlacement {
  typeId: string;
  /** Footprint centre, die px. Moving, turning and flipping keep it. */
  cx: number;
  cy: number;
  /** This die's pixels per owner-die pixel — the scale being fitted. */
  k: number;
  rotation: Rotation;
  flippedH: boolean;
  flippedV: boolean;
}

/** The type's canonical box on this die at the draft's scale. */
export function placementBox(p: LibraryPlacement, owner: CellType): { w: number; h: number } {
  return { w: owner.cropRect.width * p.k, h: owner.cropRect.height * p.k };
}

/** Axis-aligned die footprint (a quarter turn swaps the extent). */
export function placementFootprint(p: LibraryPlacement, owner: CellType): Rect {
  const { w, h } = placementBox(p, owner);
  const quarter = p.rotation === 90 || p.rotation === 270;
  const fw = quarter ? h : w;
  const fh = quarter ? w : h;
  return { x: p.cx - fw / 2, y: p.cy - fh / 2, width: fw, height: fh };
}

/** Footprint corners, clockwise from the top-left. */
export function rectCornerPoints(r: Rect): Point[] {
  return [
    { x: r.x, y: r.y },
    { x: r.x + r.width, y: r.y },
    { x: r.x + r.width, y: r.y + r.height },
    { x: r.x, y: r.y + r.height }
  ];
}

/**
 * Scale the draft by dragging footprint corner `corner` (index into
 * `rectCornerPoints`) towards `to`, the opposite corner pinned. Uniform: the
 * pointer is projected onto the box diagonal, so the aspect never changes.
 * Never shrinks below `minPx` on the short side.
 */
export function resizeFromCorner(
  p: LibraryPlacement,
  owner: CellType,
  corner: number,
  to: Point,
  minPx = 4
): LibraryPlacement {
  const fp = placementFootprint(p, owner);
  const corners = rectCornerPoints(fp);
  const anchor = corners[(corner + 2) % 4];
  const dx = corners[corner].x - anchor.x;
  const dy = corners[corner].y - anchor.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return p;
  const t = Math.max(
    ((to.x - anchor.x) * dx + (to.y - anchor.y) * dy) / len2,
    minPx / Math.max(1e-9, Math.min(fp.width, fp.height))
  );
  return { ...p, k: p.k * t, cx: anchor.x + (dx * t) / 2, cy: anchor.y + (dy * t) / 2 };
}

/** The cell a draft places: the type's owner named, orientation as drafted,
 *  origin on whole pixels. */
export function placementCell(
  p: LibraryPlacement,
  owner: CellType,
  ownerDieId: string,
  id: string
): Cell {
  const { w, h } = placementBox(p, owner);
  const cell: Cell = {
    id,
    cellTypeId: p.typeId,
    cellTypeDieId: ownerDieId,
    x: Math.round(p.cx - w / 2),
    y: Math.round(p.cy - h / 2),
    merged: true
  };
  if (p.rotation) cell.rotation = p.rotation;
  if (p.flippedH) cell.flippedH = true;
  if (p.flippedV) cell.flippedV = true;
  return cell;
}
