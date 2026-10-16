import type { Cell, CellLayers, CellType, DieAnnotations, DieSummary, LayerShape, LayerType } from "shared";
import {
  cellScaleOf,
  libraryRatio,
  scaleCellType,
  scaleRect,
  scaleShape
} from "shared/cellLibrary";
import type { AnnotationAction } from "../api/actions";
import {
  composeOrient,
  flippedCellType,
  flippedMember,
  invertOrient,
  orientOf,
  orientVector,
  rotatedCellType,
  rotatedMember,
  type Orient
} from "./mergeCells";

/**
 * Cell libraries on the client. Dies that share a library (`cellLibrary`)
 * reuse each other's cell types: a type stays owned by — stored in — one die,
 * and another die places it with `Cell.cellTypeDieId` pointing at the owner.
 * On that die the type is drawn at the ratio of the two dies' `cellScale`s.
 *
 * Pages build a `CellLibraryView` for their die, read their annotations
 * through `withLibraryTypes` (other dies' types appended, already scaled to
 * this die's pixels, so footprint / drawing code needs no changes) and send
 * edits through `routeLibraryAction`, which hands an edit of another die's
 * type to that die in its own pixels.
 */

/** Another die's cell type, as this die sees it. */
export interface ForeignType {
  /** As its owner stores it (owner-die pixels). */
  type: CellType;
  ownerDieId: string;
  ownerName: string;
  /** This die's pixels per owner-die pixel. */
  ratio: number;
  /** `type` in this die's pixels — the same object when `ratio` is 1. */
  scaled: CellType;
  /** Offered for use here: a matched type of a die in this die's library.
   *  (Others are only here because a placed cell still points at them.) */
  offered: boolean;
}

export interface CellLibraryView {
  dieId: string;
  /** This die's library, if any. */
  name: string | null;
  /** This die's pixels per library unit. */
  scale: number;
  /** The other dies of the library, by name. */
  peers: DieSummary[];
  /** Every die summary, by id. */
  dies: ReadonlyMap<string, DieSummary>;
  /** Types this die can use but doesn't own, by id. */
  foreign: ReadonlyMap<string, ForeignType>;
  /** Types this die owns. */
  ownTypeIds: ReadonlySet<string>;
  /** Loaded annotations of the other dies the view draws on. */
  annotations: ReadonlyMap<string, DieAnnotations>;
  /** Some of those are still loading. */
  loading: boolean;
}

export const EMPTY_LIBRARY: CellLibraryView = {
  dieId: "",
  name: null,
  scale: 1,
  peers: [],
  dies: new Map(),
  foreign: new Map(),
  ownTypeIds: new Set(),
  annotations: new Map(),
  loading: false
};

const byName = (a: DieSummary, b: DieSummary) =>
  a.name.localeCompare(b.name, undefined, { numeric: true });

/** Owners this die's cells point at (`cellTypeDieId`), first-seen order. */
function namedOwners(dieId: string, own: DieAnnotations | undefined): string[] {
  const out = new Set<string>();
  for (const c of own?.cells ?? []) {
    if (c.cellTypeDieId && c.cellTypeDieId !== dieId) out.add(c.cellTypeDieId);
  }
  return [...out];
}

/** The other dies a view needs loaded: the library's, plus owners that this
 *  die's cells point at (so they keep resolving after a library change). */
export function libraryDieIds(
  dieId: string,
  dies: ReadonlyArray<DieSummary>,
  own: DieAnnotations | undefined
): string[] {
  const me = dies.find((d) => d.id === dieId);
  const out = new Set(namedOwners(dieId, own));
  if (me?.cellLibrary) {
    for (const d of dies) {
      if (d.id !== dieId && d.cellLibrary === me.cellLibrary) out.add(d.id);
    }
  }
  return [...out].sort();
}

// A type scaled to a die is cached per (owner object, ratio): unchanged
// owner types keep their scaled twin across refetches, which keeps editing
// round trips exact (see `toOwnerFrame`) and memoised consumers quiet.
const scaledCache = new WeakMap<CellType, Map<number, CellType>>();
function scaledType(t: CellType, ratio: number): CellType {
  if (ratio === 1) return t;
  let byRatio = scaledCache.get(t);
  if (!byRatio) scaledCache.set(t, (byRatio = new Map()));
  let hit = byRatio.get(ratio);
  if (!hit) byRatio.set(ratio, (hit = scaleCellType(t, ratio)));
  return hit;
}

