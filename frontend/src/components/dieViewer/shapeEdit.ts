import type { DieAnnotations } from "shared";
import type { AnnotationAction } from "../../api/actions";
import {
  polyVertexAt,
  rectCornerAt,
  rectCorners,
  rectFromPoints,
  type Point,
  type Rect
} from "../../lib/geometry";
import {
  buildAnnotation,
  buildBlock,
  buildIgnore,
  buildRoiRect
} from "../../renderer/annotations/dieAnnotations";
import type { Annotation, AnnotationLayer } from "../../renderer/layers/AnnotationLayer";
import type { DragHandler } from "../../renderer/interaction";

/**
 * A selected rect-like / polygon ML entity that supports in-canvas geometry
 * editing (corner-resize + body-move for rects; per-vertex + body-move for
 * polygons). `rebuild` produces the annotation for a live `layer.update`;
 * `toAction` produces the undoable upsert (carrying the previous state).
 * via *points* are intentionally not editable here (nothing to grab).
 */
/** Live geometry of the shape currently being dragged, so the handles
 *  overlay can track the cursor (committed state lags until release). */
export type EditPreview =
  | { kind: "rect"; rect: Rect }
  | { kind: "poly"; points: Point[] };

export type EditableShape =
  | {
      kind: "rect";
      rect: Rect;
      rebuild: (r: Rect) => Annotation;
      toAction: (r: Rect) => AnnotationAction;
    }
  | {
      kind: "poly";
      points: Point[];
      rebuild: (p: Point[]) => Annotation;
      toAction: (p: Point[]) => AnnotationAction;
    };

const rRect = (r: Rect): Rect => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  width: Math.round(r.width),
  height: Math.round(r.height)
});

export function resolveEditable(
  id: string,
  ann: DieAnnotations
): EditableShape | null {
  const ci = id.indexOf(":");
  if (ci < 0) return null;
  const prefix = id.slice(0, ci);
  const eid = id.slice(ci + 1);

  if (prefix === "anno") {
    const a = ann.annotations?.find((x) => x.id === eid);
    if (!a) return null;
    if (a.geometry.kind === "rectangle") {
      const g = a.geometry;
      return {
        kind: "rect",
        rect: { x: g.x, y: g.y, width: g.width, height: g.height },
        rebuild: (r) =>
          buildAnnotation({
            ...a,
            geometry: { kind: "rectangle", x: r.x, y: r.y, width: r.width, height: r.height }
          })!,
        toAction: (r) => {
          const n = rRect(r);
          return {
            kind: "upsertAnnotation",
            annotation: {
              ...a,
              geometry: { kind: "rectangle", x: n.x, y: n.y, width: n.width, height: n.height }
            },
            prevAnnotation: a
          };
        }
      };
    }
    if (a.geometry.kind === "polygon") {
      return {
        kind: "poly",
        points: a.geometry.points.map((p) => ({ ...p })),
        rebuild: (pts) =>
          buildAnnotation({ ...a, geometry: { kind: "polygon", points: pts } })!,
        toAction: (pts) => ({
          kind: "upsertAnnotation",
          annotation: {
            ...a,
            geometry: {
              kind: "polygon",
              points: pts.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) }))
            }
          },
          prevAnnotation: a
        })
      };
    }
    return null; // point_via — not corner/vertex editable
  }

  if (prefix === "roi") {
    const r0 = ann.rois?.find((x) => x.id === eid);
    if (!r0) return null;
    return {
      kind: "rect",
      rect: { x: r0.x, y: r0.y, width: r0.width, height: r0.height },
      rebuild: (r) => buildRoiRect({ ...r0, ...r }),
      toAction: (r) => ({
        kind: "upsertRoi",
        roi: { ...r0, ...rRect(r) },
        prevRoi: r0
      })
    };
  }

  if (prefix === "ignore") {
    const i0 = ann.ignores?.find((x) => x.id === eid);
    if (!i0) return null;
    return {
      kind: "rect",
      rect: { x: i0.x, y: i0.y, width: i0.width, height: i0.height },
      rebuild: (r) => buildIgnore({ ...i0, ...r }),
      toAction: (r) => ({
        kind: "upsertIgnore",
        ignore: { ...i0, ...rRect(r) },
        prevIgnore: i0
      })
    };
  }

  if (prefix === "block") {
    const b0 = ann.blocks?.find((x) => x.id === eid);
    if (!b0) return null;
    return {
      kind: "rect",
      rect: { x: b0.x, y: b0.y, width: b0.width, height: b0.height },
      rebuild: (r) => buildBlock({ ...b0, ...r }),
      toAction: (r) => ({
        kind: "upsertBlock",
        block: { ...b0, ...rRect(r) },
        prevBlock: b0
      })
    };
  }

  return null;
}

/**
 * Build the select-tool drag handler for an editable shape: grab a corner /
 * vertex to reshape, or the body to move; live-preview via `layer.update`,
 * commit one undoable upsert on release, no-op (just select) on a plain click.
 */
export function shapeDragHandler(opts: {
  ed: EditableShape;
  worldDown: Point;
  tolWorld: number;
  layer: AnnotationLayer;
  dispatch: (a: AnnotationAction) => void;
  selectPart: () => void;
  selectOnClick: (shift: boolean) => void;
  /** Live geometry while dragging (handles overlay tracks the cursor). */
  onPreview?: (p: EditPreview | null) => void;
}): DragHandler {
  const {
    ed,
    worldDown,
    tolWorld,
    layer,
    dispatch,
    selectPart,
    selectOnClick,
    onPreview
  } = opts;

  if (ed.kind === "rect") {
    const corner = rectCornerAt(ed.rect, worldDown, tolWorld);
    const fixed =
      corner != null ? rectCorners(ed.rect)[(corner + 2) % 4] : null;
    const next = (wp: Point, sw: Point): Rect =>
      fixed
        ? rectFromPoints(fixed, wp)
        : {
            x: ed.rect.x + (wp.x - sw.x),
            y: ed.rect.y + (wp.y - sw.y),
            width: ed.rect.width,
            height: ed.rect.height
          };
    return {
      onDragStart: selectPart,
      onDragMove: ({ worldPoint, startWorld }) => {
        const r = next(worldPoint, startWorld);
        layer.update(ed.rebuild(r));
        onPreview?.({ kind: "rect", rect: r });
      },
      onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
        onPreview?.(null);
        if (!dragged) {
          selectOnClick(modifiers.shift);
          return;
        }
        dispatch(ed.toAction(next(worldPoint, startWorld)));
      },
      onCancel: () => {
        layer.update(ed.rebuild(ed.rect));
        onPreview?.(null);
      }
    };
  }

  const vIdx = polyVertexAt(ed.points, worldDown, tolWorld);
  const next = (wp: Point, sw: Point): Point[] =>
    vIdx != null
      ? ed.points.map((p, i) => (i === vIdx ? { x: wp.x, y: wp.y } : p))
      : ed.points.map((p) => ({
          x: p.x + (wp.x - sw.x),
          y: p.y + (wp.y - sw.y)
        }));
  return {
    onDragStart: selectPart,
    onDragMove: ({ worldPoint, startWorld }) => {
      const pts = next(worldPoint, startWorld);
      layer.update(ed.rebuild(pts));
      onPreview?.({ kind: "poly", points: pts });
    },
    onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
      onPreview?.(null);
      if (!dragged) {
        selectOnClick(modifiers.shift);
        return;
      }
      dispatch(ed.toAction(next(worldPoint, startWorld)));
    },
    onCancel: () => {
      layer.update(ed.rebuild(ed.points));
      onPreview?.(null);
    }
  };
}
