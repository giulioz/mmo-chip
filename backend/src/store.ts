import { promises as fs } from "node:fs";
import path from "node:path";
import type { MLInferenceJob } from "shared";
import type { DieAnnotations, DieIndex, DieRecord, ImportJobIndex, ImportJobRecord } from "./types.js";

const EMPTY_DIE_INDEX: DieIndex = { dies: [] };
const EMPTY_JOB_INDEX: ImportJobIndex = { jobs: [] };

export async function ensureDataStore(dataRoot: string) {
  await fs.mkdir(path.join(dataRoot, "dies"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "jobs"), { recursive: true });
  await fs.mkdir(path.join(dataRoot, "ml-jobs"), { recursive: true });
  await writeJsonIfMissing(path.join(dataRoot, "index.json"), EMPTY_DIE_INDEX);
  await writeJsonIfMissing(path.join(dataRoot, "jobs", "index.json"), EMPTY_JOB_INDEX);
}

export async function listDieRecords(dataRoot: string): Promise<DieRecord[]> {
  await ensureDataStore(dataRoot);
  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const records = await Promise.all(index.dies.map((dieId) => readDieRecord(dataRoot, dieId)));

  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readDieRecord(dataRoot: string, dieId: string): Promise<DieRecord> {
  return readJson<DieRecord>(path.join(dataRoot, "dies", dieId, "metadata.json"));
}

export async function writeDieRecord(dataRoot: string, record: DieRecord) {
  const dieDir = path.join(dataRoot, "dies", record.id);
  await fs.mkdir(dieDir, { recursive: true });
  await fs.writeFile(
    path.join(dieDir, "metadata.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8"
  );

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  if (!index.dies.includes(record.id)) {
    index.dies.push(record.id);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

export async function deleteDieRecord(dataRoot: string, dieId: string) {
  const dieDir = path.join(dataRoot, "dies", dieId);
  await fs.rm(dieDir, { recursive: true, force: true });

  const indexPath = path.join(dataRoot, "index.json");
  const index = await readJson<DieIndex>(indexPath, EMPTY_DIE_INDEX);
  const nextDies = index.dies.filter((id) => id !== dieId);
  if (nextDies.length !== index.dies.length) {
    await fs.writeFile(indexPath, `${JSON.stringify({ dies: nextDies }, null, 2)}\n`, "utf8");
  }
}

export async function listImportJobs(dataRoot: string): Promise<ImportJobRecord[]> {
  await ensureDataStore(dataRoot);
  const indexPath = path.join(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  const jobs = await Promise.all(index.jobs.map((jobId) => readImportJob(dataRoot, jobId)));

  return jobs.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function readImportJob(
  dataRoot: string,
  jobId: string
): Promise<ImportJobRecord> {
  return readJson<ImportJobRecord>(path.join(dataRoot, "jobs", `${jobId}.json`));
}

export async function writeImportJob(dataRoot: string, job: ImportJobRecord) {
  await fs.writeFile(
    path.join(dataRoot, "jobs", `${job.id}.json`),
    `${JSON.stringify(job, null, 2)}\n`,
    "utf8"
  );

  const indexPath = path.join(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  if (!index.jobs.includes(job.id)) {
    index.jobs.push(job.id);
    await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }
}

export async function deleteImportJobsForDie(dataRoot: string, dieId: string) {
  const indexPath = path.join(dataRoot, "jobs", "index.json");
  const index = await readJson<ImportJobIndex>(indexPath, EMPTY_JOB_INDEX);
  const jobs = await Promise.all(index.jobs.map(async (jobId) => ({
    jobId,
    job: await readImportJob(dataRoot, jobId)
  })));

  const jobsToDelete = jobs.filter(({ job }) => job.dieId === dieId);
  await Promise.all(
    jobsToDelete.map(({ jobId }) =>
      fs.rm(path.join(dataRoot, "jobs", `${jobId}.json`), { force: true })
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
    path.join(dataRoot, "ml-jobs", `${dieId}.json`),
    null
  );
}

/** Every persisted ML inference job (one per die). */
export async function listMLJobs(
  dataRoot: string
): Promise<MLInferenceJob[]> {
  const dir = path.join(dataRoot, "ml-jobs");
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch {
    return [];
  }
  const jobs = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map((f) => readJson<MLInferenceJob | null>(path.join(dir, f), null))
  );
  return jobs.filter((j): j is MLInferenceJob => j !== null);
}

export async function writeMLJob(
  dataRoot: string,
  job: MLInferenceJob
): Promise<void> {
  await fs.mkdir(path.join(dataRoot, "ml-jobs"), { recursive: true });
  // Atomic (tmp + rename): a sweep persists progress on every tick without
  // awaiting, so plain writeFile calls can interleave and a concurrent
  // reader would see one body partially overwritten by another.
  const file = path.join(dataRoot, "ml-jobs", `${job.dieId}.json`);
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

/** Drop every persisted ML job — used when the model changes (the old jobs'
 *  progress no longer reflects the new checkpoint's cache). */
export async function clearMLJobs(dataRoot: string): Promise<void> {
  await fs.rm(path.join(dataRoot, "ml-jobs"), { recursive: true, force: true });
  await fs.mkdir(path.join(dataRoot, "ml-jobs"), { recursive: true });
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
  const filePath = path.join(dataRoot, "dies", dieId, "annotations.json");
  const data = await readJson<DieAnnotations>(filePath, EMPTY_ANNOTATIONS);
  return { ...EMPTY_ANNOTATIONS, ...data };
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
  const nextRev = (annotations.rev ?? 0) + 1;
  const stamped: DieAnnotations = { ...annotations, rev: nextRev };
  const filePath = path.join(dataRoot, "dies", dieId, "annotations.json");
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
