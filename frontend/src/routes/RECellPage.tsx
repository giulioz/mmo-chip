import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type {
  Cell,
  ForcedDiffusionType,
  LayerShape,
  LayerType,
  ShapeLabel
} from "shared";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar } from "../components/shell/SubBar";
import { Ic } from "../icons";
import { useDie } from "../api/dies";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useActionDispatcher } from "../api/actions";
import { useCellLibrary, useForeignTypeImageUrl } from "../api/cellLibrary";
import {
  buildLibraryTypeTransform,
  libraryMemberCount,
  remoteInstances,
  routeLibraryAction,
  withLibraryTypes,
  type RemoteInstance
} from "../lib/cellLibrary";
import { useSession } from "../state/session";
import { useCellREStore, TOOL_LAYERS } from "../state/cellRE";
import { usePreferences } from "../state/preferences";
import { fitRectViewport } from "../renderer/TiledCanvas";
import { isTypingTarget } from "../lib/keyboard";
import {
  PASTE_OFFSET,
  resolveActiveCell,
  selectedShapes,
  snapshotForClipboard
} from "../lib/cellRE";
import {
  buildFlipShapesAction,
  buildInsertShapesAction,
  buildRemoveShapesAction,
  buildRenameCellTypeAction,
  buildRotateShapesAction,
  buildSetShapeCustomNameAction,
  buildSetShapeForcedTypesAction,
  buildSetShapeLabelsAction,
  translateShape
} from "../lib/cellLayers";
import {
  buildMarkMatchedAction,
  buildOrientAction,
  buildUnmatchAction,
  cellTypeById,
  cellTypeCropUrl,
  membersOf,
  orientOf,
  rotateView
} from "../lib/mergeCells";
import { cellFootprint, sameFrame } from "../lib/cellDetection";
import {
  CellRECanvas,
  type CellRECanvasHandle,
  type CanvasHoverTarget
} from "../components/cellRE/CellRECanvas";
import {
  canvasHoverToEntity,
  entityToImageShapeKeys,
  type HoverEntity
} from "../components/cellRE/hoverEntity";
import { CellREToolbar } from "../components/cellRE/CellREToolbar";
import { CellRELeftPanel } from "../components/cellRE/CellRELeftPanel";
import { CellRERightPanel } from "../components/cellRE/CellRERightPanel";
import { SchematicCanvas } from "../components/cellRE/SchematicCanvas";
import { LogicSchematicCanvas } from "../components/cellRE/LogicSchematicCanvas";
import {
  CellREContextMenu,
  type ReContextMenuState
} from "../components/cellRE/CellREContextMenu";
import {
  CellTypeContextMenu,
  type CellTypeContextMenuState
} from "../components/cellRE/CellTypeContextMenu";
import {
  ShapeContextMenu,
  type AppliedForcedType,
  type AppliedLabel,
  type ShapeContextMenuState,
  type ShapeMenuAnchor
} from "../components/cellRE/ShapeContextMenu";
import type { CellType } from "shared";
import { useLayerPolyTool } from "../components/cellRE/useLayerPolyTool";
import { parseShapeKey, shapeKey } from "../state/cellRE";
import { useCellExtraction } from "../api/cellExtraction";
import { specimenImageUrl, useCellSpecimens } from "../api/cellImaging";
import { netDisplayName } from "../lib/labels";
import type { CellExtraction, ExtractedNet } from "../lib/extraction";

export function RECellPage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="RE cell">
        <Centered>Open a die from the Library to reverse-engineer cells.</Centered>
      </AppShell>
    );
  }
  return <RE key={dieId} dieId={dieId} />;
}

