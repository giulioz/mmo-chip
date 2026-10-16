import type {
  AnnotationRect,
  CellLayers,
  CellType,
  DieSummary,
  LayerShape,
  LayerType
} from "./types.js";

/**
 * Cell libraries: dies that share a library reuse each other's cell types.
 * A type stays owned by (stored in) one die; another die places it through
 * `Cell.cellTypeDieId` and sees it at the ratio of the two dies' scales. Pure
 * helpers shared by the backend (detection, crops) and the frontend.
 */

/** Longest library name accepted. */
export const MAX_CELL_LIBRARY_NAME = 80;

/** A die's pixels per library unit (absent ⇒ 1). */
export function cellScaleOf(die: Pick<DieSummary, "cellScale"> | null | undefined): number {
  const s = die?.cellScale;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? s : 1;
}

/** `target` pixels per `owner` pixel: what an owner-drawn type is multiplied
 *  by to sit on the target die. */
export function libraryRatio(
  target: Pick<DieSummary, "cellScale"> | null | undefined,
  owner: Pick<DieSummary, "cellScale"> | null | undefined
): number {
  return cellScaleOf(target) / cellScaleOf(owner);
}

/** Canonical library name: trimmed, inner whitespace collapsed; empty ⇒
 *  null (no library). */
export function normalizeCellLibrary(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const out = name.trim().replace(/\s+/g, " ");
  return out ? out.slice(0, MAX_CELL_LIBRARY_NAME) : null;
}

/** Undo float noise from a scale round trip (232 × r ÷ r = 232.00000000003). */
function tidy(v: number): number {
  const r = Math.round(v);
  return Math.abs(v - r) < 1e-6 ? r : v;
}

export function scaleRect(r: AnnotationRect, k: number): AnnotationRect {
  return { x: tidy(r.x * k), y: tidy(r.y * k), width: tidy(r.width * k), height: tidy(r.height * k) };
}

/** A layer shape resized by `k` about the cell's origin — positions and
 *  sizes (line width, point size, circle radius) alike. Same id / metadata. */
export function scaleShape(s: LayerShape, k: number): LayerShape {
  const m = (v: number) => tidy(v * k);
  switch (s.kind) {
    case "rect":
      return { ...s, x: m(s.x), y: m(s.y), width: m(s.width), height: m(s.height) };
    case "line":
      return { ...s, x1: m(s.x1), y1: m(s.y1), x2: m(s.x2), y2: m(s.y2), width: m(s.width) };
    case "point":
      return { ...s, x: m(s.x), y: m(s.y), size: m(s.size) };
    case "circle":
      return { ...s, x: m(s.x), y: m(s.y), radius: m(s.radius) };
    case "polygon":
      return { ...s, points: s.points.map((p) => ({ x: m(p.x), y: m(p.y) })) };
  }
}

export function scaleLayers(layers: CellLayers, k: number): CellLayers {
  const out: CellLayers = {};
  for (const [layer, shapes] of Object.entries(layers) as Array<[LayerType, LayerShape[] | undefined]>) {
    if (shapes) out[layer] = shapes.map((s) => scaleShape(s, k));
  }
  return out;
}

/** A cell type as it sits on a die whose pixels are `k` times the owner's:
 *  box and layer shapes scaled together. The same object when `k` is 1. */
export function scaleCellType(ct: CellType, k: number): CellType {
  if (k === 1) return ct;
  const out: CellType = { ...ct, cropRect: scaleRect(ct.cropRect, k) };
  if (ct.layers) out.layers = scaleLayers(ct.layers, k);
  return out;
}
