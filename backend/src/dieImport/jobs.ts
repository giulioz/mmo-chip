import { dataPath, HttpError } from "../security.js";
import { importWork } from "../workQueue.js";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { importDieShot, type ImportProgressUpdate } from "./importer.js";
import { readImportJob, writeImportJob } from "../store.js";
import type { createTileScheduler } from "../tileScheduler.js";
import type { ImportJobProgress, ImportJobRecord } from "../types.js";

const LOG_STEP_PERCENTAGE = 10;

export function createImportJobManager(config: {
  dataRoot: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  tileScheduler: ReturnType<typeof createTileScheduler>;
}) {
  const activeJobs = new Set<string>();
  let admittedImports = 0;

  async function enqueueImportJob(file: Express.Multer.File) {
    if (admittedImports >= 5) throw new HttpError(429, "Import queue is full; retry later");
    admittedImports++;
    try {
      const jobId = crypto.randomUUID();
      const jobDirectory = dataPath(config.dataRoot, "jobs", jobId);
      await fs.mkdir(jobDirectory, { recursive: true });

      const extension =
        path.extname(file.originalname) || extensionForMimeType(file.mimetype) || ".bin";
      const inputFilePath = path.join(jobDirectory, `upload${extension}`);
      await fs.copyFile(file.path, inputFilePath);

      const timestamp = new Date().toISOString();
      const job: ImportJobRecord = {
        id: jobId,
        type: "import-die",
        status: "queued",
        originalFilename: file.originalname,
        mimeType: file.mimetype,
        inputFilePath,
        dieId: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        startedAt: null,
        finishedAt: null,
        progress: createProgress({
          phase: "queued",
          message: "Queued for import",
          totalLevels: 0,
          completedLevels: 0,
          currentLevel: null,
          currentLevelTiles: 0,
          currentLevelProcessedTiles: 0,
          totalTiles: 0,
          processedTiles: 0
        })
      };

      await writeImportJob(config.dataRoot, job);
      console.log(`[import:${jobId}] queued ${file.originalname}`);

      setImmediate(() => {
        void importWork(() => runImportJob(jobId)).catch(error => console.error("Import admission failed", error)).finally(() => { admittedImports--; });
      });

      return job;
    } catch (error) { admittedImports--; throw error; }
  }

  async function runImportJob(jobId: string) {
    if (activeJobs.has(jobId)) {
      return;
    }

    activeJobs.add(jobId);
    let job = await readImportJob(config.dataRoot, jobId);
    let lastLoggedStep = -1;

    const persistProgress = async (update: ImportProgressUpdate) => {
      job = {
        ...job,
        status: update.phase === "completed" ? "completed" : "running",
        updatedAt: new Date().toISOString(),
        progress: createProgress(update)
      };
      await writeImportJob(config.dataRoot, job);

      const nextLoggedStep = Math.floor(job.progress.percentage / LOG_STEP_PERCENTAGE);
      if (
        update.phase !== "tiling" ||
        nextLoggedStep > lastLoggedStep ||
        job.progress.percentage === 100
      ) {
        lastLoggedStep = nextLoggedStep;
        console.log(
          `[import:${jobId}] ${job.progress.message} (${job.progress.percentage.toFixed(1)}%)`
        );
      }
    };

    try {
      job = {
        ...job,
        status: "running",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: createProgress({
          phase: "analyzing",
          message: "Analyzing image",
          totalLevels: 0,
          completedLevels: 0,
          currentLevel: null,
          currentLevelTiles: 0,
          currentLevelProcessedTiles: 0,
          totalTiles: 0,
          processedTiles: 0
        })
      };
      await writeImportJob(config.dataRoot, job);
      console.log(`[import:${jobId}] started`);

      const record = await importDieShot({
        dataRoot: config.dataRoot,
        filePath: job.inputFilePath,
        originalFilename: job.originalFilename,
        mimeType: job.mimeType,
        tileSize: config.tileSize,
        limitInputPixels: config.limitInputPixels,
        tileConcurrency: config.tileConcurrency,
        onProgress: persistProgress,
        logger: (message) => console.log(`[import:${jobId}] ${message}`)
      });
      config.tileScheduler.enqueueBackground(record);

      const totalTiles = record.levels.reduce(
        (sum, level) => sum + level.columns * level.rows,
        0
      );
      const finalLevel = record.levels[record.maxZoomLevel];

      job = {
        ...job,
        status: "completed",
        dieId: record.id,
        error: null,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: createProgress({
          phase: "completed",
          message: `Completed import for ${record.name}`,
          totalLevels: record.levels.length,
          completedLevels: record.levels.length,
          currentLevel: record.maxZoomLevel,
          currentLevelTiles: finalLevel ? finalLevel.columns * finalLevel.rows : 0,
          currentLevelProcessedTiles: 0,
          totalTiles,
          processedTiles: 0
        })
      };

      await writeImportJob(config.dataRoot, job);
      await fs.rm(job.inputFilePath, { force: true });
      console.log(`[import:${jobId}] completed as die ${record.id}`);
    } catch (error) {
      job = {
        ...job,
        status: "failed",
        error: error instanceof Error ? error.message : "Unknown import error",
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: createProgress({
          phase: "failed",
          message:
            error instanceof Error ? error.message : "Import failed unexpectedly",
          totalLevels: job.progress.totalLevels,
          completedLevels: job.progress.completedLevels,
          currentLevel: job.progress.currentLevel,
          currentLevelTiles: job.progress.currentLevelTiles,
          currentLevelProcessedTiles: job.progress.currentLevelProcessedTiles,
          totalTiles: job.progress.totalTiles,
          processedTiles: job.progress.processedTiles
        })
      };

      await writeImportJob(config.dataRoot, job);
      console.error(`[import:${jobId}] failed: ${job.error}`);
    } finally {
      await fs.rm(job.inputFilePath, { force: true });
      activeJobs.delete(jobId);
    }
  }

  return {
    enqueueImportJob
  };
}

export function defaultTileConcurrency() {
  return Math.max(2, Math.min(8, os.availableParallelism?.() ?? 4));
}

function createProgress(update: Omit<ImportJobProgress, "percentage">): ImportJobProgress {
  // The import job no longer processes tiles itself — tile generation runs
  // asynchronously in the scheduler — so percentage tracks job lifecycle:
  // 0% until the metadata write succeeds, 100% on completion.
  if (update.phase === "completed") return { ...update, percentage: 100 };
  const percentage =
    update.totalTiles === 0
      ? 0
      : Math.min(100, (update.processedTiles / update.totalTiles) * 100);
  return { ...update, percentage };
}

function extensionForMimeType(mimeType: string) {
  if (mimeType === "image/png") {
    return ".png";
  }

  if (mimeType === "image/jpeg") {
    return ".jpg";
  }

  return "";
}