function RE({ dieId }: { dieId: string }) {
  const navigate = useNavigate();
  const [params, setSearchParams] = useSearchParams();
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  const ownAnnotations = annotationsQ.data;
  // Other dies' types shared through the cell library, merged in at this
  // die's scale: RE'ing one here edits it for every die (routed to the die
  // that owns it, in its pixels).
  const library = useCellLibrary(dieId, ownAnnotations);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const annotations = useMemo(
    () => (ownAnnotations ? withLibraryTypes(ownAnnotations, library) : undefined),
    [ownAnnotations, library]
  );
  const dispatcher = useActionDispatcher(dieId, {
    route: (action) => routeLibraryAction(action, libraryRef.current)
  });

  // ── State (transient page + persisted prefs) ───────────────────────
  const activeCellTypeId = useCellREStore((s) => s.activeCellTypeId);
  const activeCellId = useCellREStore((s) => s.activeCellId);
  const activeTool = useCellREStore((s) => s.activeTool);
  const activeLayer = useCellREStore((s) => s.activeLayer);
  const selectedShapeIds = useCellREStore((s) => s.selectedShapeIds);
  const clipboard = useCellREStore((s) => s.clipboard);
  const canvasTab = useCellREStore((s) => s.canvasTab);
  const activeDomainId = useCellREStore((s) => s.activeDomainId);
  const setActiveDomainId = useCellREStore((s) => s.setActiveDomainId);
  const setActiveCellType = useCellREStore((s) => s.setActiveCellType);
  const setActiveTool = useCellREStore((s) => s.setActiveTool);
  const setActiveLayer = useCellREStore((s) => s.setActiveLayer);
  const setSelectedShapeIds = useCellREStore((s) => s.setSelectedShapeIds);
  const setClipboard = useCellREStore((s) => s.setClipboard);
  const setCanvasTab = useCellREStore((s) => s.setCanvasTab);

  const layerHidden = usePreferences((s) => s.reLayerHidden);
  const useCleanSpecimens = usePreferences((s) => s.useCleanSpecimens);
  const specimenIndex = useCellSpecimens(dieId).data ?? null;

  const canvasRef = useRef<CellRECanvasHandle | null>(null);
  const [menu, setMenu] = useState<ReContextMenuState | null>(null);
  const [typeMenu, setTypeMenu] = useState<CellTypeContextMenuState | null>(null);
  const [shapeMenu, setShapeMenu] = useState<ShapeContextMenuState | null>(null);
  // What the canvas cursor is currently over. Page-local because two
  // consumers want it (status bar + right-panel row highlight) and both
  // are in this subtree.
  const [canvasHover, setCanvasHover] = useState<CanvasHoverTarget | null>(null);
  // Single source of truth for "what is the user pointing at?" — fed by
  // schematic-side hovers AND right-panel row hovers. Image-canvas cursor
  // hovers go through `canvasHover` (which carries extra subRegion info
  // for the status bar) and are folded into an entity below.
  //
  // Why typed instead of a Set<shapeKey>? See hoverEntity.ts — the
  // shape-key approach caused over-highlight via sub-region → parent-diff
  // folding (two nets sharing a diffusion parent looked "related" to
  // every consumer).
  const [hoveredEntity, setHoveredEntity] = useState<HoverEntity>(null);

  // Selection is an image-tab concept (canvas halos + right-panel-row
  // accent). Switching tabs clears it so the user lands in a fresh state
  // every time they bounce between image and schematic — leftover
  // selection from a previous session would just confuse on return.
  useEffect(() => {
    setSelectedShapeIds(new Set());
  }, [canvasTab, setSelectedShapeIds]);

  // Hover entity references net / transistor / domain ids that don't
  // outlive the current cell type — drop it when the active type changes
  // so a stale id can't ghost-match against the new cell's rows.
  useEffect(() => {
    setHoveredEntity(null);
    setCanvasHover(null);
  }, [activeCellTypeId]);

  // ── URL ↔ store sync ──────────────────────────────────────────────
  // One-shot hydration on mount: `?type=&cell=&tab=` seeds the store so a
  // refresh (or a deep link) lands the user on the same cell and tab.
  // useLayoutEffect so the set fires before the auto-select-first effect
  // below sees `activeCellTypeId` still null and overrides the URL choice.
  const hydratedFromUrlRef = useRef(false);
  useLayoutEffect(() => {
    if (hydratedFromUrlRef.current) return;
    hydratedFromUrlRef.current = true;
    const type = params.get("type");
    const cell = params.get("cell");
    if (type) setActiveCellType(type, cell);
    // Only honour the tab param when it's a non-default value — keeps
    // the URL clean for first-time visits (cell-image is the implicit
    // default the URL doesn't have to spell out).
    const tab = params.get("tab");
    if (tab === "schematic") setCanvasTab("schematic");
    else if (tab === "logic") setCanvasTab("logicSchematic");
  }, [params, setActiveCellType, setCanvasTab]);

  // Write the active type / cell / tab back into the URL whenever they
  // change. Uses `replace` so per-click switching doesn't pollute the
  // back-button history. Diffs first so the store→URL→params→effect loop
  // self-terminates. `tab` is omitted when it's the default ("image") so
  // the URL stays compact.
  useEffect(() => {
    if (!hydratedFromUrlRef.current) return;
    const next = new URLSearchParams(params);
    let changed = false;
    if (activeCellTypeId) {
      if (next.get("type") !== activeCellTypeId) {
        next.set("type", activeCellTypeId);
        changed = true;
      }
    } else if (next.has("type")) {
      next.delete("type");
      changed = true;
    }
    if (activeCellId) {
      if (next.get("cell") !== activeCellId) {
        next.set("cell", activeCellId);
        changed = true;
      }
    } else if (next.has("cell")) {
      next.delete("cell");
      changed = true;
    }
    // The URL uses short tokens: "schematic" + "logic" (vs the store's
    // longer "logicSchematic"). Keeps the URL bar readable for shared
    // deep links.
    const tabToken =
      canvasTab === "schematic" ? "schematic"
      : canvasTab === "logicSchematic" ? "logic"
      : null;
    if (tabToken) {
      if (next.get("tab") !== tabToken) {
        next.set("tab", tabToken);
        changed = true;
      }
    } else if (next.has("tab")) {
      next.delete("tab");
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [activeCellTypeId, activeCellId, canvasTab, params, setSearchParams]);

  // A type's instances on the library's other dies — listed after this
  // die's own in the tree; picking one shows its own die's pixels, scaled
  // to this die.
  const remoteMembersOf = useMemo(() => {
    const cache = new Map<string, RemoteInstance[]>();
    return (typeId: string): RemoteInstance[] => {
      if (!ownAnnotations) return [];
      let hit = cache.get(typeId);
      if (!hit) cache.set(typeId, (hit = remoteInstances(library, ownAnnotations, typeId)));
      return hit;
    };
  }, [library, ownAnnotations]);

  // ── Resolve current cell type + instance ──────────────────────────
  const { cellType, cell: localCell } = useMemo(() => {
    if (!annotations) return { cellType: null, cell: null };
    return resolveActiveCell(annotations, activeCellTypeId, activeCellId);
  }, [annotations, activeCellTypeId, activeCellId]);
  const remoteCell = useMemo(
    () =>
      cellType && activeCellId
        ? (remoteMembersOf(cellType.id).find((r) => r.cell.id === activeCellId) ?? null)
        : null,
    [cellType, activeCellId, remoteMembersOf]
  );
  const cell = remoteCell ? remoteCell.cell : localCell;
  const remoteDie = useDie(remoteCell?.dieId).data;

  // ── Cell extraction (shared between canvas + right panel) ────────
  // Single-source the hook here so the canvas's diffusion-type overlay and
  // the right panel's lists render off the same memoised result. Re-runs
  // whenever `cellType` identity changes (every annotation edit).
  const extraction = useCellExtraction(cellType);

  // Resolve the schematic's active domain. Falls back to the first domain
  // when the stored id is stale (different cell, deleted shape) or unset.
  // The render auto-selects, so the user lands on something when they
  // switch to the Schematic tab for the first time.
  const activeDomain = useMemo(() => {
    if (!extraction.data || extraction.data.kind !== "inferred") return null;
    const list = extraction.data.domains;
    if (list.length === 0) return null;
    return list.find((d) => d.id === activeDomainId) ?? list[0];
  }, [extraction.data, activeDomainId]);


  // Hover-driven status string for the status bar — derived directly from
  // the (richer) canvas hover target since it still carries the sub-region
  // info that's strictly an image-canvas thing.
  const hoverStatus = useMemo(
    () => describeHoverTarget(canvasHover, extraction.data),
    [canvasHover, extraction.data],
  );
  // Effective hover entity — what every consumer (image canvas dim/halo,
  // right-panel rows, schematic narrow highlight) actually reads. The page
  // sets `hoveredEntity` directly from schematic + right-panel hovers; the
  // image canvas's `canvasHover` (cursor-on-shape) folds in via
  // `canvasHoverToEntity` as a fallback so the inverse mapping (image →
  // panel row) still works without making the canvas component aware of
  // the typed entity machinery.
  const effectiveHover: HoverEntity = useMemo(
    () => hoveredEntity ?? canvasHoverToEntity(canvasHover, extraction.data),
    [hoveredEntity, canvasHover, extraction.data],
  );
  // Concrete shape keys for the image canvas — resolution lives in the
  // entity helper so the dim+brighten pass keeps its existing Set<string>
  // API but no longer suffers cross-net leakage at the parent-diff fold.
  const imageHoverKeys = useMemo(
    () => entityToImageShapeKeys(effectiveHover, extraction.data),
    [effectiveHover, extraction.data],
  );

  // Auto-select the first available cell type when there's nothing yet.
  // Runs after URL hydration (above), so a deep link's `?type=` wins.
  useEffect(() => {
    if (!annotations || activeCellTypeId) return;
    const first =
      annotations.cellTypes.find((c) => c.matched === true) ??
      annotations.cellTypes[0] ??
      null;
    if (first) setActiveCellType(first.id, null);
  }, [annotations, activeCellTypeId, setActiveCellType]);

  // If the URL points at a stale cell type (deleted between sessions) the
  // initial hydration set a non-existent id; once annotations load, drop
  // back to the auto-select path so the page stays usable.
  useEffect(() => {
    // (A library type only resolves once its die's annotations are in.)
    if (!annotations || !activeCellTypeId || library.loading) return;
    if (!annotations.cellTypes.some((ct) => ct.id === activeCellTypeId)) {
      setActiveCellType(null, null);
    }
  }, [annotations, activeCellTypeId, setActiveCellType, library.loading]);

  // Switching the active tool to one whose layer doesn't accept the current
  // layer (e.g. rect → point: "polysilicon" isn't in TOOL_LAYERS.point)
  // re-defaults to the tool's first valid layer.
  useEffect(() => {
    if (activeTool === "select" || activeTool === "pan") return;
    const allowed = TOOL_LAYERS[activeTool];
    if (!allowed.includes(activeLayer)) setActiveLayer(allowed[0]);
  }, [activeTool, activeLayer, setActiveLayer]);

  // ── Polygon draft (page-level for global ⌘Z + Enter / Esc) ────────
  const poly = useLayerPolyTool({
    dispatcher,
    cellType,
    activeLayer,
    active: activeTool === "polygon"
  });

  // ── Cell orientation (right-click) ────────────────────────────────
  const orient = useCallback(
    (
      target: Cell,
      patch: Partial<Pick<Cell, "flippedH" | "flippedV" | "rotation">>,
      /** Set for an instance on another die: the edit goes there. */
      onDieId?: string
    ) => {
      const action = buildOrientAction(target, patch);
      void dispatcher.dispatch(onDieId ? { kind: "onDie", dieId: onDieId, action } : action);
    },
    [dispatcher]
  );

  const doUnmatch = useCallback(
    (target: Cell) => {
      if (!annotations) return;
      void dispatcher.dispatch(buildUnmatchAction(annotations, target));
    },
    [annotations, dispatcher]
  );

  // ── Cell-type rotation / flip (right-click on a type row) ─────────
  // Turns or mirrors every instance plus the type's layer shapes in one
  // undo step — on every die of the library that places it, each in its
  // own pixels, with the definition changed on the die that owns it.
  const rotateCellType = useCallback(
    (cellTypeId: string, deg: 90 | -90) => {
      if (!ownAnnotations) return;
      const action = buildLibraryTypeTransform(library, ownAnnotations, cellTypeId, {
        kind: "rotate",
        deg
      });
      if (action) void dispatcher.dispatch(action);
    },
    [ownAnnotations, library, dispatcher]
  );

  const flipCellType = useCallback(
    (cellTypeId: string, axis: "h" | "v") => {
      if (!ownAnnotations) return;
      const action = buildLibraryTypeTransform(library, ownAnnotations, cellTypeId, {
        kind: "flip",
        axis
      });
      if (action) void dispatcher.dispatch(action);
    },
    [ownAnnotations, library, dispatcher]
  );

  /** Drop an unmatched placeholder's unmatched status (right-click on its
   *  row): it moves up into the matched list. */
  const markCellTypeMatched = useCallback(
    (cellTypeId: string) => {
      const ct = annotations ? cellTypeById(annotations, cellTypeId) : null;
      const action = ct ? buildMarkMatchedAction(ct) : null;
      if (action) void dispatcher.dispatch(action);
    },
    [annotations, dispatcher]
  );

  const jumpToDie = useCallback(
    (target: Cell, remote?: RemoteInstance) => {
      // An instance on another die opens that die, framed there.
      const targetDie = remote?.dieId ?? dieId;
      const ct = annotations ? cellTypeById(annotations, target.cellTypeId) : null;
      if (ct) {
        const k = remote?.ratio ?? 1;
        const fp = cellFootprint(target, {
          cropRect: { x: 0, y: 0, width: ct.cropRect.width / k, height: ct.cropRect.height / k }
        });
        const rect = { ...fp, width: fp.width || 64, height: fp.height || 64 };
        const v = fitRectViewport(
          rect,
          Math.max(320, window.innerWidth - 568),
          Math.max(240, window.innerHeight - 140),
          80,
          4
        );
        usePreferences.getState().saveViewport(targetDie, v);
      }
      navigate(`/die/${targetDie}`);
    },
    [annotations, dieId, navigate]
  );

  // ── Clipboard (⌘C / ⌘V) ──────────────────────────────────────────
  // Shared by every tab of the app (see `state/cellRE`), so shapes copied in
  // one tab paste into any cell type of any die open in another.
  const doCopy = useCallback(() => {
    if (!cellType || selectedShapeIds.size === 0) return;
    const items = snapshotForClipboard(cellType, selectedShapeIds);
    if (items.length > 0) setClipboard({ dieId, cellTypeId: cellType.id, items });
  }, [dieId, cellType, selectedShapeIds, setClipboard]);

  const doPaste = useCallback(() => {
    if (!cellType || !clipboard) return;
    const items = clipboard.items;
    // Default to pasting all into the active layer if it's a sensible target
    // (i.e. the active layer matches the source layer of every item), else
    // each item lands back in its original layer. Either way new ids. Back
    // into the cell type they came from, the copies are offset so they're
    // obviously distinct from the originals below; anywhere else (another
    // type or die) they land in place, on the same spot of the cell.
    const offset =
      clipboard.dieId === dieId && clipboard.cellTypeId === cellType.id ? PASTE_OFFSET : 0;
    const uniformLayer =
      items.every((c) => c.layer === activeLayer) ? activeLayer : null;
    // Group by destination layer.
    const byLayer = new Map<LayerType, LayerShape[]>();
    for (const item of items) {
      const layer = uniformLayer ?? item.layer;
      const shape = translateShape(item.shape, offset, offset);
      let arr = byLayer.get(layer);
      if (!arr) {
        arr = [];
        byLayer.set(layer, arr);
      }
      arr.push(shape);
    }
    // Sequential inserts so each upsert sees the previous edit's CellType.
    let working = cellType;
    const newKeys = new Set<string>();
    const actions = [];
    for (const [layer, shapes] of byLayer) {
      const { action, insertedIds } = buildInsertShapesAction(working, layer, shapes);
      if (action.kind === "upsertCellType") working = action.cellType;
      actions.push(action);
      for (const id of insertedIds) newKeys.add(`${layer}:${id}`);
    }
    if (actions.length === 1) void dispatcher.dispatch(actions[0]);
    else void dispatcher.dispatch({ kind: "batch", actions });
    setSelectedShapeIds(newKeys);
  }, [dieId, cellType, clipboard, activeLayer, dispatcher, setSelectedShapeIds]);

  // ── Shape-menu action handlers ────────────────────────────────────
  //
  // The right-click menu can act on the multi-selection (Duplicate / Copy /
  // Delete) OR on a single specific shape (Set label / Force diffusion type).
  // We funnel everything through the existing dispatcher so undo/redo treats
  // a menu click identically to a keyboard shortcut.

  /** Duplicate every currently-selected shape in place (offset by
   *  PASTE_OFFSET, same layer, fresh ids) and switch the selection to the
   *  copies — same behaviour as Copy + Paste but skips the clipboard. */
  const doDuplicate = useCallback(() => {
    if (!cellType || selectedShapeIds.size === 0) return;
    const snap = snapshotForClipboard(cellType, selectedShapeIds);
    if (snap.length === 0) return;
    const byLayer = new Map<LayerType, LayerShape[]>();
    for (const item of snap) {
      const shape = translateShape(item.shape, PASTE_OFFSET, PASTE_OFFSET);
      const arr = byLayer.get(item.layer) ?? [];
      arr.push(shape);
      byLayer.set(item.layer, arr);
    }
    let working = cellType;
    const newKeys = new Set<string>();
    const actions = [];
    for (const [layer, shapes] of byLayer) {
      const { action, insertedIds } = buildInsertShapesAction(working, layer, shapes);
      if (action.kind === "upsertCellType") working = action.cellType;
      actions.push(action);
      for (const id of insertedIds) newKeys.add(shapeKey(layer, id));
    }
    if (actions.length === 1) void dispatcher.dispatch(actions[0]);
    else void dispatcher.dispatch({ kind: "batch", actions });
    setSelectedShapeIds(newKeys);
  }, [cellType, selectedShapeIds, dispatcher, setSelectedShapeIds]);

  /** Delete the current selection. Mirrors the Delete/Backspace path the
   *  canvas already handles, just driven from the menu. */
  const doDelete = useCallback(() => {
    if (!cellType || selectedShapeIds.size === 0) return;
    const removals: Array<{ layer: LayerType; id: string }> = [];
    for (const k of selectedShapeIds) {
      const p = parseShapeKey(k);
      if (p) removals.push(p);
    }
    const action = buildRemoveShapesAction(cellType, removals);
    if (action) void dispatcher.dispatch(action);
    setSelectedShapeIds(new Set());
  }, [cellType, selectedShapeIds, dispatcher, setSelectedShapeIds]);

  /** Set / clear `label` on every selected shape compatible with the menu's
   *  category. Only the METAL label group goes through here now — diffusion
   *  has its own dedicated `forcedType` field handled by `doSetForcedType`
   *  below. The right-clicked shape is always in the selection (the canvas
   *  auto-selects on right-click), so iterating `selectedShapeIds` always
   *  includes it. Returns silently when every applicable shape already
   *  carries the requested label. */
  const doSetLabel = useCallback(
    (target: ShapeMenuAnchor, label: ShapeLabel | null) => {
      if (!cellType) return;
      const allowedLayers = labelLayersFor(target.layer);
      const targets: Array<{ layer: LayerType; id: string }> = [];
      for (const key of selectedShapeIds) {
        const p = parseShapeKey(key);
        if (p && allowedLayers.has(p.layer)) targets.push(p);
      }
      // Fallback: if for some reason the right-clicked shape isn't in the
      // selection, label it solo. Keeps the menu predictable even if the
      // canvas's auto-select path is bypassed (e.g. via a future hotkey).
      if (targets.length === 0) {
        targets.push({ layer: target.layer, id: target.shape.id });
      }
      const action = buildSetShapeLabelsAction(cellType, targets, label);
      if (action) void dispatcher.dispatch(action);
    },
    [cellType, selectedShapeIds, dispatcher]
  );

  /** Set / clear `forcedType` on every selected diffusion. Mirrors the label
   *  handler but only ever touches diffusion shapes — the menu's
   *  forced-type group is gated to `layer === "diffusion"`. */
  const doSetForcedType = useCallback(
    (target: ShapeMenuAnchor, type: ForcedDiffusionType | null) => {
      if (!cellType) return;
      const targets: Array<{ layer: LayerType; id: string }> = [];
      for (const key of selectedShapeIds) {
        const p = parseShapeKey(key);
        if (p && p.layer === "diffusion") targets.push(p);
      }
      if (targets.length === 0) {
        targets.push({ layer: target.layer, id: target.shape.id });
      }
      const action = buildSetShapeForcedTypesAction(cellType, targets, type);
      if (action) void dispatcher.dispatch(action);
    },
    [cellType, selectedShapeIds, dispatcher]
  );

  /** Quarter-turn the whole selection about the centre of its bounds; the
   *  shapes keep their ids, so the selection stays put. */
  const doRotateSelection = useCallback(
    (deg: 90 | -90) => {
      if (!cellType) return;
      const action = buildRotateShapesAction(
        cellType,
        selectedShapes(cellType, selectedShapeIds),
        deg
      );
      if (action) void dispatcher.dispatch(action);
    },
    [cellType, selectedShapeIds, dispatcher]
  );

  /** Mirror the whole selection across its bounds' centre line. */
  const doFlipSelection = useCallback(
    (axis: "h" | "v") => {
      if (!cellType) return;
      const action = buildFlipShapesAction(
        cellType,
        selectedShapes(cellType, selectedShapeIds),
        axis
      );
      if (action) void dispatcher.dispatch(action);
    },
    [cellType, selectedShapeIds, dispatcher]
  );

  // ── Page-level keyboard shortcuts ─────────────────────────────────
  //   ⌘Z / ⌘⇧Z — undo / redo (respects polygon-draft override)
  //   V select · M pan · R rect · P polygon · X point
  //   ⌘C / ⌘V — copy / paste selected shapes (cross-cell-type supported)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void dispatcher.redo();
        else void dispatcher.undo();
        return;
      }
      if (meta && e.key.toLowerCase() === "c") {
        e.preventDefault();
        doCopy();
        return;
      }
      if (meta && e.key.toLowerCase() === "v") {
        e.preventDefault();
        doPaste();
        return;
      }
      if (meta || e.altKey) return;
      switch (e.key.toLowerCase()) {
        case "v":
          setActiveTool("select");
          break;
        case "m":
          setActiveTool("pan");
          break;
        case "r":
          setActiveTool("rect");
          break;
        case "p":
          setActiveTool("polygon");
          break;
        case "x":
          setActiveTool("point");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatcher, setActiveTool, doCopy, doPaste]);

  /** The instance a context menu was opened on: this die's, or (with
   *  `menu.dieId`) one on another die of the library. */
  const menuTarget = (m: ReContextMenuState): { cell: Cell; remote: RemoteInstance | null } | null => {
    if (m.dieId) {
      const r = activeCellTypeId
        ? remoteMembersOf(activeCellTypeId).find((x) => x.cell.id === m.cellId)
        : undefined;
      return r ? { cell: r.cell, remote: r } : null;
    }
    const c = annotations?.cells.find((x) => x.id === m.cellId);
    return c ? { cell: c, remote: null } : null;
  };

  // ── Status bar fragments ──────────────────────────────────────────
  const baseImageName = die?.originalFilename ?? die?.name ?? "base image";
  // The canvas draws the instance's own pixels from the die's tile pyramid
  // (position + orientation from the instance); the cell-type crop template
  // only stands in when the type has no member instances yet (rare, but the
  // page still needs imagery to draw on). …Unless the *type* row is what's
  // selected (no explicit instance) and a clean specimen exists and is
  // enabled: then show the per-pixel median of every instance, free of the
  // wires and debris that sit on any single one. Clicking a specific
  // instance always shows that instance's own pixels. The specimen is
  // already canonical, so the canvas skips the orientation.
  const cleanSpecimen =
    useCleanSpecimens && cellType && activeCellId == null
      ? (specimenIndex?.specimens.find(
          (s) =>
            s.cellTypeId === cellType.id &&
            s.width === Math.round(cellType.cropRect.width) &&
            s.height === Math.round(cellType.cropRect.height) &&
            // Built before the type was flipped / turned: it would show
            // mirrored or rotated under the annotations.
            sameFrame(s.memberSignature, membersOf(annotations!, cellType.id))
        ) ?? null)
      : null;
  // Another die's type not placed here yet: its image comes from that die.
  const foreignImageUrl = useForeignTypeImageUrl(
    library,
    !cell && cellType ? cellType.id : null,
    useCleanSpecimens
  );
  const imageUrl = cleanSpecimen
    ? specimenImageUrl(dieId, cellType!.id, cleanSpecimen.createdAt)
    : !cell && cellType
      ? (foreignImageUrl ?? cellTypeCropUrl(dieId, cellType.id))
      : null;
  const cellInstanceCount = cellType
    ? membersOf(annotations!, cellType.id).length
    : 0;

  return (
    <AppShell
      breadcrumb={die?.name ?? "RE cell"}
      meta={
        cellType
          ? `re · ${cellType.name}${
              cleanSpecimen
                ? ` · median of ${cleanSpecimen.instancesUsed}`
                : cell
                  ? ` · cell ${cell.id.slice(0, 6)}${remoteCell ? ` on ${remoteCell.dieName}` : ""}`
                  : ""
            }`
          : "re"
      }
      onUndo={() => void dispatcher.undo()}
      onRedo={() => void dispatcher.redo()}
      canUndo={dispatcher.canUndo}
      canRedo={dispatcher.canRedo}
    >
      <SubBar
        right={
          <button
            className="btn"
            disabled
            title="Base image (one per die for now)"
            style={{ maxWidth: 220 }}
          >
            {Ic.image}
            <span
              className="m"
              style={{
                fontSize: 10.5,
                marginLeft: 4,
                overflow: "hidden",
                textOverflow: "ellipsis"
              }}
            >
              {baseImageName}
            </span>
            {Ic.caret}
          </button>
        }
      >
        <CellREToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          activeLayer={activeLayer}
          setActiveLayer={setActiveLayer}
          polyDraftLen={poly.points.length}
        />
      </SubBar>

      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex"
        }}
      >
        {annotations ? (
          <CellRELeftPanel
            annotations={annotations}
            foreignTypes={library.foreign}
            remoteMembersOf={remoteMembersOf}
            onCellContextMenu={(c, x, y, onDieId) => {
              // Unmatching an instance on another die would make a type
              // there — do that on its own die.
              const canUnmatch =
                !onDieId && membersOf(annotations, c.cellTypeId).length > 1;
              setMenu({ x, y, cellId: c.id, canUnmatch, dieId: onDieId });
            }}
            onCellTypeContextMenu={(ct, x, y) => {
              setTypeMenu({
                x,
                y,
                cellTypeId: ct.id,
                // Everywhere it's placed: a type-wide turn moves them all.
                memberCount: ownAnnotations
                  ? libraryMemberCount(library, ownAnnotations, ct.id)
                  : 0,
                unmatched: ct.matched !== true
              });
            }}
          />
        ) : (
          <div style={{ width: 248, flex: "0 0 auto", background: "var(--card)" }} />
        )}

        <div className="col" style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>
          {/* Tab strip above the canvas. Three views on the same cell:
              the image (editing), the CMOS-level schematic (per-domain
              transistor view), and the logic-level abstraction (the
              cell as a tree of gate symbols). */}
          <div
            style={{
              height: 30,
              borderBottom: "1px solid var(--l2)",
              background: "var(--panel)",
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              gap: 0
            }}
          >
            <button
              type="button"
              className={"tab" + (canvasTab === "image" ? " on" : "")}
              onClick={() => setCanvasTab("image")}
              style={tabStyle(canvasTab === "image")}
            >
              cell image
            </button>
            <button
              type="button"
              className={"tab" + (canvasTab === "schematic" ? " on" : "")}
              onClick={() => setCanvasTab("schematic")}
              style={tabStyle(canvasTab === "schematic")}
              title="CMOS-level schematic, per domain"
            >
              schematic (cmos)
            </button>
            <button
              type="button"
              className={"tab" + (canvasTab === "logicSchematic" ? " on" : "")}
              onClick={() => setCanvasTab("logicSchematic")}
              style={tabStyle(canvasTab === "logicSchematic")}
              title="Logic-level schematic — gates instead of transistors"
            >
              schematic (logic)
            </button>
            <div style={{ flex: 1 }} />
            {cellType && (
              <span
                className="m"
                style={{ fontSize: 10.5, color: "var(--ink3)" }}
              >
                {cellType.name} ·{" "}
                {Math.round(cellType.cropRect.width)}×{Math.round(cellType.cropRect.height)} px ·{" "}
                {cellInstanceCount} instance{cellInstanceCount === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {cellType ? (
            canvasTab === "schematic" ? (
              <SchematicCanvas
                domain={activeDomain}
                transistors={
                  extraction.data?.kind === "inferred"
                    ? extraction.data.transistors
                    : []
                }
                nets={
                  extraction.data?.kind === "inferred" ? extraction.data.nets : []
                }
                extraction={
                  extraction.data?.kind === "inferred" ? extraction.data : null
                }
                hover={effectiveHover}
                onHoverEntity={setHoveredEntity}
              />
            ) : canvasTab === "logicSchematic" ? (
              <LogicSchematicCanvas
                extraction={extraction.data}
                hover={effectiveHover}
                onHoverEntity={setHoveredEntity}
              />
            ) : (
              <CellRECanvas
                ref={canvasRef}
                cellType={cellType}
                cell={cell}
                // An instance on another die: its die's tiles, at the ratio.
                die={(remoteCell ? remoteDie : die) ?? null}
                cellScale={remoteCell?.ratio ?? 1}
                imageUrl={imageUrl}
                imageCanonical={cleanSpecimen !== null}
                // The die overlay (wires / vias drawn on the die) belongs to
                // one physical instance; over the type's median image it
                // would point at pixels that aren't there.
                annotations={
                  cleanSpecimen
                    ? undefined
                    : remoteCell
                      ? library.annotations.get(remoteCell.dieId)
                      : annotations
                }
                extraction={extraction.data}
                activeTool={activeTool}
                activeLayer={activeLayer}
                layerHidden={layerHidden}
                selectedShapeIds={selectedShapeIds}
                hoveredShapeIds={imageHoverKeys}
                // Dim only when the hover came from outside the canvas
                // (right panel or schematic). The image-canvas cursor's
                // own hover still draws the halo on the targeted shape,
                // but doesn't fade the rest of the image — mousing
                // across the canvas would otherwise feel like the image
                // is constantly flickering.
                dimNonHovered={hoveredEntity != null}
                onSelect={setSelectedShapeIds}
                dispatch={(action) => void dispatcher.dispatch(action)}
                polyDraft={poly.points}
                onPolyAddVertex={poly.addPoint}
                onPolyCommit={poly.commit}
                onPolyCancel={poly.cancel}
                onEscape={() => setActiveTool("select")}
                onShapeContextMenu={(target, x, y) => {
                  if (!target) {
                    setShapeMenu(null);
                    return;
                  }
                  setShapeMenu({ x, y, anchor: { layer: target.layer, shape: target.shape } });
                }}
                onSelectionContextMenu={(x, y) => setShapeMenu({ x, y, anchor: null })}
                onCanvasHover={setCanvasHover}
              />
            )
          ) : (
            <div
              className="m"
              style={{
                flex: "1 1 auto",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                background: "var(--canvas-bg)",
                color: "var(--ink3)",
                fontSize: 12
              }}
            >
              {annotations
                ? "select a cell type on the left to begin"
                : "loading annotations…"}
            </div>
          )}
        </div>

        <CellRERightPanel
          cellType={cellType}
          extraction={extraction.data}
          loading={extraction.loading}
          error={extraction.error}
          hoverEntity={effectiveHover}
          selectedShapeIds={selectedShapeIds}
          activeDomainId={activeDomain?.id ?? null}
          canvasTab={canvasTab}
          onHoverEntity={setHoveredEntity}
          onSelect={setSelectedShapeIds}
          onRename={(newName) => {
            if (!cellType) return;
            const action = buildRenameCellTypeAction(cellType, newName);
            if (action) void dispatcher.dispatch(action);
          }}
          onRenameNet={(netId, newName) => {
            if (!cellType || extraction.data?.kind !== "inferred") return;
            const candidates = netShapeCandidates(extraction.data, netId);
            if (candidates.length === 0) return;
            const trimmed = newName.trim();
            // Clearing → wipe customName from every candidate (so a
            // stale name on a now-merged net doesn't resurrect).
            // Setting → only write to the topmost-preferred candidate;
            // extractor's first-wins propagation handles the rest.
            if (trimmed.length === 0) {
              for (const c of candidates) {
                const action = buildSetShapeCustomNameAction(
                  cellType, c.layer, c.id, null,
                );
                if (action) void dispatcher.dispatch(action);
              }
              return;
            }
            const action = buildSetShapeCustomNameAction(
              cellType, candidates[0].layer, candidates[0].id, trimmed,
            );
            if (action) void dispatcher.dispatch(action);
          }}
          onSetNetLabel={(netId, label) => {
            if (!cellType || extraction.data?.kind !== "inferred") return;
            // Same candidate-pick logic as rename, but excluding
            // diffusion — labels there mean "force P/N" via the
            // forcedType field, not a net role. The label cascade in
            // buildNets explicitly skips diffusion shapes, so writing
            // a label to a diffusion sub-region would be a no-op
            // anyway.
            const candidates = netShapeCandidates(extraction.data, netId).filter(
              (c) => c.layer !== "diffusion",
            );
            if (candidates.length === 0) return;
            // Clearing → wipe label from every non-diffusion candidate
            // (same dedup story as rename). Setting → write only to
            // the topmost; propagation handles the rest, and a single
            // labelled shape is enough to tag the net.
            if (label === null) {
              const action = buildSetShapeLabelsAction(cellType, candidates, null);
              if (action) void dispatcher.dispatch(action);
              return;
            }
            const action = buildSetShapeLabelsAction(
              cellType, [candidates[0]], label,
            );
            if (action) void dispatcher.dispatch(action);
          }}
          onSetDiffusionForcedType={(diffusionShapeId, type) => {
            if (!cellType) return;
            // Diffusion forced-type acts directly on the diff shape
            // itself (no representative-shape picking — the diff row
            // IS one user-drawn shape). Reuses the existing single-
            // shape forced-type action builder.
            const action = buildSetShapeForcedTypesAction(
              cellType,
              [{ layer: "diffusion", id: diffusionShapeId }],
              type,
            );
            if (action) void dispatcher.dispatch(action);
          }}
          onDomainOpen={(domainId) => {
            setActiveDomainId(domainId);
            setCanvasTab("schematic");
          }}
        />
      </main>

      <StatusBar
        items={[
          die?.name ?? dieId,
          cellType ? `cell ${cellType.name}` : "no cell type",
          `tool: ${activeTool}`,
          hoverStatus ??
            (selectedShapeIds.size > 0
              ? `${selectedShapeIds.size} selected`
              : "—")
        ]}
      />

      {menu && annotations && (
        <CellREContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onFlipH={() => {
            const t = menuTarget(menu);
            if (t) orient(t.cell, { flippedH: !(t.cell.flippedH === true) }, t.remote?.dieId);
          }}
          onFlipV={() => {
            const t = menuTarget(menu);
            if (t) orient(t.cell, { flippedV: !(t.cell.flippedV === true) }, t.remote?.dieId);
          }}
          onRotate={() => {
            const t = menuTarget(menu);
            if (t) orient(t.cell, { rotation: rotateView(orientOf(t.cell), 90).rotation }, t.remote?.dieId);
          }}
          onUnmatch={() => {
            const t = menuTarget(menu);
            if (t && !t.remote) doUnmatch(t.cell);
          }}
          onJumpToDie={() => {
            const t = menuTarget(menu);
            if (t) jumpToDie(t.cell, t.remote ?? undefined);
          }}
        />
      )}

      {typeMenu && (
        <CellTypeContextMenu
          menu={typeMenu}
          onClose={() => setTypeMenu(null)}
          onRotate={(deg) => rotateCellType(typeMenu.cellTypeId, deg)}
          onFlip={(axis) => flipCellType(typeMenu.cellTypeId, axis)}
          onMarkMatched={() => markCellTypeMatched(typeMenu.cellTypeId)}
        />
      )}

      {shapeMenu && cellType && (() => {
        // Compute the multi-select aggregates the menu needs: how many
        // shapes each action touches and the current label / forced-type
        // they all share (or "mixed"). Opened on the group box there's no
        // anchor shape, and no label / diffusion-type section to feed.
        const anchor = shapeMenu.anchor;
        const labels = anchor
          ? summarizeLabels(cellType, selectedShapeIds, anchor)
          : { count: 0, applied: null };
        const forced = anchor
          ? summarizeForcedTypes(cellType, selectedShapeIds, anchor)
          : { count: 0, applied: null };
        // Transform items grey out when they'd change nothing (a lone point,
        // a lone rect for a flip, a lone square for a turn).
        const items = selectedShapes(cellType, selectedShapeIds);
        return (
          <ShapeContextMenu
            menu={shapeMenu}
            selectionCount={selectedShapeIds.size}
            labelTargetCount={labels.count}
            appliedLabel={labels.applied}
            forcedTypeTargetCount={forced.count}
            appliedForcedType={forced.applied}
            hasClipboard={clipboard != null}
            canRotate={buildRotateShapesAction(cellType, items, 90) != null}
            canFlipH={buildFlipShapesAction(cellType, items, "h") != null}
            canFlipV={buildFlipShapesAction(cellType, items, "v") != null}
            onClose={() => setShapeMenu(null)}
            onSetLabel={(label) => {
              if (anchor) doSetLabel(anchor, label);
            }}
            onSetForcedType={(type) => {
              if (anchor) doSetForcedType(anchor, type);
            }}
            onDuplicate={doDuplicate}
            onCopy={doCopy}
            onPaste={doPaste}
            onRotate={doRotateSelection}
            onFlip={doFlipSelection}
            onDelete={doDelete}
          />
        );
      })()}
    </AppShell>
  );
}

function tabStyle(active: boolean): React.CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    height: 30,
    padding: "0 12px",
    background: active ? "var(--canvas-bg)" : "transparent",
    color: active ? "var(--ink)" : "var(--ink3)",
    border: 0,
    borderRight: "1px solid var(--l2)",
    borderLeft: active ? "1px solid var(--l2)" : 0,
    fontFamily: "var(--mono)",
    fontSize: 10.5,
    letterSpacing: 0.4,
    cursor: "pointer"
  };
}