export function buildLibraryView(
  dieId: string,
  dies: ReadonlyArray<DieSummary>,
  own: DieAnnotations | undefined,
  loaded: ReadonlyMap<string, DieAnnotations>,
  loading = false
): CellLibraryView {
  const byId = new Map(dies.map((d) => [d.id, d]));
  const me = byId.get(dieId);
  const name = me?.cellLibrary ?? null;
  const peers = name
    ? dies.filter((d) => d.id !== dieId && d.cellLibrary === name).sort(byName)
    : [];
  const inLibrary = new Set(peers.map((d) => d.id));
  const ownTypeIds = new Set(own?.cellTypes.map((t) => t.id) ?? []);
  const foreign = new Map<string, ForeignType>();
  // Owners this die's cells name go first: they win an id clash (a die
  // copied from another shares its type ids).
  const order = [...namedOwners(dieId, own), ...peers.map((d) => d.id)];
  for (const ownerId of order) {
    const ann = loaded.get(ownerId);
    const owner = byId.get(ownerId);
    if (!ann || !owner) continue;
    const ratio = libraryRatio(me, owner);
    for (const t of ann.cellTypes) {
      if (ownTypeIds.has(t.id) || foreign.has(t.id)) continue;
      foreign.set(t.id, {
        type: t,
        ownerDieId: ownerId,
        ownerName: owner.name,
        ratio,
        scaled: scaledType(t, ratio),
        offered: inLibrary.has(ownerId) && t.matched === true
      });
    }
  }
  return {
    dieId,
    name,
    scale: cellScaleOf(me),
    peers,
    dies: byId,
    foreign,
    ownTypeIds,
    annotations: loaded,
    loading
  };
}

/**
 * The die's annotations with the library's types appended — the offered ones
 * and any its cells use (only the latter with `usedOnly`) — in this die's
 * pixels. Cells, nets, everything else untouched. The same object when
 * there's nothing to add.
 */
export function withLibraryTypes(
  ann: DieAnnotations,
  view: CellLibraryView,
  options: { usedOnly?: boolean } = {}
): DieAnnotations {
  if (view.foreign.size === 0) return ann;
  const used = new Set(ann.cells.map((c) => c.cellTypeId));
  const extra: CellType[] = [];
  for (const f of view.foreign.values()) {
    if ((f.offered && !options.usedOnly) || used.has(f.type.id)) extra.push(f.scaled);
  }
  return extra.length === 0 ? ann : { ...ann, cellTypes: [...ann.cellTypes, ...extra] };
}

/** Types another die offers for placing here, biggest first. */
export function placeableTypes(view: CellLibraryView): ForeignType[] {
  const area = (f: ForeignType) => f.scaled.cropRect.width * f.scaled.cropRect.height;
  return [...view.foreign.values()]
    .filter((f) => f.offered)
    .sort((a, b) => area(b) - area(a) || a.type.name.localeCompare(b.type.name, undefined, { numeric: true }));
}

// ── Routing edits to the die that owns the type ──────────────────────

/**
 * An edit made on this die, rewritten for the library:
 *  - an upsert of another die's type goes to that die (`onDie`), converted
 *    back to its pixels;
 *  - removing another die's type is dropped — it isn't this die's to delete
 *    (a delete here only detaches this die's instances, which the same
 *    gesture handles) — and so is removing one of this die's types that
 *    other dies of the library still place;
 *  - a cell upsert gets `cellTypeDieId` set to its type's owner, or cleared
 *    when its type is this die's own.
 * Null when nothing is left.
 */
export function routeLibraryAction(
  action: AnnotationAction,
  view: CellLibraryView
): AnnotationAction | null {
  if (view.foreign.size === 0 && view.annotations.size === 0 && !mentionsOwner(action)) {
    return action;
  }
  // Types this gesture creates here are this die's own, like the rest.
  const created = new Set<string>();
  const collect = (a: AnnotationAction): void => {
    if (a.kind === "batch") a.actions.forEach(collect);
    else if (a.kind === "upsertCellType" && !view.foreign.has(a.cellType.id)) {
      created.add(a.cellType.id);
    }
  };
  collect(action);
  const route = (a: AnnotationAction): AnnotationAction | null => {
    switch (a.kind) {
      case "batch": {
        const actions = a.actions.map(route).filter((x): x is AnnotationAction => x !== null);
        return actions.length === 0 ? null : { kind: "batch", actions };
      }
      case "upsertCellType": {
        const f = view.foreign.get(a.cellType.id);
        if (!f) return a;
        return {
          kind: "onDie",
          dieId: f.ownerDieId,
          action: { kind: "upsertCellType", cellType: toOwnerFrame(a.cellType, f), prevCellType: f.type }
        };
      }
      case "removeCellType":
        return view.foreign.has(a.cellType.id) || placedElsewhere(view, a.cellType.id) ? null : a;
      case "upsertCell": {
        const cell = withTypeOwner(a.cell, view, created);
        return cell === a.cell ? a : { ...a, cell };
      }
      default:
        return a;
    }
  };
  return route(action);
}

