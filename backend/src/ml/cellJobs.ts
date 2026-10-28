import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  CellDetection,
  CellDetectionJob,
  CellDetectionOptions,
  CellDetectionResult,
  CellPlacementScore,
  DieAnnotations,
  MLPrediction
} from "shared";
import {
  effectiveCellTypes,
  foreignCellTypes,
  instancesOn,
  libraryDies,
  libraryInstances,
  resolveCellType,
  type ForeignCellType,
  type RemoteInstances
} from "../cellLibrary.js";
import { readAnnotations, readDieRecord, readMLJob } from "../store.js";
import type { DieRecord } from "../types.js";
import {
  buildPooledTemplate,
  buildTemplate,
  detectCells,
  type RectBox,
  type TemplateSource,
  type TemplateVia,
  type TypedCandidate,
  EXISTING_OVERLAP_ANY,
  EXISTING_OVERLAP_SAME_TYPE,
  existingFootprints,
  footprint,
  orientOf,
  resolveAcrossTypes,
  scorePlacement,
  ViaIndex
} from "./cellDetect.js";
import { readCellDetection, writeCellDetection } from "./cellDetectionStore.js";
import type { MLPredictor } from "./predict.js";

/** Coalesce WS progress pushes. */
const BROADCAST_THROTTLE_MS = 500;
/** A library type (owned by another die) with fewer instances than this
 *  here borrows its owner's template — averaged over every instance there —
 *  scaled to this die. */
const MIN_OWN_TEMPLATE_MEMBERS = 3;
/** Instances per die that go into a pooled template (spread evenly). */
const MAX_POOLED_PER_DIE = 200;

const spread = <T,>(list: ReadonlyArray<T>, max: number): T[] =>
  list.length <= max ? [...list] : Array.from({ length: max }, (_, i) => list[Math.floor((i * list.length) / max)]);
/** Tile JSONs read concurrently while loading the die's vias. */
const READ_CONCURRENCY = 64;

/** Stable fingerprint of a type's members (ids + placement + orientation).
 *  Shared with the frontend's staleness check — keep the two in sync. */
export function memberSignature(
  members: ReadonlyArray<{ id: string; x: number; y: number; flippedH?: boolean; flippedV?: boolean; rotation?: number }>
): string {
  return members
    .map(
      (m) =>
        `${m.id}:${Math.round(m.x)}:${Math.round(m.y)}:${m.flippedH ? 1 : 0}${m.flippedV ? 1 : 0}${m.rotation ?? 0}`
    )
    .sort()
    .join("|");
}

/** Rerunning a type mints fresh detection ids, so a previous run's
 *  dismissals are carried over by placement: a new detection within this many
 *  px of a dismissed one, in the same orientation, stays dismissed. */
const DISMISS_CARRY_TOL = 8;

export function carryDismissals(
  previous: CellDetectionResult | null,
  detections: ReadonlyArray<CellDetection>
): string[] {
  if (!previous || !previous.dismissed?.length) return [];
  const byId = new Map(previous.detections.map((d) => [d.id, d]));
  const dismissed = previous.dismissed
    .map((id) => byId.get(id))
    .filter((d): d is CellDetection => d !== undefined);
  if (dismissed.length === 0) return [];
  const same = (a: CellDetection, b: CellDetection) =>
    (a.flippedH ?? false) === (b.flippedH ?? false) &&
    (a.flippedV ?? false) === (b.flippedV ?? false) &&
    (a.rotation ?? 0) === (b.rotation ?? 0) &&
    Math.abs(a.x - b.x) <= DISMISS_CARRY_TOL &&
    Math.abs(a.y - b.y) <= DISMISS_CARRY_TOL;
  return detections.filter((d) => dismissed.some((p) => same(p, d))).map((d) => d.id);
}

export class CellJobBusy extends Error {}
export class CellJobBadRequest extends Error {}

