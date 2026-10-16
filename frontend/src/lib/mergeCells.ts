import type { Cell, CellPlacementScore, CellType, DieAnnotations } from "shared";
import type { AnnotationAction } from "../api/actions";
import {
  compareByMemberScore,
  detectionToCell,
  type Proposal,
  type ProposalOverride
} from "./cellDetection";
import { mapLayerPoints, mirrorAbout, rotateLayers } from "./cellLayers";

// ── Orientation ──────────────────────────────────────────────────────

export type Rotation = 0 | 90 | 180 | 270;

export interface Orient {
  flippedH: boolean;
  flippedV: boolean;
  rotation: Rotation;
}

export function orientOf(cell: Cell): Orient {
  return {
    flippedH: cell.flippedH === true,
    flippedV: cell.flippedV === true,
    rotation: (cell.rotation ?? 0) as Rotation
  };
}

/**
 * The orientation that shows an instance's canonical view turned a quarter
 * turn about its centre (`deg` 90 = clockwise on screen, −90 = counter-
 * clockwise). Placement is `O = R(θ)·S` (mirror, then rotate) and the view
 * is `O⁻¹`, so turning the view by `deg` means `O' = O·R(−deg)`. Moving that
 * rotation past the mirror flips its sign under a single reflection
 * (`S·R(φ) = R(−φ)·S`); no flip, or both (a half turn), commute with it.
 */
export function rotateView<T extends Orient>(o: T, deg: 90 | -90): T {
  const step = o.flippedH !== o.flippedV ? deg : -deg;
  return { ...o, rotation: ((((o.rotation + step) % 360) + 360) % 360) as Rotation };
}

export type DieOrientOp = "rotateCw" | "rotateCcw" | "flipH" | "flipV";

/**
 * The orientation after turning or mirroring a placed instance as it lies on
 * the die (what the die viewer shows), about its footprint centre. Placement
 * is `O = R(θ)·S`, so a turn composes as `R(±90)·O`, and a mirror `M` gives
 * `M·R(θ)·S = R(−θ)·M·S`: the flip toggles and the rotation reverses.
 */
export function orientOnDie<T extends Orient>(o: T, op: DieOrientOp): T {
  const norm = (r: number) => (((r % 360) + 360) % 360) as Rotation;
  switch (op) {
    case "rotateCw":
      return { ...o, rotation: norm(o.rotation + 90) };
    case "rotateCcw":
      return { ...o, rotation: norm(o.rotation - 90) };
    case "flipH":
      return { ...o, flippedH: !o.flippedH, rotation: norm(-o.rotation) };
    case "flipV":
      return { ...o, flippedV: !o.flippedV, rotation: norm(-o.rotation) };
  }
}

// Orientations as 2×2 integer matrices ((x, y) ↦ (a·x + b·y, c·x + d·y)),
// for composing / inverting them: `O = R(θ)·S`, with R(90) = (x, y) ↦ (−y, x)
// (see `applyOrientation`) and S the mirror.
type OrientMatrix = readonly [number, number, number, number];
const TURNS: Record<Rotation, OrientMatrix> = {
  0: [1, 0, 0, 1],
  90: [0, -1, 1, 0],
  180: [-1, 0, 0, -1],
  270: [0, 1, -1, 0]
};

function orientMatrix(o: Orient): OrientMatrix {
  const [a, b, c, d] = TURNS[o.rotation];
  const sx = o.flippedH ? -1 : 1;
  const sy = o.flippedV ? -1 : 1;
  return [a * sx, b * sy, c * sx, d * sy];
}

function fromMatrix(m: OrientMatrix): Orient {
  // Canonical form: at most a horizontal mirror (a vertical one is the same
  // as horizontal + a half turn).
  for (const rotation of [0, 90, 180, 270] as const) {
    for (const flippedH of [false, true]) {
      const o: Orient = { flippedH, flippedV: false, rotation };
      if (orientMatrix(o).every((v, i) => v === m[i])) return o;
    }
  }
  throw new Error(`not an orientation: ${m.join(",")}`);
}