/**
 * Format a hover-over-shape into a one-line status string. Falls back to
 * `null` (caller should render the default "N selected" line) when the
 * cursor isn't over a shape or extraction isn't loaded.
 *
 * For non-diffusion shapes: surfaces the net id + role + label.
 * For diffusion: surfaces the inferred P/N type plus — when we resolved a
 * specific sub-region under the cursor — that sub-region's net info, so
 * the user can see which S/D pad they're pointing at.
 */
function describeHoverTarget(
  hover: CanvasHoverTarget | null,
  extraction: CellExtraction | null,
): string | null {
  if (!hover) return null;
  const parts: string[] = [hover.layer];
  if (!extraction || extraction.kind !== "inferred") {
    return parts.join(" · ");
  }
  const ext = extraction;
  if (hover.layer === "diffusion") {
    const diff = ext.diffusions.find((d) => d.shapeId === hover.shape.id);
    if (diff && diff.type !== "unknown") {
      parts.push(`${diff.type.toUpperCase()}-type${diff.forced ? " (forced)" : ""}`);
    }
    if (hover.subRegionId) {
      const sub = ext.shapes.find((s) => s.id === hover.subRegionId);
      const net = sub ? ext.nets.find((n) => n.id === sub.netId) : null;
      if (net) parts.push(formatNet(net));
    }
    return parts.join(" · ");
  }
  // Non-diffusion: resolve to the net via the user-drawn shape id.
  const shape = ext.shapes.find(
    (s) => s.layer === hover.layer && s.id === hover.shape.id,
  );
  if (shape) {
    const net = ext.nets.find((n) => n.id === shape.netId);
    if (net) parts.push(formatNet(net));
  }
  return parts.join(" · ");
}

