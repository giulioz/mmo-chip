import type { Cell } from "shared";

/**
 * Point `ctx` — currently in a cell's canonical frame (origin at the W×H
 * box's top-left) — at die coordinates, so whatever is drawn next in die
 * pixels (the instance's crop, die-viewer wires / vias, ML vias) lands where
 * it sits inside this instance. It is the inverse of the placement
 * orientation (`toCanonical` in lib/geometry.ts): move the footprint centre
 * onto the box centre, un-rotate, un-flip. Callers save / restore around it.
 */
export function enterCellDieFrame(
  ctx: CanvasRenderingContext2D,
  cell: Pick<Cell, "x" | "y" | "flippedH" | "flippedV" | "rotation">,
  boxW: number,
  boxH: number
): void {
  ctx.translate(boxW / 2, boxH / 2);
  ctx.scale(cell.flippedH ? -1 : 1, cell.flippedV ? -1 : 1);
  ctx.rotate((-(cell.rotation ?? 0) * Math.PI) / 180);
  ctx.translate(-cell.x - boxW / 2, -cell.y - boxH / 2);
}
