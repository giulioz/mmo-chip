import { checkImage, dataPath, limits, safeId } from "../security.js";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { writeDieRecord } from "../store.js";
import type { DieLevelMetadata, DieRecord } from "../types.js";

const VALID_MIME_TYPES = new Set(["image/png", "image/jpeg"]);

export interface ImportProgressUpdate {
  phase: "analyzing" | "tiling" | "persisting" | "completed" | "failed";
  message: string;
  totalLevels: number;
  completedLevels: number;
  currentLevel: number | null;
  currentLevelTiles: number;
  currentLevelProcessedTiles: number;
  totalTiles: number;
  processedTiles: number;
}

export async function importDieShot(params: {
  dataRoot: string;
  filePath: string;
  originalFilename: string;
  mimeType: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  name?: string;
  // Store the original as a tiled TIFF so crops and ML regions get random
  // access instead of decoding a JPEG down to the requested rows.
  tiledOriginal?: boolean;
  // Build the whole tile pyramid now, in one decode, instead of lazily.
  prebuildTiles?: boolean;
  onProgress?: (update: ImportProgressUpdate) => Promise<void> | void;
  logger?: (message: string) => void;
}): Promise<DieRecord> {
  if (!VALID_MIME_TYPES.has(params.mimeType)) {
    throw new Error("Only PNG and JPEG imports are supported.");
  }

  const metadata = await sharp(params.filePath, {
    limitInputPixels: params.limitInputPixels === false ? limits.imagePixels : Math.min(params.limitInputPixels, limits.imagePixels),
    sequentialRead: true
  }).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("Failed to read image dimensions.");
  }

  checkImage(metadata.width, metadata.height, params.limitInputPixels === false ? limits.imagePixels : Math.min(params.limitInputPixels, limits.imagePixels));
  params.logger?.(`analyzed ${params.originalFilename} at ${metadata.width}x${metadata.height}`);

  const id = crypto.randomUUID();
  const extension = params.tiledOriginal ? "tif" : params.mimeType === "image/png" ? "png" : "jpg";
  const dieDir = path.join(params.dataRoot, "dies", id);
  const originalDir = path.join(dieDir, "original");
  const tilesDir = path.join(dieDir, "tiles");
  await fs.mkdir(originalDir, { recursive: true });
  await fs.mkdir(tilesDir, { recursive: true });

  const sanitizedBase = sanitizeName(path.parse(params.originalFilename).name) || "die-shot";
  const originalPath = path.join(originalDir, `${sanitizedBase}.${extension}`);

  const maxDimension = Math.max(metadata.width, metadata.height);
  const maxZoomLevel = Math.max(0, Math.ceil(Math.log2(maxDimension / params.tileSize)));
  const levels = buildLevels(metadata.width, metadata.height, params.tileSize, maxZoomLevel);
  const totalTiles = levels.reduce((sum, level) => sum + level.columns * level.rows, 0);

  try {
    if (params.tiledOriginal) {
      params.logger?.("writing tiled TIFF original");
      await sharp(params.filePath, { limitInputPixels: limits.imagePixels, sequentialRead: true })
        .tiff({ tile: true, tileWidth: 512, tileHeight: 512, compression: "deflate", predictor: "horizontal", bigtiff: true })
        .toFile(originalPath);
    } else {
      await fs.copyFile(params.filePath, originalPath);
    }

    if (params.prebuildTiles) {
      await params.onProgress?.({
        phase: "tiling",
        message: "Building tile pyramid",
        totalLevels: levels.length,
        completedLevels: 0,
        currentLevel: null,
        currentLevelTiles: 0,
        currentLevelProcessedTiles: 0,
        totalTiles,
        processedTiles: 0
      });
      await buildTilePyramid({ source: originalPath, dieDir, record: { width: metadata.width, height: metadata.height, tileSize: params.tileSize, levels } });
      params.logger?.(`built ${totalTiles} tiles across ${levels.length} levels`);
    }
  } catch (error) {
    await fs.rm(dieDir, { recursive: true, force: true });
    throw error;
  }

  await params.onProgress?.({
    phase: "analyzing",
    message: "Preparing lazy tile metadata",
    totalLevels: levels.length,
    completedLevels: 0,
    currentLevel: null,
    currentLevelTiles: 0,
    currentLevelProcessedTiles: 0,
    totalTiles,
    processedTiles: 0
  });

  params.logger?.(`prepared ${levels.length} lazy tile levels`);

  const timestamp = new Date().toISOString();
  const record: DieRecord = {
    id,
    name: params.name?.trim() || sanitizedBase,
    originalFilename: params.originalFilename,
    originalPath,
    width: metadata.width,
    height: metadata.height,
    tileSize: params.tileSize,
    tileFormat: "jpg",
    maxZoomLevel,
    levels,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await params.onProgress?.({
    phase: "persisting",
    message: "Writing die metadata",
    totalLevels: levels.length,
    completedLevels: levels.length,
    currentLevel: maxZoomLevel,
    currentLevelTiles:
      levels[maxZoomLevel]?.columns * levels[maxZoomLevel]?.rows || 0,
    currentLevelProcessedTiles: 0,
    totalTiles,
    processedTiles: 0
  });

  await writeDieRecord(params.dataRoot, record);

  await params.onProgress?.({
    phase: "completed",
    message: `Imported ${record.name}`,
    totalLevels: levels.length,
    completedLevels: levels.length,
    currentLevel: maxZoomLevel,
    currentLevelTiles:
      levels[maxZoomLevel]?.columns * levels[maxZoomLevel]?.rows || 0,
    currentLevelProcessedTiles: 0,
    totalTiles,
    processedTiles: 0
  });

  return record;
}

