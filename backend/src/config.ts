import { limits, positiveLimit } from "./security.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultTileConcurrency } from "./dieImport/jobs.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(moduleDirectory, "../..");
const defaultDataRoot = path.join(repoRoot, "data");


export const config: {
  port: number;
  dataRoot: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  mlSidecarUrl: string;
  mlPredictPad: number;
} = {
  port: Number(process.env.PORT ?? 3001),
  dataRoot: process.env.CHIPTOOL_DATA_ROOT ?? defaultDataRoot,
  tileSize: positiveLimit("CHIPTOOL_TILE_SIZE", 512, 2048),
  limitInputPixels: limits.imagePixels,
  tileConcurrency: positiveLimit("CHIPTOOL_TILE_CONCURRENCY", defaultTileConcurrency(), 18),
  mlSidecarUrl: process.env.CHIPTOOL_ML_SIDECAR_URL ?? "http://127.0.0.1:8001",
  mlPredictPad: Number(process.env.CHIPTOOL_ML_PREDICT_PAD ?? 128)
};
