import type { Annotation } from "../layers/AnnotationLayer";
import { AnnotationLayer } from "../layers/AnnotationLayer";
import {
  cellFootprint,
  mlCellId,
  type Proposal
} from "../../lib/cellDetection";
import {
  CELL_OUTLINE_PX,
  PICK,
  SELECT_COLOR,
  SELECT_FILL
} from "./style";

/** Kind tag for visibility filtering. */
export const ML_CELL_KIND = "ml-cell";

/** Pink — distinct from cells (white), ML vias (green), nets (blue) and the
 *  amber selection accent. */
export const COLOR_ML_CELL = "#f472b6";
const FILL = "rgba(244, 114, 182, 0.12)";
const STROKE = "rgba(244, 114, 182, 0.9)";
/** Below this zoom the score label is unreadable — skip it. */
const LABEL_MIN_ZOOM = 0.35;

/**
 * Die-overlay annotation for one ML cell proposal: the oriented footprint as
 * a dashed pink box with its confidence in the corner. Pick priority matches
 * real cells; proposals never overlap real cells (filtered out upstream), so
 * a click on a proposal is unambiguous.
 */
export function buildCellDetectionAnnotation(p: Proposal): Annotation {
  const { cell, cellType, detection } = p;
  const w = cellType.cropRect.width;
  const h = cellType.cropRect.height;
  const bbox = cellFootprint(cell, cellType);
  const label = detection.score.toFixed(2);

  return {
    id: mlCellId(detection.id),
    kind: ML_CELL_KIND,
    pickPriority: PICK.cell,
    bbox,
    draw(ctx, bounds, state) {
      const z = bounds.zoom;
      ctx.save();
      ctx.translate(cell.x + w / 2, cell.y + h / 2);
      ctx.rotate(((cell.rotation ?? 0) * Math.PI) / 180);
      ctx.scale(cell.flippedH ? -1 : 1, cell.flippedV ? -1 : 1);
      ctx.translate(-w / 2, -h / 2);

      ctx.fillStyle = state.selected ? SELECT_FILL : FILL;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = state.selected ? SELECT_COLOR : STROKE;
      ctx.lineWidth = (state.selected ? CELL_OUTLINE_PX + 1 : CELL_OUTLINE_PX) / z;
      ctx.setLineDash(state.selected ? [] : [6 / z, 4 / z]);
      ctx.strokeRect(0, 0, w, h);
      ctx.setLineDash([]);
      ctx.restore();

      if (z >= LABEL_MIN_ZOOM) {
        // Screen-constant label at the footprint's top-left, unrotated so it
        // stays readable whatever the instance orientation.
        const px = 11 / z;
        ctx.save();
        ctx.font = `${px}px var(--mono, ui-monospace, monospace)`;
        ctx.textBaseline = "top";
        const padX = 3 / z;
        const padY = 1.5 / z;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = state.selected ? SELECT_COLOR : STROKE;
        ctx.fillRect(bbox.x, bbox.y, tw + padX * 2, px + padY * 2);
        ctx.fillStyle = "#1a1020";
        ctx.fillText(label, bbox.x + padX, bbox.y + padY);
        ctx.restore();
      }
    }
  };
}

/** Rebuild the proposal layer from scratch (results are few thousand at
 *  most; rbush bulk-inserts are cheap). */
export function populateCellDetectionLayer(
  layer: AnnotationLayer,
  proposals: ReadonlyArray<Proposal>
): void {
  layer.clear();
  for (const p of proposals) layer.add(buildCellDetectionAnnotation(p));
}
