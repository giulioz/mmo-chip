import type {
  Cell,
  CellDetection,
  CellDetectionResult,
  CellPlacementScore,
  CellType,
  DieAnnotations
} from "shared";
import { applyOrientation, polygonBounds, type Rect } from "./geometry";

/**
 * Pure helpers over cell-detection results ("ML cells" / proposals).
 *
 * A proposal is a `CellDetection` that is still worth showing: above the
 * confidence threshold, not dismissed, its type still exists, and not sitting
 * on top of an already-placed cell. That last filter is what makes approval
 * stateless — approving creates a real cell at the same spot, so the
 * proposal disappears on its own (and comes back if the approval is undone).
 */

export const ML_CELL_PREFIX = "ml-cell:";

/** Selection / virtual-cell id for a detection. */
export function mlCellId(detectionId: string): string {
  return `${ML_CELL_PREFIX}${detectionId}`;
}

export function isMlCellId(id: string): boolean {
  return id.startsWith(ML_CELL_PREFIX);
}

export function parseMlCellId(id: string): string | null {
  return isMlCellId(id) ? id.slice(ML_CELL_PREFIX.length) : null;
}

/** Local (unsaved) orientation / position tweaks applied to a proposal while
 *  it's being aligned in merge-cells. */
export interface ProposalOverride {
  x?: number;
  y?: number;
  flippedH?: boolean;
  flippedV?: boolean;
  rotation?: 0 | 90 | 180 | 270;
}

/** A detection as a virtual `Cell` (id prefixed) so cell-shaped UI can show
 *  it without a persisted instance. Falsy orientation fields are omitted to
 *  match the persisted-cell convention. */
export function detectionToCell(
  det: CellDetection,
  override?: ProposalOverride
): Cell {
  const cell: Cell = {
    id: mlCellId(det.id),
    cellTypeId: det.cellTypeId,
    x: override?.x ?? det.x,
    y: override?.y ?? det.y
  };
  const flippedH = override?.flippedH ?? det.flippedH;
  const flippedV = override?.flippedV ?? det.flippedV;
  const rotation = override?.rotation ?? det.rotation;
  if (flippedH) cell.flippedH = true;
  if (flippedV) cell.flippedV = true;
  if (rotation) cell.rotation = rotation;
  return cell;
}

/** Axis-aligned die footprint of a placed cell (same math as the die-viewer
 *  cell renderer: orient the W×H box about its centre, then offset). */
export function cellFootprint(
  cell: Pick<Cell, "x" | "y" | "flippedH" | "flippedV" | "rotation">,
  cellType: Pick<CellType, "cropRect">
): Rect {
  const w = cellType.cropRect.width;
  const h = cellType.cropRect.height;
  const corners = [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h }
  ].map((p) => applyOrientation(p, cell, w, h));
  const b = polygonBounds(corners) ?? { x: 0, y: 0, width: w, height: h };
  return { x: cell.x + b.x, y: cell.y + b.y, width: b.width, height: b.height };
}

/** Fraction of `a`'s area covered by `b` (0..1). */
export function overlapFraction(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  const own = Math.max(a.width, 1e-9) * Math.max(a.height, 1e-9);
  return (w * h) / own;
}

/** A proposal overlapping an existing cell by more than this fraction of its
 *  own footprint is hidden (mirrors the backend's run-time exclusion). When a
 *  run allowed overlaps, only near-duplicates of the type's own placed cells
 *  are hidden — which is still what makes an approved proposal disappear. */
export const PROPOSAL_OVERLAP_HIDE = 0.3;
export const PROPOSAL_OVERLAP_HIDE_SAME_TYPE = 0.6;

export interface Proposal {
  detection: CellDetection;
  /** Virtual cell (`ml-cell:` id) at the detection's placement. */
  cell: Cell;
  cellType: CellType;
  result: CellDetectionResult;
}

export interface ProposalFilter {
  /** Minimum `score` (0..1). */
  threshold: number;
  /** Include user-dismissed detections. Default false. */
  includeDismissed?: boolean;
}

/**
 * Every detection worth showing right now, sorted by descending score.
 * Cheap enough to recompute on each annotations / threshold change: a few
 * thousand detections × placed cells rect checks.
 */