function formatNet(net: ExtractedNet): string {
  // Lead with the same display name the schematic + right panel show
  // (customName > label > netN) so the status bar's hover text and
  // the rest of the UI agree on what a given net is called.
  const display = netDisplayName(net);
  const tags: string[] = [display];
  // If the display name is the customName, still surface the role so
  // the user knows what classification the extractor inferred.
  if (display !== `net${net.id}` && net.role) tags.push(net.role);
  else if (display === `net${net.id}` && net.role) tags.push(net.role);
  return tags.join(" ");
}

/**
 * Which selected layers the shape-menu's metal label action applies to,
 * given the layer of the right-clicked anchor shape. metal1 + metal2 share
 * a category (so a mixed selection labels them together); everything else
 * is single-layer scope. Diffusion is intentionally excluded — its
 * force-type action goes through `doSetForcedType` on a separate field.
 */
function labelLayersFor(anchorLayer: LayerType): Set<LayerType> {
  if (anchorLayer === "metal1" || anchorLayer === "metal2") {
    return new Set<LayerType>(["metal1", "metal2"]);
  }
  return new Set<LayerType>([anchorLayer]);
}

/**
 * Inspect the selection (filtered to the menu's label category) and return
 * how many shapes the label action will touch + their shared label state.
 * Used by the page to drive ShapeContextMenu's "✓ on all that agree" UI.
 *
 * If the right-clicked shape isn't in the selection (defensive — the canvas
 * normally auto-selects it), we fall back to a single-shape view of its own
 * label so the menu still reflects what an action would do.
 */
