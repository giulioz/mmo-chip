import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef
} from "react";
import type {
  Cell,
  CellType,
  DieAnnotations,
  DieMetadata,
  LayerShape,
  LayerType,
  ShapeLabel
} from "shared";
import type { AnnotationAction } from "../../api/actions";
import {
  buildRemoveShapesAction,
  buildReplaceShapesAction,
  buildUpsertShapeAction,
  cornerScale,
  makePoint,
  makeRect,
  mapShapePoints,
  moveShapeVertex,
  scaleAbout,
  shapeHandleAt,
  shapeHandles,
  shapeHit,
  shapeIntersectsRect,
  shapesBounds,
  translateShape
} from "../../lib/cellLayers";
import {
  type Point,
  type Rect,
  normalizeRect,
  pointInPolygon,
  pointInRect,
  polygonBounds,
  rectCorners,
  rectsIntersect,
  segmentIntersectsRect
} from "../../lib/geometry";
import {
  LAYER_DRAW_ORDER,
  applyShapeStyle,
  drawCellLayers,
  drawShape
} from "../../renderer/annotations/shapes";
import {
  COLOR_LAYER,
  COLOR_VIA,
  COLOR_VIA_FILL,
  NET_COLOR,
  WIRE_LAYER_COLOR
} from "../../renderer/annotations/style";
import { enterCellDieFrame } from "../../renderer/annotations/cellFrame";
import { dieRegion } from "../../renderer/dieRegion";
import type { TileBounds } from "../../renderer/types";
import { cellFootprint } from "../../lib/cellDetection";
import {
  shapeKey,
  parseShapeKey,
  type ReToolKind
} from "../../state/cellRE";
import type { CellExtraction, InferredCellExtraction } from "../../lib/extraction";

export interface CellRECanvasHandle {
  /** Re-fit the cell into the viewport. */
  fit: () => void;
  zoomBy: (factor: number) => void;
  /** Read the current cursor's world (cell-local) point — for the page's
   *  status bar readout. */
  getCursor: () => Point | null;
}

interface Props {
  cellType: CellType;
  /** Instance loaded in the canvas (null ⇒ no member exists yet). */
  cell: Cell | null;
  /** The die's tile pyramid, which the instance's pixels are drawn from. */
  die: DieMetadata | null;
  /** When `cell` is on another die of the cell library (`die` is then that
   *  die): this die's pixels per that die's pixel. Default 1. */
  cellScale?: number;
  /** A canonical image instead of the instance's own pixels: the type's
   *  clean specimen (`imageCanonical`), or its template crop when it has no
   *  instance yet. */
  imageUrl: string | null;
  /** `imageUrl` is a clean specimen already in canonical orientation — show
   *  it instead of the instance's pixels (the die overlay still follows
   *  `cell`). */
  imageCanonical?: boolean;
  /** Full die annotations — used to draw the die-viewer overlay (wires +
   *  vias clipped to the cell's die rect). Absent ⇒ no overlay. */
  annotations?: DieAnnotations;
  activeTool: ReToolKind;
  activeLayer: LayerType;
  /** Visibility map. Editable cell-layer keys plus the virtual keys for the
   *  die-viewer overlay rows (`_dvWires`, `_dvVias`) and the placeholder
   *  inferred / dv group rows. Absent keys = visible. */
  layerHidden: Record<string, boolean>;
  selectedShapeIds: Set<string>;
  /** Transient highlight from right-panel row hover. Same key format as
   *  `selectedShapeIds`. The canvas paints a softer halo for these. */
  hoveredShapeIds?: Set<string>;
  /** When true, fade everything outside `hoveredShapeIds` to background
   *  alpha so the hovered set pops. Default true. The page turns this OFF
   *  when the hover originated from the canvas cursor itself — dimming the
   *  whole image while the user is just mousing over the canvas is too
   *  jarring; the steel-blue halo on the hovered shape is sufficient
   *  feedback in that case. */
  dimNonHovered?: boolean;
  /** Structural extraction for the current cell — drives the diffusion
   *  type overlay (sub-region outlines + P/N labels). `null` while loading
   *  or when extraction failed. */
  extraction?: CellExtraction | null;
  onSelect: (next: Set<string>) => void;
  dispatch: (action: AnnotationAction) => void;
  /** In-progress polygon (points the user has clicked so far). Page-level so
   *  ⌘Z while drafting can pop the last vertex via the global undo override. */
  polyDraft: Point[];
  onPolyAddVertex: (p: Point) => void;
  onPolyCommit: () => void;
  onPolyCancel: () => void;
  /** Esc with no draft cancels the active tool back to select. */
  onEscape: () => void;
  /** Right-click on a shape. Canvas has already hit-tested + (re-)selected the
   *  shape so the menu's actions can read `selectedShapeIds`. `null` is sent
   *  when the user right-clicked on empty canvas (so the page can dismiss any
   *  open menu). Coordinates are client-space for portal positioning. */
  onShapeContextMenu?: (
    target: { layer: LayerType; shape: LayerShape } | null,
    clientX: number,
    clientY: number
  ) => void;
  /** Right-click inside a multi-selection's bounding box but off any shape:
   *  the page opens the menu for the selection as a whole. */
  onSelectionContextMenu?: (clientX: number, clientY: number) => void;
  /** Cursor moved over (or off) a shape. Fires only when the resolved
   *  target changes — moving the cursor within the same shape doesn't
   *  trigger. Drives the status bar's hover-info + right-panel row
   *  highlighting. `subRegionId` is set when the cursor is over a specific
   *  diffusion sub-region (requires `extraction` to be loaded). */
  onCanvasHover?: (target: CanvasHoverTarget | null) => void;
}

/** Public shape of the canvas hover callback's payload. */
export interface CanvasHoverTarget {
  layer: LayerType;
  shape: LayerShape;
  /** Synthetic id of the diffusion sub-region under the cursor, if any. */
  subRegionId?: string;
}

interface View {
  ox: number; // world x at canvas left
  oy: number; // world y at canvas top
  zoom: number;
}

/** Wheel zoom step. Matches the merge canvas and the die viewer so trackpad
 *  zoom feels identical across pages. */
const WHEEL_ZOOM_FACTOR = 0.01;
/** CSS-px tolerance for handle / shape picks. Translated to world units via
 *  the current zoom at pick time. */
const PICK_TOL_PX = 6;
const HANDLE_PX = 10;
const HANDLE_HIT_TOL_PX = 8;
/** CSS-px gap between a multi-selection's shapes and its group box, so the
 *  box and its corner handles don't sit on top of the selection halos. */
const GROUP_PAD_PX = 6;
/** Selection accent — same amber the die viewer uses on selected shapes. */
const SELECT_COLOR = "#f3b351";

function fitBox(w: number, h: number, pw: number, ph: number): View {
  const bw = Math.max(w, 1);
  const bh = Math.max(h, 1);
  const pad = 32;
  const zoom = Math.max(
    1e-3,
    Math.min((pw - pad * 2) / bw, (ph - pad * 2) / bh)
  );
  return { zoom, ox: bw / 2 - pw / 2 / zoom, oy: bh / 2 - ph / 2 / zoom };
}

type DragKind =
  | "pan"
  | "marquee"
  | "move"
  | "vertex"
  | "scale"
  | "rect-draw"
  | null;

/** A box grown by `pad` on every side. */
function inflate(r: Rect, pad: number): Rect {
  return { x: r.x - pad, y: r.y - pad, width: r.width + pad * 2, height: r.height + pad * 2 };
}

