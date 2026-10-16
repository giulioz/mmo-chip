// ── Die metadata ──────────────────────────────────────────────────

export interface DieLevelMetadata {
  z: number;
  width: number;
  height: number;
  columns: number;
  rows: number;
  scale: number;
}

export interface DieTileProgress {
  totalTiles: number;
  completedTiles: number;
  percentage: number;
}

export interface DieSummary {
  id: string;
  name: string;
  originalFilename: string;
  width: number;
  height: number;
  tileSize: number;
  maxZoomLevel: number;
  createdAt: string;
  updatedAt: string;
  tileProgress?: DieTileProgress;
  /** Cell library the die belongs to: dies sharing one see — and place —
   *  each other's cell types. Absent ⇒ none. */
  cellLibrary?: string;
  /** This die's pixels per library unit. A type owned by another die of the
   *  library is drawn here at `cellScale / its die's cellScale` times its
   *  own size. Absent ⇒ 1. */
  cellScale?: number;
}

export interface DieMetadata extends DieSummary {
  tileFormat: "jpg" | "png";
  levels: DieLevelMetadata[];
}

/** `PATCH /api/dies/:dieId` — die properties. A field left out stays as it
 *  is; `null` clears it. */
export interface DieUpdateRequest {
  cellLibrary?: string | null;
  cellScale?: number | null;
}

// ── Annotations ───────────────────────────────────────────────────

export interface AnnotationPoint {
  x: number;
  y: number;
}

export interface AnnotationNetNode {
  id: string;
  x: number;
  y: number;
}

/** Conductor layer of a wire segment. Absent ⇒ "unknown" (the default).
 *  RE/verilog metadata only — ML trace derivation ignores material. */
export type WireLayer = "poly" | "metal1" | "metal2";

export interface AnnotationNetEdge {
  id: string;
  from: string;
  to: string;
  /** Absent ⇒ unknown layer. Stamped per-segment at draw time; editable
   *  later from the inspector. Persisted verbatim inside the net. */
  layer?: WireLayer;
}

export interface AnnotationNet {
  id: string;
  name: string;
  nodes: AnnotationNetNode[];
  edges: AnnotationNetEdge[];
}

export interface AnnotationRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ── Cell layer annotations ────────────────────────────────────────

export type LayerType =
  | "diffusion"
  | "polysilicon"
  | "metal1"
  | "metal2"
  | "contact"
  | "via1"
  | "wire_hitbox";

/**
 * User-set role tag on a layer shape, scoped to interconnect (metals, polys,
 * contacts, vias). Propagates through extraction so the whole electrical net
 * the shape sits in gets this role (vcc / gnd / io / input / output) instead
 * of whatever the structural inference would have picked. `input` / `output`
 * exist as a manual escape hatch for cells the bridge-rule classifies wrong
 * (pass-transistor logic, transmission gates, unusual cells).
 *
 * NOT used on diffusion. Diffusion uses `forcedType` instead — historically
 * we conflated the two by reading `label === "vcc" / "gnd"` on diffusion as
 * a P/N override, but that confused the net-propagation step into shorting
 * the diffusion's whole sub-region net to a power rail.
 */
export type ShapeLabel = "vcc" | "gnd" | "io" | "input" | "output";

/**
 * Diffusion-only manual override for the body type. Bypasses the auto-
 * inference in step 3 of the cell extractor (which looks at which rail each
 * sub-region's contacts touch). Independent of `label` so a forced type
 * doesn't accidentally propagate as a net role.
 */
export type ForcedDiffusionType = "p" | "n";

/**
 * Arbitrary user-supplied name for the net this shape participates in
 * (e.g. "CLK", "Qbar", "STORAGE_NODE"). Lives on the shape so it
 * persists in the cellType document; propagates to the net at
 * extraction time exactly like `label` does. Distinct from `label` so
 * a custom name can coexist with a role assignment (e.g. label "vcc"
 * tags the net as a power rail for inference, customName "VDD_int"
 * controls how it's displayed in the schematic).
 */

