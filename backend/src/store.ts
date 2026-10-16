import { checkImage, dataPath, HttpError, safeId } from "./security.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { MLInferenceJob } from "shared";
import type { DieAnnotations, DieIndex, DieRecord, ImportJobIndex, ImportJobRecord } from "./types.js";

const EMPTY_DIE_INDEX: DieIndex = { dies: [] };
const EMPTY_JOB_INDEX: ImportJobIndex = { jobs: [] };

export async function ensureDataStore(dataRoot: string) {
  await fs.mkdir(dataPath(dataRoot, "dies"), { recursive: true });
  await fs.mkdir(dataPath(dataRoot, "jobs"), { recursive: true });
  await fs.mkdir(dataPath(dataRoot, "ml-jobs"), { recursive: true });
  await writeJsonIfMissing(dataPath(dataRoot, "index.json"), EMPTY_DIE_INDEX);
  await writeJsonIfMissing(dataPath(dataRoot, "jobs", "index.json"), EMPTY_JOB_INDEX);
}

export async function listDieRecords(dataRoot: string): Promise<DieRecord[]> {
  await ensureDataStore(dataRoot);
  const indexPath = dataPath(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const loaded = await Promise.all(index.dies.map(async (dieId) => {
    try { return await readDieRecord(dataRoot, dieId); }
    catch (error) {
      if (error instanceof HttpError || (error as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`Skipping invalid die metadata: ${JSON.stringify(dieId)}`);
        return null;
      }
      throw error;
    }
  }));
  const records = loaded.filter((record): record is DieRecord => record !== null);

  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readDieRecord(dataRoot: string, dieId: string): Promise<DieRecord> {
  safeId(dieId);
  const record = await readJson<DieRecord>(dataPath(dataRoot, "dies", dieId, "metadata.json"));
  validateRecord(dataRoot, dieId, record);
  return record;
}

export async function writeDieRecord(dataRoot: string, record: DieRecord) {
  validateRecord(dataRoot, record.id, record);
  const dieDir = dataPath(dataRoot, "dies", safeId(record.id));
  await fs.mkdir(dieDir, { recursive: true });
  await fs.writeFile(
    dataPath(dataRoot, "dies", record.id, "metadata.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );

  const indexPath = dataPath(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  if (!index.dies.includes(record.id)) {
    index.dies.push(record.id);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

export async function deleteDieRecord(dataRoot: string, dieId: string) {
  const dieDir = dataPath(dataRoot, "dies", safeId(dieId));
  await fs.rm(dieDir, { recursive: true, force: true });

  const indexPath = dataPath(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const nextDies = index.dies.filter((id) => id !== dieId);
  if (nextDies.length !== index.dies.length) {
    await fs.writeFile(indexPath, `${JSON.stringify({ dies: nextDies }, null, 2)}\n`, "utf8");
  }
}

export async function listImportJobs(dataRoot: string): Promise<ImportJobRecord[]> {
  await ensureDataStore(dataRoot);
  const indexPath = dataPath(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  const jobs = await Promise.all(index.jobs.map((jobId) => readImportJob(dataRoot, jobId)));

  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readImportJob(
  dataRoot: string,
  jobId: string
): Promise<ImportJobRecord> {
  safeId(jobId);
  const job = await readJson<ImportJobRecord>(dataPath(dataRoot, "jobs", `${jobId}.json`));
  validateImportJob(dataRoot, jobId, job);
  return job;
}

export async function writeImportJob(dataRoot: string, job: ImportJobRecord) {
  validateImportJob(dataRoot, job.id, job);
  await fs.writeFile(
    dataPath(dataRoot, "jobs", `${job.id}.json`),
    `${JSON.stringify(job, null, 2)}\n`,
    "utf8"
  );

  const indexPath = dataPath(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  if (!index.jobs.includes(job.id)) {
    index.jobs.push(job.id);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

export async function deleteImportJobsForDie(dataRoot: string, dieId: string) {
  const indexPath = dataPath(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  const jobs = await Promise.all(index.jobs.map(async (jobId) => ({
    jobId,
    job: await readImportJob(dataRoot, jobId)
  })));

  const jobsToDelete = jobs.filter(({ job }) => job.dieId === dieId);
  await Promise.all(
    jobsToDelete.map(({ jobId }) =>
      fs.rm(dataPath(dataRoot, "jobs", `${jobId}.json`), { force: true })
    )
  );

  if (jobsToDelete.length > 0) {
    const remainingJobs = index.jobs.filter(
      (jobId) => !jobsToDelete.some((job) => job.jobId === jobId)
    );
    await fs.writeFile(
      indexPath,
      `${JSON.stringify({ jobs: remainingJobs }, null, 2)}\n`,
      "utf8"
    );
  }
}

// ── ML inference jobs (one per die, keyed by dieId) ───────────────

export async function readMLJob(
  dataRoot: string,
  dieId: string
): Promise<MLInferenceJob | null> {
  return readJson<MLInferenceJob | null>(
    dataPath(dataRoot, "ml-jobs", `${safeId(dieId)}.json`),
    null
  );
}

/** Every persisted ML inference job (one per die). */
export async function listMLJobs(
  dataRoot: string
): Promise<MLInferenceJob[]> {
  const dir = dataPath(dataRoot, "ml-jobs");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jobs = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<MLInferenceJob | null>(dataPath(dataRoot, "ml-jobs", `${safeId(f.slice(0, -5))}.json`), null))
  );
  return jobs.filter((j): j is MLInferenceJob => j !== null);
}

export async function writeMLJob(
  dataRoot: string,
  job: MLInferenceJob
): Promise<void> {
  await fs.mkdir(dataPath(dataRoot, "ml-jobs"), { recursive: true });
  // Atomic (tmp + rename): a sweep persists progress on every tick without
  // awaiting, so plain writeFile calls can interleave and a concurrent
  // reader would see one body partially overwritten by another.
  const file = dataPath(dataRoot, "ml-jobs", `${safeId(job.dieId)}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** Drop every persisted ML job — used when the model changes (the old jobs'
 *  progress no longer reflects the new checkpoint's cache). */
export async function clearMLJobs(dataRoot: string): Promise<void> {
  await fs.rm(dataPath(dataRoot, "ml-jobs"), { recursive: true, force: true });
  await fs.mkdir(dataPath(dataRoot, "ml-jobs"), { recursive: true });
}

const EMPTY_ANNOTATIONS: DieAnnotations = {
  version: 2,
  rev: 0,
  nets: [],
  cellTypes: [],
  cells: [],
  grids: []
};

export async function readAnnotations(dataRoot: string, dieId: string): Promise<DieAnnotations> {
  const filePath = dataPath(dataRoot, "dies", safeId(dieId), "annotations.json");
  const data = await readJson<DieAnnotations>(filePath, EMPTY_ANNOTATIONS);
  const annotations = { ...EMPTY_ANNOTATIONS, ...data };
  validateAnnotations(annotations);
  return annotations;
}

/**
 * Persist annotations and bump the monotonic revision counter. Returns the
 * new revision so callers (the WS broadcaster) can include it in the change
 * notification.
 */
export async function writeAnnotations(
  dataRoot: string,
  dieId: string,
  annotations: DieAnnotations
): Promise<number> {
  validateAnnotations(annotations);
  const nextRev = (annotations.rev ?? 0) + 1;
  const stamped: DieAnnotations = { ...annotations, rev: nextRev };
  const filePath = dataPath(dataRoot, "dies", safeId(dieId), "annotations.json");
  await fs.writeFile(filePath, `${JSON.stringify(stamped, null, 2)}\n`, "utf8");
  return nextRev;
}

// Per-die mutex: serializes any read-modify-write cycle on a die's files.
// In-process only (single Node instance). Reads via readAnnotations are not
// gated since fs.writeFile is atomic at the OS level — a concurrent reader
// sees either pre- or post-write content, never torn JSON.
const dieLocks = new Map<string, Promise<unknown>>();

export async function withDieLock<T>(dieId: string, fn: () => Promise<T>): Promise<T> {
  const previous = dieLocks.get(dieId) ?? Promise.resolve();
  let releaseNext!: () => void;
  const next = previous.then(
    () => new Promise<void>((resolve) => {
      releaseNext = resolve;
    })
  );
  dieLocks.set(dieId, next);

  await previous;
  try {
    return await fn();
  } finally {
    releaseNext();
    if (dieLocks.get(dieId) === next) {
      dieLocks.delete(dieId);
    }
  }
}

async function readJson<T>(filePath: string, fallback?: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && fallback !== undefined) {
      return fallback;
    }
    throw error;
  }
}

async function writeJsonIfMissing(filePath: string, value: unknown) {
  try {
    await fs.access(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  }
}

function validateRecord(dataRoot: string, dieId: string, record: DieRecord): void {
  safeId(dieId);
  if (!record || record.id !== dieId) throw new HttpError(400, "Metadata ID does not match lookup ID");
  checkImage(record.width, record.height);
  if (typeof record.name !== "string" || typeof record.createdAt !== "string" || typeof record.updatedAt !== "string" || typeof record.originalFilename !== "string" || !["png", "jpg"].includes(record.tileFormat) ||
      !Number.isSafeInteger(record.tileSize) || record.tileSize <= 0 || record.tileSize > 2048 ||
      !Number.isInteger(record.maxZoomLevel) || record.maxZoomLevel < 0 || record.maxZoomLevel > 32 ||
      !Array.isArray(record.levels) || record.levels.length !== record.maxZoomLevel + 1) {
    throw new HttpError(400, "Invalid die metadata");
  }
  for (const [z, level] of record.levels.entries()) {
    if (!level || typeof level !== "object") throw new HttpError(400, "Invalid tile pyramid metadata");
    const factor = 2 ** (record.maxZoomLevel - z);
    const width = Math.ceil(record.width / factor), height = Math.ceil(record.height / factor);
    if (level.z !== z || level.scale !== factor || level.width !== width || level.height !== height ||
        level.columns !== Math.ceil(width / record.tileSize) || level.rows !== Math.ceil(height / record.tileSize)) {
      throw new HttpError(400, "Invalid tile pyramid metadata");
    }
  }
  if (typeof record.originalPath !== "string") throw new HttpError(400, "Invalid original image path");
  const originalDir = dataPath(dataRoot, "dies", dieId, "original");
  const original = path.resolve(record.originalPath);
  if (path.dirname(original) !== originalDir) throw new HttpError(400, "Original image must be inside its die directory");
  record.originalPath = dataPath(dataRoot, path.relative(path.resolve(dataRoot), original));
}
function validateImportJob(dataRoot: string, jobId: string, job: ImportJobRecord): void {
  safeId(jobId);
  if (!job || job.id !== jobId || typeof job.inputFilePath !== "string" ||
      path.dirname(path.resolve(job.inputFilePath)) !== dataPath(dataRoot, "jobs", jobId)) {
    throw new HttpError(400, "Invalid import job metadata");
  }
  job.inputFilePath = dataPath(dataRoot, path.relative(path.resolve(dataRoot), path.resolve(job.inputFilePath)));
  if (job.dieId != null) safeId(job.dieId);
}
function validateAnnotations(annotations: DieAnnotations): void {
  if (!annotations || !Array.isArray(annotations.cellTypes) || !Array.isArray(annotations.cells)) throw new HttpError(400, "Invalid annotations");
  for (const type of annotations.cellTypes) safeId(type.id);
  for (const cell of annotations.cells) {
    safeId(cell.id); safeId(cell.cellTypeId);
    if (cell.cellTypeDieId != null) safeId(cell.cellTypeDieId);
  }
}
