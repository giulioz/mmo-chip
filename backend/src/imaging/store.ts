import { promises as fs } from "node:fs";
import path from "node:path";
import type { CellSpecimenIndex, WireMapInfo } from "shared";

/**
 * Derived imagery lives in its own folders beside a die's annotations —
 * `cell-specimens/` and `wire-map/` — so regenerating or clearing it can
 * never touch `annotations.json`.
 */
export const specimensDir = (dataRoot: string, dieId: string) =>
  path.join(dataRoot, "dies", dieId, "cell-specimens");
export const wireMapDir = (dataRoot: string, dieId: string) =>
  path.join(dataRoot, "dies", dieId, "wire-map");

export const specimenPath = (dataRoot: string, dieId: string, cellTypeId: string) =>
  path.join(specimensDir(dataRoot, dieId), `${cellTypeId}.png`);
/** High-resolution display rendering (sharpest instances, affine-registered,
 *  reconstructed at DISPLAY_SCALE× and sharpened). The plain specimen above
 *  stays the measurement reference for the wire map. */
export const specimenDisplayPath = (dataRoot: string, dieId: string, cellTypeId: string) =>
  path.join(specimensDir(dataRoot, dieId), `${cellTypeId}@2x.png`);
/** Per-pixel MAD ×SPREAD_SCALE, clipped to 8 bits. */
export const spreadPath = (dataRoot: string, dieId: string, cellTypeId: string) =>
  path.join(specimensDir(dataRoot, dieId), `${cellTypeId}.spread.png`);
export const SPREAD_SCALE = 4;

export const wireTilePath = (dataRoot: string, dieId: string, z: number, x: number, y: number) =>
  path.join(wireMapDir(dataRoot, dieId), String(z), `${x}_${y}.png`);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  await fs.rename(tmp, file);
}

export const readSpecimenIndex = (dataRoot: string, dieId: string) =>
  readJson<CellSpecimenIndex>(path.join(specimensDir(dataRoot, dieId), "index.json"));
export const writeSpecimenIndex = (dataRoot: string, index: CellSpecimenIndex) =>
  writeJsonAtomic(path.join(specimensDir(dataRoot, index.dieId), "index.json"), index);
export const readWireMapInfo = (dataRoot: string, dieId: string) =>
  readJson<WireMapInfo>(path.join(wireMapDir(dataRoot, dieId), "info.json"));
export const writeWireMapInfo = (dataRoot: string, info: WireMapInfo) =>
  writeJsonAtomic(path.join(wireMapDir(dataRoot, info.dieId), "info.json"), info);

export const clearSpecimens = (dataRoot: string, dieId: string) =>
  fs.rm(specimensDir(dataRoot, dieId), { recursive: true, force: true });
export const clearWireMap = (dataRoot: string, dieId: string) =>
  fs.rm(wireMapDir(dataRoot, dieId), { recursive: true, force: true });