/** Do other dies of the library place this die's type `typeId`? */
function placedElsewhere(view: CellLibraryView, typeId: string): boolean {
  for (const [dieId, ann] of view.annotations) {
    if (dieId === view.dieId) continue;
    if (ann.cells.some((c) => c.cellTypeId === typeId && c.cellTypeDieId === view.dieId)) return true;
  }
  return false;
}

function mentionsOwner(a: AnnotationAction): boolean {
  if (a.kind === "batch") return a.actions.some(mentionsOwner);
  return a.kind === "upsertCell" && a.cell.cellTypeDieId !== undefined;
}

/** `cell` pointing at its type's owner: set for another die's type, cleared
 *  for this die's own; left alone while the type is unknown (e.g. its die
 *  is still loading). */
function withTypeOwner(cell: Cell, view: CellLibraryView, created: ReadonlySet<string>): Cell {
  const f = view.foreign.get(cell.cellTypeId);
  if (f) {
    return cell.cellTypeDieId === f.ownerDieId ? cell : { ...cell, cellTypeDieId: f.ownerDieId };
  }
  if (
    cell.cellTypeDieId !== undefined &&
    (view.ownTypeIds.has(cell.cellTypeId) || created.has(cell.cellTypeId))
  ) {
    const { cellTypeDieId: _drop, ...rest } = cell;
    return rest;
  }
  return cell;
}

/**
 * A foreign type edited in this die's pixels, back in its owner's. Whatever
 * the edit didn't touch — the box, the layers, single shapes — is taken from
 * the owner's copy as is, so an edit never drifts the rest through a scale
 * round trip.
 */
export function toOwnerFrame(next: CellType, f: ForeignType): CellType {
  if (f.ratio === 1) return next;
  const k = 1 / f.ratio;
  const out: CellType = {
    ...next,
    cropRect: next.cropRect === f.scaled.cropRect ? f.type.cropRect : scaleRect(next.cropRect, k)
  };
  if (!next.layers) delete out.layers;
  else if (next.layers === f.scaled.layers && f.type.layers) out.layers = f.type.layers;
  else out.layers = unscaleLayers(next.layers, f.scaled.layers, f.type.layers, k);
  return out;
}

function unscaleLayers(
  layers: CellLayers,
  scaled: CellLayers | undefined,
  owner: CellLayers | undefined,
  k: number
): CellLayers {
  const out: CellLayers = {};
  for (const [layer, shapes] of Object.entries(layers) as Array<[LayerType, LayerShape[] | undefined]>) {
    if (!shapes) continue;
    const before = scaled?.[layer];
    const original = owner?.[layer];
    if (shapes === before && original) {
      out[layer] = original;
      continue;
    }
    const scaledById = new Map(before?.map((s) => [s.id, s]));
    const ownerById = new Map(original?.map((s) => [s.id, s]));
    out[layer] = shapes.map((s) => {
      const kept = scaledById.get(s.id) === s ? ownerById.get(s.id) : undefined;
      return kept ?? scaleShape(s, k);
    });
  }
  return out;
}

// ── A type's instances across the library ────────────────────────────

/** Does `cell` (on die `dieId`) place the type `typeId` owned by `ownerId`? */
function placesType(cell: Cell, dieId: string, typeId: string, ownerId: string): boolean {
  return cell.cellTypeId === typeId && (cell.cellTypeDieId ?? dieId) === ownerId;
}

/** The type's owner and its stored copy, from this die's point of view. */
function ownerOf(
  view: CellLibraryView,
  homeAnn: DieAnnotations,
  typeId: string
): { ownerId: string; type: CellType } | null {
  const f = view.foreign.get(typeId);
  if (f) return { ownerId: f.ownerDieId, type: f.type };
  const own = homeAnn.cellTypes.find((t) => t.id === typeId);
  return own ? { ownerId: view.dieId, type: own } : null;
}

/** How many instances the type has on this die and every loaded die of its
 *  library. */
