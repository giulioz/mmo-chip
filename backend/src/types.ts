export type {
  AnnotationNet,
  AnnotationNetEdge,
  AnnotationNetNode,
  AnnotationPoint,
  AnnotationRect,
  Cell,
  CellType,
  DieAnnotations,
  DieLevelMetadata,
  DieMetadata,
  DieSummary,
  ImportJobPhase,
  ImportJobProgress,
  ImportJobStatus,
} from "shared";

// --- Backend-only types ---

export interface DieRecord {
  id: string;
  name: string;
  originalFilename: string;
  originalPath: string;
  width: number;
  height: number;
  tileSize: number;
  tileFormat: "jpg" | "png";
  maxZoomLevel: number;
  levels: import("shared").DieLevelMetadata[];
  createdAt: string;
  updatedAt: string;
  /** See `DieSummary.cellLibrary`. */
  cellLibrary?: string;
  /** See `DieSummary.cellScale`. */
  cellScale?: number;
}

export interface DieIndex {
  dies: string[];
}

export interface ImportJobRecord {
  id: string;
  type: "import-die";
  status: import("shared").ImportJobStatus;
  originalFilename: string;
  mimeType: string;
  inputFilePath: string;
  dieId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progress: import("shared").ImportJobProgress;
}

export interface ImportJobIndex {
  jobs: string[];
}
