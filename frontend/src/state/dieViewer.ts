import { create } from "zustand";
import type { DieMLConfig, WireLayer } from "shared";
import type { AnnotationAction } from "../api/actions";

/** Which right-panel tab is showing. The ML tab also drives a render mode:
 *  traces/vias size from `mlConfig` instead of display preferences. */
export type InspectorTab = "inspector" | "ml" | "cells";

/** Mockup defaults for the ML config until a real per-die value is seeded
 *  from the annotations blob. Source-pixel units. */
export const DEFAULT_ML_CONFIG: DieMLConfig = {
  pointViaSize: 6,
  traceWidth: 8
};

export type ToolKind =
  | "select"
  | "pan"
  | "wire"
  | "multiWire"
  | "via"
  | "viaRect"
  | "viaPoly"
  | "addCell"
  | "cellGuideLine"
  | "cellGuideSeg"
  | "ioPoint"
  | "libraryCell"
  | "roi"
  | "ignore";

/**
 * Modes for `select`:
 *  - "replace": clear and select only these ids
 *  - "add":     add these ids to the current set
 *  - "toggle":  flip membership for each id
 */
export type SelectMode = "replace" | "add" | "toggle";

/**
 * A transient capture of the global undo/redo keystroke. While a tool is in a
 * sub-state with its own stepwise history (e.g. an in-progress wire draft),
 * it registers an override here; the global ⌘Z handler routes to it instead
 * of the action dispatcher. Cleared when the sub-state ends.
 */
export interface UndoOverride {
  undo: () => void;
  redo: () => void;
}

interface DieViewerState {
  /** Currently selected annotation ids. */
  selectedIds: ReadonlySet<string>;
  /** Outline-tree sub-groups (e.g. cell types) currently expanded. Scoped to
   *  the current die session — not persisted because group ids are die-specific. */
  expandedGroups: string[];
  /** Tool currently selected in the sub-toolbar. */
  activeTool: ToolKind;
  /** The die whose edits the undo / redo stacks hold (relative to it: parts
   *  on other dies are wrapped in `onDie`). Another die's dispatcher leaves
   *  them alone, and its first edit starts a fresh history. */
  historyDieId: string | null;
  /** Actions the user has applied, newest at the end. */
  undoStack: AnnotationAction[];
  /** Actions that were undone and can be redone, newest at the end. */
  redoStack: AnnotationAction[];
  /** When set, the global ⌘Z/⌘⇧Z handler defers to this instead of the
   *  action dispatcher (e.g. per-point undo while drawing a wire). */
  undoOverride: UndoOverride | null;
  /** Active conductor layer for the wire / multi-wire tools. `null` = the
   *  "unknown" layer (edges store no `layer`). Changing it mid-draw only
   *  affects segments drawn afterwards. */
  wireLayer: WireLayer | null;
  /** Orientation for the cell-grid guide-line tool: "x" = vertical line
   *  (fixed x), "y" = horizontal line (fixed y). */
  guideAxis: "x" | "y";
  /** Draft ML config edited from the ML tab (mockup: client-side, seeded from
   *  the die's `annotations.mlConfig`). Source-pixel units. */
  mlConfig: DieMLConfig;
  /** Total ML vias currently held in the `MLViasLayer` cache — bumped by the
   *  layer as tiles load (and reset when the cache is cleared on a model
   *  switch). Lets the outline panel surface a live cardinality without
   *  having to walk the cache itself. Partial: it's the count for tiles
   *  fetched so far this session, not a die-wide ground truth. */
  mlViasCount: number;
  /** Cell type picked in the Cells (detection) tab — from the dropdown or by
   *  selecting a placed cell on the canvas while the tab is open. */
  cellDetectionTypeId: string | null;
  /** Proposals currently shown on the canvas (after threshold / overlap
   *  filtering). Drives the outline-tree count. */
  cellDetectionsCount: number;
  /** A wire-likelihood map exists for this die (drives the outline row). */
  wireMapAvailable: boolean;
}