export function libraryMemberCount(
  view: CellLibraryView,
  homeAnn: DieAnnotations,
  typeId: string
): number {
  const owner = ownerOf(view, homeAnn, typeId);
  if (!owner) return 0;
  let n = 0;
  for (const [dieId, ann] of dieAnnotations(view, homeAnn)) {
    for (const c of ann.cells) if (placesType(c, dieId, typeId, owner.ownerId)) n += 1;
  }
  return n;
}

function dieAnnotations(view: CellLibraryView, homeAnn: DieAnnotations): Array<[string, DieAnnotations]> {
  const out: Array<[string, DieAnnotations]> = [[view.dieId, homeAnn]];
  for (const [id, ann] of view.annotations) if (id !== view.dieId) out.push([id, ann]);
  return out;
}

/** An instance of a type on another die of the library. */
export interface RemoteInstance {
  cell: Cell;
  dieId: string;
  dieName: string;
  /** This die's pixels per that die's pixel. */
  ratio: number;
}

/** The type's instances on the other loaded dies of the library (this die's
 *  own excluded), grouped by die name. */
export function remoteInstances(
  view: CellLibraryView,
  homeAnn: DieAnnotations,
  typeId: string
): RemoteInstance[] {
  const owner = ownerOf(view, homeAnn, typeId);
  if (!owner) return [];
  const me = view.dies.get(view.dieId);
  const out: RemoteInstance[] = [];
  for (const [dieId, ann] of view.annotations) {
    if (dieId === view.dieId) continue;
    const die = view.dies.get(dieId);
    for (const c of ann.cells) {
      if (!placesType(c, dieId, typeId, owner.ownerId)) continue;
      out.push({ cell: c, dieId, dieName: die?.name ?? dieId, ratio: libraryRatio(me, die) });
    }
  }
  return out.sort((a, b) => a.dieName.localeCompare(b.dieName, undefined, { numeric: true }));
}

export type TypeTransform = { kind: "rotate"; deg: 90 | -90 } | { kind: "flip"; axis: "h" | "v" };

/**
 * Turn or mirror a type everywhere it's used: its definition, in the die
 * that owns it, and every instance on every loaded die of the library — each
 * re-placed in its own die's pixels so it keeps covering the same die area
 * (see `buildRotateCellTypeAction`). One undo step; null when the type has
 * no instance anywhere. `homeAnn` is this die's own (unmerged) annotations.
 */
export function buildLibraryTypeTransform(
  view: CellLibraryView,
  homeAnn: DieAnnotations,
  typeId: string,
  t: TypeTransform
): AnnotationAction | null {
  const owner = ownerOf(view, homeAnn, typeId);
  if (!owner) return null;
  const onDie = (dieId: string, a: AnnotationAction): AnnotationAction =>
    dieId === view.dieId ? a : { kind: "onDie", dieId, action: a };
  const nextType =
    t.kind === "rotate" ? rotatedCellType(owner.type, t.deg) : flippedCellType(owner.type, t.axis);
  const actions: AnnotationAction[] = [
    onDie(owner.ownerId, { kind: "upsertCellType", cellType: nextType, prevCellType: owner.type })
  ];
  let members = 0;
  for (const [dieId, ann] of dieAnnotations(view, homeAnn)) {
    // The type's box before the change, in this die's pixels.
    const r = libraryRatio(view.dies.get(dieId), view.dies.get(owner.ownerId));
    const w = owner.type.cropRect.width * r;
    const h = owner.type.cropRect.height * r;
    const cells: AnnotationAction[] = [];
    for (const c of ann.cells) {
      if (!placesType(c, dieId, typeId, owner.ownerId)) continue;
      const next = t.kind === "rotate" ? rotatedMember(c, t.deg, w, h) : flippedMember(c, t.axis);
      cells.push({ kind: "upsertCell", cell: next, prevCell: c });
    }
    members += cells.length;
    if (cells.length > 0) {
      actions.push(onDie(dieId, cells.length === 1 ? cells[0] : { kind: "batch", actions: cells }));
    }
  }
  return members === 0 ? null : { kind: "batch", actions };
}

// ── Merging two whole types ──────────────────────────────────────────

/** How a candidate type lines up with the specimen type, both in this die's
 *  pixels: a candidate-canonical point p lands on the specimen's canonical
 *  frame at `orient·(p − candidate centre) + specimen centre + (dx, dy)`. */
export interface TypeAlignment {
  orient: Orient;
  dx: number;
  dy: number;
}

export interface TypeMergePlan {
  action: AnnotationAction;
  /** The type both become: the one with more layer annotations (the
   *  specimen on a tie). The other is deleted. */
  survivorId: string;
  loserId: string;
  /** Layer shapes each had — the loser's are dropped. */
  survivorShapes: number;
  loserShapes: number;
  /** Instances re-typed, over every die. */
  moved: number;
}