export const IDENTITY_ORIENT: Orient = { flippedH: false, flippedV: false, rotation: 0 };

/** `a·b`: apply `b`, then `a`. */
export function composeOrient(a: Orient, b: Orient): Orient {
  const [a0, a1, a2, a3] = orientMatrix(a);
  const [b0, b1, b2, b3] = orientMatrix(b);
  return fromMatrix([a0 * b0 + a1 * b2, a0 * b1 + a1 * b3, a2 * b0 + a3 * b2, a2 * b1 + a3 * b3]);
}

export function invertOrient(o: Orient): Orient {
  const [a, b, c, d] = orientMatrix(o);
  return fromMatrix([a, c, b, d]); // orthogonal: the inverse is the transpose
}

/** `O·v` for a vector (no box, no origin). */
export function orientVector(o: Orient, v: { x: number; y: number }): { x: number; y: number } {
  const [a, b, c, d] = orientMatrix(o);
  return { x: a * v.x + b * v.y, y: c * v.x + d * v.y };
}

// ── Size / grouping helpers ──────────────────────────────────────────

export function typeSize(ct: CellType): { w: number; h: number; area: number } {
  const w = ct.cropRect.width;
  const h = ct.cropRect.height;
  return { w, h, area: w * h };
}

/**
 * Distance between two cell-type footprints, resilient to 90° rotation and
 * flips: we compare the *unordered* {short, long} side pair plus the area, so
 * a tall cell and the same cell rotated 90° score as identical. Lower = more
 * likely the same cell — that's the candidate sort order.
 */
export function sizeDistance(a: CellType, b: CellType): number {
  const sa = typeSize(a);
  const sb = typeSize(b);
  const aMin = Math.min(sa.w, sa.h);
  const aMax = Math.max(sa.w, sa.h);
  const bMin = Math.min(sb.w, sb.h);
  const bMax = Math.max(sb.w, sb.h);
  const dimDiff = Math.abs(aMin - bMin) + Math.abs(aMax - bMax);
  // Normalise the area term so it's comparable to pixel dim diffs.
  const areaDiff = Math.abs(sa.area - sb.area) / Math.max(aMax, bMax, 1);
  return dimDiff + areaDiff;
}

const byName = (a: CellType, b: CellType) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

export interface GroupedTypes {
  matched: CellType[];
  unmatched: CellType[];
}

export function groupCellTypes(annotations: DieAnnotations): GroupedTypes {
  const matched: CellType[] = [];
  const unmatched: CellType[] = [];
  for (const ct of annotations.cellTypes) {
    if (ct.matched === true) matched.push(ct);
    else unmatched.push(ct);
  }
  matched.sort(byName);
  unmatched.sort(byName);
  return { matched, unmatched };
}

export function membersOf(annotations: DieAnnotations, typeId: string): Cell[] {
  return annotations.cells.filter((c) => c.cellTypeId === typeId);
}

export function cellTypeById(
  annotations: DieAnnotations,
  id: string | null | undefined
): CellType | null {
  if (!id) return null;
  return annotations.cellTypes.find((ct) => ct.id === id) ?? null;
}

export function cellById(
  annotations: DieAnnotations,
  id: string | null | undefined
): Cell | null {
  if (!id) return null;
  return annotations.cells.find((c) => c.id === id) ?? null;
}

/**
 * The reference cell shown as the fixed specimen: the explicitly-selected
 * member, else the first member of the specimen type. Null when the type has
 * no member cells yet (caller falls back to the cell-type crop template).
 */
export function resolveSpecimenCell(
  annotations: DieAnnotations,
  specimenTypeId: string | null,
  specimenCellId: string | null
): Cell | null {
  if (!specimenTypeId) return null;
  if (specimenCellId) {
    const sel = cellById(annotations, specimenCellId);
    if (sel && sel.cellTypeId === specimenTypeId) return sel;
  }
  return membersOf(annotations, specimenTypeId)[0] ?? null;
}