interface DieViewerActions {
  select: (ids: Iterable<string>, mode?: SelectMode) => void;
  clearSelection: () => void;
  toggleGroup: (id: string) => void;
  setActiveTool: (tool: ToolKind) => void;
  /** Make the history `dieId`'s, dropping another die's stacks. */
  claimHistory: (dieId: string) => void;
  pushUndo: (action: AnnotationAction) => void;
  popUndo: () => AnnotationAction | undefined;
  pushRedo: (action: AnnotationAction) => void;
  popRedo: () => AnnotationAction | undefined;
  clearRedo: () => void;
  /** Register / clear the global-undo override (see `UndoOverride`). */
  setUndoOverride: (override: UndoOverride | null) => void;
  setWireLayer: (layer: WireLayer | null) => void;
  setGuideAxis: (axis: "x" | "y") => void;
  /** Patch the draft ML config (one or more fields). */
  setMlConfig: (patch: Partial<DieMLConfig>) => void;
  /** Set the live ML-via cardinality — called by the layer when tiles load. */
  setMlViasCount: (count: number) => void;
  setCellDetectionTypeId: (id: string | null) => void;
  setCellDetectionsCount: (count: number) => void;
  setWireMapAvailable: (available: boolean) => void;
  /** Wipe transient state — called when navigating to a different die. */
  reset: () => void;
}

const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const INITIAL_STATE: DieViewerState = {
  selectedIds: EMPTY_SELECTION,
  expandedGroups: [],
  activeTool: "select",
  historyDieId: null,
  undoStack: [],
  redoStack: [],
  undoOverride: null,
  wireLayer: null,
  guideAxis: "x",
  mlConfig: { ...DEFAULT_ML_CONFIG },
  mlViasCount: 0,
  cellDetectionTypeId: null,
  cellDetectionsCount: 0,
  wireMapAvailable: false
};

/**
 * Per-session UI state for the Die viewer. Hot-path values (pan/zoom,
 * cursor position) intentionally do NOT live here — they're handled via
 * `LiveValue` stores in the page, which rAF-coalesce and don't re-render
 * react components on every event.
 */
export const useDieViewerStore = create<DieViewerState & DieViewerActions>()((set, get) => ({
  ...INITIAL_STATE,

  select: (ids, mode = "replace") => {
    const incoming = Array.from(ids);
    const current = get().selectedIds;
    let next: Set<string>;
    if (mode === "replace") {
      next = new Set(incoming);
    } else if (mode === "add") {
      next = new Set(current);
      for (const id of incoming) next.add(id);
    } else {
      next = new Set(current);
      for (const id of incoming) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
    }
    if (setsEqual(current, next)) return;
    set({ selectedIds: next });
  },
  clearSelection: () => {
    if (get().selectedIds.size === 0) return;
    set({ selectedIds: EMPTY_SELECTION });
  },
  toggleGroup: (id) =>
    set((state) => ({
      expandedGroups: state.expandedGroups.includes(id)
        ? state.expandedGroups.filter((g) => g !== id)
        : [...state.expandedGroups, id]
    })),
  // Switching to any non-select tool drops the current selection, so the
  // user never has to Escape before starting to draw.
  setActiveTool: (tool) =>
    set((state) => ({
      activeTool: tool,
      selectedIds:
        tool === "select" || state.selectedIds.size === 0
          ? state.selectedIds
          : EMPTY_SELECTION
    })),

  claimHistory: (dieId) => {
    if (get().historyDieId !== dieId) set({ historyDieId: dieId, undoStack: [], redoStack: [] });
  },
  pushUndo: (action) =>
    set((state) => ({ undoStack: [...state.undoStack, action] })),
  popUndo: () => {
    const stack = get().undoStack;
    if (stack.length === 0) return undefined;
    const top = stack[stack.length - 1];
    set({ undoStack: stack.slice(0, -1) });
    return top;
  },
  pushRedo: (action) =>
    set((state) => ({ redoStack: [...state.redoStack, action] })),
  popRedo: () => {
    const stack = get().redoStack;
    if (stack.length === 0) return undefined;
    const top = stack[stack.length - 1];
    set({ redoStack: stack.slice(0, -1) });
    return top;
  },
  clearRedo: () => set({ redoStack: [] }),
  setUndoOverride: (override) => set({ undoOverride: override }),
  setWireLayer: (layer) => set({ wireLayer: layer }),
  setGuideAxis: (axis) => set({ guideAxis: axis }),
  setMlConfig: (patch) =>
    set((state) => ({ mlConfig: { ...state.mlConfig, ...patch } })),
  setMlViasCount: (count) => {
    if (get().mlViasCount === count) return;
    set({ mlViasCount: count });
  },
  setCellDetectionTypeId: (id) => set({ cellDetectionTypeId: id }),
  setCellDetectionsCount: (count) => {
    if (get().cellDetectionsCount === count) return;
    set({ cellDetectionsCount: count });
  },
  setWireMapAvailable: (available) => {
    if (get().wireMapAvailable === available) return;
    set({ wireMapAvailable: available });
  },

  reset: () => set(INITIAL_STATE)
}));

function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}
