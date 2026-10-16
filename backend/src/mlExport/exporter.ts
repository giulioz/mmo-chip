import { checkRegion, dataPath, limits } from "../security.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { readAnnotations, readDieRecord } from "../store.js";

// Output JPG side length. Each ROI is cropped from the source image and
// resized to this resolution.
export const ML_EXPORT_RESOLUTION = 512;

const ML_EXPORTS_SUBDIR = "ml_exports";
const ALL_CLASSES = ["point_via", "irregular_via", "trace"] as const;

type ManifestGeometry =
  | { kind: "point"; x: number; y: number }
  | { kind: "polyline"; points: { x: number; y: number }[] }
  | { kind: "rectangle"; x: number; y: number; width: number; height: number }
  | { kind: "polygon"; points: { x: number; y: number }[] };

interface ManifestAnnotation {
  class: "point_via" | "irregular_via" | "trace";
  geometry: ManifestGeometry;
}

interface ManifestIgnore {
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RoiManifest {
  source_image: string;
  roi_bbox: [number, number, number, number];
  roi_classes: string[];
  ml_config: { point_via_size: number; trace_width: number };
  annotations: ManifestAnnotation[];
  ignore?: ManifestIgnore[];
}

export interface MLExportResult {
  exportDir: string;
  totalRois: number;
}

export async function runMLExport(params: {
  dataRoot: string;
  dieId: string;
  approxViaRadiusPx: number; // legacy fallback when mlConfig is absent
  logger?: (message: string) => void;
}): Promise<MLExportResult> {
  const { dataRoot, dieId, approxViaRadiusPx, logger } = params;
  const log = logger ?? (() => {});

  const record = await readDieRecord(dataRoot, dieId);
  const annotations = await readAnnotations(dataRoot, dieId);
  const rois = annotations.rois ?? [];
  const humanAnnotations = annotations.annotations ?? [];
  const ignores = annotations.ignores ?? [];
  const nets = annotations.nets ?? [];
  const mlConfig = annotations.mlConfig ?? {
    pointViaSize: approxViaRadiusPx > 0 ? approxViaRadiusPx : 6,
    traceWidth: 4
  };

  // nets is a node/edge graph; flatten to source-space segments once.
  const netSegments: { ax: number; ay: number; bx: number; by: number }[] = [];
  for (const net of nets) {
    const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
    for (const e of net.edges) {
      const a = nodeById.get(e.from);
      const b = nodeById.get(e.to);
      if (a && b) netSegments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
    }
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const exportDirAbs = dataPath(dataRoot, ML_EXPORTS_SUBDIR, `${record.id}-${timestamp}`);
  await fs.mkdir(exportDirAbs, { recursive: true });

  log(`[ml-export] ${dieId} → ${exportDirAbs} (${rois.length} ROIs, ${netSegments.length} net segments)`);

  let written = 0;
  for (let i = 0; i < rois.length; i++) {
    const roi = rois[i];
    const x0 = Math.max(0, Math.round(roi.x));
    const y0 = Math.max(0, Math.round(roi.y));
    const x1 = Math.min(record.width, Math.round(roi.x + roi.width));
    const y1 = Math.min(record.height, Math.round(roi.y + roi.height));
    const cropWidth = x1 - x0;
    const cropHeight = y1 - y0;
    if (cropWidth <= 0 || cropHeight <= 0) {
      log(`[ml-export]   roi_${i + 1} skipped (out of bounds)`);
      continue;
    }

    const jpgPath = path.join(exportDirAbs, `roi_${i + 1}.jpg`);
    const jsonPath = path.join(exportDirAbs, `roi_${i + 1}.json`);

    checkRegion(cropWidth, cropHeight);
    await sharp(record.originalPath, { limitInputPixels: limits.imagePixels, sequentialRead: true })
      .extract({ left: x0, top: y0, width: cropWidth, height: cropHeight })
      .resize({
        width: ML_EXPORT_RESOLUTION,
        height: ML_EXPORT_RESOLUTION,
        fit: "fill",
        kernel: sharp.kernel.lanczos3
      })
      .jpeg({ quality: 92 })
      .toFile(jpgPath);

    // fit:"fill" → x/y scale independently. Size driver uses the geometric
    // mean so it's fair under edge clipping (scaleX==scaleY when unclipped).
    const scaleX = ML_EXPORT_RESOLUTION / cropWidth;
    const scaleY = ML_EXPORT_RESOLUTION / cropHeight;
    const sizeScale = Math.sqrt(scaleX * scaleY);
    const sx = (x: number) => (x - x0) * scaleX;
    const sy = (y: number) => (y - y0) * scaleY;
    const bboxHits = (
      pxMin: number, pyMin: number, pxMax: number, pyMax: number
    ) => !(pxMax <= x0 || pxMin >= x1 || pyMax <= y0 || pyMin >= y1);

    const roiClasses = roi.classes ?? [...ALL_CLASSES];
    const out: ManifestAnnotation[] = [];
    let pts = 0, regions = 0, traces = 0;

    // ── Authored point_via / irregular_via ──────────────────────────
    for (const a of humanAnnotations) {
      const g = a.geometry;
      if (a.class === "point_via" && g.kind === "point") {
        if (g.x >= x0 && g.x <= x1 && g.y >= y0 && g.y <= y1) {
          out.push({ class: "point_via", geometry: { kind: "point", x: sx(g.x), y: sy(g.y) } });
          pts += 1;
        }
      } else if (a.class === "irregular_via" && g.kind === "rectangle") {
        const rx0 = Math.max(x0, g.x);
        const ry0 = Math.max(y0, g.y);
        const rx1 = Math.min(x1, g.x + g.width);
        const ry1 = Math.min(y1, g.y + g.height);
        if (rx1 > rx0 && ry1 > ry0) {
          out.push({
            class: "irregular_via",
            geometry: {
              kind: "rectangle",
              x: sx(rx0), y: sy(ry0),
              width: (rx1 - rx0) * scaleX, height: (ry1 - ry0) * scaleY
            }
          });
          regions += 1;
        }
      } else if (a.class === "irregular_via" && g.kind === "polygon") {
        if (g.points.length < 3) continue;
        let pxMin = Infinity, pyMin = Infinity, pxMax = -Infinity, pyMax = -Infinity;
        for (const p of g.points) {
          pxMin = Math.min(pxMin, p.x); pyMin = Math.min(pyMin, p.y);
          pxMax = Math.max(pxMax, p.x); pyMax = Math.max(pyMax, p.y);
        }
        if (!bboxHits(pxMin, pyMin, pxMax, pyMax)) continue;
        out.push({
          class: "irregular_via",
          geometry: { kind: "polygon", points: g.points.map((p) => ({ x: sx(p.x), y: sy(p.y) })) }
        });
        regions += 1;
      }
    }

    // ── Traces materialized from nets (never persisted) ─────────────
    for (const s of netSegments) {
      const pxMin = Math.min(s.ax, s.bx), pxMax = Math.max(s.ax, s.bx);
      const pyMin = Math.min(s.ay, s.by), pyMax = Math.max(s.ay, s.by);
      if (!bboxHits(pxMin, pyMin, pxMax, pyMax)) continue;
      out.push({
        class: "trace",
        geometry: {
          kind: "polyline",
          points: [
            { x: sx(s.ax), y: sy(s.ay) },
            { x: sx(s.bx), y: sy(s.by) }
          ]
        }
      });
      traces += 1;
    }

    // ── Ignore rectangles clipped to the ROI ────────────────────────
    const ignore: ManifestIgnore[] = [];
    for (const r of ignores) {
      const rx0 = Math.max(x0, r.x);
      const ry0 = Math.max(y0, r.y);
      const rx1 = Math.min(x1, r.x + r.width);
      const ry1 = Math.min(y1, r.y + r.height);
      if (rx1 <= rx0 || ry1 <= ry0) continue;
      ignore.push({
        kind: "rectangle",
        x: sx(rx0), y: sy(ry0),
        width: (rx1 - rx0) * scaleX, height: (ry1 - ry0) * scaleY
      });
    }

    const manifest: RoiManifest = {
      source_image: record.originalFilename,
      roi_bbox: [x0, y0, x1, y1],
      roi_classes: roiClasses,
      ml_config: {
        point_via_size: mlConfig.pointViaSize * sizeScale,
        trace_width: mlConfig.traceWidth * sizeScale
      },
      annotations: out
    };
    if (ignore.length > 0) manifest.ignore = ignore;

    await fs.writeFile(jsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    written += 1;
    log(`[ml-export]   roi_${i + 1}.jpg (${pts} pts, ${regions} regions, ${traces} trace segs, ${ignore.length} ignore) classes=[${roiClasses.join(",")}]`);
  }

  log(`[ml-export] ${dieId} done — wrote ${written}/${rois.length} ROIs`);

  return {
    exportDir: path.relative(dataRoot, exportDirAbs),
    totalRois: written
  };
}