export interface Candidate {
  cell: Cell;
  cellType: CellType;
  /** Already merged into the active specimen (shows the green check, pinned
   *  to the front of the list). */
  done: boolean;
  /** Present when this candidate is an ML cell proposal rather than a placed
   *  cell — `cell` is then virtual (`ml-cell:` id) and approval creates it. */
  proposal?: Proposal;
  /** For members of the specimen type: how well this placed cell matches the
   *  type's via template (from the latest detection run). Low = suspect. */
  memberScore?: CellPlacementScore;
  /** Present when this candidate is a whole cell type to merge with the
   *  specimen's — `cell` is then virtual (`type:` id, see
   *  `typeCandidateId`) and `cellType` is that type. */
  mergeType?: { source: TypeCandidateSource | null };
}

/** Where a whole-type candidate's pixels come from: one of its instances,
 *  on this die or (not placed here) on the die that owns it — `cellType` is
 *  the type in that die's pixels. */
export interface TypeCandidateSource {
  dieId: string;
  cell: Cell;
  cellType: CellType;
}

// Whole cell types offered as merge candidates carry a virtual cell with
// this id prefix (it names the type).
const TYPE_CANDIDATE_PREFIX = "type:";

export function typeCandidateId(cellTypeId: string): string {
  return `${TYPE_CANDIDATE_PREFIX}${cellTypeId}`;
}

/** The type a whole-type candidate id names (null for any other id). */
export function parseTypeCandidateId(id: string | null | undefined): string | null {
  return id?.startsWith(TYPE_CANDIDATE_PREFIX) ? id.slice(TYPE_CANDIDATE_PREFIX.length) : null;
}

/**
 * Every other matched cell type (this die's and, merged in, other dies' of
 * its library) as a candidate for merging into the specimen type as a whole,
 * most similar size first — sizes are in this die's pixels, so the dies'
 * scales are accounted for. `sourceFor` picks the pixels to show for each.
 */
export function typeCandidatesFor(
  annotations: DieAnnotations,
  specimenType: CellType | null,
  sourceFor: (ct: CellType) => TypeCandidateSource | null
): Candidate[] {
  if (!specimenType) return [];
  return annotations.cellTypes
    .filter((ct) => ct.matched === true && ct.id !== specimenType.id)
    .map((ct) => ({ ct, d: sizeDistance(ct, specimenType) }))
    .sort((a, b) => a.d - b.d || byName(a.ct, b.ct))
    .map(({ ct }) => ({
      cell: { id: typeCandidateId(ct.id), cellTypeId: ct.id, x: 0, y: 0 },
      cellType: ct,
      done: false,
      mergeType: { source: sourceFor(ct) }
    }));
}

/** Is this candidate / cell id an ML proposal (virtual cell)? */
export function isProposalCell(cell: Pick<Cell, "id">): boolean {
  return cell.id.startsWith("ml-cell:");
}

/**
 * All cells offered as candidates for the active specimen: every cell whose
 * type is still unmatched, plus the ones already merged into this specimen
 * (kept visible with a check). Sorted: done first, then by ascending size
 * distance to the specimen footprint.
 */