function summarizeLabels(
  cellType: CellType,
  selectedShapeIds: Set<string>,
  menu: ShapeMenuAnchor
): { count: number; applied: AppliedLabel } {
  const allowed = labelLayersFor(menu.layer);
  const labels: Array<ShapeLabel | null> = [];
  for (const key of selectedShapeIds) {
    const p = parseShapeKey(key);
    if (!p || !allowed.has(p.layer)) continue;
    const shape = cellType.layers?.[p.layer]?.find((s) => s.id === p.id);
    if (!shape) continue;
    labels.push(shape.label ?? null);
  }
  if (labels.length === 0) {
    labels.push(menu.shape.label ?? null);
  }
  const first = labels[0];
  const allSame = labels.every((l) => l === first);
  return {
    count: labels.length,
    applied: allSame ? first : "mixed"
  };
}

/**
 * Same shape as `summarizeLabels`, but for the diffusion-only `forcedType`
 * field. Only diffusion shapes contribute. Returns `null` (the default)
 * when none are forced, the type when all targets agree, or `"mixed"`.
 */
function summarizeForcedTypes(
  cellType: CellType,
  selectedShapeIds: Set<string>,
  menu: ShapeMenuAnchor
): { count: number; applied: AppliedForcedType } {
  const types: Array<ForcedDiffusionType | null> = [];
  for (const key of selectedShapeIds) {
    const p = parseShapeKey(key);
    if (!p || p.layer !== "diffusion") continue;
    const shape = cellType.layers?.[p.layer]?.find((s) => s.id === p.id);
    if (!shape) continue;
    types.push(shape.forcedType ?? null);
  }
  if (types.length === 0) {
    types.push(menu.shape.forcedType ?? null);
  }
  const first = types[0];
  const allSame = types.every((t) => t === first);
  return {
    count: types.length,
    applied: allSame ? first : "mixed"
  };
}