const shapeCount = (t: CellType) =>
  Object.values(t.layers ?? {}).reduce((n, shapes) => n + (shapes?.length ?? 0), 0);

/**
 * Merge two whole cell types into one, as lined up in merge-cells: every
 * instance of the losing type — on this die and every loaded die of the
 * library — becomes an instance of the survivor covering exactly the same die
 * pixels (its orientation composed with the alignment, its origin moved
 * accordingly, in its own die's pixels), then the loser is deleted from the
 * die that owns it. One undo step. Null when either type is unknown.
 */
export function buildTypeMergeAction(
  view: CellLibraryView,
  homeAnn: DieAnnotations,
  specimenTypeId: string,
  candidateTypeId: string,
  align: TypeAlignment
): TypeMergePlan | null {
  const spec = ownerOf(view, homeAnn, specimenTypeId);
  const cand = ownerOf(view, homeAnn, candidateTypeId);
  if (!spec || !cand || specimenTypeId === candidateTypeId) return null;
  const keepCandidate = shapeCount(cand.type) > shapeCount(spec.type);
  const [survivor, loser] = keepCandidate ? [cand, spec] : [spec, cand];
  // Loser-canonical → survivor-canonical (this die's pixels): the alignment,
  // or its inverse when the candidate survives.
  const inv = invertOrient(align.orient);
  const map = keepCandidate
    ? { orient: inv, d: orientVector(inv, { x: -align.dx, y: -align.dy }) }
    : { orient: align.orient, d: { x: align.dx, y: align.dy } };
  const unmap = invertOrient(map.orient);
  const home = view.dies.get(view.dieId);
  // Explicitly addressed — even on this die — so routing leaves them as built.
  const on = (dieId: string, a: AnnotationAction): AnnotationAction => ({ kind: "onDie", dieId, action: a });

  const actions: AnnotationAction[] = [];
  let moved = 0;
  for (const [dieId, ann] of dieAnnotations(view, homeAnn)) {
    const die = view.dies.get(dieId);
    const k = libraryRatio(die, home); // this die's px per home-die px
    const boxOf = (t: { ownerId: string; type: CellType }) => {
      const r = libraryRatio(die, view.dies.get(t.ownerId));
      return { w: t.type.cropRect.width * r, h: t.type.cropRect.height * r };
    };
    const bl = boxOf(loser);
    const bs = boxOf(survivor);
    const e = { x: map.d.x * k, y: map.d.y * k };
    const cells: AnnotationAction[] = [];
    for (const c of ann.cells) {
      if (!placesType(c, dieId, loser.type.id, loser.ownerId)) continue;
      // Instance of the loser: die = xy + c_l + O(p − c_l). As one of the
      // survivor, with p_s = M(p − c_l) + c_s + e: O' = O·M⁻¹ and
      // xy' = xy + c_l − c_s − O'·e.
      const o = composeOrient(orientOf(c), unmap);
      const oe = orientVector(o, e);
      const next: Cell = {
        ...c,
        cellTypeId: survivor.type.id,
        x: c.x + (bl.w - bs.w) / 2 - oe.x,
        y: c.y + (bl.h - bs.h) / 2 - oe.y
      };
      delete next.flippedH;
      delete next.flippedV;
      delete next.rotation;
      delete next.cellTypeDieId;
      if (o.flippedH) next.flippedH = true;
      if (o.flippedV) next.flippedV = true;
      if (o.rotation) next.rotation = o.rotation;
      if (survivor.ownerId !== dieId) next.cellTypeDieId = survivor.ownerId;
      cells.push({ kind: "upsertCell", cell: next, prevCell: c });
    }
    moved += cells.length;
    if (cells.length > 0) {
      actions.push(on(dieId, cells.length === 1 ? cells[0] : { kind: "batch", actions: cells }));
    }
  }
  if (survivor.type.matched !== true) {
    actions.push(
      on(survivor.ownerId, {
        kind: "upsertCellType",
        cellType: { ...survivor.type, matched: true },
        prevCellType: survivor.type
      })
    );
  }
  actions.push(on(loser.ownerId, { kind: "removeCellType", cellType: loser.type }));
  return {
    action: { kind: "batch", actions },
    survivorId: survivor.type.id,
    loserId: loser.type.id,
    survivorShapes: shapeCount(survivor.type),
    loserShapes: shapeCount(loser.type),
    moved
  };
}