export function candidatesFor(
  annotations: DieAnnotations,
  specimenType: CellType | null,
  proposals: ReadonlyArray<Proposal> = [],
  overrides: Readonly<Record<string, ProposalOverride>> = {},
  memberScores: ReadonlyMap<string, CellPlacementScore> = new Map()
): Candidate[] {
  const typeOf = new Map(annotations.cellTypes.map((ct) => [ct.id, ct]));
  const out: Candidate[] = [];
  for (const cell of annotations.cells) {
    const ct = typeOf.get(cell.cellTypeId);
    if (!ct) continue;
    // A cell already belongs to the active specimen type (including its
    // founding / first member) → show it as done, pinned to the front.
    const inSpecimen = specimenType != null && ct.id === specimenType.id;
    const isUnmatched = ct.matched !== true;
    // Members of *other* matched (real) types aren't candidates.
    if (!inSpecimen && !isUnmatched) continue;
    out.push({
      cell,
      cellType: ct,
      done: inSpecimen,
      memberScore: inSpecimen ? memberScores.get(cell.id) : undefined
    });
  }
  const byScore = compareByMemberScore(memberScores);
  out.sort((a, b) => {
    if (a.done !== b.done) return a.done ? -1 : 1;
    // Members: worst template match first so misclassified ones surface.
    if (a.done && b.done) return byScore(a.cell, b.cell);
    if (!specimenType) return byName(a.cellType, b.cellType);
    const d = sizeDistance(a.cellType, specimenType) - sizeDistance(b.cellType, specimenType);
    if (d !== 0) return d;
    return byName(a.cellType, b.cellType);
  });
  // ML proposals for the specimen type go after the hand-placed candidates,
  // best score first (`proposals` is already sorted that way).
  if (specimenType) {
    for (const p of proposals) {
      if (p.cellType.id !== specimenType.id) continue;
      out.push({
        cell: detectionToCell(p.detection, overrides[p.detection.id]),
        cellType: p.cellType,
        done: false,
        proposal: p
      });
    }
  }
  return out;
}

/**
 * Approve an ML proposal: create a real, merged member of `specimenType` at
 * the (possibly tweaked) placement, promoting the type if needed. The
 * proposal then hides itself because it overlaps the new cell — undoing the
 * approval brings it back.
 */
export function buildApproveAction(
  specimenType: CellType,
  orient: Orient & { x: number; y: number }
): AnnotationAction {
  const cell: Cell = {
    id: newId(),
    cellTypeId: specimenType.id,
    x: Math.round(orient.x),
    y: Math.round(orient.y),
    flippedH: orient.flippedH || undefined,
    flippedV: orient.flippedV || undefined,
    rotation: orient.rotation === 0 ? undefined : orient.rotation,
    merged: true
  };
  const actions: AnnotationAction[] = [{ kind: "upsertCell", cell, prevCell: null }];
  if (specimenType.matched !== true) {
    actions.push({
      kind: "upsertCellType",
      cellType: { ...specimenType, matched: true },
      prevCellType: specimenType
    });
  }
  return actions.length === 1 ? actions[0] : { kind: "batch", actions };
}

// ── Crop URLs ────────────────────────────────────────────────────────
//
// Instances are drawn from the die's tile pyramid (`renderer/dieRegion`);
// these crop endpoints remain for callers that want a standalone image.
//
// A cell crop is the instance's die footprint (the oriented box, so a 90°
// turn swaps its extent) and the server caches it by footprint position, so
// re-aligning (which changes the cell's x/y) naturally yields a fresh crop.
// We mirror x/y — and the rotation, which reshapes the footprint without
// moving x/y — into the query so the *browser* cache busts too.

export function cellCropUrl(dieId: string, cell: Cell): string {
  const x = Math.max(0, Math.round(cell.x));
  const y = Math.max(0, Math.round(cell.y));
  const r = cell.rotation ? `&r=${cell.rotation}` : "";
  return `/api/dies/${dieId}/cells/${cell.id}/crop?x=${x}&y=${y}${r}`;
}

export function cellTypeCropUrl(dieId: string, cellTypeId: string): string {
  return `/api/dies/${dieId}/cell-types/${cellTypeId}/crop`;
}

// ── Action builders ──────────────────────────────────────────────────

const newId = () => crypto.randomUUID();

export interface MergePlan {
  action: AnnotationAction;
  /** The candidate's current type carries layer annotations the merge would
   *  detach (the target has none) — surface a confirm before dispatching. */
  losesAnnotations: boolean;
}

function hasLayerShapes(ct: CellType | null): boolean {
  if (!ct || !ct.layers) return false;
  return Object.values(ct.layers).some((s) => s != null && s.length > 0);
}

/**
 * Re-type `candidate` into `specimenType` with the given orientation/position,
 * promote the specimen to a matched type, and clean up the candidate's now
 * orphaned placeholder type. One batched (single-undo) action.
 */