export function proposalsFor(
  results: ReadonlyArray<CellDetectionResult>,
  annotations: DieAnnotations,
  filter: ProposalFilter
): Proposal[] {
  const typeById = new Map(annotations.cellTypes.map((ct) => [ct.id, ct]));
  const existing: { rect: Rect; typeId: string }[] = [];
  const membersByType = new Map<string, Cell[]>();
  for (const c of annotations.cells) {
    const ct = typeById.get(c.cellTypeId);
    if (ct) existing.push({ rect: cellFootprint(c, ct), typeId: ct.id });
    const list = membersByType.get(c.cellTypeId);
    if (list) list.push(c);
    else membersByType.set(c.cellTypeId, [c]);
  }
  const out: Proposal[] = [];
  for (const result of results) {
    const cellType = typeById.get(result.cellTypeId);
    if (!cellType) continue;
    // Found in the type's old frame (it was flipped / turned since): those
    // placements would land mirrored or rotated — wait for a re-run.
    if (!sameFrame(result.memberSignature, membersByType.get(cellType.id) ?? [])) continue;
    const dismissed = new Set(result.dismissed ?? []);
    const avoidAny = result.options?.avoidExistingCells !== false;
    const bar = avoidAny ? PROPOSAL_OVERLAP_HIDE : PROPOSAL_OVERLAP_HIDE_SAME_TYPE;
    for (const detection of result.detections) {
      if (detection.score < filter.threshold) continue;
      if (!filter.includeDismissed && dismissed.has(detection.id)) continue;
      const cell = detectionToCell(detection);
      const fp = cellFootprint(cell, cellType);
      let clash = false;
      for (const e of existing) {
        if (!avoidAny && e.typeId !== cellType.id) continue;
        if (overlapFraction(fp, e.rect) > bar) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      out.push({ detection, cell, cellType, result });
    }
  }
  out.sort((a, b) => b.detection.score - a.detection.score);
  return out;
}

/** Same fingerprint the backend stamps into a result — a mismatch with the
 *  live members means the template may no longer describe the type. */
export function memberSignature(
  members: ReadonlyArray<Pick<Cell, "id" | "x" | "y" | "flippedH" | "flippedV" | "rotation">>
): string {
  return members
    .map((m) => `${m.id}:${Math.round(m.x)}:${Math.round(m.y)}:${orientCode(m)}`)
    .sort()
    .join("|");
}

/** A member's orientation as a signature records it (flips, then rotation). */
function orientCode(m: Pick<Cell, "flippedH" | "flippedV" | "rotation">): string {
  return `${m.flippedH ? 1 : 0}${m.flippedV ? 1 : 0}${m.rotation ?? 0}`;
}

/**
 * Whether data built from a type's members (a clean specimen, a detection
 * template — `signature` is `memberSignature` at build time) is still in the
 * type's current frame. Turning or flipping the whole type re-orients every
 * member at once, so none of the members it was built from kept its
 * orientation; re-aligning, adding or fixing single members doesn't count.
 */
export function sameFrame(
  signature: string | undefined,
  members: ReadonlyArray<Pick<Cell, "id" | "flippedH" | "flippedV" | "rotation">>
): boolean {
  if (!signature) return true;
  const then = new Map<string, string>();
  for (const entry of signature.split("|")) {
    const parts = entry.split(":");
    if (parts.length >= 4) then.set(parts[0], parts[parts.length - 1]);
  }
  let shared = 0;
  for (const m of members) {
    const was = then.get(m.id);
    if (was === undefined) continue;
    if (was === orientCode(m)) return true;
    shared += 1;
  }
  return shared === 0;
}

/** True when the type's members changed since the result was computed
 *  (approving proposals into the type counts — the template could now be
 *  averaged over more members). */
export function resultIsStale(
  result: CellDetectionResult,
  annotations: DieAnnotations
): boolean {
  if (!result.memberSignature) return false;
  const members = annotations.cells.filter((c) => c.cellTypeId === result.cellTypeId);
  return memberSignature(members) !== result.memberSignature;
}

/** Per-member template scores from the latest run of each type, keyed by
 *  cell id. Lets merge-cells rank a type's members worst-first. */
export function memberScoreMap(
  results: ReadonlyArray<CellDetectionResult>
): Map<string, CellPlacementScore> {
  const out = new Map<string, CellPlacementScore>();
  for (const r of results) {
    for (const [cellId, s] of Object.entries(r.memberScores ?? {})) out.set(cellId, s);
  }
  return out;
}

/** Ascending-score order (unscored cells last, then by id for stability). */
export function compareByMemberScore(
  scores: ReadonlyMap<string, CellPlacementScore>
): (a: Pick<Cell, "id">, b: Pick<Cell, "id">) => number {
  return (a, b) => {
    const sa = scores.get(a.id)?.score;
    const sb = scores.get(b.id)?.score;
    if (sa === undefined && sb === undefined) return a.id.localeCompare(b.id);
    if (sa === undefined) return 1;
    if (sb === undefined) return -1;
    return sa - sb || a.id.localeCompare(b.id);
  };
}

/** Crop URL for a proposal thumbnail (no cell id to key on — crop by rect). */
export function rectCropUrl(
  dieId: string,
  x: number,
  y: number,
  w: number,
  h: number
): string {
  const q = new URLSearchParams({
    x: String(Math.max(0, Math.round(x))),
    y: String(Math.max(0, Math.round(y))),
    w: String(Math.round(w)),
    h: String(Math.round(h))
  });
  return `/api/dies/${dieId}/crop?${q.toString()}`;
}