export interface CellJobManager {
  /** The running job for a die, else the last one this process ran, else null. */
  getJob(dieId: string): CellDetectionJob | null;
  startJob(
    dieId: string,
    cellTypeId: string,
    options?: Partial<CellDetectionOptions>
  ): Promise<CellDetectionJob>;
  /** Detect every type the die can see (see `CellDetectionBatchStartRequest`). */
  startBatch(
    dieId: string,
    options?: Partial<CellDetectionOptions> & { minInstances?: number }
  ): Promise<CellDetectionJob>;
  stopJob(dieId: string): CellDetectionJob | null;
}

interface Active {
  cancel: boolean;
}

function nativeTileCount(record: DieRecord): number {
  const level = record.levels.find((l) => l.z === record.maxZoomLevel);
  if (level) return level.columns * level.rows;
  return (
    Math.ceil(record.width / record.tileSize) *
    Math.ceil(record.height / record.tileSize)
  );
}

interface LoadedVias {
  index: ViaIndex;
  tiles: number;
  hash: string | null;
}

/**
 * What a run reads besides the type itself — the die's vias, the other
 * library dies' vias and annotations, the foreign types, the placed cells'
 * footprints — each loaded at most once, so a batch over every library type
 * pays for it once instead of per type.
 */
interface RunContext {
  record: DieRecord;
  annotations: DieAnnotations;
  vias(record: DieRecord, onProgress: (fraction: number) => void): Promise<LoadedVias>;
  foreign(): Promise<Map<string, ForeignCellType>>;
  libraryDies(): Promise<Array<Omit<RemoteInstances, "cells">>>;
  /** Footprints of every placed cell, any type (`avoidExistingCells`). */
  placedFootprints(): Promise<RectBox[]>;
}

const once = <T,>(load: () => Promise<T>): (() => Promise<T>) => {
  let p: Promise<T> | null = null;
  return () => (p ??= load());
};

/** A run's result plus what the cross-type pass needs: the type's size. */
interface TypeRun {
  result: CellDetectionResult;
  cropRect: { width: number; height: number };
}

/**
 * Runs cell detection for one (die, cell type) at a time per die, entirely
 * in-process: reads the cached via predictions off disk (no sidecar call),
 * builds the type's template from its placed members, and runs the matcher
 * (which yields to the event loop between chunks). A batch runs every type
 * the die can see in one job. Progress is broadcast over WS as `cellJob`.
 */
