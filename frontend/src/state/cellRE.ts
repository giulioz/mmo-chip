import { create } from "zustand";
import type { LayerShape, LayerType } from "shared";

/** Tool kinds for the Cells-RE page (a separate union from the die viewer
 *  so the two pages can't collide). */
export type ReToolKind = "select" | "pan" | "rect" | "polygon" | "point";

/** A shape on the clipboard, kept paired with the layer it came from so the
 *  paste can choose a sensible default layer (current layer, falling back to
 *  this one). Each entry is a deep copy with a fresh id at paste-time. */
export interface CellREClipboardItem {
  layer: LayerType;
  shape: LayerShape;
}

/** What ⌘C put on the shape clipboard. */
export interface CellREClipboard {
  /** Where the shapes were copied from: a paste back into that cell type is
   *  offset so the copies don't hide the originals; anywhere else they land
   *  in place. */
  dieId: string;
  cellTypeId: string;
  items: CellREClipboardItem[];
}

// ── Shared clipboard ──────────────────────────────────────────────────
//
// The shape clipboard lives in localStorage, so every tab of the app (same
// origin) shares it: copy in one tab, paste in another. The `storage` event
// (bottom of this file) keeps each tab's store in step; a tab that can't
// reach storage (blocked, full) still copies and pastes within itself.

const CLIPBOARD_KEY = "mmo-chip-shape-clipboard";
const CLIPBOARD_VERSION = 1;

/** Every layer a clipboard item may name — a Record, so a new LayerType
 *  doesn't compile until it's listed here. */
const CLIPBOARD_LAYERS: Record<LayerType, true> = {
  diffusion: true,
  polysilicon: true,
  metal1: true,
  metal2: true,
  contact: true,
  via1: true,
  wire_hitbox: true
};

export function serializeClipboard(clipboard: CellREClipboard): string {
  return JSON.stringify({ version: CLIPBOARD_VERSION, ...clipboard });
}

/** Decode a stored clipboard. It may come from another tab running another
 *  build, so anything from a different version, malformed or empty is
 *  null. */
export function parseClipboard(raw: string | null): CellREClipboard | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { version, dieId, cellTypeId, items } = value as Record<string, unknown>;
  if (
    version !== CLIPBOARD_VERSION ||
    typeof dieId !== "string" ||
    typeof cellTypeId !== "string" ||
    !Array.isArray(items) ||
    items.length === 0 ||
    !items.every(isClipboardItem)
  ) {
    return null;
  }
  return { dieId, cellTypeId, items };
}

function isClipboardItem(value: unknown): value is CellREClipboardItem {
  if (!value || typeof value !== "object") return false;
  const { layer, shape } = value as { layer?: unknown; shape?: unknown };
  if (typeof layer !== "string" || !Object.hasOwn(CLIPBOARD_LAYERS, layer)) return false;
  if (!shape || typeof shape !== "object") return false;
  const s = shape as Record<string, unknown>;
  if (typeof s.id !== "string") return false;
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  switch (s.kind) {
    case "rect":
      return num(s.x) && num(s.y) && num(s.width) && num(s.height);
    case "point":
      return num(s.x) && num(s.y) && num(s.size);
    case "circle":
      return num(s.x) && num(s.y) && num(s.radius);
    case "line":
      return num(s.x1) && num(s.y1) && num(s.x2) && num(s.y2) && num(s.width);
    case "polygon":
      return (
        Array.isArray(s.points) &&
        s.points.every((p: unknown) => {
          const q = p as { x?: unknown; y?: unknown } | null;
          return !!q && typeof q === "object" && num(q.x) && num(q.y);
        })
      );
    default:
      return false;
  }
}

function readSharedClipboard(): CellREClipboard | null {
  try {
    if (typeof window === "undefined") return null;
    return parseClipboard(window.localStorage.getItem(CLIPBOARD_KEY));
  } catch {
    return null;
  }
}

function writeSharedClipboard(clipboard: CellREClipboard | null): void {
  try {
    if (typeof window === "undefined") return;
    if (clipboard) window.localStorage.setItem(CLIPBOARD_KEY, serializeClipboard(clipboard));
    else window.localStorage.removeItem(CLIPBOARD_KEY);
  } catch {
    // Storage blocked or full: the copy still works within this tab.
  }
}

