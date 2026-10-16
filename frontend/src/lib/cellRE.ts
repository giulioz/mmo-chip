import type {
  Cell,
  CellType,
  DieAnnotations,
  LayerShape,
  LayerType
} from "shared";
import { parseShapeKey, type CellREClipboardItem } from "../state/cellRE";

/**
 * Cells-RE-page-specific glue. Generic LayerShape geometry / mutation / action
 * builders live in `lib/cellLayers.ts`; this file only handles things tied to
 * the RE page's selection / clipboard model (which knows about layer-keyed
 * `${layer}:${shapeId}` selection ids — that convention lives next to the
 * store, not in the generic layer helpers).
 */

// ── Resolve the active cell ──────────────────────────────────────────

/** Resolve the page's `activeCellTypeId` / `activeCellId` pair to the actual
 *  entities. When `cellId` is set but stale (different type or removed), or
 *  not set at all, falls back to the type's first member. Returns
 *  `cell == null` only when the type genuinely has no instances yet. */
export function resolveActiveCell(
  annotations: DieAnnotations,
  cellTypeId: string | null,
  cellId: string | null
): { cellType: CellType | null; cell: Cell | null } {
  const cellType = cellTypeId
    ? (annotations.cellTypes.find((c) => c.id === cellTypeId) ?? null)
    : null;
  if (!cellType) return { cellType: null, cell: null };
  const cell =
    (cellId
      ? annotations.cells.find(
          (c) => c.id === cellId && c.cellTypeId === cellType.id
        )
      : null) ??
    annotations.cells.find((c) => c.cellTypeId === cellType.id) ??
    null;
  return { cellType, cell };
}

// ── Selection ────────────────────────────────────────────────────────

/** The selected shapes (keyed `${layer}:${id}`) as they stand in the cell
 *  type; keys that no longer resolve are skipped. */
export function selectedShapes(
  cellType: CellType,
  selectedKeys: Iterable<string>
): Array<{ layer: LayerType; shape: LayerShape }> {
  const out: Array<{ layer: LayerType; shape: LayerShape }> = [];
  for (const key of selectedKeys) {
    const p = parseShapeKey(key);
    const shape = p ? cellType.layers?.[p.layer]?.find((s) => s.id === p.id) : undefined;
    if (p && shape) out.push({ layer: p.layer, shape });
  }
  return out;
}

// ── Clipboard ────────────────────────────────────────────────────────

/** Pixel offset applied to pasted shapes so a duplicate doesn't sit on top
 *  of the original (the pasted shapes are auto-selected so the user can drag
 *  immediately). */
export const PASTE_OFFSET = 10;

/** Collect the selected shapes (keyed `${layer}:${id}`) into a clipboard
 *  snapshot. Deep-cloned so a later edit on the source cell-type can't
 *  silently mutate the pasted shapes. */
export function snapshotForClipboard(
  cellType: CellType,
  selectedKeys: Set<string>
): CellREClipboardItem[] {
  if (!cellType.layers) return [];
  const out: CellREClipboardItem[] = [];
  for (const [layer, shapes] of Object.entries(cellType.layers) as Array<
    [LayerType, LayerShape[] | undefined]
  >) {
    if (!shapes) continue;
    for (const s of shapes) {
      if (selectedKeys.has(`${layer}:${s.id}`)) {
        out.push({ layer, shape: structuredClone(s) });
      }
    }
  }
  return out;
}