export function buildMergeAction(
  annotations: DieAnnotations,
  candidate: Cell,
  specimenType: CellType,
  orient: Orient & { x: number; y: number }
): MergePlan {
  const prevCell = candidate;
  const prevType = cellTypeById(annotations, candidate.cellTypeId);

  const nextCell: Cell = {
    ...candidate,
    cellTypeId: specimenType.id,
    x: Math.round(orient.x),
    y: Math.round(orient.y),
    flippedH: orient.flippedH || undefined,
    flippedV: orient.flippedV || undefined,
    rotation: orient.rotation === 0 ? undefined : orient.rotation,
    merged: true
  };

  const actions: AnnotationAction[] = [
    { kind: "upsertCell", cell: nextCell, prevCell }
  ];

  if (specimenType.matched !== true) {
    actions.push({
      kind: "upsertCellType",
      cellType: { ...specimenType, matched: true },
      prevCellType: specimenType
    });
  }

  // Drop the candidate's old placeholder if nothing else references it (and
  // it isn't the specimen itself / an already-matched real type).
  if (
    prevType &&
    prevType.id !== specimenType.id &&
    prevType.matched !== true &&
    !annotations.cells.some(
      (c) => c.id !== candidate.id && c.cellTypeId === prevType.id
    )
  ) {
    actions.push({ kind: "removeCellType", cellType: prevType });
  }

  return {
    action: actions.length === 1 ? actions[0] : { kind: "batch", actions },
    losesAnnotations: hasLayerShapes(prevType) && !hasLayerShapes(specimenType)
  };
}

/**
 * Detach `cell` from its (matched) type back into a fresh standalone unmatched
 * placeholder type — the inverse intent of a merge. One batched action.
 */
export function buildUnmatchAction(
  annotations: DieAnnotations,
  cell: Cell
): AnnotationAction {
  const prevType = cellTypeById(annotations, cell.cellTypeId);
  const cropRect = prevType
    ? { x: 0, y: 0, width: prevType.cropRect.width, height: prevType.cropRect.height }
    : { x: 0, y: 0, width: 0, height: 0 };
  const placeholder: CellType = {
    id: newId(),
    name: `cell ${cell.id.slice(0, 6)}`,
    cropRect,
    matched: false
  };
  const nextCell: Cell = { ...cell, cellTypeId: placeholder.id, merged: undefined };
  return {
    kind: "batch",
    actions: [
      { kind: "upsertCellType", cellType: placeholder, prevCellType: null },
      { kind: "upsertCell", cell: nextCell, prevCell: cell }
    ]
  };
}

/** Promote an unmatched placeholder to a matched (real) type — the flag a
 *  merge sets on its target. Null when it's matched already. */
export function buildMarkMatchedAction(cellType: CellType): AnnotationAction | null {
  if (cellType.matched === true) return null;
  return {
    kind: "upsertCellType",
    cellType: { ...cellType, matched: true },
    prevCellType: cellType
  };
}

/** A single-field orientation/position edit on a candidate (flip/rotate/align)
 *  — its own undo step. */
export function buildOrientAction(
  cell: Cell,
  patch: Partial<Pick<Cell, "flippedH" | "flippedV" | "rotation" | "x" | "y">>
): AnnotationAction {
  const next: Cell = { ...cell, ...patch };
  // Normalise falsy orientation to absent so the JSON stays clean.
  if (next.flippedH === false) delete next.flippedH;
  if (next.flippedV === false) delete next.flippedV;
  if (next.rotation === 0) delete next.rotation;
  return { kind: "upsertCell", cell: next, prevCell: cell };
}

/** The type half of a quarter turn (`deg` 90 = clockwise as seen in the RE
 *  canvas): its canonical box swaps W×H and its layer shapes turn with it. */
