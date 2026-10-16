import { promises as fs } from "node:fs";
import sharp from "sharp";
import type {
  Cell,
  CellImagingJob,
  CellImagingJobKind,
  CellSpecimenIndex,
  CellSpecimenInfo,
  CellType
} from "shared";
import { footprint, orientOf } from "../ml/cellDetect.js";
import { memberSignature } from "../ml/cellJobs.js";
import { effectiveCellTypes, foreignCellTypes, instancesOn, libraryDies } from "../cellLibrary.js";
import { readAnnotations, readDieRecord } from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";
import { buildSpecimen, DISPLAY_SCALE, MAX_INSTANCES, toBytes, type ForeignInstance } from "./specimen.js";
import {
  clearWireMap,
  readSpecimenIndex,
  SPREAD_SCALE,
  specimenDisplayPath,
  specimenPath,
  specimensDir,
  spreadPath,
  writeSpecimenIndex,
  writeWireMapInfo
} from "./store.js";
import { createTileReader } from "./tileReader.js";
import {
  buildWirePyramid,
  cellWireLikelihood,
  createWireTileWriter,
  prepareSpecimen,
  type LoadedSpecimen
} from "./wireMap.js";

const BROADCAST_THROTTLE_MS = 500;
/** Types with fewer stacked instances have no meaningful per-pixel spread, so
 *  their cells are left out of the wire map (everything would "deviate"). */
const MIN_INSTANCES_FOR_WIRES = 5;

export class ImagingJobBusy extends Error {}
export class ImagingJobBadRequest extends Error {}

export interface CellImagingJobManager {
  getJob(dieId: string): CellImagingJob | null;
  start(dieId: string, kind: CellImagingJobKind, options?: { allDies?: boolean }): Promise<CellImagingJob>;
  stop(dieId: string): CellImagingJob | null;
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

async function writeAtomic(file: string, png: Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, png);
  await fs.rename(tmp, file);
}

/**
 * Runs the two imaging jobs — clean per-type specimens, and the die-wide
 * wire-likelihood overlay computed against them — one at a time per die,
 * in-process, yielding to the event loop between instances. Both read pixels
 * through the tile scheduler and write only to their own folders.
 */
