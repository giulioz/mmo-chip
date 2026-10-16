import type { Cell, CellType, DieAnnotations } from "shared";
import { libraryRatio, scaleCellType } from "shared/cellLibrary";
import { listDieRecords, readAnnotations, readDieRecord } from "./store.js";
import type { DieRecord } from "./types.js";

/**
 * Cell types a die uses without owning them: types of the other dies in its
 * cell library (see `DieSummary.cellLibrary`). A cell placed with one of them
 * names the owner in `cellTypeDieId`; the type is drawn at the ratio of the
 * two dies' `cellScale`s.
 */
export interface ForeignCellType {
  /** The type as it sits on the asking die: the owner's type × `ratio`. */
  type: CellType;
  /** The type as its owner stores it. */
  ownerType: CellType;
  owner: DieRecord;
  ownerAnnotations: DieAnnotations;
  /** Asking-die pixels per owner-die pixel. */
  ratio: number;
}

/**
 * Every type a die can see but doesn't own, keyed by id: the types of the
 * dies its cells point at (`cellTypeDieId` — so placed cells keep resolving
 * after a library change) and of the other dies in its library. The die's
 * own types win an id clash, then the owners its cells name.
 */
export async function foreignCellTypes(
  dataRoot: string,
  record: DieRecord,
  annotations: DieAnnotations
): Promise<Map<string, ForeignCellType>> {
  const own = new Set(annotations.cellTypes.map((t) => t.id));
  const named = new Set<string>();
  for (const c of annotations.cells) {
    if (c.cellTypeDieId && c.cellTypeDieId !== record.id && !own.has(c.cellTypeId)) {
      named.add(c.cellTypeDieId);
    }
  }
  const peers: DieRecord[] = [];
  for (const id of named) {
    try {
      peers.push(await readDieRecord(dataRoot, id));
    } catch {
      // Owner deleted: its cells here are left without a type.
    }
  }
  if (record.cellLibrary) {
    for (const r of await listDieRecords(dataRoot)) {
      if (r.id !== record.id && r.cellLibrary === record.cellLibrary && !named.has(r.id)) {
        peers.push(r);
      }
    }
  }
  const out = new Map<string, ForeignCellType>();
  for (const owner of peers) {
    const ownerAnnotations = await readAnnotations(dataRoot, owner.id);
    const ratio = libraryRatio(record, owner);
    for (const t of ownerAnnotations.cellTypes) {
      if (own.has(t.id) || out.has(t.id)) continue;
      out.set(t.id, {
        type: scaleCellType(t, ratio),
        ownerType: t,
        owner,
        ownerAnnotations,
        ratio
      });
    }
  }
  return out;
}

/** One type by id, in the die's pixels: its own, or a foreign one (the
 *  owner looked up directly when the caller knows it). Null when unknown. */
export async function resolveCellType(
  dataRoot: string,
  record: DieRecord,
  annotations: DieAnnotations,
  cellTypeId: string,
  ownerDieId?: string
): Promise<{ type: CellType; foreign: ForeignCellType | null } | null> {
  const own = annotations.cellTypes.find((t) => t.id === cellTypeId);
  if (own) return { type: own, foreign: null };
  if (ownerDieId && ownerDieId !== record.id) {
    try {
      const owner = await readDieRecord(dataRoot, ownerDieId);
      const ownerAnnotations = await readAnnotations(dataRoot, ownerDieId);
      const ownerType = ownerAnnotations.cellTypes.find((t) => t.id === cellTypeId);
      if (ownerType) {
        const ratio = libraryRatio(record, owner);
        const foreign = { type: scaleCellType(ownerType, ratio), ownerType, owner, ownerAnnotations, ratio };
        return { type: foreign.type, foreign };
      }
    } catch {
      // fall through to the library scan
    }
  }
  const foreign = (await foreignCellTypes(dataRoot, record, annotations)).get(cellTypeId);
  return foreign ? { type: foreign.type, foreign } : null;
}

/** The die's own types plus the foreign ones its cells use, all in the
 *  die's pixels — what footprint math over its cells needs. */
export async function effectiveCellTypes(
  dataRoot: string,
  record: DieRecord,
  annotations: DieAnnotations
): Promise<CellType[]> {
  const own = new Set(annotations.cellTypes.map((t) => t.id));
  const used = new Set(annotations.cells.map((c) => c.cellTypeId).filter((id) => !own.has(id)));
  if (used.size === 0) return annotations.cellTypes;
  const foreign = await foreignCellTypes(dataRoot, record, annotations);
  const extra: CellType[] = [];
  for (const id of used) {
    const f = foreign.get(id);
    if (f) extra.push(f.type);
  }
  return [...annotations.cellTypes, ...extra];
}

/** A type's instances on one other die, with that die's pixels relative to
 *  the asking die's. */
export interface RemoteInstances {
  record: DieRecord;
  annotations: DieAnnotations;
  cells: Cell[];
  /** Asking-die pixels per that die's pixel. */
  ratio: number;
}

/** The other dies of `record`'s cell library (plus any of `alsoIds`), loaded
 *  once: record, annotations and pixels relative to `record`'s. */
export async function libraryDies(
  dataRoot: string,
  record: DieRecord,
  alsoIds: Iterable<string> = []
): Promise<Array<Omit<RemoteInstances, "cells">>> {
  const ids = new Set<string>([...alsoIds].filter((id) => id !== record.id));
  if (record.cellLibrary) {
    for (const r of await listDieRecords(dataRoot)) {
      if (r.id !== record.id && r.cellLibrary === record.cellLibrary) ids.add(r.id);
    }
  }
  const out: Array<Omit<RemoteInstances, "cells">> = [];
  for (const id of ids) {
    try {
      const other = await readDieRecord(dataRoot, id);
      out.push({ record: other, annotations: await readAnnotations(dataRoot, id), ratio: libraryRatio(record, other) });
    } catch {
      // deleted die — skip
    }
  }
  return out;
}

/** The instances of type `typeId` (owned by `ownerDieId`) on `dies`. */
export function instancesOn(
  dies: ReadonlyArray<Omit<RemoteInstances, "cells">>,
  typeId: string,
  ownerDieId: string
): RemoteInstances[] {
  const out: RemoteInstances[] = [];
  for (const d of dies) {
    const cells = d.annotations.cells.filter(
      (c) => c.cellTypeId === typeId && (c.cellTypeDieId ?? d.record.id) === ownerDieId
    );
    if (cells.length > 0) out.push({ ...d, cells });
  }
  return out;
}

/** Instances of the type `typeId` (owned by `ownerDieId`) on the other dies
 *  of `record`'s cell library — and on the owner, wherever it is. */
export async function libraryInstances(
  dataRoot: string,
  record: DieRecord,
  typeId: string,
  ownerDieId: string
): Promise<RemoteInstances[]> {
  return instancesOn(await libraryDies(dataRoot, record, [ownerDieId]), typeId, ownerDieId);
}