export function rotatedCellType(cellType: CellType, deg: 90 | -90): CellType {
  const { width: w, height: h } = cellType.cropRect;
  const next: CellType = { ...cellType, cropRect: { ...cellType.cropRect, width: h, height: w } };
  if (cellType.layers) next.layers = rotateLayers(cellType.layers, deg, w, h);
  return next;
}

/** A member's half of its type's quarter turn: it keeps covering exactly the
 *  same die pixels — its view turns by `deg` (`rotateView`) and its origin
 *  shifts by the box's half-difference so the footprint centre stays put (a
 *  half-pixel origin is fine: the footprint itself stays on whole pixels).
 *  `w` × `h` is the type's box before the turn, in this member's die pixels. */
export function rotatedMember(cell: Cell, deg: 90 | -90, w: number, h: number): Cell {
  const next: Cell = {
    ...cell,
    x: cell.x + (w - h) / 2,
    y: cell.y + (h - w) / 2,
    rotation: rotateView(orientOf(cell), deg).rotation
  };
  if (next.rotation === 0) delete next.rotation;
  return next;
}

/**
 * Turn a whole cell type a quarter turn (`deg` 90 = clockwise as seen in the
 * RE canvas, −90 = counter-clockwise): its canonical box swaps W×H, its layer
 * shapes turn with it, and every member keeps covering exactly the same die
 * pixels (`rotatedMember`). One batched, single-undo action; null when the
 * type has no members to turn.
 */
export function buildRotateCellTypeAction(
  annotations: DieAnnotations,
  cellType: CellType,
  deg: 90 | -90
): AnnotationAction | null {
  const members = membersOf(annotations, cellType.id);
  if (members.length === 0) return null;
  const { width: w, height: h } = cellType.cropRect;
  const actions: AnnotationAction[] = [
    { kind: "upsertCellType", cellType: rotatedCellType(cellType, deg), prevCellType: cellType }
  ];
  for (const cell of members) {
    actions.push({ kind: "upsertCell", cell: rotatedMember(cell, deg, w, h), prevCell: cell });
  }
  return { kind: "batch", actions };
}

/** The type half of a mirror (`axis` "h" = left↔right as seen in the RE
 *  canvas, "v" = top↔bottom): layer shapes mirror across the box's centre
 *  line; the W×H box stays. */
export function flippedCellType(cellType: CellType, axis: "h" | "v"): CellType {
  const { width: w, height: h } = cellType.cropRect;
  const next: CellType = { ...cellType };
  if (cellType.layers) {
    next.layers = mapLayerPoints(cellType.layers, mirrorAbout({ x: w / 2, y: h / 2 }, axis));
  }
  return next;
}

/** A member's half of its type's mirror: it toggles the matching flip
 *  (`O' = O·M`), so it keeps covering the same die pixels. */
export function flippedMember(cell: Cell, axis: "h" | "v"): Cell {
  const next: Cell = { ...cell };
  if (axis === "h") next.flippedH = !cell.flippedH;
  else next.flippedV = !cell.flippedV;
  if (!next.flippedH) delete next.flippedH;
  if (!next.flippedV) delete next.flippedV;
  return next;
}

/**
 * Mirror a whole cell type (`axis` "h" = left↔right as seen in the RE canvas,
 * "v" = top↔bottom): its layer shapes mirror across the box's centre line and
 * every member toggles the matching flip, so each keeps covering exactly the
 * same die pixels — a mirror keeps the W×H box and its centre. One batched,
 * single-undo action; null when the type has no members.
 */
export function buildFlipCellTypeAction(
  annotations: DieAnnotations,
  cellType: CellType,
  axis: "h" | "v"
): AnnotationAction | null {
  const members = membersOf(annotations, cellType.id);
  if (members.length === 0) return null;
  const actions: AnnotationAction[] = [
    { kind: "upsertCellType", cellType: flippedCellType(cellType, axis), prevCellType: cellType }
  ];
  for (const cell of members) {
    actions.push({ kind: "upsertCell", cell: flippedMember(cell, axis), prevCell: cell });
  }
  return { kind: "batch", actions };
}