export function createCellImagingJobManager(config: {
  dataRoot: string;
  tileScheduler: ReturnType<typeof createTileScheduler>;
  onJobChange?: (job: CellImagingJob) => void;
}): CellImagingJobManager {
  const { dataRoot, tileScheduler, onJobChange } = config;
  const active = new Map<string, { cancel: boolean }>();
  const jobs = new Map<string, CellImagingJob>();

  async function runSpecimens(
    job: CellImagingJob,
    progress: (phase: string, f: number) => void,
    cancelled: () => boolean,
    allDies: boolean
  ) {
    const record = await readDieRecord(dataRoot, job.dieId);
    const annotations = await readAnnotations(dataRoot, job.dieId);
    const reader = createTileReader(record, tileScheduler);
    const byType = new Map<string, Cell[]>();
    for (const c of annotations.cells) {
      const list = byType.get(c.cellTypeId);
      if (list) list.push(c);
      else byType.set(c.cellTypeId, [c]);
    }
    // Library types placed here (owned by another die) get a specimen of
    // their own from this die's instances, at this die's scale — pooled with
    // their instances on the library's other dies when asked.
    const foreign = allDies ? await foreignCellTypes(dataRoot, record, annotations) : null;
    const peers = foreign
      ? await libraryDies(dataRoot, record, [...foreign.values()].map((f) => f.owner.id))
      : [];
    const readers = new Map<string, ReturnType<typeof createTileReader>>();
    const readerOf = (r: (typeof peers)[number]["record"]) => {
      let rd = readers.get(r.id);
      if (!rd) readers.set(r.id, (rd = createTileReader(r, tileScheduler)));
      return rd;
    };
    const work = (await effectiveCellTypes(dataRoot, record, annotations))
      .map((t) => {
        const members = byType.get(t.id) ?? [];
        const remote = foreign ? instancesOn(peers, t.id, foreign.get(t.id)?.owner.id ?? record.id) : [];
        const extra: ForeignInstance[] = remote.flatMap((r) =>
          r.cells.map((cell) => ({ cell, reader: readerOf(r.record), k: r.ratio }))
        );
        return { t, members, extra, dies: 1 + remote.length };
      })
      .filter((w) => w.members.length > 0);
    if (work.length === 0) throw new ImagingJobBadRequest("no placed cells on this die");
    const cost = (w: { t: CellType; members: Cell[]; extra: ForeignInstance[] }) =>
      Math.min(w.members.length + w.extra.length, MAX_INSTANCES) * w.t.cropRect.width * w.t.cropRect.height;
    const total = work.reduce((s, w) => s + cost(w), 0);

    await fs.mkdir(specimensDir(dataRoot, job.dieId), { recursive: true });
    const specimens: CellSpecimenInfo[] = [];
    let done = 0;
    for (const w of work) {
      if (cancelled()) return;
      const res = await buildSpecimen(w.t, w.members, reader, { percentile: 50, foreign: w.extra }, {
        onProgress: (f) => progress(`specimen · ${w.t.name}`, (done + f * cost(w)) / total),
        shouldCancel: cancelled,
        yieldToLoop
      });
      done += cost(w);
      if (!res) continue;
      const raw = { raw: { width: res.width, height: res.height, channels: 3 as const } };
      await writeAtomic(specimenPath(dataRoot, job.dieId, w.t.id), await sharp(toBytes(res.centre), raw).png().toBuffer());
      await writeAtomic(spreadPath(dataRoot, job.dieId, w.t.id), await sharp(toBytes(res.mad, SPREAD_SCALE), raw).png().toBuffer());
      await writeAtomic(
        specimenDisplayPath(dataRoot, job.dieId, w.t.id),
        await sharp(toBytes(res.display), {
          raw: { width: res.width * DISPLAY_SCALE, height: res.height * DISPLAY_SCALE, channels: 3 }
        })
          .png()
          .toBuffer()
      );
      specimens.push({
        cellTypeId: w.t.id,
        cellTypeName: w.t.name,
        width: res.width,
        height: res.height,
        instancesUsed: res.instancesUsed,
        displayScale: DISPLAY_SCALE,
        displayInstances: res.displayInstances,
        orientationMismatches: res.orientationMismatches,
        orientationMismatchIds: res.orientationMismatchIds,
        memberSignature: memberSignature(w.members),
        ...(w.extra.length > 0 ? { dies: w.dies } : {}),
        createdAt: new Date().toISOString()
      });
    }
    if (cancelled()) return;
    const index: CellSpecimenIndex = {
      version: 1,
      dieId: job.dieId,
      percentile: 50,
      createdAt: new Date().toISOString(),
      specimens
    };
    await writeSpecimenIndex(dataRoot, index);
    // Drop images of types that no longer exist.
    const keep = new Set(
      specimens.flatMap((s) => [`${s.cellTypeId}.png`, `${s.cellTypeId}.spread.png`, `${s.cellTypeId}@2x.png`])
    );
    for (const f of await fs.readdir(specimensDir(dataRoot, job.dieId))) {
      if (f.endsWith(".png") && !keep.has(f)) await fs.rm(`${specimensDir(dataRoot, job.dieId)}/${f}`, { force: true });
    }
  }

  async function loadSpecimen(dieId: string, info: CellSpecimenInfo): Promise<LoadedSpecimen> {
    const centre = await sharp(specimenPath(dataRoot, dieId, info.cellTypeId)).removeAlpha().raw().toBuffer();
    const spread = await sharp(spreadPath(dataRoot, dieId, info.cellTypeId)).removeAlpha().raw().toBuffer();
    const c = new Float32Array(centre.length);
    const m = new Float32Array(spread.length);
    for (let i = 0; i < c.length; i++) {
      c[i] = centre[i];
      m[i] = spread[i] / SPREAD_SCALE;
    }
    return prepareSpecimen(info.width, info.height, c, m);
  }

  async function runWireMap(job: CellImagingJob, progress: (phase: string, f: number) => void, cancelled: () => boolean) {
    const record = await readDieRecord(dataRoot, job.dieId);
    const annotations = await readAnnotations(dataRoot, job.dieId);
    const index = await readSpecimenIndex(dataRoot, job.dieId);
    if (!index || index.specimens.length === 0) {
      throw new ImagingJobBadRequest("generate the cell specimens first");
    }
    const reader = createTileReader(record, tileScheduler);
    const typeById = new Map(
      (await effectiveCellTypes(dataRoot, record, annotations)).map((t) => [t.id, t])
    );
    const infoById = new Map(index.specimens.map((s) => [s.cellTypeId, s]));
    const loaded = new Map<string, LoadedSpecimen>();

    await clearWireMap(dataRoot, job.dieId);
    const writer = createWireTileWriter(dataRoot, record);
    const ts = record.tileSize;
    const topRow = (c: Cell, t: CellType) =>
      Math.floor(Math.max(0, footprint(c.x, c.y, orientOf(c), t.cropRect.width, t.cropRect.height).y0) / ts);
    const cells = annotations.cells
      .map((c) => ({ c, t: typeById.get(c.cellTypeId) }))
      .filter((x): x is { c: Cell; t: CellType } => x.t !== undefined)
      .map((x) => ({ ...x, row: topRow(x.c, x.t) }))
      .sort((a, b) => a.row - b.row || a.c.x - b.c.x);

    let processed = 0;
    let skipped = 0;
    for (let i = 0; i < cells.length; i++) {
      if (cancelled()) break;
      const { c, t, row } = cells[i];
      await writer.flushRowsBefore(row);
      const info = infoById.get(t.id);
      // A specimen built for a different crop size no longer fits the type.
      const usable =
        info &&
        info.instancesUsed >= MIN_INSTANCES_FOR_WIRES &&
        info.width === Math.round(t.cropRect.width) &&
        info.height === Math.round(t.cropRect.height);
      if (!usable) {
        skipped += 1;
      } else {
        let spec = loaded.get(t.id);
        if (!spec) {
          spec = await loadSpecimen(job.dieId, info);
          loaded.set(t.id, spec);
        }
        const lik = await cellWireLikelihood(c, spec, reader);
        if (lik) {
          writer.paste(c, t, lik);
          processed += 1;
        } else skipped += 1;
      }
      progress("wire map · cells", (0.9 * (i + 1)) / cells.length);
      await yieldToLoop();
    }
    if (cancelled()) {
      await clearWireMap(dataRoot, job.dieId); // never serve half a map
      return;
    }
    await writer.flushAll();
    progress("wire map · pyramid", 0.92);
    const minZoomLevel = await buildWirePyramid(dataRoot, record, writer.nativeTiles, { shouldCancel: cancelled, yieldToLoop });
    if (cancelled()) {
      await clearWireMap(dataRoot, job.dieId);
      return;
    }
    await writeWireMapInfo(dataRoot, {
      version: 1,
      dieId: job.dieId,
      createdAt: new Date().toISOString(),
      specimensCreatedAt: index.createdAt,
      annotationsRev: annotations.rev,
      cellsProcessed: processed,
      cellsSkipped: skipped,
      minZoomLevel,
      maxZoomLevel: record.maxZoomLevel
    });
  }

  async function run(job: CellImagingJob, flag: { cancel: boolean }, allDies: boolean): Promise<void> {
    let last = 0;
    const emit = (force: boolean) => {
      const now = Date.now();
      if (!force && now - last < BROADCAST_THROTTLE_MS) return;
      last = now;
      job.updatedAt = new Date().toISOString();
      jobs.set(job.dieId, { ...job });
      onJobChange?.({ ...job });
    };
    const progress = (phase: string, f: number) => {
      job.phase = phase;
      job.percentage = Math.round(Math.min(1, Math.max(0, f)) * 100);
      emit(false);
    };
    try {
      if (job.kind === "specimens") await runSpecimens(job, progress, () => flag.cancel, allDies);
      else await runWireMap(job, progress, () => flag.cancel);
      job.status = flag.cancel ? "stopped" : "completed";
      if (!flag.cancel) {
        job.phase = "done";
        job.percentage = 100;
      }
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof Error ? error.message : "imaging job failed";
    } finally {
      active.delete(job.dieId);
      job.finishedAt = new Date().toISOString();
      emit(true);
    }
  }

  async function start(
    dieId: string,
    kind: CellImagingJobKind,
    options: { allDies?: boolean } = {}
  ): Promise<CellImagingJob> {
    if (active.has(dieId)) throw new ImagingJobBusy("an imaging job is already running for this die");
    await readDieRecord(dataRoot, dieId); // 404s through the error handler when missing
    if (kind === "wireMap" && !(await readSpecimenIndex(dataRoot, dieId))) {
      throw new ImagingJobBadRequest("generate the cell specimens first");
    }
    const now = new Date().toISOString();
    const job: CellImagingJob = {
      dieId,
      kind,
      status: "running",
      phase: "starting",
      percentage: 0,
      error: null,
      startedAt: now,
      updatedAt: now,
      finishedAt: null
    };
    const flag = { cancel: false };
    active.set(dieId, flag);
    jobs.set(dieId, { ...job });
    onJobChange?.({ ...job });
    void run(job, flag, options.allDies === true);
    return { ...job };
  }

  return {
    getJob: (dieId) => jobs.get(dieId) ?? null,
    start,
    stop(dieId) {
      const flag = active.get(dieId);
      if (flag) flag.cancel = true;
      return jobs.get(dieId) ?? null;
    }
  };
}