/**
 * Resolve a net id to the list of user-drawn shapes that could
 * carry a label / customName for it, in preference order (metal2 →
 * metal1 → polysilicon → diffusion → contact → via1, then by shape
 * id for determinism).
 *
 * Sub-region ids (synthesised by the diffusion-split pass) aren't
 * stored in `cellType.layers`, so we fold them back to their parent
 * diffusion's id. Same logic for both `onRenameNet` and
 * `onSetNetLabel` — pulled out so the two stay in sync.
 */
function netShapeCandidates(
  extraction: Extract<CellExtraction, { kind: "inferred" }>,
  netId: number,
): Array<{ layer: LayerType; id: string }> {
  const net = extraction.nets.find((n) => n.id === netId);
  if (!net) return [];
  const shapeIndex = new Map(extraction.shapes.map((s) => [s.id, s]));
  const candidates: Array<{ layer: LayerType; id: string }> = [];
  const seen = new Set<string>();
  for (const sid of net.shapeIds) {
    const s = shapeIndex.get(sid);
    if (!s) continue;
    const layer: LayerType = s.parentDiffId ? "diffusion" : s.layer;
    const id = s.parentDiffId ?? s.id;
    const key = `${layer}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ layer, id });
  }
  const layerRank: Record<string, number> = {
    metal2: 0,
    metal1: 1,
    polysilicon: 2,
    diffusion: 3,
    contact: 4,
    via1: 5,
  };
  candidates.sort((a, b) => {
    const ra = layerRank[a.layer] ?? 99;
    const rb = layerRank[b.layer] ?? 99;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : 1;
  });
  return candidates;
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink3)",
        fontSize: 12
      }}
    >
      {children}
    </div>
  );
}