export function buildLevels(
  width: number,
  height: number,
  tileSize: number,
  maxZoomLevel: number
): DieLevelMetadata[] {
  return Array.from({ length: maxZoomLevel + 1 }, (_, z) => {
    const scale = 2 ** (maxZoomLevel - z);
    const levelWidth = Math.max(1, Math.ceil(width / scale));
    const levelHeight = Math.max(1, Math.ceil(height / scale));

    return {
      z,
      width: levelWidth,
      height: levelHeight,
      columns: Math.ceil(levelWidth / tileSize),
      rows: Math.ceil(levelHeight / tileSize),
      scale
    };
  });
}

/**
 * Writes every level of the tile pyramid from a single decode of the source,
 * using libvips' Deep Zoom writer. Deep Zoom levels halve rounding up and crop
 * edge tiles exactly like buildLevels/ensureTileForRecord, and name tiles
 * `col_row`, so each level maps straight onto tiles/<z>/<x>_<y>.jpg.
 */
export async function buildTilePyramid(params: {
  source: string;
  dieDir: string;
  record: Pick<DieRecord, "width" | "height" | "tileSize" | "levels">;
}) {
  const { width, height, tileSize, levels } = params.record;
  const buildDir = path.join(params.dieDir, `tiles-build-${crypto.randomBytes(4).toString("hex")}`);
  await fs.mkdir(buildDir);
  try {
    await sharp(params.source, { limitInputPixels: limits.imagePixels })
      .jpeg({ quality: 90 })
      .tile({ size: tileSize, overlap: 0, layout: "dz" })
      .toFile(path.join(buildDir, "pyramid.dz"));

    // Deep Zoom level n is the image shrunk to fit 2^n px; ours are counted
    // from the level that fits one tile.
    const dzMaxLevel = Math.ceil(Math.log2(Math.max(width, height)));
    const maxZoomLevel = levels.length - 1;
    for (const level of levels) {
      const from = path.join(buildDir, "pyramid_files", String(dzMaxLevel - (maxZoomLevel - level.z)));
      const names = await fs.readdir(from);
      if (names.length !== level.columns * level.rows) {
        throw new Error(`Tile pyramid level ${level.z} has ${names.length} tiles, expected ${level.columns * level.rows}.`);
      }
      for (const name of names) {
        await fs.rename(path.join(from, name), path.join(from, name.replace(/\.jpeg$/, ".jpg")));
      }
      const to = path.join(params.dieDir, "tiles", String(level.z));
      await fs.rm(to, { recursive: true, force: true });
      await fs.rename(from, to);
    }
  } finally {
    await fs.rm(buildDir, { recursive: true, force: true });
  }
}

export async function ensureTileForRecord(params: {
  dataRoot: string;
  record: DieRecord;
  z: number;
  x: number;
  y: number;
}) {
  const level = params.record.levels[params.z];
  if (!level) {
    throw new Error("Tile level out of range.");
  }

  if (
    params.x < 0 ||
    params.y < 0 ||
    params.x >= level.columns ||
    params.y >= level.rows
  ) {
    throw new Error("Tile coordinates out of range.");
  }

  const tilePath = dataPath(
    params.dataRoot,
    "dies",
    safeId(params.record.id),
    "tiles",
    String(params.z),
    `${params.x}_${params.y}.jpg`
  );

  try {
    await fs.access(tilePath);
    return tilePath;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  const tileDir = path.dirname(tilePath);
  await fs.mkdir(tileDir, { recursive: true });

  const left = params.x * params.record.tileSize;
  const top = params.y * params.record.tileSize;
  const width = Math.min(params.record.tileSize, level.width - left);
  const height = Math.min(params.record.tileSize, level.height - top);
  const sourceLeft = left * level.scale;
  const sourceTop = top * level.scale;
  const sourceWidth = Math.min(params.record.width - sourceLeft, width * level.scale);
  const sourceHeight = Math.min(params.record.height - sourceTop, height * level.scale);

  await pipelineToFileAtomic(
    sharp(params.record.originalPath, {
      limitInputPixels: limits.imagePixels,
      sequentialRead: true
    })
      .extract({
        left: sourceLeft,
        top: sourceTop,
        width: sourceWidth,
        height: sourceHeight
      })
      .resize({
        width,
        height,
        fit: "fill",
        kernel: sharp.kernel.lanczos3
      })
      .jpeg({ quality: 90 }),
    tilePath
  );

  return tilePath;
}

// libvips writes JPEG bytes incrementally to disk, so a concurrent reader
// could fs.access the file mid-write and serve an incomplete JPEG. Write to
// a temp path and rename atomically — fs.rename is atomic on POSIX, so the
// canonical path only ever points at a fully-written file.
async function pipelineToFileAtomic(pipeline: sharp.Sharp, finalPath: string) {
  const tempPath = `${finalPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    await pipeline.toFile(tempPath);
    await fs.rename(tempPath, finalPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => {});
    throw error;
  }
}

function sanitizeName(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}