export interface LayerRect {
  id: string;
  kind: "rect";
  x: number;
  y: number;
  width: number;
  height: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerLine {
  id: string;
  kind: "line";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerPoint {
  id: string;
  kind: "point";
  x: number;
  y: number;
  size: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerCircle {
  id: string;
  kind: "circle";
  x: number;
  y: number;
  radius: number;
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export interface LayerPolygon {
  id: string;
  kind: "polygon";
  points: { x: number; y: number }[];
  label?: ShapeLabel;
  forcedType?: ForcedDiffusionType;
  customName?: string;
}

export type LayerShape = LayerRect | LayerLine | LayerPoint | LayerCircle | LayerPolygon;

export type CellLayers = Partial<Record<LayerType, LayerShape[]>>;

export interface CellType {
  id: string;
  name: string;
  cropRect: AnnotationRect;
  layers?: CellLayers;
  /** True once promoted to a real, human-confirmed type via the merge-cells
   *  tool. Absent/false ⇒ an auto-created singleton placeholder (a cell that
   *  has only been labelled, not yet classified) — grouped under "Unmatched". */
  matched?: boolean;
}

export interface Cell {
  id: string;
  cellTypeId: string;
  /** The die that owns `cellTypeId`, when it isn't this die: a type shared
   *  through the cell library, drawn here at the dies' scale ratio. Absent ⇒
   *  one of this die's own types. */
  cellTypeDieId?: string;
  x: number;
  y: number;
  /** Vertical mirror (existing). */
  flippedV?: boolean;
  /** Horizontal mirror, applied for display + ML export. Set while aligning
   *  a candidate in the merge-cells tool. */
  flippedH?: boolean;
  /** Orientation in degrees clockwise. Absent ⇒ 0. */
  rotation?: 0 | 90 | 180 | 270;
  /** Set true once this instance has been classified & confirmed by the user
   *  via the merge-cells tool (drives the candidate "done" checkmark). */
  merged?: boolean;
}

// ── Grid definitions ──────────────────────────────────────────────

export interface GridColumn {
  x: number;
  width: number;
}

export interface GridDefinition {
  id: string;
  name: string;
  columns: GridColumn[];
  rowHeight: number;
  columnOffsets: number[];
}

/**
 * Cell-placement guides. RE/layout aid only (not ML): the cell-rectangle
 * tool can snap its edges to these. A `line` is infinite (axis = the fixed
 * coordinate: "x" ⇒ vertical line at x=`pos`, "y" ⇒ horizontal at y=`pos`);
 * a `segment` is a finite axis-aligned span that only snaps when near.
 */
export type Guide =
  | { id: string; kind: "line"; axis: "x" | "y"; pos: number }
  | {
      id: string;
      kind: "segment";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
    };

export interface IOPin {
  id: string;
  x: number;
  y: number;
  pin: number;
  name: string;
}

// ── ML annotations  ───────

export type GeometryKind = "point" | "polyline" | "rectangle" | "polygon";

export interface PointGeometry {
  kind: "point";
  x: number;
  y: number;
}
/** Trace width is chip-global (DieMLConfig.traceWidth), never per-segment. */
export interface PolylineGeometry {
  kind: "polyline";
  points: { x: number; y: number }[];
}
export interface RectangleGeometry {
  kind: "rectangle";
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface PolygonGeometry {
  kind: "polygon";
  points: { x: number; y: number }[];
}
export type Geometry =
  | PointGeometry
  | PolylineGeometry
  | RectangleGeometry
  | PolygonGeometry;

export type AnnotationClass = "point_via" | "irregular_via" | "trace";
export type DecoderKind = "peak" | "region" | "skeleton";

export interface ClassDef {
  id: AnnotationClass;
  decoderKind: DecoderKind;
  /** Model output channel index. */
  channel: number;
  allowedGeometry: GeometryKind[];
  sizeSource: "pointViaSize" | "traceWidth" | null;
}

/** The shared contract. Both ends import this — never hardcode channel
 *  indices or class→geometry rules anywhere else. */
export const CLASS_REGISTRY: Record<AnnotationClass, ClassDef> = {
  point_via: {
    id: "point_via",
    decoderKind: "peak",
    channel: 0,
    allowedGeometry: ["point"],
    sizeSource: "pointViaSize"
  },
  irregular_via: {
    id: "irregular_via",
    decoderKind: "region",
    channel: 1,
    allowedGeometry: ["rectangle", "polygon"],
    sizeSource: null
  },
  trace: {
    id: "trace",
    decoderKind: "skeleton",
    channel: 2,
    allowedGeometry: ["polyline"],
    sizeSource: "traceWidth"
  }
};
export const NUM_CLASSES = 3;

/** Persisted classes are point_via | irregular_via only; `trace` is
 *  materialized from `nets` by the exporter, never stored here. */
export interface HumanAnnotation {
  id: string;
  class: AnnotationClass;
  geometry: Geometry;
  /** "approved" = a model prediction the user verified; default "human". */
  source?: "human" | "approved";
}

export interface ROIRectangle {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Which classes this ROI fully labels (absent ⇒ all). Drives the
   *  per-channel loss mask so net-derived traces can't poison via-only ROIs. */
  classes?: AnnotationClass[];
}

/** Region the model must not score (any class) during training. */
export interface IgnoreRect {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DieMLConfig {
  /** Via radius in source px → Gaussian sigma = radius * 0.5. Chip-global. */
  pointViaSize: number;
  /** Default trace stroke width in source px. Chip-global. */
  traceWidth: number;
}

export interface DieAnnotations {
  version: 2;
  /** Monotonically incremented every time the annotations are written.
   *  Clients use it to spot stale caches when a WS notification arrives. */
  rev: number;
  nets: AnnotationNet[];
  cellTypes: CellType[];
  cells: Cell[];
  grids: GridDefinition[];
  pins?: IOPin[];
  mlConfig?: DieMLConfig;
  annotations?: HumanAnnotation[];
  rois?: ROIRectangle[];
  ignores?: IgnoreRect[];
  /** Cell-placement guides (RE aid, not ML). Absent ⇒ none. */
  guides?: Guide[];
}

/** The whole-entity collections of `DieAnnotations`, by item type. */
interface AnnotationCollectionItems {
  cells: Cell;
  cellTypes: CellType;
  nets: AnnotationNet;
  grids: GridDefinition;
  pins: IOPin;
  annotations: HumanAnnotation;
  rois: ROIRectangle;
  ignores: IgnoreRect;
  guides: Guide;
}

export type AnnotationCollection = keyof AnnotationCollectionItems;

/** One whole-entity write (upsert by id / remove by id). */
export type AnnotationBatchOp = {
  [K in AnnotationCollection]:
    | { op: "upsert"; collection: K; item: AnnotationCollectionItems[K] }
    | { op: "remove"; collection: K; id: string };
}[AnnotationCollection];

/** `POST /api/dies/:dieId/batch` — applied in order, atomically: one write,
 *  one revision, or nothing at all. */
export interface AnnotationBatchRequest {
  ops: AnnotationBatchOp[];
}

export interface MLExportRequest {
  approxViaRadiusPx: number;
}

export interface MLExportResponse {
  exportDir: string;
  totalRois: number;
}

export interface MLVia {
  /** Source-image pixel coordinates (Node translates from crop-local). */
  x: number;
  y: number;
  /** Heatmap probability at the peak, in (threshold, 1]. */
  score: number;
}

/** irregular_via instance (ch1 connected component), source-image coords. */
export interface MLRegion {
  bbox: [number, number, number, number]; // x, y, w, h
  centroid: [number, number];
  area: number;
  score: number;
}

/** trace decode (ch2). Source-image coords. v1 = contour polyline; a true
 *  skeleton→graph is the later assisted-tracing phase. */
export interface MLTracePolyline {
  points: [number, number][];
}

export interface MLPrediction {
  pointVias: MLVia[];
  irregularVias: MLRegion[];
  traces: MLTracePolyline[];
  /** [x0, y0, x1, y1] in source-image pixels — the region this covers. */
  bbox: [number, number, number, number];
  /** Checkpoint the prediction came from; changes invalidate caches. */
  checkpointHash: string | null;
}

/** One native tile's cached prediction inside a batched range response. */
export interface MLViasTileResult {
  /** Native-level tile column / row. */
  x: number;
  y: number;
  prediction: MLPrediction;
}

/**
 * Batched ML-vias response: every *cached* tile in a native-tile range, in
 * one round-trip. Tiles with no cached prediction are simply omitted (the
 * client treats them as not-yet-computed). Replaces N per-tile requests.
 */
export interface MLViasTilesResponse {
  z: number;
  checkpointHash: string | null;
  tiles: MLViasTileResult[];
}

export interface MLTrainRequest {
  /** Dir containing rois/ (recursively). Relative paths resolve under the data root. */
  dataDir: string;
  epochs?: number;
  encoder?: string;
  lr?: number;
  cropSize?: number;
  stepsPerEpoch?: number;
  batchSize?: number;
  /** Checkpoint output path; defaults to the sidecar's resident checkpoint. */
  output?: string;
}

export interface MLTrainResponse {
  jobId: string;
}

export interface MLJobStatus {
  jobId: string;
  kind: "train" | "predict_die";
  status: "running" | "done" | "error";
  epoch?: number;
  epochs?: number;
  loss?: number | null;
  checkpointPath?: string | null;
  error?: string | null;
  startedAt?: string;
  updatedAt?: string;
}

/** Mirror of the Python sidecar's GET /health, surfaced via Node /api/ml/status. */
export interface MLServiceStatus {
  /** false when the sidecar is unreachable; the rest of the fields are then absent. */
  reachable: boolean;
  status?: string;
  device?: string;
  checkpoint?: string | null;
  checkpointHash?: string | null;
  encoder?: string;
  modelLoaded?: boolean;
  trainingActive?: boolean;
}

// ── ML inference jobs (Node-managed, per-die tile sweep) ──────────

export type MLInferenceJobStatus =
  | "running"
  | "stopped"
  | "completed"
  | "failed";

/**
 * A die-wide inference sweep. Node walks every native-zoom tile, runs the
 * sidecar, and caches each prediction. There is at most one job per die, so
 * the die id doubles as the job key. Stopping leaves the cache intact, so a
 * later start resumes from where it left off.
 */
export interface MLInferenceJob {
  dieId: string;
  status: MLInferenceJobStatus;
  /** Native-zoom tile grid total (columns × rows). */
  totalTiles: number;
  /** Tiles whose prediction JSON is cached on disk for `checkpointHash`. */
  completedTiles: number;
  /** 0–100, completedTiles / totalTiles. */
  percentage: number;
  /** Checkpoint hash the cached predictions belong to. */
  checkpointHash: string | null;
  /** Sidecar checkpoint filename in use when the job last ran. */
  model: string | null;
  error: string | null;
  startedAt: string | null;
  updatedAt: string;
  finishedAt: string | null;
}

/** A checkpoint file the sidecar can load. */
export interface MLModelInfo {
  /** Checkpoint filename, relative to the sidecar's checkpoints dir. */
  name: string;
  /** 12-char checkpoint hash, or null if unreadable. */
  hash: string | null;
  /** File size in bytes. */
  sizeBytes: number;
  /** True for the model currently resident in the sidecar. */
  resident: boolean;
}

export interface MLModelsResponse {
  models: MLModelInfo[];
}

export interface MLSelectModelRequest {
  /** Checkpoint name from MLModelInfo.name. */
  name: string;
}

// ── Import jobs ───────────────────────────────────────────────────

export type ImportJobStatus = "queued" | "running" | "completed" | "failed";

export type ImportJobPhase =
  | "queued"
  | "analyzing"
  | "tiling"
  | "persisting"
  | "completed"
  | "failed";

export interface ImportJob {
  id: string;
  type: "import-die";
  status: ImportJobStatus;
  originalFilename: string;
  mimeType: string;
  dieId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: ImportJobProgress;
}

export interface ImportJobProgress {
  phase: ImportJobPhase;
  message: string;
  totalLevels: number;
  completedLevels: number;
  currentLevel: number | null;
  currentLevelTiles: number;
  currentLevelProcessedTiles: number;
  totalTiles: number;
  processedTiles: number;
  percentage: number;
}

// ── Cell detection (via-constellation matching of annotated cell types) ──

/**
 * One proposed placement of a cell type, produced by the cell-detection job
 * from the cached ML via predictions. Shaped like a `Cell` (same orientation
 * convention: canonical point p lands at (x, y) + orient(p)) plus a score,
 * so the die overlay and the merge-cells canvas can treat it as a virtual
 * cell instance until the user approves it into a real one.
 */
export interface CellDetection {
  id: string;
  cellTypeId: string;
  x: number;
  y: number;
  flippedH?: boolean;
  flippedV?: boolean;
  rotation?: 0 | 90 | 180 | 270;
  /** 0..1 — F1 between the template's vias and the die vias under the
   *  footprint. The confidence slider filters on this client-side. */
  score: number;
  /** Template vias that found a die via within tolerance. */
  matched: number;
  /** Die vias inside the footprint the template doesn't explain. */
  extra: number;
}

/** How well a placement matches a type's via template (same F1 as a
 *  detection's `score`). Computed for the type's own members at run time so
 *  misclassified members stand out as low scores. */
export interface CellPlacementScore {
  score: number;
  matched: number;
  extra: number;
}

/** Persisted output of one detection run for one cell type. Lives beside
 *  the die's annotations (never inside them) so clearing results can't touch
 *  human work. */
export interface CellDetectionResult {
  version: 1;
  dieId: string;
  cellTypeId: string;
  /** The die that owns the type, when it's another die's library type
   *  (approved proposals become cells pointing there). Absent ⇒ this die. */
  cellTypeDieId?: string;
  /** Where the via template came from when it wasn't this die's own members:
   *  the owner die's members, scaled by `ratio` (this die's px per theirs). */
  templateSource?: { dieId: string; dieName: string; memberCount: number; ratio: number };
  /** Set when the template pooled the type's instances from every die of the
   *  cell library (`CellDetectionOptions.allDies`): which, and how many. */
  pooledFrom?: Array<{ dieId: string; dieName: string; memberCount: number; ratio: number }>;
  /** Name at run time — shown when the type has since been renamed/removed. */
  cellTypeName: string;
  /** Via checkpoint the die vias came from. */
  checkpointHash: string | null;
  /** `annotations.rev` when the template was built — a later rev means the
   *  members may have changed and the results could be stale. */
  annotationsRev: number;
  /** Member cells the template was averaged from. */
  memberCount: number;
  /** Fingerprint of the members' ids + placements at run time. Differs from
   *  the live annotations ⇒ the template may no longer match the type. */
  memberSignature?: string;
  /** Vias in the consensus template. */
  templateVias: number;
  /** The type's placed members scored against the template, keyed by cell
   *  id. Absent on results from before this existed. */
  memberScores?: Record<string, CellPlacementScore>;
  /** Orientation options the run used (absent on results from before the
   *  option existed ⇒ both flips allowed). */
  options?: CellDetectionOptions;
  createdAt: string;
  detections: CellDetection[];
  /** Detection ids the user explicitly rejected in merge-cells. */
  dismissed: string[];
}

export type CellDetectionJobStatus =
  | "running"
  | "stopped"
  | "completed"
  | "failed";

/** A cell-detection run. At most one per die at a time; the cell type is
 *  fixed for the run's lifetime. Broadcast over WS as `cellJob`. */
export interface CellDetectionJob {
  dieId: string;
  cellTypeId: string;
  cellTypeName: string;
  status: CellDetectionJobStatus;
  /** Human-readable stage: "loading vias", "matching", "scoring". */
  phase: string;
  /** 0–100 across the whole run. */
  percentage: number;
  /** Detections written (completed runs only). */
  detections: number | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

/** Which mirrored placements the matcher may propose. Rotations (90°/180°/
 *  270°) are always searched; these gate the reflected orientations — a
 *  "flipped X" copy is the cell mirrored across its vertical axis (any
 *  rotation of it), "flipped Y" across its horizontal axis. Both default on. */
export interface CellDetectionOptions {
  allowFlipX: boolean;
  allowFlipY: boolean;
  /** Drop candidates whose footprint overlaps any placed cell (of any type)
   *  by more than ~30%. Off ⇒ only near-duplicates of the type's own placed
   *  members are dropped, so proposals may sit on cells of other types.
   *  Default on. */
  avoidExistingCells: boolean;
  /** Build the template from the type's instances on every die of the cell
   *  library (scaled to this die), not just this die's. Default off. */
  allDies?: boolean;
}

export interface CellDetectionStartRequest {
  cellTypeId: string;
  allowFlipX?: boolean;
  allowFlipY?: boolean;
  avoidExistingCells?: boolean;
  allDies?: boolean;
}

export interface CellDetectionDismissRequest {
  ids: string[];
  /** false ⇒ un-dismiss. Default true. */
  dismissed?: boolean;
}

// ── Cell imaging (clean specimens + wire-likelihood map) ──────────────

/** One cell type's clean specimen: the per-pixel robust centre of its
 *  aligned instances, in the type's canonical orientation. */
export interface CellSpecimenInfo {
  cellTypeId: string;
  cellTypeName: string;
  width: number;
  height: number;
  /** Instances stacked (capped per type). */
  instancesUsed: number;
  /** Resolution of the display image relative to the cell (2 = reconstructed
   *  at twice the source resolution from sub-pixel-registered instances).
   *  Absent ⇒ 1. */
  displayScale?: number;
  /** Instances that went into the display image (the sharpest subset). */
  displayInstances?: number;
  /** Instances that only registered once mirrored relative to their
   *  annotation — the annotation's flip flags are probably wrong for them. */
  orientationMismatches?: number;
  /** Cell ids of those instances. */
  orientationMismatchIds?: string[];
  /** Fingerprint of the type's members when it was built (see
   *  `CellDetectionResult.memberSignature`). */
  memberSignature: string;
  /** Dies the stacked instances came from when pooled across the cell
   *  library (`CellImagingStartRequest.allDies`). Absent ⇒ this die only. */
  dies?: number;
  createdAt: string;
}

export interface CellSpecimenIndex {
  version: 1;
  dieId: string;
  /** Percentile of the stack used as the specimen (50 = median). */
  percentile: number;
  createdAt: string;
  specimens: CellSpecimenInfo[];
}

/** Die-wide overlay of "pixels under a recognised cell that don't belong to
 *  the cell" — dominated by wires routed over it. Served as RGBA tiles. */
export interface WireMapInfo {
  version: 1;
  dieId: string;
  createdAt: string;
  /** `CellSpecimenIndex.createdAt` it was computed against. */
  specimensCreatedAt: string;
  annotationsRev: number;
  cellsProcessed: number;
  cellsSkipped: number;
  /** Lowest pyramid level that has tiles (overlay hides below it). */
  minZoomLevel: number;
  maxZoomLevel: number;
}

export type CellImagingJobKind = "specimens" | "wireMap";

export interface CellImagingJob {
  dieId: string;
  kind: CellImagingJobKind;
  status: "running" | "stopped" | "completed" | "failed";
  phase: string;
  percentage: number;
  error: string | null;
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface CellImagingStartRequest {
  kind: CellImagingJobKind;
  /** Specimens: stack the type's instances from every die of the cell
   *  library too (resampled to this die). Default off. */
  allDies?: boolean;
}