interface CellREState {
  /** The currently-selected cell type — the canvas + right panel both read
   *  off this. Null = nothing selected yet. */
  activeCellTypeId: string | null;
  /** Which instance is loaded in the canvas. Null ⇒ first member of the type
   *  (resolved by helpers). */
  activeCellId: string | null;
  /** Active tool. Defaults to select so cold-start lands in the safe tool. */
  activeTool: ReToolKind;
  /** Current target layer for the drawing tools. Rect/polygon use one of the
   *  4 shape layers; point uses one of the 2 via layers. We store one value
   *  per tool-category in the same field — switching tool may shift to a
   *  compatible default. */
  activeLayer: LayerType;
  /** Selected shape ids. Ids are namespaced `${layer}:${shapeId}` so the same
   *  raw shape id used across layers stays distinguishable. */
  selectedShapeIds: Set<string>;
  /** Cell types expanded in the left tree (to show instances). */
  expandedTypes: string[];
  /** "Unmatched" folder open. */
  unmatchedOpen: boolean;
  /** "ML" folder open (empty placeholder for now). */
  mlOpen: boolean;
  /** Layer-list visibility folders (cell layers always open; inferred /
   *  die-viewer groups collapsible). */
  inferredOpen: boolean;
  dieViewerLayersOpen: boolean;
  /** Per-tab in the canvas.
   *   - `image`         — the user-annotated cell image (the editing tab).
   *   - `schematic`     — CMOS-level schematic (one domain at a time).
   *   - `logicSchematic`— logic-level abstraction (cell.logic as a tree
   *                       of standard gate symbols). Auto-selected for
   *                       combinational cells when `extraction.logic`
   *                       is set. */
  canvasTab: "image" | "schematic" | "logicSchematic";
  /** Which CmosDomain the schematic tab is currently rendering. Null = let
   *  the page auto-pick the first available domain. Stored here (not in the
   *  URL) because it's a transient pick — the cell's domain ids change on
   *  every annotation edit. */
  activeDomainId: string | null;
  /** Shape clipboard, shared by every tab of the app (see "Shared
   *  clipboard" above): shapes paste across tabs, dies and cell types. */
  clipboard: CellREClipboard | null;
}

interface CellREActions {
  setActiveCellType: (typeId: string | null, cellId?: string | null) => void;
  setActiveCell: (cellId: string | null) => void;
  setActiveTool: (tool: ReToolKind) => void;
  setActiveLayer: (layer: LayerType) => void;
  setSelectedShapeIds: (ids: Set<string>) => void;
  selectOne: (id: string) => void;
  toggleSelected: (id: string) => void;
  clearSelection: () => void;
  toggleType: (id: string) => void;
  setUnmatchedOpen: (open: boolean) => void;
  setMlOpen: (open: boolean) => void;
  setInferredOpen: (open: boolean) => void;
  setDieViewerLayersOpen: (open: boolean) => void;
  setCanvasTab: (tab: "image" | "schematic" | "logicSchematic") => void;
  setActiveDomainId: (id: string | null) => void;
  setClipboard: (clipboard: CellREClipboard | null) => void;
  reset: () => void;
}

/** Layer-id format used in the selection set, mirrored by the canvas hit-test. */
export function shapeKey(layer: LayerType, shapeId: string): string {
  return `${layer}:${shapeId}`;
}
export function parseShapeKey(key: string): { layer: LayerType; id: string } | null {
  const i = key.indexOf(":");
  if (i < 0) return null;
  return { layer: key.slice(0, i) as LayerType, id: key.slice(i + 1) };
}

const INITIAL: CellREState = {
  activeCellTypeId: null,
  activeCellId: null,
  activeTool: "select",
  activeLayer: "polysilicon",
  selectedShapeIds: new Set(),
  expandedTypes: [],
  unmatchedOpen: true,
  mlOpen: false,
  inferredOpen: true,
  dieViewerLayersOpen: true,
  canvasTab: "image",
  activeDomainId: null,
  clipboard: null
};