export function createCellJobManager(config: {
  dataRoot: string;
  predictor: MLPredictor;
  onJobChange?: (job: CellDetectionJob) => void;
}): CellJobManager {
  const { dataRoot, predictor, onJobChange } = config;
  const active = new Map<string, Active>();
  const jobs = new Map<string, CellDetectionJob>();

  function getJob(dieId: string): CellDetectionJob | null {
    return jobs.get(dieId) ?? null;
  }

  /** Cached checkpoint hash the die's via sweep used. Prefers the live
   *  sidecar, falls back to the persisted sweep so detection works with the
   *  sidecar down. */
  async function resolveHash(dieId: string): Promise<string | null> {
    try {
      const live = await predictor.getCheckpointHash();
      if (live) return live;
    } catch {
      // sidecar down — fall through
    }
    const persisted = await readMLJob(dataRoot, dieId);
    return persisted?.checkpointHash ?? null;
  }

  async function loadVias(
    record: DieRecord,
    hash: string | null,
    onProgress: (fraction: number) => void,
    cancelled: () => boolean
  ): Promise<{ vias: { x: number; y: number; score: number }[]; tiles: number }> {
    const dir = predictor.cacheDirFor(record.id, hash);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch {
      files = [];
    }
    const prefix = `${record.maxZoomLevel}_`;
    const tileFiles = files.filter((f) => f.startsWith(prefix) && f.endsWith(".json"));
    const vias: { x: number; y: number; score: number }[] = [];
    let done = 0;
    for (let i = 0; i < tileFiles.length; i += READ_CONCURRENCY) {
      if (cancelled()) break;
      const batch = tileFiles.slice(i, i + READ_CONCURRENCY);
      const parsed = await Promise.all(
        batch.map(async (f) => {
          try {
            return JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as MLPrediction;
          } catch {
            return null;
          }
        })
      );
      for (const p of parsed) {
        if (!p) continue;
        for (const v of p.pointVias) vias.push({ x: v.x, y: v.y, score: v.score });
        for (const r of p.irregularVias) {
          vias.push({ x: r.centroid[0], y: r.centroid[1], score: r.score });
        }
      }
      done += batch.length;
      onProgress(done / Math.max(1, tileFiles.length));
    }
    return { vias, tiles: tileFiles.length };
  }

  function createRunContext(
    record: DieRecord,
    annotations: DieAnnotations,
    cancelled: () => boolean
  ): RunContext {
    const viaCache = new Map<string, Promise<LoadedVias>>();
    const foreign = once(() => foreignCellTypes(dataRoot, record, annotations));
    return {
      record,
      annotations,
      vias(die, onProgress) {
        let p = viaCache.get(die.id);
        if (!p) {
          p = (async () => {
            const hash = await resolveHash(die.id);
            const { vias, tiles } = await loadVias(die, hash, onProgress, cancelled);
            return { index: new ViaIndex(vias), tiles, hash };
          })();
          // A cancelled load is partial — never reuse it.
          void p.then(() => cancelled() && viaCache.delete(die.id));
          viaCache.set(die.id, p);
        }
        return p;
      },
      foreign,
      // The library's dies plus every owner a foreign type names.
      libraryDies: once(async () =>
        libraryDies(dataRoot, record, [...(await foreign()).values()].map((f) => f.owner.id))
      ),
      placedFootprints: once(async () =>
        existingFootprints(annotations.cells, await effectiveCellTypes(dataRoot, record, annotations))
      )
    };
  }

  /**
   * Detect one type over `ctx`'s die. `progress` gets the phase and the
   * fraction (0..1) of this type's run. Resolves null when cancelled; throws
   * `CellJobBadRequest` when the type can't be detected (no members, no
   * via sweep, too small a template).
   */
  async function detectType(
    ctx: RunContext,
    cellTypeId: string,
    options: CellDetectionOptions,
    progress: (phase: string, fraction: number) => void,
    cancelled: () => boolean
  ): Promise<TypeRun | null> {
    const { record, annotations } = ctx;
    const setProgress = (phase: string, fraction: number, base: number, span: number) =>
      progress(phase, base + span * Math.min(1, Math.max(0, fraction)));
    // Own type, or another die's type shared through the cell library
    // (then in this die's pixels).
    const ownType = annotations.cellTypes.find((t) => t.id === cellTypeId);
    const foreign = ownType ? null : ((await ctx.foreign()).get(cellTypeId) ?? null);
    const cellType = ownType ?? foreign?.type;
    if (!cellType) throw new CellJobBadRequest("cell type not found");
    const members = annotations.cells.filter((c) => c.cellTypeId === cellType.id);
    const ownerMembers = foreign
      ? foreign.ownerAnnotations.cells.filter((c) => c.cellTypeId === cellType.id)
      : [];
    // Pooling: the type's instances on every other die of the library.
    const remote = options.allDies
      ? instancesOn(await ctx.libraryDies(), cellType.id, foreign ? foreign.owner.id : record.id)
      : [];
    if (members.length === 0 && ownerMembers.length === 0 && remote.length === 0) {
      throw new CellJobBadRequest("cell type has no placed cells to build a template from");
    }
    if (cellType.cropRect.width <= 0 || cellType.cropRect.height <= 0) {
      throw new CellJobBadRequest("cell type has an empty crop rect");
    }
    const pool = remote.length > 0;
    const borrow =
      !options.allDies &&
      foreign !== null &&
      members.length < MIN_OWN_TEMPLATE_MEMBERS &&
      ownerMembers.length > members.length;
    // Progress: this die's vias, the other dies' when borrowing / pooling,
    // then matching.
    const loadSpan = borrow || pool ? 0.1 : 0.15;
    const matchBase = borrow || pool ? 0.2 : 0.15;

    setProgress("loading vias", 0, 0, loadSpan);
    const { index, tiles, hash } = await ctx.vias(record, (f) =>
      setProgress("loading vias", f, 0, loadSpan)
    );
    if (cancelled()) return null;
    if (tiles === 0) {
      throw new CellJobBadRequest(
        "no cached via predictions for this die — run ML inference first"
      );
    }
    const total = nativeTileCount(record);
    // Partial sweep: proceed, but say so in the phase text.
    const sweepNote =
      tiles < total ? ` (via sweep ${Math.round((tiles / total) * 100)}% complete)` : "";
    setProgress(`matching${sweepNote}`, 0, matchBase, 0);

    let template: TemplateVia[] | null = null;
    let templateSource: CellDetectionResult["templateSource"];
    let pooledFrom: CellDetectionResult["pooledFrom"];
    let poolTolerance = 4;
    if (pool) {
      // One consensus over every die's instances, in this die's pixels.
      const sources: TemplateSource[] = [];
      pooledFrom = [];
      if (members.length > 0) {
        sources.push({ members: spread(members, MAX_POOLED_PER_DIE), cellType, index, scale: 1 });
        pooledFrom.push({ dieId: record.id, dieName: record.name, memberCount: members.length, ratio: 1 });
      }
      for (let i = 0; i < remote.length; i++) {
        const r = remote[i];
        const loaded = await ctx.vias(r.record, (f) =>
          setProgress(`loading ${r.record.name} vias`, (i + f) / remote.length, loadSpan, 0.1)
        );
        if (cancelled()) return null;
        if (loaded.tiles === 0) continue; // no via sweep there — left out
        sources.push({
          members: spread(r.cells, MAX_POOLED_PER_DIE),
          cellType: {
            cropRect: {
              x: 0,
              y: 0,
              width: cellType.cropRect.width / r.ratio,
              height: cellType.cropRect.height / r.ratio
            }
          },
          index: loaded.index,
          scale: r.ratio
        });
        pooledFrom.push({ dieId: r.record.id, dieName: r.record.name, memberCount: r.cells.length, ratio: r.ratio });
      }
      if (sources.length === 0) {
        throw new CellJobBadRequest("no die with this type's instances has cached via predictions");
      }
      // Vias from a coarser photo land less precisely once scaled up.
      poolTolerance = 4 * Math.min(2, Math.max(1, ...sources.map((s) => s.scale)));
      template = buildPooledTemplate(sources, { tolerance: poolTolerance });
    } else if (borrow && foreign) {
      const owner = foreign.owner;
      const ownerVias = await ctx.vias(owner, (f) =>
        setProgress(`loading ${owner.name} vias`, f, loadSpan, 0.1)
      );
      if (cancelled()) return null;
      if (ownerVias.tiles > 0) {
        const ownerTemplate = buildTemplate(ownerMembers, foreign.ownerType, ownerVias.index);
        template = ownerTemplate.map((v) => ({ ...v, x: v.x * foreign.ratio, y: v.y * foreign.ratio }));
        templateSource = {
          dieId: owner.id,
          dieName: owner.name,
          memberCount: ownerMembers.length,
          ratio: foreign.ratio
        };
      } else if (members.length === 0) {
        throw new CellJobBadRequest(
          `no cached via predictions for ${owner.name}, which owns this type — run ML inference there first`
        );
      }
    }
    template ??= buildTemplate(members, cellType, index);
    // A borrowed template's clusters were averaged at the owner's scale.
    const tolerance = templateSource
      ? Math.max(4, 4 * templateSource.ratio)
      : pooledFrom
        ? poolTolerance
        : 4;
    if (template.length < 2) {
      throw new CellJobBadRequest(
        `template has ${template.length} via(s) — the members' footprints need at least 2 ML vias`
      );
    }
    // Avoiding existing cells: any placed cell blocks a candidate. Otherwise
    // only the type's own members do, at a near-duplicate bar — they match
    // the template perfectly and would all be re-proposed.
    const existing = options.avoidExistingCells
      ? await ctx.placedFootprints()
      : existingFootprints(members, [cellType]);
    const maxExistingOverlap = options.avoidExistingCells
      ? EXISTING_OVERLAP_ANY
      : EXISTING_OVERLAP_SAME_TYPE;

    // Score the type's own members against the consensus template: a
    // member that was misclassified (or mis-placed) scores low, which is
    // what merge-cells sorts on to surface outliers.
    const memberScores: Record<string, CellPlacementScore> = {};
    for (const m of members) {
      memberScores[m.id] = scorePlacement(template, cellType, index, m, tolerance);
    }

    const candidates = await detectCells(
      template,
      cellType,
      index,
      existing,
      {
        dieWidth: record.width,
        dieHeight: record.height,
        allowFlipX: options.allowFlipX,
        allowFlipY: options.allowFlipY,
        maxExistingOverlap,
        tolerance
      },
      {
        onProgress: (phase, f) =>
          setProgress(phase, f, matchBase, (phase === "scoring" ? 1 : 0.95) - matchBase),
        shouldCancel: cancelled
      }
    );
    if (cancelled()) return null;

    const detections: CellDetection[] = candidates.map((c) => ({
      id: randomUUID(),
      cellTypeId: cellType.id,
      ...c
    }));
    return {
      cropRect: cellType.cropRect,
      result: {
        version: 1,
        dieId: record.id,
        cellTypeId: cellType.id,
        ...(foreign ? { cellTypeDieId: foreign.owner.id } : {}),
        ...(templateSource ? { templateSource } : {}),
        ...(pooledFrom ? { pooledFrom } : {}),
        cellTypeName: cellType.name,
        checkpointHash: hash,
        annotationsRev: annotations.rev,
        memberCount: members.length,
        memberSignature: memberSignature(members),
        templateVias: template.length,
        memberScores,
        options,
        createdAt: new Date().toISOString(),
        detections,
        dismissed: []
      }
    };
  }

  /** Persist a run, carrying the previous run's dismissals over. */
  async function save(result: CellDetectionResult): Promise<void> {
    const previous = await readCellDetection(dataRoot, result.dieId, result.cellTypeId);
    await writeCellDetection(dataRoot, {
      ...result,
      dismissed: carryDismissals(previous, result.detections)
    });
  }

  /** Job bookkeeping shared by single and batch runs: throttled WS pushes,
   *  and the terminal state written in one place. */
  function tracker(job: CellDetectionJob) {
    let lastBroadcast = 0;
    const emit = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastBroadcast < BROADCAST_THROTTLE_MS) return;
      lastBroadcast = now;
      job.updatedAt = new Date().toISOString();
      jobs.set(job.dieId, { ...job });
      onJobChange?.({ ...job });
    };
    return {
      emit,
      progress(phase: string, fraction: number) {
        job.phase = phase;
        job.percentage = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
        emit(false);
      },
      fail(error: unknown) {
        job.status = "failed";
        job.error = error instanceof Error ? error.message : "cell detection failed";
      },
      finish() {
        active.delete(job.dieId);
        job.finishedAt = new Date().toISOString();
        emit(true);
      }
    };
  }

  async function run(
    job: CellDetectionJob,
    flag: Active,
    options: CellDetectionOptions
  ): Promise<void> {
    const t = tracker(job);
    const cancelled = () => flag.cancel;
    try {
      const record = await readDieRecord(dataRoot, job.dieId);
      const annotations = await readAnnotations(dataRoot, job.dieId);
      const ctx = createRunContext(record, annotations, cancelled);
      const out = await detectType(ctx, job.cellTypeId, options, t.progress, cancelled);
      if (!out) {
        job.status = "stopped";
        return;
      }
      await save(out.result);
      job.status = "completed";
      job.detections = out.result.detections.length;
      job.phase = "done";
      job.percentage = 100;
    } catch (error) {
      t.fail(error);
    } finally {
      t.finish();
    }
  }

  /** Every type the die can see with at least `minInstances` placed
   *  instances across the library (its own cells included). */
  async function batchTypes(
    ctx: RunContext,
    minInstances: number
  ): Promise<Array<{ id: string; name: string }>> {
    const { record, annotations } = ctx;
    const dies = await ctx.libraryDies();
    const count = (id: string, ownerId: string) =>
      annotations.cells.filter((c) => c.cellTypeId === id).length +
      instancesOn(dies, id, ownerId).reduce((n, r) => n + r.cells.length, 0);
    const out: Array<{ id: string; name: string; n: number }> = [];
    for (const t of annotations.cellTypes) out.push({ id: t.id, name: t.name, n: count(t.id, record.id) });
    for (const [id, f] of await ctx.foreign()) out.push({ id, name: f.type.name, n: count(id, f.owner.id) });
    // Most-placed first: their templates are the most reliable, and a
    // cancelled batch has then done the types that matter most.
    return out.filter((t) => t.n >= Math.max(1, minInstances)).sort((a, b) => b.n - a.n);
  }

  async function runBatch(
    job: CellDetectionJob,
    flag: Active,
    options: CellDetectionOptions,
    minInstances: number
  ): Promise<void> {
    const t = tracker(job);
    const cancelled = () => flag.cancel;
    try {
      const record = await readDieRecord(dataRoot, job.dieId);
      const annotations = await readAnnotations(dataRoot, job.dieId);
      const ctx = createRunContext(record, annotations, cancelled);
      t.progress("listing library types", 0);
      const types = await batchTypes(ctx, minInstances);
      if (types.length === 0) throw new CellJobBadRequest("no cell type has placed instances");
      const batch = { done: 0, total: types.length, skipped: 0 };
      job.batch = batch;
      const runs: TypeRun[] = [];
      // The matching share of the bar; the cross-type pass and writes follow.
      const span = 0.97;
      for (const type of types) {
        if (cancelled()) break;
        job.cellTypeId = type.id;
        job.cellTypeName = type.name;
        const base = batch.done / types.length;
        try {
          const out = await detectType(
            ctx,
            type.id,
            options,
            (phase, f) => t.progress(phase, span * (base + f / types.length)),
            cancelled
          );
          if (out) runs.push(out);
        } catch (error) {
          // One undetectable type doesn't sink the batch.
          if (!(error instanceof CellJobBadRequest)) throw error;
          batch.skipped += 1;
        }
        if (!cancelled()) batch.done += 1;
      }
      if (runs.length === 0) {
        if (cancelled()) {
          job.status = "stopped";
          return;
        }
        throw new CellJobBadRequest("no library type could be detected on this die");
      }

      // Keep one type per location: flatten every type's proposals, resolve,
      // and drop the losers from their type's result.
      t.progress("resolving overlaps between types", span);
      const flat: Array<TypedCandidate & { run: number; id: string }> = [];
      runs.forEach((r, run) => {
        const { width: W, height: H } = r.cropRect;
        for (const d of r.result.detections) {
          flat.push({
            run,
            id: d.id,
            box: footprint(d.x, d.y, orientOf(d), W, H),
            score: d.score,
            matched: d.matched,
            extra: d.extra,
            templateVias: r.result.templateVias
          });
        }
      });
      const kept = resolveAcrossTypes(flat);
      const keepIds = new Set([...kept].map((i) => flat[i].id));
      let total = 0;
      for (let i = 0; i < runs.length; i++) {
        const r = runs[i].result;
        const detections = r.detections.filter((d) => keepIds.has(d.id));
        total += detections.length;
        await save({ ...r, detections, crossTypeSuppressed: r.detections.length - detections.length });
        t.progress("saving", span + (1 - span) * ((i + 1) / runs.length));
      }
      job.cellTypeId = "";
      job.cellTypeName = `${runs.length} library types`;
      job.status = cancelled() ? "stopped" : "completed";
      job.detections = total;
      job.phase = "done";
      job.percentage = 100;
    } catch (error) {
      t.fail(error);
    } finally {
      t.finish();
    }
  }

  function begin(
    dieId: string,
    cellTypeId: string,
    cellTypeName: string,
    batch?: CellDetectionJob["batch"]
  ): { job: CellDetectionJob; flag: Active } {
    const now = new Date().toISOString();
    const job: CellDetectionJob = {
      dieId,
      cellTypeId,
      cellTypeName,
      ...(batch ? { batch } : {}),
      status: "running",
      phase: "starting",
      percentage: 0,
      detections: null,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null
    };
    const flag: Active = { cancel: false };
    active.set(dieId, flag);
    jobs.set(dieId, { ...job });
    onJobChange?.({ ...job });
    return { job, flag };
  }

  const normalize = (options: Partial<CellDetectionOptions>): CellDetectionOptions => ({
    allowFlipX: options.allowFlipX !== false,
    allowFlipY: options.allowFlipY !== false,
    avoidExistingCells: options.avoidExistingCells !== false,
    ...(options.allDies === true ? { allDies: true } : {})
  });

  async function startJob(
    dieId: string,
    cellTypeId: string,
    options: Partial<CellDetectionOptions> = {}
  ): Promise<CellDetectionJob> {
    if (active.has(dieId)) {
      throw new CellJobBusy("a cell-detection job is already running for this die");
    }
    // Validate up-front so a bad request fails the HTTP call, not the job.
    const record = await readDieRecord(dataRoot, dieId);
    const annotations = await readAnnotations(dataRoot, dieId);
    const resolved = await resolveCellType(dataRoot, record, annotations, cellTypeId);
    if (!resolved) throw new CellJobBadRequest("cell type not found");
    const cellType = resolved.type;
    const placed = (cells: ReadonlyArray<{ cellTypeId: string }>) =>
      cells.some((c) => c.cellTypeId === cellTypeId);
    if (
      !placed(annotations.cells) &&
      !(resolved.foreign && placed(resolved.foreign.ownerAnnotations.cells)) &&
      !(
        options.allDies === true &&
        (await libraryInstances(dataRoot, record, cellTypeId, resolved.foreign?.owner.id ?? record.id))
          .length > 0
      )
    ) {
      throw new CellJobBadRequest("cell type has no placed cells to build a template from");
    }
    if (active.has(dieId)) {
      throw new CellJobBusy("a cell-detection job is already running for this die");
    }
    const { job, flag } = begin(dieId, cellTypeId, cellType.name);
    void run(job, flag, normalize(options));
    return { ...job };
  }

  async function startBatch(
    dieId: string,
    options: Partial<CellDetectionOptions> & { minInstances?: number } = {}
  ): Promise<CellDetectionJob> {
    if (active.has(dieId)) {
      throw new CellJobBusy("a cell-detection job is already running for this die");
    }
    await readDieRecord(dataRoot, dieId); // 404s an unknown die up front
    if (active.has(dieId)) {
      throw new CellJobBusy("a cell-detection job is already running for this die");
    }
    const { job, flag } = begin(dieId, "", "library types", { done: 0, total: 0, skipped: 0 });
    // Templates pool every library die's instances: most library types have
    // few or none placed here.
    void runBatch(job, flag, { ...normalize(options), allDies: true }, options.minInstances ?? 1);
    return { ...job };
  }

  function stopJob(dieId: string): CellDetectionJob | null {
    const flag = active.get(dieId);
    if (flag) flag.cancel = true;
    return getJob(dieId);
  }

  return { getJob, startJob, startBatch, stopJob };
}
