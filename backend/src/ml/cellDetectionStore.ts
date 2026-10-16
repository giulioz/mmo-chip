import { promises as fs } from "node:fs";
import path from "node:path";
import type { CellDetectionResult } from "shared";

/**
 * Persistence for cell-detection results. One JSON per (die, cell type)
 * under `data/dies/<dieId>/cell-detections/` — deliberately a separate
 * directory from `annotations.json` so nothing here can touch human work:
 * "clear results" removes only this directory.
 */

export function cellDetectionsDir(dataRoot: string, dieId: string): string {
  return path.join(dataRoot, "dies", dieId, "cell-detections");
}

function fileFor(dataRoot: string, dieId: string, cellTypeId: string): string {
  return path.join(cellDetectionsDir(dataRoot, dieId), `${cellTypeId}.json`);
}

export async function readCellDetection(
  dataRoot: string,
  dieId: string,
  cellTypeId: string
): Promise<CellDetectionResult | null> {
  try {
    const raw = await fs.readFile(fileFor(dataRoot, dieId, cellTypeId), "utf8");
    return JSON.parse(raw) as CellDetectionResult;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function listCellDetections(
  dataRoot: string,
  dieId: string
): Promise<CellDetectionResult[]> {
  const dir = cellDetectionsDir(dataRoot, dieId);
  let files: string[];
  try {
    files = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const results = await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        try {
          return JSON.parse(await fs.readFile(path.join(dir, f), "utf8")) as CellDetectionResult;
        } catch {
          return null; // a half-written / corrupt file shouldn't sink the list
        }
      })
  );
  return results
    .filter((r): r is CellDetectionResult => r !== null && r.version === 1)
    .sort((a, b) => a.cellTypeName.localeCompare(b.cellTypeName));
}

export async function writeCellDetection(
  dataRoot: string,
  result: CellDetectionResult
): Promise<void> {
  const file = fileFor(dataRoot, result.dieId, result.cellTypeId);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(result), "utf8");
  await fs.rename(tmp, file);
}

export async function deleteCellDetection(
  dataRoot: string,
  dieId: string,
  cellTypeId: string
): Promise<void> {
  await fs.rm(fileFor(dataRoot, dieId, cellTypeId), { force: true });
}

/** Remove every result for a die (only the `cell-detections/` directory). */
export async function clearCellDetections(dataRoot: string, dieId: string): Promise<void> {
  await fs.rm(cellDetectionsDir(dataRoot, dieId), { recursive: true, force: true });
}

/** Mark / unmark detections as user-dismissed. Returns the updated result,
 *  or null when there is no result for that type. */
export async function setCellDetectionsDismissed(
  dataRoot: string,
  dieId: string,
  cellTypeId: string,
  ids: ReadonlyArray<string>,
  dismissed: boolean
): Promise<CellDetectionResult | null> {
  const current = await readCellDetection(dataRoot, dieId, cellTypeId);
  if (!current) return null;
  const set = new Set(current.dismissed ?? []);
  const known = new Set(current.detections.map((d) => d.id));
  for (const id of ids) {
    if (!known.has(id)) continue;
    if (dismissed) set.add(id);
    else set.delete(id);
  }
  const next: CellDetectionResult = { ...current, dismissed: [...set] };
  await writeCellDetection(dataRoot, next);
  return next;
}