/**
 * The reverse-engineering canvas. One single-image cell crop, oriented to the
 * cell-type canonical view via `cell.flippedH/V/rotation`, with cell-type
 * layer shapes drawn on top in cell-local coordinates. All drawing tools live
 * here (rect, polygon, point) with select supporting marquee, drag-move,
 * alt-duplicate, shift-axis-lock, and per-vertex / per-corner edit handles.
 */
export const CellRECanvas = forwardRef<CellRECanvasHandle, Props>(function CellRECanvas(
  {
    cellType,
    cell,
    die,
    cellScale = 1,
    imageUrl,
    imageCanonical = false,
    annotations,
    extraction,
    activeTool,
    activeLayer,
    layerHidden,
    selectedShapeIds,
    hoveredShapeIds,
    dimNonHovered = true,
    onSelect,
    dispatch,
    polyDraft,
    onPolyAddVertex,
    onPolyCommit,
    onPolyCancel,
    onEscape,
    onShapeContextMenu,
    onSelectionContextMenu,
    onCanvasHover
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewRef = useRef<View>({ ox: 0, oy: 0, zoom: 1 });
  const sizeRef = useRef({ w: 1, h: 1 });
  const cursorRef = useRef<Point | null>(null);
  /** Last value passed to `onCanvasHover`, encoded as a stable key — drives
   *  change-detection so we only fire the callback when the cursor crosses
   *  into a different shape (or sub-region). `null` means "currently off
   *  any shape". */
  const lastHoverKeyRef = useRef<string | null>(null);
  // Live "preview" state pushed during a drag — held outside React state to
  // avoid re-rendering during the hot path. The draw effect reads these refs.
  const liveRectRef = useRef<Rect | null>(null);
  const liveMarqueeRef = useRef<Rect | null>(null);
  // Per-selected-shape live offset (drag-move) and per-shape live vertex move.
  const liveMoveRef = useRef<{ dx: number; dy: number } | null>(null);
  const liveVertexRef = useRef<{
    key: string;
    shape: LayerShape;
  } | null>(null);
  // Live group scale (dragging a multi-selection's corner handle).
  const liveScaleRef = useRef<{ anchor: Point; sx: number; sy: number } | null>(null);
  /** Group-box corner under the cursor (index into `rectCorners`) — drives
   *  the resize cursor. */
  const hoverCornerRef = useRef<number | null>(null);
  // Drag bookkeeping.
  const dragRef = useRef<{
    kind: DragKind;
    /** Pointer-down in CSS px (client coords). */
    sx: number;
    sy: number;
    /** Pointer-down in world (cell-local) coords. */
    wx: number;
    wy: number;
    startView: View;
    /** "move" drag: vertex index when the drag started on a single-shape
     *  handle (otherwise null = body-move). */
    vertex: { key: string; vIdx: number } | null;
    /** "move" drag: alt+drag duplicates → fresh ids created up-front. */
    duplicateIds: Map<string, string> | null;
    /** "move" / "scale" drag: original shapes snapshot keyed by shape-key. */
    movingSnapshot: Map<string, { layer: LayerType; shape: LayerShape }> | null;
    /** "scale" drag: the grabbed corner of the group bounds and the fixed
     *  opposite one. */
    scale: { corner: Point; anchor: Point } | null;
    /** Pointer has actually moved (a tiny wiggle still reads as a click). */
    moved: boolean;
  } | null>(null);
  const spaceRef = useRef(false);

  // Mirror dynamic props into a ref so the pointer/keyboard handlers stay
  // referentially stable (no ResizeObserver / wheel re-subscription churn).
  const propsRef = useRef({
    cellType,
    cell,
    activeTool,
    activeLayer,
    layerHidden,
    selectedShapeIds,
    hoveredShapeIds: hoveredShapeIds as Set<string> | undefined,
    extraction: extraction as Props["extraction"],
    onSelect,
    dispatch,
    polyDraft,
    onPolyAddVertex,
    onPolyCommit,
    onPolyCancel,
    onEscape,
    onShapeContextMenu: undefined as Props["onShapeContextMenu"],
    onSelectionContextMenu: undefined as Props["onSelectionContextMenu"],
    onCanvasHover: undefined as Props["onCanvasHover"]
  });
  propsRef.current = {
    cellType,
    cell,
    activeTool,
    activeLayer,
    layerHidden,
    selectedShapeIds,
    hoveredShapeIds,
    extraction,
    onSelect,
    dispatch,
    polyDraft,
    onPolyAddVertex,
    onPolyCommit,
    onPolyCancel,
    onEscape,
    onShapeContextMenu,
    onSelectionContextMenu,
    onCanvasHover
  };

  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);

  // ── Image cache ────────────────────────────────────────────────────
  const imgCacheRef = useRef(new Map<string, HTMLImageElement>());
  const getImage = useCallback(
    (url: string | null): HTMLImageElement | null => {
      if (!url) return null;
      const cache = imgCacheRef.current;
      const hit = cache.get(url);
      if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
      const img = new Image();
      img.decoding = "async";
      img.onload = redraw;
      img.onerror = redraw;
      img.src = url;
      cache.set(url, img);
      return null;
    },
    [redraw]
  );

  // ── Fit ────────────────────────────────────────────────────────────
  const fit = useCallback(() => {
    const { w: cw, h: ch } = sizeRef.current;
    const ct = propsRef.current.cellType;
    viewRef.current = fitBox(ct.cropRect.width, ct.cropRect.height, cw, ch);
    redraw();
  }, [redraw]);

  useImperativeHandle(
    ref,
    () => ({
      fit,
      zoomBy: (factor: number) => {
        const v = viewRef.current;
        const { w, h } = sizeRef.current;
        const cx = v.ox + w / 2 / v.zoom;
        const cy = v.oy + h / 2 / v.zoom;
        const zoom = Math.min(64, Math.max(1e-3, v.zoom * factor));
        viewRef.current = { zoom, ox: cx - w / 2 / zoom, oy: cy - h / 2 / zoom };
        redraw();
      },
      getCursor: () => cursorRef.current
    }),
    [fit, redraw]
  );

  // Re-fit when the canonical box changes (a different cell type, or the
  // type turned a quarter turn). Don't re-fit on other same-type edits
  // (would yank zoom).
  const fitKey = `${cellType.id}|${cellType.cropRect.width}x${cellType.cropRect.height}`;
  const fitKeyRef = useRef("");
  useEffect(() => {
    if (fitKey !== fitKeyRef.current) {
      fitKeyRef.current = fitKey;
      fit();
    }
  }, [fitKey, fit]);

  // ── Resize ─────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const first = sizeRef.current.w === 1 && sizeRef.current.h === 1;
        sizeRef.current = { w: r.width, h: r.height };
        if (first) fit();
        else redraw();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit, redraw]);

  // ── Keyboard (space pan; Esc / Enter / Delete) ─────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ── Coordinate helpers ──────────────────────────────────────────────
  // Convert canvas-local CSS px → cell-local (canonical) world coords. The
  // image is drawn with a forward-orientation transform inside the canonical
  // box, so the box itself stays in canonical coords — clicks on layer
  // geometry (which is stored canonical) need only the pan/zoom inverse.
  const toWorld = useCallback((cssX: number, cssY: number): Point => {
    const v = viewRef.current;
    return { x: cssX / v.zoom + v.ox, y: cssY / v.zoom + v.oy };
  }, []);

  /** Cell-local hit-test for shapes — returns the deepest-paint match (later
   *  paint = on top). Respects layer visibility. */
  const hitShape = useCallback(
    (pt: Point): { layer: LayerType; shape: LayerShape } | null => {
      const { cellType, layerHidden } = propsRef.current;
      const tol = PICK_TOL_PX / viewRef.current.zoom;
      // Iterate in reverse paint order so the top-most shape wins.
      for (let i = LAYER_DRAW_ORDER.length - 1; i >= 0; i--) {
        const layer = LAYER_DRAW_ORDER[i];
        if (layerHidden[layer]) continue;
        const shapes = cellType.layers?.[layer];
        if (!shapes) continue;
        for (let j = shapes.length - 1; j >= 0; j--) {
          if (shapeHit(shapes[j], pt, tol)) {
            return { layer, shape: shapes[j] };
          }
        }
      }
      return null;
    },
    []
  );

  /** Resolve a shape-key back to its current layer + shape. */
  const resolveKey = useCallback(
    (key: string): { layer: LayerType; shape: LayerShape } | null => {
      const parsed = parseShapeKey(key);
      if (!parsed) return null;
      const shapes = propsRef.current.cellType.layers?.[parsed.layer];
      const shape = shapes?.find((s) => s.id === parsed.id);
      return shape ? { layer: parsed.layer, shape } : null;
    },
    []
  );

  /** Among the currently-selected shapes, find a corner/vertex handle within
   *  `tol` of `pt`. Returns null if `pt` lands on no handle. Single-shape
   *  selection only (multi-select drags the bodies, not vertices). */
  const hitHandle = useCallback(
    (pt: Point): { key: string; vIdx: number } | null => {
      const sel = propsRef.current.selectedShapeIds;
      if (sel.size !== 1) return null;
      const only = sel.values().next().value as string;
      const r = resolveKey(only);
      if (!r) return null;
      const tol = HANDLE_HIT_TOL_PX / viewRef.current.zoom;
      const v = shapeHandleAt(r.shape, pt, tol);
      return v == null ? null : { key: only, vIdx: v };
    },
    [resolveKey]
  );

  /** Bounds of a multi-selection's vertices — the group box a corner drag
   *  scales. Null unless 2+ selected shapes still exist. */
  const selectionBox = useCallback((): Rect | null => {
    const sel = propsRef.current.selectedShapeIds;
    if (sel.size < 2) return null;
    const shapes: LayerShape[] = [];
    for (const key of sel) {
      const r = resolveKey(key);
      if (r) shapes.push(r.shape);
    }
    return shapes.length < 2 ? null : shapesBounds(shapes);
  }, [resolveKey]);

  /** Group-box corner handle under `pt` (index into `rectCorners` of the
   *  padded box: TL, TR, BR, BL), or null. */
  const hitGroupCorner = useCallback(
    (pt: Point): number | null => {
      const box = selectionBox();
      if (!box) return null;
      const zoom = viewRef.current.zoom;
      const tol = HANDLE_HIT_TOL_PX / zoom;
      const corners = rectCorners(inflate(box, GROUP_PAD_PX / zoom));
      const i = corners.findIndex(
        (c) => Math.abs(pt.x - c.x) <= tol && Math.abs(pt.y - c.y) <= tol
      );
      return i < 0 ? null : i;
    },
    [selectionBox]
  );

  // ── Pointer handling ───────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    canvas.focus();
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    const v = viewRef.current;
    const world = toWorld(cssX, cssY);
    const panKey = spaceRef.current || e.button === 1 || e.button === 2;
    const tool = propsRef.current.activeTool;

    // Pan beats everything else: dedicated pan tool or modifier-pan.
    if (tool === "pan" || panKey) {
      dragRef.current = {
        kind: "pan",
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        scale: null,
        moved: false
      };
      return;
    }

    if (tool === "select") {
      // Group corner (multi-select scale) > handle pick (single-shape vertex
      // edit) > body pick (move) > marquee.
      const corner = hitGroupCorner(world);
      const box = corner == null ? null : selectionBox();
      if (corner != null && box) {
        const snap = new Map<string, { layer: LayerType; shape: LayerShape }>();
        for (const k of propsRef.current.selectedShapeIds) {
          const r = resolveKey(k);
          if (r) snap.set(k, r);
        }
        const cs = rectCorners(box);
        const anchor = cs[(corner + 2) % 4];
        dragRef.current = {
          kind: "scale",
          sx: e.clientX,
          sy: e.clientY,
          wx: world.x,
          wy: world.y,
          startView: v,
          vertex: null,
          duplicateIds: null,
          movingSnapshot: snap,
          scale: { corner: cs[corner], anchor },
          moved: false
        };
        liveScaleRef.current = { anchor, sx: 1, sy: 1 };
        return;
      }
      const handle = hitHandle(world);
      if (handle) {
        const cur = resolveKey(handle.key);
        if (cur) {
          liveVertexRef.current = { key: handle.key, shape: cur.shape };
        }
        dragRef.current = {
          kind: "vertex",
          sx: e.clientX,
          sy: e.clientY,
          wx: world.x,
          wy: world.y,
          startView: v,
          vertex: handle,
          duplicateIds: null,
          movingSnapshot: null,
          scale: null,
          moved: false
        };
        return;
      }
      const hit = hitShape(world);
      if (hit) {
        const key = shapeKey(hit.layer, hit.shape.id);
        const sel = new Set(propsRef.current.selectedShapeIds);
        if (e.shiftKey) {
          if (sel.has(key)) sel.delete(key);
          else sel.add(key);
        } else if (!sel.has(key)) {
          sel.clear();
          sel.add(key);
        }
        propsRef.current.onSelect(sel);
        // Snapshot the (now) selected shapes so a move drag can translate
        // them in lock-step from the original positions.
        const snap = new Map<string, { layer: LayerType; shape: LayerShape }>();
        for (const k of sel) {
          const r = resolveKey(k);
          if (r) snap.set(k, r);
        }
        // Alt = duplicate the selection into the same layer(s), and move
        // the *copies*. We allocate fresh ids up-front so the live drag can
        // address them; the commit reinserts the originals untouched.
        const duplicateIds = e.altKey ? new Map<string, string>() : null;
        if (duplicateIds) {
          for (const k of snap.keys()) duplicateIds.set(k, crypto.randomUUID());
        }
        dragRef.current = {
          kind: "move",
          sx: e.clientX,
          sy: e.clientY,
          wx: world.x,
          wy: world.y,
          startView: v,
          vertex: null,
          duplicateIds,
          movingSnapshot: snap,
          scale: null,
          moved: false
        };
        liveMoveRef.current = { dx: 0, dy: 0 };
        return;
      }
      // Empty space → marquee.
      if (!e.shiftKey) propsRef.current.onSelect(new Set());
      dragRef.current = {
        kind: "marquee",
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        scale: null,
        moved: false
      };
      liveMarqueeRef.current = { x: world.x, y: world.y, width: 0, height: 0 };
      redraw();
      return;
    }

    if (tool === "rect") {
      dragRef.current = {
        kind: "rect-draw",
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        scale: null,
        moved: false
      };
      liveRectRef.current = { x: world.x, y: world.y, width: 0, height: 0 };
      redraw();
      return;
    }

    if (tool === "point") {
      // Single click drops a point on pointer-up; track to suppress click on
      // drag (so a tiny accidental wiggle still places).
      dragRef.current = {
        kind: null,
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        scale: null,
        moved: false
      };
      return;
    }

    if (tool === "polygon") {
      dragRef.current = {
        kind: null,
        sx: e.clientX,
        sy: e.clientY,
        wx: world.x,
        wy: world.y,
        startView: v,
        vertex: null,
        duplicateIds: null,
        movingSnapshot: null,
        scale: null,
        moved: false
      };
      return;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    cursorRef.current = toWorld(cssX, cssY);

    const d = dragRef.current;
    if (!d) {
      // No drag in flight → this is plain hover. Resolve the shape under
      // the cursor (and, when extraction is loaded, the specific diffusion
      // sub-region) and fire `onCanvasHover` only when the resolved target
      // changes. We avoid the dispatch on every mouse-move so the page can
      // do real work (status bar / row highlight) without throttling.
      const worldHover = cursorRef.current ?? toWorld(cssX, cssY);
      hoverCornerRef.current =
        propsRef.current.activeTool === "select" && !spaceRef.current
          ? hitGroupCorner(worldHover)
          : null;
      const hit = hitShape(worldHover);
      let subId: string | undefined;
      const ext = propsRef.current.extraction;
      if (hit?.layer === "diffusion" && ext && ext.kind === "inferred") {
        for (const sub of ext.shapes) {
          if (sub.parentDiffId !== hit.shape.id) continue;
          if (pointInPolygon(worldHover, sub.polygon)) {
            subId = sub.id;
            break;
          }
        }
      }
      const key = hit ? `${hit.layer}:${hit.shape.id}#${subId ?? ""}` : null;
      if (key !== lastHoverKeyRef.current) {
        lastHoverKeyRef.current = key;
        propsRef.current.onCanvasHover?.(
          hit ? { layer: hit.layer, shape: hit.shape, subRegionId: subId } : null,
        );
      }
      redraw();
      return;
    }
    if (!d.moved && (Math.abs(e.clientX - d.sx) > 1 || Math.abs(e.clientY - d.sy) > 1)) {
      d.moved = true;
    }
    const v = viewRef.current;
    const world = toWorld(cssX, cssY);

    if (d.kind === "pan") {
      viewRef.current = {
        ...v,
        ox: d.startView.ox - (e.clientX - d.sx) / v.zoom,
        oy: d.startView.oy - (e.clientY - d.sy) / v.zoom
      };
      redraw();
      return;
    }

    if (d.kind === "marquee") {
      liveMarqueeRef.current = {
        x: d.wx,
        y: d.wy,
        width: world.x - d.wx,
        height: world.y - d.wy
      };
      redraw();
      return;
    }

    if (d.kind === "rect-draw") {
      liveRectRef.current = {
        x: d.wx,
        y: d.wy,
        width: world.x - d.wx,
        height: world.y - d.wy
      };
      redraw();
      return;
    }

    if (d.kind === "move") {
      let dx = world.x - d.wx;
      let dy = world.y - d.wy;
      // Shift = constrain to dominant axis (horizontal or vertical only).
      if (e.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0;
        else dx = 0;
      }
      liveMoveRef.current = { dx, dy };
      redraw();
      return;
    }

    if (d.kind === "vertex" && d.vertex) {
      const r = resolveKey(d.vertex.key);
      if (r) {
        const next = moveShapeVertex(r.shape, d.vertex.vIdx, world);
        liveVertexRef.current = { key: d.vertex.key, shape: next };
        redraw();
      }
      return;
    }

    if (d.kind === "scale" && d.scale) {
      // The grabbed corner follows the pointer; the opposite corner holds.
      // Shift keeps the group's aspect ratio.
      const { corner, anchor } = d.scale;
      const target = { x: corner.x + world.x - d.wx, y: corner.y + world.y - d.wy };
      liveScaleRef.current = { anchor, ...cornerScale(anchor, corner, target, e.shiftKey) };
      redraw();
      return;
    }
  };

  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) {
      cursorRef.current = null;
      redraw();
      return;
    }
    const canvas = canvasRef.current;
    canvas?.releasePointerCapture(e.pointerId);
    const rect = canvas?.getBoundingClientRect();
    const cssX = rect ? e.clientX - rect.left : 0;
    const cssY = rect ? e.clientY - rect.top : 0;
    const world = toWorld(cssX, cssY);
    const tool = propsRef.current.activeTool;
    const { cellType, dispatch } = propsRef.current;

    if (d.kind === "pan") {
      redraw();
      return;
    }

    if (d.kind === "marquee") {
      const m = liveMarqueeRef.current;
      liveMarqueeRef.current = null;
      if (!d.moved || !m || m.width === 0 || m.height === 0) {
        redraw();
        return;
      }
      const r = normalizeRect(m);
      const next = new Set(
        e.shiftKey ? propsRef.current.selectedShapeIds : new Set<string>()
      );
      for (const layer of LAYER_DRAW_ORDER) {
        if (propsRef.current.layerHidden[layer]) continue;
        const shapes = cellType.layers?.[layer];
        if (!shapes) continue;
        for (const s of shapes) {
          if (shapeIntersectsRect(s, r)) next.add(shapeKey(layer, s.id));
        }
      }
      propsRef.current.onSelect(next);
      redraw();
      return;
    }

    if (d.kind === "rect-draw") {
      const r = liveRectRef.current;
      liveRectRef.current = null;
      if (!r || Math.abs(r.width) < 1 || Math.abs(r.height) < 1) {
        redraw();
        return;
      }
      const layer = propsRef.current.activeLayer;
      const shape = makeRect(r);
      dispatch(buildUpsertShapeAction(cellType, layer, shape));
      redraw();
      return;
    }

    if (d.kind === "move") {
      const live = liveMoveRef.current;
      liveMoveRef.current = null;
      const snap = d.movingSnapshot;
      if (!snap || !live || !d.moved || (live.dx === 0 && live.dy === 0)) {
        redraw();
        return;
      }
      // Build one atomic upsert: each moved shape replaced with its translated
      // copy. Alt-drag instead inserts fresh-id duplicates and leaves the
      // originals where they were.
      let action: AnnotationAction | null = null;
      if (d.duplicateIds) {
        // Bulk-insert per layer.
        const byLayer = new Map<LayerType, LayerShape[]>();
        const newKeys = new Set<string>();
        for (const [key, item] of snap) {
          const moved = translateShape(item.shape, live.dx, live.dy);
          const id = d.duplicateIds.get(key)!;
          const dup = { ...moved, id } as LayerShape;
          let arr = byLayer.get(item.layer);
          if (!arr) {
            arr = [];
            byLayer.set(item.layer, arr);
          }
          arr.push(dup);
          newKeys.add(shapeKey(item.layer, id));
        }
        // Walk the layers in stable order so the action sequence is
        // deterministic (helps if anything ever indexes by it).
        const actions: AnnotationAction[] = [];
        let working = cellType;
        for (const layer of LAYER_DRAW_ORDER) {
          const arr = byLayer.get(layer);
          if (!arr) continue;
          for (const s of arr) {
            const a = buildUpsertShapeAction(working, layer, s);
            actions.push(a);
            if (a.kind === "upsertCellType") working = a.cellType;
          }
        }
        action = actions.length === 1 ? actions[0] : { kind: "batch", actions };
        if (action) dispatch(action);
        propsRef.current.onSelect(newKeys);
      } else {
        const actions: AnnotationAction[] = [];
        let working = cellType;
        for (const [, item] of snap) {
          const moved = translateShape(item.shape, live.dx, live.dy);
          const a = buildUpsertShapeAction(working, item.layer, moved);
          actions.push(a);
          if (a.kind === "upsertCellType") working = a.cellType;
        }
        action = actions.length === 1 ? actions[0] : { kind: "batch", actions };
        if (action) dispatch(action);
      }
      redraw();
      return;
    }

    if (d.kind === "vertex" && d.vertex) {
      const live = liveVertexRef.current;
      liveVertexRef.current = null;
      if (!live || !d.moved) {
        redraw();
        return;
      }
      const parsed = parseShapeKey(d.vertex.key);
      if (parsed) {
        dispatch(buildUpsertShapeAction(cellType, parsed.layer, live.shape));
      }
      redraw();
      return;
    }

    if (d.kind === "scale") {
      const live = liveScaleRef.current;
      liveScaleRef.current = null;
      const snap = d.movingSnapshot;
      if (!snap || !live || !d.moved || (live.sx === 1 && live.sy === 1)) {
        redraw();
        return;
      }
      // One upsert for the whole group; the selection keeps its ids.
      const f = scaleAbout(live.anchor, live.sx, live.sy);
      const action = buildReplaceShapesAction(
        cellType,
        [...snap.values()].map(({ layer, shape }) => ({ layer, shape: mapShapePoints(shape, f) }))
      );
      if (action) dispatch(action);
      redraw();
      return;
    }

    // Click (no drag) branches by tool. Reaching here means kind was null —
    // i.e. the pointer-down landed on a click-only tool (point / polygon).
    if (!d.moved) {
      if (tool === "point") {
        const layer = propsRef.current.activeLayer;
        const shape = makePoint(world);
        dispatch(buildUpsertShapeAction(cellType, layer, shape));
      } else if (tool === "polygon") {
        propsRef.current.onPolyAddVertex(world);
      }
    }
    redraw();
  };

  // ── Wheel zoom (non-passive so trackpad pinch doesn't paginate) ────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const v = viewRef.current;
      if (e.ctrlKey || e.metaKey) {
        // Zoom about the cursor.
        const wx = v.ox + cssX / v.zoom;
        const wy = v.oy + cssY / v.zoom;
        const zoom = Math.min(
          64,
          Math.max(1e-3, v.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR))
        );
        viewRef.current = { zoom, ox: wx - cssX / zoom, oy: wy - cssY / zoom };
      } else {
        viewRef.current = {
          ...v,
          ox: v.ox + e.deltaX / v.zoom,
          oy: v.oy + e.deltaY / v.zoom
        };
      }
      redraw();
    };
    const preventGesture = (e: Event) => e.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", preventGesture, { passive: false });
    canvas.addEventListener("gesturechange", preventGesture, { passive: false });
    canvas.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", preventGesture);
      canvas.removeEventListener("gesturechange", preventGesture);
      canvas.removeEventListener("gestureend", preventGesture);
    };
  }, [redraw]);

  // ── Local keyboard (Esc / Enter / Delete / ⌘C ⌘V) ──────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Bail on inputs / contenteditable.
      const el = e.target as HTMLElement | null;
      if (
        el &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)
      ) {
        return;
      }
      const { activeTool, polyDraft } = propsRef.current;
      if (e.key === "Escape") {
        // Cancel order: rect-draft > polygon-draft > clear selection > leave
        // tool to select.
        if (liveRectRef.current) {
          liveRectRef.current = null;
          redraw();
          return;
        }
        if (activeTool === "polygon" && polyDraft.length > 0) {
          propsRef.current.onPolyCancel();
          return;
        }
        if (propsRef.current.selectedShapeIds.size > 0) {
          propsRef.current.onSelect(new Set());
          return;
        }
        propsRef.current.onEscape();
        return;
      }
      if (e.key === "Enter" && activeTool === "polygon" && polyDraft.length >= 3) {
        e.preventDefault();
        propsRef.current.onPolyCommit();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && !e.metaKey && !e.ctrlKey) {
        const sel = propsRef.current.selectedShapeIds;
        if (sel.size === 0) return;
        e.preventDefault();
        const removals: Array<{ layer: LayerType; id: string }> = [];
        for (const k of sel) {
          const p = parseShapeKey(k);
          if (p) removals.push(p);
        }
        const action = buildRemoveShapesAction(propsRef.current.cellType, removals);
        if (action) propsRef.current.dispatch(action);
        propsRef.current.onSelect(new Set());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [redraw]);

  // ── Drawing ────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w: cw, h: ch } = sizeRef.current;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#1a1a18";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const v = viewRef.current;
    const box = {
      w: cellType.cropRect.width,
      h: cellType.cropRect.height
    };

    // World → device transform (no per-instance rotation here: layer shapes
    // are stored in the canonical, un-rotated cell-local frame and the image
    // is rotated in-place inside that frame).
    ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, -v.ox * v.zoom * dpr, -v.oy * v.zoom * dpr);

    // ── Hover dim setup ───────────────────────────────────────────────
    //
    // When the user is hovering a right-panel row (or a schematic element),
    // dim everything that ISN'T a hover target so the highlighted shapes
    // pop. We compute the hover set once here and skip dimming once a drag
    // has ACTUALLY moved (the sub-region cache and live-edit transforms
    // wouldn't line up at the drag offset). Importantly: a stationary
    // pointer-down without movement also primes liveMove/liveVertex refs,
    // but the cached extraction is still valid in that state — gating on
    // `drag.moved` instead of `liveMove != null` keeps the inferred
    // colours visible across a normal click-select.
    //
    // `dimNonHovered` lets the page disable the dim pass when the hover
    // source is the canvas cursor itself (the steel-blue halo alone is
    // enough feedback — full-image dim while mousing across is jarring).
    // When false: `hovering` is held false, so the dim pass is skipped
    // AND the bright re-draw is skipped (everything renders normally in
    // the first pass), while the halo stroke below still paints because
    // it's gated on `hoveredShapeIds?.size > 0`, not on `hovering`.
    const inflightForDim = dragRef.current?.moved === true;
    const hoveredKeys = hoveredShapeIds ?? new Set<string>();
    const hoveredParentDiffIds = new Set<string>();
    for (const key of hoveredKeys) {
      const p = parseShapeKey(key);
      if (p?.layer === "diffusion") hoveredParentDiffIds.add(p.id);
    }
    const hovering = !inflightForDim && dimNonHovered && hoveredKeys.size > 0;
    const DIM_ALPHA = 0.35;

    // ── Image (die pixels shown in the canonical frame) ───────────────
    // An instance comes straight from the die's tile pyramid, at the level
    // the zoom needs, seen through its orientation and clipped to the box.
    // A URL image is canonical already: the clean specimen, or the type's
    // template crop when there's no instance to orient through.
    const img = getImage(imageUrl);
    // An instance on another die is read in that die's pixels (its box is
    // 1/cellScale of this one's) and drawn scaled up to this die's.
    const k = cellScale;
    const instanceBox = { cropRect: { x: 0, y: 0, width: box.w / k, height: box.h / k } };
    const region =
      cell && die && !imageCanonical
        ? dieRegion(die, cellFootprint(cell, instanceBox), v.zoom * dpr * k, redraw)
        : null;
    ctx.save();
    if (hovering) ctx.globalAlpha = DIM_ALPHA;
    ctx.imageSmoothingEnabled = v.zoom < 3;
    if (region && cell) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, box.w, box.h);
      ctx.clip();
      if (k !== 1) ctx.scale(k, k);
      enterCellDieFrame(ctx, cell, box.w / k, box.h / k);
      const r = region.rect;
      ctx.drawImage(region.canvas, r.x, r.y, r.width, r.height);
      ctx.restore();
    } else if (img) {
      ctx.drawImage(img, 0, 0, box.w, box.h);
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.04)";
      ctx.fillRect(0, 0, box.w, box.h);
    }
    // Die-viewer overlay (wires, vias) is drawn in die coordinates through
    // the same frame as the crop, so items stay pinned to the image features.
    if (cell && annotations) {
      ctx.save();
      if (k !== 1) ctx.scale(k, k);
      enterCellDieFrame(ctx, cell, box.w / k, box.h / k);
      drawDieOverlay(ctx, annotations, cellFootprint(cell, instanceBox), v.zoom * k, {
        hideWires: layerHidden["_dvWires"] === true,
        hideVias: layerHidden["_dvVias"] === true
      });
      ctx.restore();
    }
    ctx.restore();

    // Cell-type bounding rect (constant-screen-px stroke).
    ctx.strokeStyle = "rgba(245,214,138,0.5)";
    ctx.lineWidth = 1 / v.zoom;
    ctx.strokeRect(0, 0, box.w, box.h);

    // ── Layer shapes ──────────────────────────────────────────────────
    const tile: TileBounds = {
      size: 0,
      i: 0,
      j: 0,
      world: { x: 0, y: 0, width: 0, height: 0 },
      dpr,
      zoom: v.zoom
    };
    const liveMove = liveMoveRef.current;
    const liveVertex = liveVertexRef.current;
    const liveScale = liveScaleRef.current;
    const drag = dragRef.current;
    const moving = drag?.kind === "move" ? drag.movingSnapshot : null;
    const duplicating = drag?.kind === "move" ? drag.duplicateIds : null;
    const scaling = drag?.kind === "scale" ? drag.movingSnapshot : null;
    const scaleMap = liveScale ? scaleAbout(liveScale.anchor, liveScale.sx, liveScale.sy) : null;
    /** A shape as the in-flight drag shows it: mid vertex-edit, moved, or
     *  scaled with its group. */
    const preview = (key: string, s: LayerShape): LayerShape => {
      if (liveVertex && liveVertex.key === key) return liveVertex.shape;
      if (moving && moving.has(key) && !duplicating && liveMove) {
        return translateShape(s, liveMove.dx, liveMove.dy);
      }
      if (scaling && scaling.has(key) && scaleMap) return mapShapePoints(s, scaleMap);
      return s;
    };

    // ── Extraction-driven coloring hints ──────────────────────────────
    //
    // Two sources of inferred colour, both routed through the existing
    // `shape.label` → `COLOR_LABEL` path so the cell uses the same red/blue
    // palette the user already sees from "Force P/N":
    //
    //   1. Any shape in a net that resolved to label "vcc"/"gnd"/"io" gets
    //      that label injected for rendering (only when the shape doesn't
    //      already carry one — user-set labels always win).
    //   2. The diffusion sub-regions returned by step 1 of the pipeline
    //      replace the original diffusion shape: same fill colour as the
    //      net-label propagation would produce, but each S/D pad becomes a
    //      separate visual region so the gate cuts are obvious.
    //
    // Both are suppressed once the drag has actually moved — the cached
    // sub-region polygons are stale at the drag offset, so we'd be painting
    // at the old location. A pointer-down without movement (a normal
    // click-to-select) leaves the inferred view intact: `inflightForDim`
    // above gates on the same `drag.moved` flag.
    const inferred =
      !inflightForDim && extraction && extraction.kind === "inferred"
        ? (extraction as InferredCellExtraction)
        : null;
    const inferredLabel = new Map<string, ShapeLabel>();
    const hideOriginalDiff = new Set<string>();
    const subRegionDraws: Array<{
      id: string;
      parentDiffId: string;
      polygon: Point[];
      label?: ShapeLabel;
    }> = [];
    if (inferred) {
      // Non-diffusion shape colouring comes from the net's propagated label:
      // a metal/poly/contact/via that ended up in the VCC net should display
      // as VCC. Sub-regions don't go through this branch — even when a
      // middle sub-region's net is an internal stack node, the whole
      // diffusion body sits in a single well biased to VCC or GND, so per-
      // sub-region net labels would only colour the rail-touching ones and
      // leave the middle pads orange. Those use the parent-type rule below.
      const labelByNetId = new Map<number, ShapeLabel>();
      for (const n of inferred.nets) {
        if (n.label) labelByNetId.set(n.id, n.label);
      }
      for (const s of inferred.shapes) {
        if (s.parentDiffId) continue;
        const l = labelByNetId.get(s.netId);
        if (l) inferredLabel.set(s.id, l);
      }
      // Sub-regions: colour is driven by the parent diffusion's inferred
      // P/N type (P → "vcc" red, N → "gnd" blue, unknown → no override).
      // This way EVERY sub-region of one diffusion reads the same colour,
      // regardless of which transistor S/D net each one ended up on.
      const typeByDiff = new Map(
        inferred.diffusions.map((d) => [d.shapeId, d.type]),
      );
      for (const s of inferred.shapes) {
        if (!s.parentDiffId) continue;
        hideOriginalDiff.add(s.parentDiffId);
        const type = typeByDiff.get(s.parentDiffId);
        const label: "vcc" | "gnd" | undefined =
          type === "p" ? "vcc" : type === "n" ? "gnd" : undefined;
        if (label) inferredLabel.set(s.id, label);
        subRegionDraws.push({
          id: s.id,
          parentDiffId: s.parentDiffId,
          polygon: s.polygon,
          label,
        });
      }
    }

    // Main pass — wrapped in a save so the optional hover dim doesn't leak
    // into the halos / handles drawn afterwards. Hovered shapes are skipped
    // here (so they don't render at dim alpha) and re-drawn at full alpha
    // in the bright pass further down.
    ctx.save();
    if (hovering) ctx.globalAlpha = DIM_ALPHA;
    drawCellLayers(ctx, cellType.layers, tile, {
      isHidden: (layer) => layerHidden[layer] === true,
      replaceShape: (_layer, s) => {
        if (_layer === "diffusion" && hideOriginalDiff.has(s.id)) return null;
        if (hovering && hoveredKeys.has(shapeKey(_layer, s.id))) return null;
        let shape = preview(shapeKey(_layer, s.id), s);
        if (!shape.label) {
          const l = inferredLabel.get(s.id);
          if (l) shape = { ...shape, label: l } as LayerShape;
        }
        return shape;
      }
    });

    // Diffusion sub-region overlays. Sit at the same z-order as the original
    // diffusion they replace. Sub-regions whose parent is hovered are
    // skipped here and redrawn at full alpha below.
    if (inferred && !layerHidden["diffusion"]) {
      for (const sub of subRegionDraws) {
        if (hovering && hoveredParentDiffIds.has(sub.parentDiffId)) continue;
        const polyShape = {
          id: sub.id,
          kind: "polygon",
          points: sub.polygon,
          label: sub.label,
        } as LayerShape;
        applyShapeStyle(ctx, "diffusion", polyShape);
        drawShape(ctx, polyShape, tile);
      }
    }
    ctx.restore();

    // ── Bright re-draw of hovered shapes ──────────────────────────────
    //
    // Paint every hovered shape (and the sub-regions of any hovered
    // diffusion) at full opacity so they pop above the faded background.
    // Mirrors the dim pass's per-shape transform + label injection so the
    // same shape renders identically in both passes, only at different alpha.
    if (hovering) {
      for (const key of hoveredKeys) {
        const r = resolveKey(key);
        if (!r) continue;
        // Originals hidden in favour of sub-regions — those are repainted
        // in the sub-region block below.
        if (r.layer === "diffusion" && hideOriginalDiff.has(r.shape.id)) continue;
        let shape = preview(key, r.shape);
        if (!shape.label) {
          const l = inferredLabel.get(r.shape.id);
          if (l) shape = { ...shape, label: l } as LayerShape;
        }
        applyShapeStyle(ctx, r.layer, shape);
        drawShape(ctx, shape, tile);
      }
      if (inferred && !layerHidden["diffusion"]) {
        for (const sub of subRegionDraws) {
          if (!hoveredParentDiffIds.has(sub.parentDiffId)) continue;
          const polyShape = {
            id: sub.id,
            kind: "polygon",
            points: sub.polygon,
            label: sub.label,
          } as LayerShape;
          applyShapeStyle(ctx, "diffusion", polyShape);
          drawShape(ctx, polyShape, tile);
        }
      }
    }
    // Alt-drag duplicates: fresh-id copies painted at the dragged offset, in
    // their source layer's color. Grouped by layer so we don't churn the
    // canvas fill/stroke between shapes.
    if (duplicating && moving && liveMove) {
      const byLayer = new Map<LayerType, LayerShape[]>();
      for (const [key, item] of moving) {
        const dupId = duplicating.get(key);
        if (!dupId) continue;
        const moved = translateShape(item.shape, liveMove.dx, liveMove.dy);
        const list = byLayer.get(item.layer) ?? [];
        list.push({ ...moved, id: dupId } as LayerShape);
        byLayer.set(item.layer, list);
      }
      for (const [layer, shapes] of byLayer) {
        if (layerHidden[layer]) continue;
        for (const s of shapes) {
          applyShapeStyle(ctx, layer, s);
          drawShape(ctx, s, tile);
        }
      }
    }

    // ── Hover halos (right-panel row highlight) ──────────────────────
    //
    // Painted BEFORE the selection halos so selection visually dominates
    // when both fire on the same shape. Steel-blue + thinner stroke so it
    // reads as "look here" without competing with the amber selection.
    if (hoveredShapeIds && hoveredShapeIds.size > 0) {
      ctx.strokeStyle = "#7fb2ff";
      ctx.lineWidth = 1.5 / v.zoom;
      for (const key of hoveredShapeIds) {
        const r = resolveKey(key);
        if (!r) continue;
        strokeShape(ctx, r.shape, v.zoom);
      }
    }

    // ── Selection halos (amber outline) ───────────────────────────────
    ctx.strokeStyle = SELECT_COLOR;
    ctx.lineWidth = 2 / v.zoom;
    for (const key of selectedShapeIds) {
      const r = resolveKey(key);
      if (!r) continue;
      strokeShape(ctx, preview(key, r.shape), v.zoom);
    }
    // For alt-drag duplicates: outline the *duplicates* in the active accent
    // (they're the things that will be selected after release).
    if (duplicating && moving && liveMove) {
      for (const [, item] of moving) {
        const moved = translateShape(item.shape, liveMove.dx, liveMove.dy);
        strokeShape(ctx, moved, v.zoom);
      }
    }

    // ── Group box + corner (scale) handles for a multi-selection ──────
    // Hidden during an alt-drag duplicate: what moves then is the copies.
    if (selectedShapeIds.size >= 2 && !duplicating) {
      const shapes: LayerShape[] = [];
      for (const key of selectedShapeIds) {
        const r = resolveKey(key);
        if (r) shapes.push(preview(key, r.shape));
      }
      const groupBox = shapes.length >= 2 ? shapesBounds(shapes) : null;
      if (groupBox) {
        const outer = inflate(groupBox, GROUP_PAD_PX / v.zoom);
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = 1 / v.zoom;
        ctx.setLineDash([4 / v.zoom, 3 / v.zoom]);
        ctx.strokeRect(outer.x, outer.y, outer.width, outer.height);
        ctx.setLineDash([]);
        const r = HANDLE_PX / v.zoom / 2;
        ctx.fillStyle = "#fff";
        ctx.lineWidth = 1.5 / v.zoom;
        for (const c of rectCorners(outer)) {
          ctx.beginPath();
          ctx.rect(c.x - r, c.y - r, r * 2, r * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // ── Drag handles for single-shape selection ───────────────────────
    if (selectedShapeIds.size === 1) {
      const only = selectedShapeIds.values().next().value as string;
      const cur = resolveKey(only);
      if (cur) {
        const handles = shapeHandles(preview(only, cur.shape));
        const r = HANDLE_PX / v.zoom / 2;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = SELECT_COLOR;
        ctx.lineWidth = 1.5 / v.zoom;
        for (const h of handles) {
          ctx.beginPath();
          ctx.rect(h.x - r, h.y - r, r * 2, r * 2);
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // ── In-progress rect (rubber-band) ────────────────────────────────
    const liveR = liveRectRef.current;
    if (liveR && (Math.abs(liveR.width) > 0 || Math.abs(liveR.height) > 0)) {
      const n = normalizeRect(liveR);
      ctx.strokeStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "rgba(255,255,255,0.1)";
      ctx.globalAlpha = 0.4;
      ctx.fillRect(n.x, n.y, n.width, n.height);
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5 / v.zoom;
      ctx.strokeRect(n.x, n.y, n.width, n.height);
    }

    // ── In-progress polygon ───────────────────────────────────────────
    if (activeTool === "polygon" && polyDraft.length > 0) {
      ctx.strokeStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      ctx.lineWidth = 1.5 / v.zoom;
      ctx.beginPath();
      ctx.moveTo(polyDraft[0].x, polyDraft[0].y);
      for (let i = 1; i < polyDraft.length; i++) {
        ctx.lineTo(polyDraft[i].x, polyDraft[i].y);
      }
      if (polyDraft.length >= 3) {
        ctx.closePath();
        ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "rgba(255,255,255,0.1)";
        ctx.globalAlpha = 0.25;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      ctx.stroke();
      // Cursor preview edge.
      const cur = cursorRef.current;
      if (cur) {
        const last = polyDraft[polyDraft.length - 1];
        ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
        ctx.beginPath();
        ctx.moveTo(last.x, last.y);
        ctx.lineTo(cur.x, cur.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // Vertex dots.
      ctx.fillStyle = COLOR_LAYER[activeLayer] ?? "#fff";
      const dotR = 3 / v.zoom;
      for (const p of polyDraft) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotR, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ── Marquee rectangle ─────────────────────────────────────────────
    const liveM = liveMarqueeRef.current;
    if (liveM && (Math.abs(liveM.width) > 0 || Math.abs(liveM.height) > 0)) {
      const n = normalizeRect(liveM);
      ctx.fillStyle = "rgba(58, 169, 255, 0.10)";
      ctx.strokeStyle = "rgba(58, 169, 255, 0.95)";
      ctx.lineWidth = 1 / v.zoom;
      ctx.fillRect(n.x, n.y, n.width, n.height);
      ctx.strokeRect(n.x, n.y, n.width, n.height);
    }
  });

  // ── Cursor styling per tool ────────────────────────────────────────
  const cursor = (() => {
    if (spaceRef.current) return "grab" as const;
    if (activeTool === "pan") return "grab" as const;
    // Over (or dragging) a group-box corner: TL / BR vs TR / BL diagonal.
    const corner =
      dragRef.current?.kind === "scale" || !dragRef.current ? hoverCornerRef.current : null;
    if (activeTool === "select" && selectedShapeIds.size >= 2 && corner != null) {
      return corner % 2 === 0 ? ("nwse-resize" as const) : ("nesw-resize" as const);
    }
    if (activeTool === "rect" || activeTool === "polygon" || activeTool === "point") {
      return "crosshair" as const;
    }
    return "default" as const;
  })();

  return (
    <div
      ref={hostRef}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: 0,
        background: "var(--canvas-bg)",
        overflow: "hidden",
        overscrollBehavior: "none"
      }}
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{
          display: "block",
          cursor,
          touchAction: "none",
          overscrollBehavior: "none",
          outline: "none"
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => {
          if (!dragRef.current) hoverCornerRef.current = null;
          // Cursor left the canvas — clear status/highlight. Only fire if we
          // had a hover (avoids redundant null callbacks while dragging in
          // and out of empty regions).
          if (lastHoverKeyRef.current !== null) {
            lastHoverKeyRef.current = null;
            propsRef.current.onCanvasHover?.(null);
          }
        }}
        onContextMenu={(e) => {
          // We always preempt the OS menu. Then: if we're in select mode and
          // the click landed on a shape, ensure that shape is part of the
          // selection (replace if not, keep multi-select intact otherwise) and
          // notify the page so it can pop the shape menu. Outside select mode
          // — or on empty canvas — we just dismiss any open menu.
          e.preventDefault();
          const cb = propsRef.current.onShapeContextMenu;
          if (!cb) return;
          const tool = propsRef.current.activeTool;
          // Pan / draw tools don't have a useful per-shape menu; respect the
          // current tool's modality and skip the menu entirely.
          if (tool !== "select") {
            cb(null, e.clientX, e.clientY);
            return;
          }
          const canvas = canvasRef.current;
          if (!canvas) return;
          const r = canvas.getBoundingClientRect();
          const world = toWorld(e.clientX - r.left, e.clientY - r.top);
          const hit = hitShape(world);
          if (!hit) {
            // Off any shape but inside a multi-selection's group box: a menu
            // for the selection as a whole.
            const box = selectionBox();
            const onSelection = propsRef.current.onSelectionContextMenu;
            if (
              box &&
              onSelection &&
              pointInRect(world, inflate(box, GROUP_PAD_PX / viewRef.current.zoom))
            ) {
              onSelection(e.clientX, e.clientY);
              return;
            }
            cb(null, e.clientX, e.clientY);
            return;
          }
          // If the right-clicked shape isn't already selected, replace-select
          // it (Photoshop-style). Otherwise leave the existing multi-select
          // alone — the menu's plural-aware labels handle the rest.
          const key = shapeKey(hit.layer, hit.shape.id);
          const sel = propsRef.current.selectedShapeIds;
          if (!sel.has(key)) {
            propsRef.current.onSelect(new Set([key]));
          }
          cb(hit, e.clientX, e.clientY);
        }}
      />
    </div>
  );
});

/** Stroke (outline) a shape for the selection halo. Caller has already set
 *  strokeStyle / lineWidth. */
function strokeShape(
  ctx: CanvasRenderingContext2D,
  shape: LayerShape,
  zoom: number
): void {
  switch (shape.kind) {
    case "rect":
      ctx.strokeRect(shape.x, shape.y, shape.width, shape.height);
      return;
    case "point": {
      const r = Math.max(shape.size / 2, 3 / zoom);
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, r + 1.5 / zoom, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    case "polygon":
      if (shape.points.length === 0) return;
      ctx.beginPath();
      ctx.moveTo(shape.points[0].x, shape.points[0].y);
      for (let i = 1; i < shape.points.length; i++) {
        ctx.lineTo(shape.points[i].x, shape.points[i].y);
      }
      ctx.closePath();
      ctx.stroke();
      return;
    case "circle":
      ctx.beginPath();
      ctx.arc(shape.x, shape.y, shape.radius, 0, Math.PI * 2);
      ctx.stroke();
      return;
    case "line":
      ctx.beginPath();
      ctx.moveTo(shape.x1, shape.y1);
      ctx.lineTo(shape.x2, shape.y2);
      ctx.stroke();
      return;
  }
}

// ── Die-viewer overlay ─────────────────────────────────────────────────

/** Screen-px stroke for overlay wires — kept thin so they don't dominate the
 *  imagery, and constant on-screen via the `/zoom` factor. */
const DV_WIRE_PX = 1.5;
const DV_NODE_PX = 2.5;
const DV_POINT_VIA_PX = 3;

/**
 * Paint die-viewer wires + vias clipped to `cellDieRect` (so we only draw
 * the items actually intersecting this cell). Caller has already placed the
 * transform into die-coord space (`enterCellDieFrame`), so this function
 * just iterates `annotations` and draws raw die coordinates.
 *
 * Visibility is per-feature (wires / vias) rather than a single die-viewer
 * toggle so the user can keep the wire skeleton on while turning off via
 * dots when annotating a noisy cell, and vice versa.
 */
function drawDieOverlay(
  ctx: CanvasRenderingContext2D,
  annotations: DieAnnotations,
  cellDieRect: Rect,
  zoom: number,
  options: { hideWires?: boolean; hideVias?: boolean } = {}
): void {
  // ── Wires ─────────────────────────────────────────────────────────
  if (!options.hideWires) {
    const prevCap = ctx.lineCap;
    ctx.lineCap = "round";
    ctx.lineWidth = DV_WIRE_PX / zoom;
    const nodeRadius = DV_NODE_PX / zoom;
    for (const net of annotations.nets) {
      // Skip nets whose entire bbox sits outside the cell — cheap reject
      // before the per-node lookup.
      let any = false;
      for (const n of net.nodes) {
        if (pointInRect(n, cellDieRect)) {
          any = true;
          break;
        }
      }
      // Also check edge intersection in case a long wire passes through
      // without an endpoint in the cell.
      if (!any) {
        const nodeMap = new Map(net.nodes.map((n) => [n.id, n]));
        for (const e of net.edges) {
          const a = nodeMap.get(e.from);
          const b = nodeMap.get(e.to);
          if (a && b && segmentIntersectsRect(a, b, cellDieRect)) {
            any = true;
            break;
          }
        }
      }
      if (!any) continue;

      const nodeById = new Map(net.nodes.map((n) => [n.id, n]));
      // Edges first so node dots sit on top of the wire ends.
      for (const edge of net.edges) {
        const from = nodeById.get(edge.from);
        const to = nodeById.get(edge.to);
        if (!from || !to) continue;
        if (!segmentIntersectsRect(from, to, cellDieRect)) continue;
        ctx.strokeStyle =
          (edge.layer && WIRE_LAYER_COLOR[edge.layer]) || NET_COLOR;
        ctx.beginPath();
        ctx.moveTo(from.x, from.y);
        ctx.lineTo(to.x, to.y);
        ctx.stroke();
      }
      ctx.fillStyle = NET_COLOR;
      for (const node of net.nodes) {
        if (!pointInRect(node, cellDieRect)) continue;
        ctx.beginPath();
        ctx.arc(node.x, node.y, nodeRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.lineCap = prevCap;
  }

  // ── Vias (ML / human annotations) ─────────────────────────────────
  if (!options.hideVias && annotations.annotations) {
    ctx.lineWidth = 1 / zoom;
    for (const a of annotations.annotations) {
      const g = a.geometry;
      if (g.kind === "point") {
        if (!pointInRect(g, cellDieRect)) continue;
        const r = DV_POINT_VIA_PX / zoom;
        ctx.fillStyle = COLOR_VIA;
        ctx.beginPath();
        ctx.arc(g.x, g.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (g.kind === "rectangle") {
        if (!rectsIntersect(g, cellDieRect)) continue;
        ctx.fillStyle = COLOR_VIA_FILL;
        ctx.strokeStyle = COLOR_VIA;
        ctx.fillRect(g.x, g.y, g.width, g.height);
        ctx.strokeRect(g.x, g.y, g.width, g.height);
      } else if (g.kind === "polygon") {
        const b = polygonBounds(g.points);
        if (!b || !rectsIntersect(b, cellDieRect)) continue;
        ctx.fillStyle = COLOR_VIA_FILL;
        ctx.strokeStyle = COLOR_VIA;
        ctx.beginPath();
        ctx.moveTo(g.points[0].x, g.points[0].y);
        for (let i = 1; i < g.points.length; i++) {
          ctx.lineTo(g.points[i].x, g.points[i].y);
        }
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      // polyline geometry only occurs for `trace`, which isn't persisted.
    }
  }
}