export const useCellREStore = create<CellREState & CellREActions>()((set, get) => ({
  ...INITIAL,
  clipboard: readSharedClipboard(),

  setActiveCellType: (typeId, cellId = null) =>
    set({
      activeCellTypeId: typeId,
      activeCellId: cellId,
      // Picking a new type discards the lingering selection from the
      // previous type's layer shapes (those shape ids don't exist on the
      // new type, so a leftover selection would paint over nothing
      // meaningful), and resets the schematic's active domain (domain ids
      // change per cell). The page's hover entity is also cleared by an
      // effect keyed on `activeCellTypeId`.
      selectedShapeIds: new Set(),
      activeDomainId: null
    }),
  setActiveCell: (cellId) => set({ activeCellId: cellId }),
  setActiveTool: (tool) => {
    const prev = get().activeTool;
    if (prev === tool) return;
    // Changing tool clears the selection unless we're going to/from "pan"
    // (which is a transient cursor, often invoked momentarily via space).
    const clears = prev !== "pan" && tool !== "pan";
    set({
      activeTool: tool,
      ...(clears ? { selectedShapeIds: new Set() } : {})
    });
  },
  setActiveLayer: (layer) => set({ activeLayer: layer }),
  setSelectedShapeIds: (ids) => set({ selectedShapeIds: ids }),
  selectOne: (id) => set({ selectedShapeIds: new Set([id]) }),
  toggleSelected: (id) =>
    set((s) => {
      const next = new Set(s.selectedShapeIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { selectedShapeIds: next };
    }),
  clearSelection: () => set({ selectedShapeIds: new Set() }),
  toggleType: (id) =>
    set((s) => ({
      expandedTypes: s.expandedTypes.includes(id)
        ? s.expandedTypes.filter((t) => t !== id)
        : [...s.expandedTypes, id]
    })),
  setUnmatchedOpen: (open) => set({ unmatchedOpen: open }),
  setMlOpen: (open) => set({ mlOpen: open }),
  setInferredOpen: (open) => set({ inferredOpen: open }),
  setDieViewerLayersOpen: (open) => set({ dieViewerLayersOpen: open }),
  setCanvasTab: (tab) => set({ canvasTab: tab }),
  setActiveDomainId: (id) => set({ activeDomainId: id }),
  setClipboard: (clipboard) => {
    writeSharedClipboard(clipboard);
    set({ clipboard });
  },
  reset: () => {
    // The clipboard is shared with the other tabs — not this page's to drop.
    const { expandedTypes, unmatchedOpen, mlOpen, clipboard } = get();
    set({ ...INITIAL, expandedTypes, unmatchedOpen, mlOpen, clipboard });
  }
}));

// Another tab copied (or storage was cleared): pick up its clipboard. The
// event only fires in the *other* tabs, never the one that wrote.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== null && e.key !== CLIPBOARD_KEY) return;
    useCellREStore.setState({ clipboard: parseClipboard(e.newValue) });
  });
}

/** Which LayerTypes are valid for each drawing tool. The point tool is
 *  restricted to via-style layers (the only kind that accepts a sole point);
 *  rect & polygon work on the 4 shape layers. Used by toolbar + tools to
 *  keep impossible combinations off the table. */
export const TOOL_LAYERS: Record<"rect" | "polygon" | "point", LayerType[]> = {
  rect: ["diffusion", "polysilicon", "metal1", "metal2"],
  polygon: ["diffusion", "polysilicon", "metal1", "metal2"],
  point: ["contact", "via1"]
};

/** Short labels that read cleanly on the toolbar chips. */
export const LAYER_LABEL: Record<LayerType, string> = {
  diffusion: "diff",
  polysilicon: "poly",
  metal1: "m1",
  metal2: "m2",
  contact: "contact",
  via1: "m1↔m2",
  wire_hitbox: "hitbox"
};

/** Long human-readable names for the layer-visibility list. */
export const LAYER_LONG: Record<LayerType, string> = {
  diffusion: "Diffusion",
  polysilicon: "Polysilicon",
  metal1: "Metal 1",
  metal2: "Metal 2",
  contact: "Contact via",
  via1: "M1 ↔ M2 via",
  wire_hitbox: "Wire hitbox"
};
