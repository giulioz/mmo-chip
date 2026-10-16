import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import type { AnnotationNet, Cell, CellType } from "shared";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { netChangesToAction, useActionDispatcher } from "../api/actions";
import { useDie } from "../api/dies";
import { useCellLibrary } from "../api/cellLibrary";
import { routeLibraryAction, withLibraryTypes } from "../lib/cellLibrary";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar } from "../components/shell/SubBar";
import { Ic } from "../icons";
import {
  TiledCanvas,
  fitRectViewport,
  fitViewport,
  type DragHandler,
  type Interaction,
  type PointerEventData,
  type TiledCanvasHandle
} from "../renderer/TiledCanvas";
import { DieImageLayer } from "../renderer/layers/DieImageLayer";
import { AnnotationLayer } from "../renderer/layers/AnnotationLayer";
import {
  MLViasLayer,
  isMlViaId,
  parseMlViaId
} from "../renderer/layers/MLViasLayer";
import {
  buildCellAnnotation,
  buildNetAnnotation,
  populateAnnotationLayer
} from "../renderer/annotations/dieAnnotations";
import { OutlineTree } from "../components/dieViewer/OutlineTree";
import {
  CenteredStatus,
  CursorReadout,
  MarqueeOverlay,
  ZoomChip,
  ZoomReadout,
  annotationsSummary,
  panelStyle
} from "../components/dieViewer/DieViewerUI";
import { DieToolbar, IssuesChip } from "../components/dieViewer/DieToolbar";
import {
  DieContextMenu,
  type DieContextMenuState
} from "../components/dieViewer/DieContextMenu";
import { InspectorPanel } from "../components/dieViewer/InspectorPanel";
import { useMLJob, useMLStatus } from "../api/ml";
import { useCellDetections } from "../api/cellDetection";
import { useWireMapInfo, wireTileUrl } from "../api/cellImaging";
import { proposalsFor, type Proposal } from "../lib/cellDetection";
import { populateCellDetectionLayer } from "../renderer/annotations/cellDetections";
import { WireDraftOverlay } from "../components/dieViewer/WireDraftOverlay";
import { RectDraftOverlay } from "../components/dieViewer/RectDraftOverlay";
import { PolyDraftOverlay } from "../components/dieViewer/PolyDraftOverlay";
import { SelectionHandlesOverlay } from "../components/dieViewer/SelectionHandlesOverlay";
import { usePersistedViewport } from "../components/dieViewer/usePersistedViewport";
import { useCanvasSelection } from "../components/dieViewer/useCanvasSelection";
import {
  HIT_TOLERANCE_PX,
  useWireTool,
  type WireSnap
} from "../components/dieViewer/useWireTool";
import { useCellTool } from "../components/dieViewer/useCellTool";
import { useLibraryCellTool } from "../components/dieViewer/useLibraryCellTool";
import { LibraryCellOverlay } from "../components/dieViewer/LibraryCellOverlay";
import {
  buildOrientAction,
  orientOf,
  orientOnDie,
  type DieOrientOp
} from "../lib/mergeCells";
import { useViaPolyTool } from "../components/dieViewer/useViaPolyTool";
import {
  multiParallelEnd,
  multiWireEndpoint,
  useMultiWireTool
} from "../components/dieViewer/useMultiWireTool";
import { MultiWireOverlay } from "../components/dieViewer/MultiWireOverlay";
import { useGuideTool } from "../components/dieViewer/useGuideTool";
import {
  GuidesOverlay,
  type GuideDragPreview
} from "../components/dieViewer/GuidesOverlay";
import {
  guideHitTest,
  guidesInRect,
  pointInGuidesRegion,
  snapRectToGuides,
  translateGuide
} from "../lib/guides";
import {
  resolveEditable,
  shapeDragHandler,
  type EditPreview
} from "../components/dieViewer/shapeEdit";
import { useSelectionDelete } from "../components/dieViewer/useSelectionDelete";
import { useUndoRedoHotkeys } from "../components/dieViewer/useUndoRedoHotkeys";
import type { AnnotationAction } from "../api/actions";
import { parseNetPartId, type DrawAnchor } from "../lib/netGraph";
import {
  normalizeRect,
  pointInRect,
  rectCornerAt,
  rectCorners,
  rectFromPoints,
  snapTo45,
  squareFromPoints,
  type Point,
  type Rect
} from "../lib/geometry";
import { viaSnapTolerance } from "../renderer/annotations/style";
import type { Layer, Viewport } from "../renderer/types";
import { formatPercent } from "../lib/format";
import { isTypingTarget } from "../lib/keyboard";
import { createLiveValue } from "../lib/liveValue";
import type { WirePreview } from "../components/dieViewer/WireDraftOverlay";
import { ANNOTATION_KIND_VALUES } from "../state/annotationKinds";
import { DEFAULT_ML_CONFIG, useDieViewerStore } from "../state/dieViewer";
import { usePreferences } from "../state/preferences";
import { useSession } from "../state/session";

/** Stable empty points array so the overlay effect doesn't churn when idle. */
const NO_DRAFT_POINTS: Point[] = [];

export function DieViewerPage() {
  const { dieId } = useParams<{ dieId: string }>();

  if (!dieId) {
    return (
      <AppShell>
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
          <span>no die selected — </span>
          <Link to="/" style={{ color: "var(--accent)", marginLeft: 4 }}>
            choose one from the library
          </Link>
        </div>
      </AppShell>
    );
  }

  return <DieViewer key={dieId} dieId={dieId} />;
}

function DieViewer({ dieId }: { dieId: string }) {
  const { data: die, isLoading, error } = useDie(dieId);
  const { data: ownAnnotations } = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  // The cell library: other dies' types this die uses or is offered, merged
  // into the annotations at this die's scale (the page draws, hit-tests and
  // edits them like its own); edits to them are routed to their die.
  const library = useCellLibrary(dieId, ownAnnotations);
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const annotations = useMemo(
    () => (ownAnnotations ? withLibraryTypes(ownAnnotations, library) : undefined),
    [ownAnnotations, library]
  );
  const foreignTypeOwners = useMemo(
    () => new Map([...library.foreign].map(([id, f]) => [id, f.ownerName])),
    [library]
  );
  // Always-fresh annotations for the (stable) pointer router's shape editing.
  const annotationsRef = useRef(annotations);
  annotationsRef.current = annotations;
  const canvasHandle = useRef<TiledCanvasHandle>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const activeTool = useDieViewerStore((s) => s.activeTool);
  const setActiveTool = useDieViewerStore((s) => s.setActiveTool);
  const dispatcher = useActionDispatcher(dieId, {
    route: (action) => routeLibraryAction(action, libraryRef.current)
  });

  // Hot-path live values. These never trigger DieViewer re-renders — only the
  // tiny readout subcomponents subscribe via `useLiveValue`. The renderer
  // also reads them directly via the canvas handle.
  const viewportLive = useMemo(() => createLiveValue<Viewport | null>(null), []);
  const cursorLive = useMemo(
    () => createLiveValue<{ x: number; y: number } | null>(null),
    []
  );
  const marqueeLive = useMemo(() => createLiveValue<Rect | null>(null), []);
  const cellRectLive = useMemo(() => createLiveValue<Rect | null>(null), []);
  const shapeRectLive = useMemo(() => createLiveValue<Rect | null>(null), []);
  const wirePreviewLive = useMemo(
    () => createLiveValue<WirePreview | null>(null),
    []
  );
  const viaPolyPreviewLive = useMemo(
    () => createLiveValue<Point | null>(null),
    []
  );
  const editPreviewLive = useMemo(
    () => createLiveValue<EditPreview | null>(null),
    []
  );
  const guideDragLive = useMemo(
    () => createLiveValue<GuideDragPreview | null>(null),
    []
  );
  const multiWireSnapLive = useMemo(
    () => createLiveValue<Point | null>(null),
    []
  );
  // Phase-2 endpoint snaps: each sweeping wire that would lock onto a via at
  // this cursor — one entry from the snap-to-vias-near-cursor path, or many
  // from auto-end-on-via (one per wire whose projection crosses a via). The
  // overlay redraws each such wire ending on its via so the preview matches
  // the commit. Empty / null = no snaps right now.
  const multiWireEndSnapLive = useMemo(
    () =>
      createLiveValue<
        Array<{ lockIndex: number; x: number; y: number }> | null
      >(null),
    []
  );
  const wireSnapLive = useMemo(
    () => createLiveValue<WireSnap | null>(null),
    []
  );
  const shiftLive = useMemo(() => createLiveValue<boolean>(false), []);

  // Shift state captured from pointer-move, read by the click handler (which
  // has no event of its own).
  const shiftRef = useRef(false);

  // Right-click context menu. Null = closed. Position is viewport-relative
  // (clientX/clientY) so the menu renders fixed at the cursor regardless of
  // canvas pan/zoom.
  const [contextMenu, setContextMenu] = useState<DieContextMenuState | null>(
    null
  );

  // Hold-Space momentary pan. The ref is read by the (stable) pointer-down
  // router without re-binding; the state only drives the cursor.
  const [spacePan, setSpacePan] = useState(false);
  const spacePanRef = useRef(false);
  useEffect(() => {
    const setPan = (on: boolean) => {
      spacePanRef.current = on;
      setSpacePan(on);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat || isTypingTarget(e.target)) return;
      e.preventDefault();
      setPan(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== "Space") return;
      setPan(false);
    };
    const onBlur = () => setPan(false);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const getNetW = useCallback(() => usePreferences.getState().netWidth, []);
  const getNetC = useCallback(() => usePreferences.getState().netColor, []);
  const getCellC = useCallback(() => usePreferences.getState().cellColor, []);
  const getCellShapes = useCallback(
    () => usePreferences.getState().cellShowShapes,
    []
  );

  const resetDieViewer = useDieViewerStore((s) => s.reset);
  // Reset transient selection/expand state whenever the active die changes.
  useEffect(() => {
    resetDieViewer();
  }, [dieId, resetDieViewer]);

  // Remember the active die so the phase tabs can return to it after the user
  // visits Library or another phase.
  useEffect(() => {
    useSession.getState().setDieId(dieId);
  }, [dieId]);

  const layers = useMemo<Layer[]>(() => {
    if (!die) return [];
    // Display controls read live from prefs (keyed by the base-image id =
    // die id today) so toggling visibility/opacity doesn't rebuild the layer.
    return [
      new DieImageLayer(die, {
        getHidden: () =>
          usePreferences.getState().baseImageHidden[die.id] === true,
        getOpacity: () =>
          usePreferences.getState().baseImageOpacity[die.id] ?? 1
      })
    ];
  }, [die]);

  // Wire-likelihood overlay (pixels under recognised cells that aren't part
  // of the cell — mostly wires routed over them). Same tile geometry as the
  // die image, so it reuses the image layer with its own RGBA tile source.
  // Rebuilt when the map is regenerated (the version busts tile caches).
  const wireMapInfo = useWireMapInfo(die?.id ?? null).data ?? null;
  const wireMapVersion = wireMapInfo?.createdAt ?? null;
  const wireMapMinLevel = wireMapInfo?.minZoomLevel ?? 0;
  const wireMapLayer = useMemo(
    () =>
      die && wireMapVersion
        ? new DieImageLayer(
            die,
            {
              getHidden: () => usePreferences.getState().wireMapHidden,
              getOpacity: () => usePreferences.getState().wireMapOpacity
            },
            {
              id: "wire-map",
              tileUrl: (z, x, y) => wireTileUrl(die.id, wireMapVersion, z, x, y),
              pyramid: false,
              minLevel: wireMapMinLevel
            }
          )
        : null,
    [die, wireMapVersion, wireMapMinLevel]
  );
  useEffect(() => {
    useDieViewerStore.getState().setWireMapAvailable(wireMapLayer !== null);
    return () => useDieViewerStore.getState().setWireMapAvailable(false);
  }, [wireMapLayer]);

  // ML via predictions, fetched per backend tile (server-side cached). Lives
  // above the die image but below the annotation layer so user-drawn
  // geometry still wins for picks / selection. Recreated per die so each
  // layer instance owns its own tile cache.
  const mlViasLayer = useMemo(
    () =>
      die
        ? new MLViasLayer(die.id, die, {
            getHidden: () => usePreferences.getState().mlResultsHidden,
            // Same render radius as manual vias — the user-facing pref
            // governs both render + snap so the visible dot matches the
            // click target.
            getViaWorldRadius: () => usePreferences.getState().viaSize,
            // Confidence slider filters the cached predictions client-side.
            getConfidenceThreshold: () =>
              usePreferences.getState().viaConfidenceThreshold,
            onCountChange: (n) => useDieViewerStore.getState().setMlViasCount(n)
          })
        : null,
    [die]
  );
  useEffect(() => {
    // Cleanup on die change: drop the cache + zero the count out so the
    // outline doesn't show stale numbers from the previous die.
    return () => {
      mlViasLayer?.destroy();
      useDieViewerStore.getState().setMlViasCount(0);
    };
  }, [mlViasLayer]);

  // Confidence-threshold pref change → re-filter the cached ML vias (recount
  // for the items list + redraw the overlay). No re-fetch: tile data already
  // carries every detection's score.
  useEffect(() => {
    if (!mlViasLayer) return;
    return usePreferences.subscribe(
      (s) => s.viaConfidenceThreshold,
      () => mlViasLayer.recountAndRedraw()
    );
  }, [mlViasLayer]);

  // Live inference-job state (also updated by WS broadcasts from other users).
  const mlJob = useMLJob(die?.id ?? null);
  const mlJobCompleted = mlJob.data?.completedTiles ?? 0;
  useEffect(() => {
    // As a sweep advances, retry any tiles that errored earlier (e.g. the
    // sidecar was briefly down) so the overlay catches up.
    if (mlJobCompleted > 0) mlViasLayer?.retryFailed();
  }, [mlJobCompleted, mlViasLayer]);

  // The sidecar's checkpoint changing (model switch / retrain) invalidates
  // every cached prediction — drop the layer's tile cache so it re-fetches.
  const mlCheckpointHash = useMLStatus().data?.checkpointHash ?? null;
  useEffect(() => {
    mlViasLayer?.clearCache();
  }, [mlCheckpointHash, mlViasLayer]);

  const annotationLayer = useMemo(
    () => (die ? new AnnotationLayer("die-annotations") : null),
    [die]
  );

  // ML cell proposals (cell-detection results). Their own rbush layer so
  // picks / marquee / visibility behave like real annotations without mixing
  // into the persisted-annotation layer. Rebuilt whenever the results, the
  // placed cells (approvals hide the proposal underneath) or the confidence
  // threshold change.
  const proposalLayer = useMemo(
    () => (die ? new AnnotationLayer("cell-detections") : null),
    [die]
  );
  const cellDetectionsQ = useCellDetections(die?.id ?? null);
  const cellDetectionThreshold = usePreferences((s) => s.cellDetectionThreshold);
  const proposals = useMemo<Proposal[]>(
    () =>
      annotations && cellDetectionsQ.data
        ? proposalsFor(cellDetectionsQ.data, annotations, {
            threshold: cellDetectionThreshold
          })
        : [],
    [annotations, cellDetectionsQ.data, cellDetectionThreshold]
  );
  useEffect(() => {
    if (!proposalLayer) return;
    populateCellDetectionLayer(proposalLayer, proposals);
    useDieViewerStore.getState().setCellDetectionsCount(proposals.length);
  }, [proposalLayer, proposals]);
  const cellDetectionsHidden = usePreferences((s) => s.cellDetectionsHidden);
  useEffect(() => {
    proposalLayer?.setVisibleKinds(cellDetectionsHidden ? new Set() : null);
  }, [proposalLayer, cellDetectionsHidden]);

  useEffect(() => {
    if (!annotationLayer || !annotations) return;
    populateAnnotationLayer(annotationLayer, annotations, {
      // ML tab active → render traces/vias at the ML export footprint
      // (source-px sizes) instead of the display preferences.
      netWidth: () =>
        usePreferences.getState().inspectorTab === "ml"
          ? useDieViewerStore.getState().mlConfig.traceWidth
          : usePreferences.getState().netWidth,
      netColor: () => usePreferences.getState().netColor,
      cellColor: () => usePreferences.getState().cellColor,
      cellShowShapes: () => usePreferences.getState().cellShowShapes,
      pointViaWorldRadius: () => {
        // ML tab forces the export footprint (mockup ml-config). Otherwise
        // use the global `viaSize` pref so manual vias render the same
        // physical size as ML vias and as the snap target. `buildAnnotation`
        // applies the screen-px clamp internally.
        if (usePreferences.getState().inspectorTab === "ml")
          return useDieViewerStore.getState().mlConfig.pointViaSize;
        return usePreferences.getState().viaSize;
      },
      netNodeMatchesWidth: () =>
        usePreferences.getState().inspectorTab === "ml"
    });
  }, [annotationLayer, annotations]);

  // Net width/color + cell color/detail + via size pref changes → invalidate
  // the canvas. The layers read these prefs live each draw, so an invalidate
  // is all that's needed.
  useEffect(() => {
    const unsubs = (
      ["netWidth", "netColor", "cellColor", "cellShowShapes", "viaSize"] as const
    ).map((key) =>
      usePreferences.subscribe(
        (s) => s[key],
        () => canvasHandle.current?.invalidate()
      )
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  // Base-image visibility / opacity + ML-results visibility pref changes →
  // repaint the canvas. Layer `draw` methods read the pref live so we only
  // need the redraw to kick.
  useEffect(() => {
    const unsubs = (
      [
        "baseImageHidden",
        "baseImageOpacity",
        "mlResultsHidden",
        "wireMapHidden",
        "wireMapOpacity"
      ] as const
    ).map((key) =>
      usePreferences.subscribe(
        (s) => s[key],
        () => canvasHandle.current?.invalidate()
      )
    );
    return () => unsubs.forEach((u) => u());
  }, []);

  // Seed the (mockup, client-side) ML config from the die's annotations once
  // per die — `resetDieViewer` already restored defaults on the die change.
  const mlSeededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!annotations || mlSeededRef.current === dieId) return;
    mlSeededRef.current = dieId;
    useDieViewerStore
      .getState()
      .setMlConfig(annotations.mlConfig ?? DEFAULT_ML_CONFIG);
  }, [dieId, annotations]);

  // ML tab / ML-config changes → repaint so traces/vias resize live.
  // The tab now lives in (persisted) preferences; mlConfig stays transient.
  useEffect(() => {
    const invalidate = () => canvasHandle.current?.invalidate();
    const unsubTab = usePreferences.subscribe(
      (s) => s.inspectorTab,
      invalidate
    );
    let prevMl = useDieViewerStore.getState().mlConfig;
    const unsubMl = useDieViewerStore.subscribe((s) => {
      if (s.mlConfig !== prevMl) {
        prevMl = s.mlConfig;
        invalidate();
      }
    });
    return () => {
      unsubTab();
      unsubMl();
    };
  }, []);

  const hiddenKinds = usePreferences((s) => s.hiddenKinds);
  useEffect(() => {
    if (!annotationLayer) return;
    const visible = ANNOTATION_KIND_VALUES.filter((k) => !hiddenKinds.includes(k));
    annotationLayer.setVisibleKinds(new Set(visible));
  }, [annotationLayer, hiddenKinds]);

  // Push selection changes into the annotation layer so its draw highlights.
  // ML vias get the same set — the layer filters out non-`ml-via:` ids itself.
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  useEffect(() => {
    annotationLayer?.setSelectedIds(selectedIds);
    mlViasLayer?.setSelectedIds(selectedIds);
    proposalLayer?.setSelectedIds(selectedIds);
  }, [annotationLayer, mlViasLayer, proposalLayer, selectedIds]);

  const allLayers = useMemo<Layer[]>(() => {
    // Paint order: die image → ML via overlay → user annotations. The user's
    // own annotations sit on top so picks / selection always prefer them.
    const out: Layer[] = [...layers];
    if (wireMapLayer) out.push(wireMapLayer);
    if (mlViasLayer) out.push(mlViasLayer);
    if (proposalLayer) out.push(proposalLayer);
    if (annotationLayer) out.push(annotationLayer);
    return out;
  }, [layers, wireMapLayer, mlViasLayer, proposalLayer, annotationLayer]);

  // ── Behaviors (extracted hooks) ─────────────────────────────────

  const { initialViewport, onViewportChange } = usePersistedViewport({
    dieId,
    die,
    viewportLive,
    containerRef
  });

  const { selectFromHit, clearSelectionFromEmpty, selectFromMarquee } =
    useCanvasSelection();

  // Snap-to-vias plumbing (wire + multi-wire). Combines the user's manually-
  // placed vias (`annotations.annotations` of class point/irregular via, with
  // irregular vias snapping to their centroid) with the live ML predictions
  // held by `mlViasLayer`. The latter's `findNearestPointVia` is itself
  // centroid-aware. Reads `annotations` fresh from the existing
  // `annotationsRef` mirror so the snap closure stays referentially stable.
  const findNearestVia = useCallback(
    (world: Point, tolWorld: number): Point | null => {
      let best: Point | null = null;
      let bestD = tolWorld;
      const anns = annotationsRef.current?.annotations;
      if (anns) {
        for (const a of anns) {
          const g = a.geometry;
          let cx: number, cy: number;
          if (a.class === "point_via" && g.kind === "point") {
            cx = g.x;
            cy = g.y;
          } else if (a.class === "irregular_via" && g.kind === "rectangle") {
            cx = g.x + g.width / 2;
            cy = g.y + g.height / 2;
          } else if (
            a.class === "irregular_via" &&
            g.kind === "polygon" &&
            g.points.length > 0
          ) {
            let sx = 0;
            let sy = 0;
            for (const p of g.points) {
              sx += p.x;
              sy += p.y;
            }
            cx = sx / g.points.length;
            cy = sy / g.points.length;
          } else {
            continue;
          }
          const d = Math.hypot(cx - world.x, cy - world.y);
          if (d <= bestD) {
            bestD = d;
            best = { x: cx, y: cy };
          }
        }
      }
      // ML vias from the layer's tile cache (covers everything currently
      // visible plus anything ever loaded earlier — see the layer's
      // cross-level draw pass).
      const ml = mlViasLayer?.findNearestPointVia(world, bestD);
      if (ml) {
        const d = Math.hypot(ml.x - world.x, ml.y - world.y);
        if (d <= bestD) {
          bestD = d;
          best = ml;
        }
      }
      return best;
    },
    [mlViasLayer]
  );
  const snapToViasEnabled = useCallback(
    () => usePreferences.getState().snapToVias,
    []
  );
  const getViaSizeWorld = useCallback(
    () => usePreferences.getState().viaSize,
    []
  );

  /** First via lying on the open segment `a`–`b` within `perpTol` of the line,
   *  preferring the one closest to `a`. Mirrors `findNearestVia`'s source set
   *  (manual annotations of point / irregular via, plus cached ML vias) so the
   *  auto-end-on-via path sees exactly what's on screen. Used by the wire and
   *  multi-wire tools when the "auto-end on via" pref is enabled. */
  const findViaOnSegment = useCallback(
    (a: Point, b: Point, perpTol: number): Point | null => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lenSq = dx * dx + dy * dy;
      if (lenSq === 0) return null;
      const perpSq = perpTol * perpTol;
      let best: Point | null = null;
      let bestT = Infinity;
      const consider = (cx: number, cy: number) => {
        const t = ((cx - a.x) * dx + (cy - a.y) * dy) / lenSq;
        if (t <= 0 || t >= 1) return;
        const fx = a.x + t * dx;
        const fy = a.y + t * dy;
        const px = cx - fx;
        const py = cy - fy;
        if (px * px + py * py > perpSq) return;
        if (t < bestT) {
          bestT = t;
          best = { x: cx, y: cy };
        }
      };
      const anns = annotationsRef.current?.annotations;
      if (anns) {
        for (const ann of anns) {
          const g = ann.geometry;
          if (ann.class === "point_via" && g.kind === "point") {
            consider(g.x, g.y);
          } else if (
            ann.class === "irregular_via" &&
            g.kind === "rectangle"
          ) {
            consider(g.x + g.width / 2, g.y + g.height / 2);
          } else if (
            ann.class === "irregular_via" &&
            g.kind === "polygon" &&
            g.points.length > 0
          ) {
            let sx = 0;
            let sy = 0;
            for (const p of g.points) {
              sx += p.x;
              sy += p.y;
            }
            consider(sx / g.points.length, sy / g.points.length);
          }
        }
      }
      const ml = mlViasLayer?.findPointViaOnSegment(a, b, perpTol);
      if (ml) consider(ml.x, ml.y);
      return best;
    },
    [mlViasLayer]
  );
  const autoEndOnViaEnabled = useCallback(
    () => usePreferences.getState().wireAutoEndOnVia,
    []
  );

  const wire = useWireTool({
    dispatcher,
    annotationLayer,
    annotations,
    viewportLive,
    wirePreviewLive,
    activeTool,
    setActiveTool,
    findNearestVia,
    findViaOnSegment,
    snapToViasEnabled,
    autoEndOnViaEnabled,
    getViaSizeWorld
  });

  const cell = useCellTool({
    dispatcher,
    annotations,
    cellRectLive,
    activeTool,
    setActiveTool
  });

  const libraryCell = useLibraryCellTool({
    dieId,
    library,
    dispatcher,
    viewportLive,
    containerRef,
    activeTool
  });

  const viaPoly = useViaPolyTool({ dispatcher, activeTool, setActiveTool });
  const guide = useGuideTool({ dispatcher, activeTool, setActiveTool });
  const multiWire = useMultiWireTool({
    dispatcher,
    annotations,
    activeTool,
    setActiveTool
  });

  // Phase-aware multi-wire help (kept short so the toolbar stays compact).
  const multiWireHint = useMemo(() => {
    if (multiWire.phase === 1) {
      const n = multiWire.points.length;
      return n === 0
        ? "click bus start points, then Enter"
        : `${n} start${n > 1 ? "s" : ""} · Enter to continue · Esc to cancel`;
    }
    const left = multiWire.ends.reduce((a, e) => a + (e ? 0 : 1), 0);
    const placed = multiWire.points.length - left;
    const save = placed > 0 ? ` · Enter saves ${placed} placed` : "";
    if (multiWire.continued) {
      return `continuing from ${multiWire.points.length} ends · click each wire to end · ${left} left${save} · ${placed > 0 ? "Esc" : "Enter/Esc"} to finish`;
    }
    return `click each wire to end · ${left} left${save}`;
  }, [multiWire.phase, multiWire.points, multiWire.ends, multiWire.continued]);

  /**
   * Multi-wire phase-2 helper: find the via the cursor is pointing at and
   * decide which wire to land on it. The via search is at the **raw
   * cursor** — symmetric with the phase-1 start snap — so "point at a via
   * and the wire ends there" works no matter where the via sits relative
   * to the bus's 45° axis. The locked wire then runs straight from its
   * start to that via (it leaves the parallel front; via routing wants
   * each wire on its own via).
   *
   * Which wire gets locked: the still-sweeping one whose current projected
   * endpoint is closest to the via — i.e. the wire already ending nearest
   * where you're pointing.
   *
   * Returns null when via-snap is off, Shift bypasses, or no via lies
   * within tolerance of the cursor. Shared by the click commit and the
   * live snap-halo so the halo previews exactly where the click lands.
   */
  const findMultiWireEndpointViaSnap = useCallback(
    (
      world: Point,
      shift: boolean
    ): { endpoint: Point; via: Point; lockIndex: number } | null => {
      const vp = viewportLive.get();
      if (
        !vp ||
        shift ||
        !usePreferences.getState().snapToVias ||
        multiWire.phase !== 2 ||
        multiWire.points.length === 0
      ) {
        return null;
      }
      const tol = viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize);
      const via = findNearestVia(world, tol);
      if (!via) return null;
      const V: Point = { x: Math.round(via.x), y: Math.round(via.y) };
      // Pick which wire to lock: the still-sweeping one whose projected
      // endpoint (under the current bus geometry) is closest to the via.
      const ref = multiWire.points[0];
      const projected = snapTo45(ref, world);
      let best = -1;
      let bestDist = Infinity;
      multiWire.points.forEach((p, i) => {
        if (multiWire.ends[i]) return; // already locked
        const wireEnd = multiWireEndpoint(p, ref, projected);
        const d = Math.hypot(wireEnd.x - V.x, wireEnd.y - V.y);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      if (best < 0) return null;
      return { endpoint: V, via: V, lockIndex: best };
    },
    [findNearestVia, multiWire, viewportLive]
  );

  /**
   * Auto-end-on-via path for the bus: when the pref is on, return one snap
   * per still-sweeping wire whose own projected segment (start → its endpoint
   * on the perpendicular front through the cursor) crosses a via. Each wire
   * lands on its own via — they don't have to share one. A single click then
   * locks them all in one batch via `multiWire.endWires`. Empty array when
   * the pref is off, Shift bypasses, no wires are unlocked, or no projections
   * cross a via.
   */
  const findMultiWireAutoEndSnaps = useCallback(
    (
      world: Point,
      shift: boolean
    ): Array<{ endpoint: Point; lockIndex: number }> => {
      const vp = viewportLive.get();
      if (
        !vp ||
        shift ||
        !usePreferences.getState().wireAutoEndOnVia ||
        multiWire.phase !== 2 ||
        multiWire.points.length === 0
      ) {
        return [];
      }
      const tol = viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize);
      const ref = multiWire.points[0];
      const projected = multiParallelEnd(ref, world, false);
      if (projected.x === ref.x && projected.y === ref.y) return [];
      const out: Array<{ endpoint: Point; lockIndex: number }> = [];
      multiWire.points.forEach((p, i) => {
        if (multiWire.ends[i]) return;
        const end = multiWireEndpoint(p, ref, projected);
        if (end.x === p.x && end.y === p.y) return;
        const via = findViaOnSegment(p, end, tol);
        if (via) {
          out.push({
            endpoint: { x: Math.round(via.x), y: Math.round(via.y) },
            lockIndex: i
          });
        }
      });
      return out;
    },
    [findViaOnSegment, multiWire, viewportLive]
  );

  /**
   * Walk `selectedIds` and pull out every entry that names a single point in
   * world space (a manual via centroid, an ML via, or a net vertex). Used by
   * the right-click "Start multi-wire from selection" entry and by the
   * "multi point count" the menu shows. Whole-net / cell / ROI selections are
   * skipped — they don't name one specific point. Net vertices come back with
   * a `DrawAnchor` so the new wire extends that existing net.
   */
  const extractAnchorPointsFromSelection = useCallback(
    (
      ids: ReadonlySet<string>
    ): Array<{ point: Point; anchor: DrawAnchor | null }> => {
      const out: Array<{ point: Point; anchor: DrawAnchor | null }> = [];
      const ann = annotationsRef.current;
      for (const id of ids) {
        // ML via — synthetic position id, no persistent record.
        if (isMlViaId(id)) {
          const p = parseMlViaId(id);
          if (p) out.push({ point: p, anchor: null });
          continue;
        }
        // Net vertex sub-selection — anchor onto its existing net so the new
        // wire merges into it rather than starting parallel.
        const np = parseNetPartId(id);
        if (np && np.part === "node" && np.partId) {
          const net = ann?.nets.find((n) => n.id === np.netId);
          const node = net?.nodes.find((nd) => nd.id === np.partId);
          if (net && node) {
            out.push({
              point: { x: node.x, y: node.y },
              anchor: { netId: net.id, nodeId: node.id }
            });
          }
          continue;
        }
        // Manual via annotation — point geometry, rectangle bbox, or polygon
        // centroid (matches `findNearestVia`'s source set).
        if (id.startsWith("anno:")) {
          const a = ann?.annotations?.find((x) => x.id === id.slice(5));
          if (!a) continue;
          const g = a.geometry;
          if (a.class === "point_via" && g.kind === "point") {
            out.push({ point: { x: g.x, y: g.y }, anchor: null });
          } else if (a.class === "irregular_via" && g.kind === "rectangle") {
            out.push({
              point: { x: g.x + g.width / 2, y: g.y + g.height / 2 },
              anchor: null
            });
          } else if (
            a.class === "irregular_via" &&
            g.kind === "polygon" &&
            g.points.length > 0
          ) {
            let sx = 0;
            let sy = 0;
            for (const p of g.points) {
              sx += p.x;
              sy += p.y;
            }
            out.push({
              point: {
                x: sx / g.points.length,
                y: sy / g.points.length
              },
              anchor: null
            });
          }
        }
      }
      return out;
    },
    []
  );

  /** Switch to the wire tool and open a draft anchored at `point`. The wire
   *  tool's own snap / preview takes over from there. `beginDraftAt` discards
   *  any in-flight partial draft, so this is safe regardless of prior state. */
  const startWireAt = useCallback(
    (point: Point, anchor: DrawAnchor | null) => {
      setActiveTool("wire");
      wire.beginDraftAt(point, anchor);
    },
    [setActiveTool, wire]
  );

  /** Switch to multi-wire and open the bus directly in phase 2 with each
   *  selected via / vertex as a start point. */
  const startMultiWireFrom = useCallback(
    (picks: Array<{ point: Point; anchor: DrawAnchor | null }>) => {
      if (picks.length < 2) return;
      setActiveTool("multiWire");
      multiWire.beginPhase2(picks);
    },
    [setActiveTool, multiWire]
  );

  // Commit a rubber-band rectangle from the via-rect / ROI / ignore tools
  // (rounded, normalized, min-size-guarded). One undoable upsert each.
  const commitDrawnRect = useCallback(
    (toolKind: "viaRect" | "roi" | "ignore", r: Rect) => {
      const x = Math.round(Math.min(r.x, r.x + r.width));
      const y = Math.round(Math.min(r.y, r.y + r.height));
      const width = Math.round(Math.abs(r.width));
      const height = Math.round(Math.abs(r.height));
      if (width < 1 || height < 1) return;
      const id = crypto.randomUUID();
      let action: AnnotationAction;
      if (toolKind === "viaRect") {
        action = {
          kind: "upsertAnnotation",
          annotation: {
            id,
            class: "irregular_via",
            geometry: { kind: "rectangle", x, y, width, height },
            source: "human"
          },
          prevAnnotation: null
        };
      } else if (toolKind === "roi") {
        action = {
          kind: "upsertRoi",
          roi: {
            id,
            x,
            y,
            width,
            height,
            classes: [...usePreferences.getState().roiClasses]
          },
          prevRoi: null
        };
      } else {
        action = {
          kind: "upsertIgnore",
          ignore: { id, x, y, width, height },
          prevIgnore: null
        };
      }
      void dispatcher.dispatch(action);
    },
    [dispatcher]
  );

  // Kind-agnostic Delete/Backspace handling for the current selection.
  useSelectionDelete({ dispatcher, annotations });
  // Global ⌘Z/⌘⇧Z — routes to a tool's undo override (e.g. wire draft) when
  // one is registered, else the action dispatcher.
  useUndoRedoHotkeys(dispatcher);

  // ── Pointer move / leave ────────────────────────────────────────

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const c = containerRef.current?.querySelector("canvas") as
        | HTMLCanvasElement
        | null;
      if (!c) return;
      const rect = c.getBoundingClientRect();
      const cssX = event.clientX - rect.left;
      const cssY = event.clientY - rect.top;
      const vp = canvasHandle.current?.getViewport();
      if (!vp) return;
      const world = {
        x: vp.originX + cssX / vp.zoom,
        y: vp.originY + cssY / vp.zoom
      };
      cursorLive.set(world);
      shiftRef.current = event.shiftKey;
      shiftLive.set(event.shiftKey);
      wire.computeWirePreview(world, event.shiftKey, vp.zoom);
      const tool = useDieViewerStore.getState().activeTool;
      viaPolyPreviewLive.set(tool === "viaPoly" ? world : null);
      // Multi-wire preview snap. Phase 1: the halo previews the vertex /
      // via a start would snap to. Phase 2: `multiWireEndSnapLive` carries
      // which wire would lock onto a via and where — the overlay redraws
      // that wire ending on the via so the user sees the snap and knows
      // where to click. (Phase-2 has no entry in `multiWireSnapLive`.)
      let snap: { x: number; y: number } | null = null;
      let endSnaps: Array<{ lockIndex: number; x: number; y: number }> | null =
        null;
      if (tool === "multiWire" && annotationLayer) {
        if (multiWire.phase === 1) {
          // Vertex beats via — same precedence as the single-wire tool.
          const via = usePreferences.getState().snapToVias
            ? findNearestVia(
                world,
                viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize)
              )
            : null;
          const node = wire.snapVertex(world, vp.zoom, via);
          if (node) {
            snap = { x: node.x, y: node.y };
          } else if (via) {
            snap = { x: Math.round(via.x), y: Math.round(via.y) };
          }
        } else {
          // Auto-end first (independent per-wire snaps); fall back to the
          // single nearest-cursor snap if auto-end has nothing to show.
          const autos = findMultiWireAutoEndSnaps(world, event.shiftKey);
          if (autos.length > 0) {
            endSnaps = autos.map((a) => ({
              lockIndex: a.lockIndex,
              x: a.endpoint.x,
              y: a.endpoint.y
            }));
          } else {
            const result = findMultiWireEndpointViaSnap(world, event.shiftKey);
            if (result) {
              endSnaps = [
                {
                  lockIndex: result.lockIndex,
                  x: result.via.x,
                  y: result.via.y
                }
              ];
            }
          }
        }
      }
      multiWireSnapLive.set(snap);
      multiWireEndSnapLive.set(endSnaps);
      // Single-wire pre-start hover: existing vertex or a virtual vertex on a
      // wire body (only before the first point is placed).
      wireSnapLive.set(
        tool === "wire" && !wire.draft ? wire.resolveWireSnap(world) : null
      );
    },
    [
      cursorLive,
      shiftLive,
      wireSnapLive,
      wire,
      viaPolyPreviewLive,
      multiWireSnapLive,
      multiWireEndSnapLive,
      multiWire,
      annotationLayer,
      findNearestVia,
      findMultiWireEndpointViaSnap,
      findMultiWireAutoEndSnaps
    ]
  );

  const onPointerLeave = useCallback(() => {
    cursorLive.set(null);
    viaPolyPreviewLive.set(null);
    multiWireSnapLive.set(null);
    multiWireEndSnapLive.set(null);
    wireSnapLive.set(null);
  }, [
    cursorLive,
    viaPolyPreviewLive,
    multiWireSnapLive,
    multiWireEndSnapLive,
    wireSnapLive
  ]);

  // ── Canvas pointer-down router ──────────────────────────────────

  const onCanvasPointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      // Holding Space (or middle-drag, handled in the canvas) momentarily
      // forces pan regardless of the active tool.
      if (spacePanRef.current) return "pan";
      const tool = useDieViewerStore.getState().activeTool;

      // Place library cell: drag the template's body to move it, a corner to
      // scale it; anywhere else pans (and a click moves the template there).
      if (tool === "libraryCell") return libraryCell.pointerDown(e);

      // Add-cell: rubber-band a rectangle. The rect lives in `cellRectLive`
      // (no page re-render while dragging) and stays as an *editable draft*
      // until the user presses Enter to commit (or Escape to discard) — see
      // useCellTool. While a draft exists, dragging a corner resizes it and
      // dragging the body moves it; a drag started outside the draft starts
      // a fresh rect (replacing the previous draft).
      if (tool === "addCell") {
        const vp = viewportLive.get();
        const tolWorld = vp ? 32 / vp.zoom : 32;
        const snap = (r: Rect): Rect => {
          const guides = annotationsRef.current?.guides;
          if (
            usePreferences.getState().cellSnapToGuides &&
            guides &&
            guides.length > 0
          ) {
            return snapRectToGuides(r, guides, tolWorld);
          }
          return r;
        };

        const pending = cellRectLive.get();
        if (pending) {
          const draft = normalizeRect(pending);
          // Corner-resize: nearest corner moves with the cursor, opposite
          // corner stays fixed as the anchor.
          const corner = rectCornerAt(draft, e.worldPoint, tolWorld);
          if (corner != null) {
            const fixed = rectCorners(draft)[(corner + 2) % 4];
            const setFromCorner = (wp: Point) =>
              cellRectLive.set(snap(rectFromPoints(fixed, wp)));
            return {
              onDragStart: ({ worldPoint }) => setFromCorner(worldPoint),
              onDragMove: ({ worldPoint }) => setFromCorner(worldPoint),
              onPointerUp: ({ worldPoint }) => setFromCorner(worldPoint),
              onCancel: () => cellRectLive.set(draft)
            };
          }
          // Body-move: translate the rect by the pointer delta.
          if (pointInRect(e.worldPoint, draft)) {
            const start = e.worldPoint;
            const moveTo = (wp: Point) =>
              cellRectLive.set({
                x: draft.x + (wp.x - start.x),
                y: draft.y + (wp.y - start.y),
                width: draft.width,
                height: draft.height
              });
            return {
              onDragStart: ({ worldPoint }) => moveTo(worldPoint),
              onDragMove: ({ worldPoint }) => moveTo(worldPoint),
              onPointerUp: ({ worldPoint }) => moveTo(worldPoint),
              onCancel: () => cellRectLive.set(draft)
            };
          }
        }

        // Otherwise: start a fresh rubber-band rect. On release we DO NOT
        // commit — the rect stays as a draft for Enter / further editing.
        const origin = { x: e.worldPoint.x, y: e.worldPoint.y };
        const setRect = (worldPoint: { x: number; y: number }) =>
          cellRectLive.set(snap(rectFromPoints(origin, worldPoint)));
        const drawRect: DragHandler = {
          onDragStart: ({ worldPoint }) => setRect(worldPoint),
          onDragMove: ({ worldPoint }) => setRect(worldPoint),
          onPointerUp: ({ dragged, worldPoint }) => {
            if (!dragged) return; // a plain click makes no cell
            setRect(worldPoint);
          },
          onCancel: () => cellRectLive.set(null)
        };
        return drawRect;
      }

      // Via-rect / ROI / ignore: rubber-band a rectangle, commit on release
      // (no Enter). Shares `shapeRectLive` + a generic overlay.
      if (tool === "viaRect" || tool === "roi" || tool === "ignore") {
        const origin = { x: e.worldPoint.x, y: e.worldPoint.y };
        // ROIs are always square (ML crops are square); the others are free.
        const rectFor = (wp: Point) =>
          tool === "roi"
            ? squareFromPoints(origin, wp)
            : rectFromPoints(origin, wp);
        const drawRect: DragHandler = {
          onDragStart: ({ worldPoint }) =>
            shapeRectLive.set(rectFor(worldPoint)),
          onDragMove: ({ worldPoint }) =>
            shapeRectLive.set(rectFor(worldPoint)),
          onPointerUp: ({ dragged, worldPoint }) => {
            shapeRectLive.set(null);
            if (dragged) commitDrawnRect(tool, rectFor(worldPoint));
          },
          onCancel: () => shapeRectLive.set(null)
        };
        return drawRect;
      }

      // Click-to-place / draw tools defer to onCanvasClick; pan tool pans.
      if (
        tool === "pan" ||
        tool === "wire" ||
        tool === "multiWire" ||
        tool === "via" ||
        tool === "viaPoly" ||
        tool === "cellGuideLine" ||
        tool === "cellGuideSeg" ||
        tool === "ioPoint"
      ) {
        return "pan";
      }

      // Select tool — broad+narrow hit-test, then dispatch click vs marquee.
      const vp = viewportLive.get();
      if (!vp || !annotationLayer) return "pan";
      const tolerance = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer.hitTest(e.worldPoint, tolerance);

      if (hit) {
        // Dragging an existing net vertex moves it. The move is shown live by
        // updating just that one net in the index (no full repopulate); the
        // undoable `upsertNet` is dispatched only on pointer-up.
        const node = wire.nodeFromHit(hit);
        if (node && annotationLayer) {
          const original =
            wire.netsRef.current.find((n) => n.id === node.netId) ?? null;
          const moveNode = (worldPoint: { x: number; y: number }): AnnotationNet | null =>
            original
              ? {
                  ...original,
                  nodes: original.nodes.map((nd) =>
                    nd.id === node.nodeId
                      ? { ...nd, x: worldPoint.x, y: worldPoint.y }
                      : nd
                  )
                }
              : null;
          const handler: DragHandler = {
            onDragStart: () => {
              useDieViewerStore.getState().select([hit.partId], "replace");
            },
            onDragMove: ({ worldPoint }) => {
              const moved = moveNode(worldPoint);
              if (moved) {
                annotationLayer.update(buildNetAnnotation(moved, getNetW, getNetC));
              }
            },
            onPointerUp: ({ dragged, worldPoint, modifiers }) => {
              const moved = dragged ? moveNode(worldPoint) : null;
              if (!moved || !original) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              const action = netChangesToAction([{ prev: original, next: moved }]);
              if (action) void dispatcher.dispatch(action);
            },
            onCancel: () => {
              if (original) {
                annotationLayer.update(
                  buildNetAnnotation(original, getNetW, getNetC)
                );
              }
            }
          };
          return handler;
        }

        // Dragging a placed cell repositions it; Alt-dragging drops a copy
        // there instead and leaves the original in place (Alt is read live,
        // as in the guide drag). Grabbing a cell that's part of a multi-cell
        // selection carries every selected cell. Same live-update / commit-
        // on-up scheme as the net-vertex drag above; one undo step.
        const cellHit = cell.cellFromHit(hit);
        if (cellHit) {
          const sel = useDieViewerStore.getState().selectedIds;
          const ann = annotationsRef.current;
          const group: Array<{ cell: Cell; cellType: CellType }> = [];
          if (sel.has(hit.partId) && ann) {
            const typeById = new Map(ann.cellTypes.map((ct) => [ct.id, ct]));
            for (const c of ann.cells) {
              const ct = typeById.get(c.cellTypeId);
              if (ct && sel.has(`cell:${c.id}`)) group.push({ cell: c, cellType: ct });
            }
          }
          if (group.length === 0) group.push(cellHit);
          // Copies get their ids up front so the live preview and the commit
          // agree (the layer is rebuilt from the annotations after either).
          const copyIds = group.map(() => crypto.randomUUID());
          // Shift locks the move to the dominant axis (re-evaluated live, so
          // tapping Shift mid-drag snaps it straight without restarting). The
          // committed offset is rounded — not the position — so an origin on a
          // half pixel (a type turned a quarter turn) keeps its footprint on
          // whole pixels.
          const offset = (
            worldPoint: { x: number; y: number },
            startWorld: { x: number; y: number },
            shift: boolean,
            round: boolean
          ) => {
            let dx = worldPoint.x - startWorld.x;
            let dy = worldPoint.y - startWorld.y;
            if (shift) {
              if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
              else dx = 0;
            }
            return round ? { dx: Math.round(dx), dy: Math.round(dy) } : { dx, dy };
          };
          const draw = (c: Cell, ct: CellType) =>
            buildCellAnnotation(c, ct, getCellC, getCellShapes);
          /** Put the layer back: originals where they were, no copies. */
          const restore = () => {
            group.forEach(({ cell: c, cellType: ct }, i) => {
              annotationLayer.update(draw(c, ct));
              annotationLayer.remove(`cell:${copyIds[i]}`);
            });
          };
          const handler: DragHandler = {
            onDragStart: () => {
              if (!sel.has(hit.partId)) {
                useDieViewerStore.getState().select([hit.partId], "replace");
              }
            },
            onDragMove: ({ worldPoint, startWorld, modifiers }) => {
              const { dx, dy } = offset(worldPoint, startWorld, modifiers.shift, false);
              group.forEach(({ cell: c, cellType: ct }, i) => {
                const moved = { ...c, x: c.x + dx, y: c.y + dy };
                if (modifiers.alt) {
                  annotationLayer.update(draw(c, ct));
                  annotationLayer.add(draw({ ...moved, id: copyIds[i] }, ct));
                } else {
                  annotationLayer.remove(`cell:${copyIds[i]}`);
                  annotationLayer.update(draw(moved, ct));
                }
              });
            },
            onPointerUp: ({ dragged, worldPoint, startWorld, modifiers }) => {
              if (!dragged) {
                selectFromHit(hit, modifiers.shift);
                return;
              }
              const { dx, dy } = offset(worldPoint, startWorld, modifiers.shift, true);
              if (dx === 0 && dy === 0) {
                // Nothing moved (or a copy would sit exactly on its original).
                restore();
                return;
              }
              const actions: AnnotationAction[] = group.map(({ cell: c }, i) =>
                modifiers.alt
                  ? {
                      kind: "upsertCell",
                      cell: { ...c, id: copyIds[i], x: c.x + dx, y: c.y + dy },
                      prevCell: null
                    }
                  : {
                      kind: "upsertCell",
                      cell: { ...c, x: c.x + dx, y: c.y + dy },
                      prevCell: c
                    }
              );
              void dispatcher.dispatch(
                actions.length === 1 ? actions[0] : { kind: "batch", actions }
              );
              if (modifiers.alt) {
                useDieViewerStore
                  .getState()
                  .select(copyIds.map((id) => `cell:${id}`), "replace");
              }
            },
            onCancel: restore
          };
          return handler;
        }

        // Editable ML shapes (via rectangle / polygon, ROI, ignore): grab a
        // corner/vertex to reshape or the body to move; live-preview, commit
        // one undoable upsert on release.
        const ann = annotationsRef.current;
        const ed = ann ? resolveEditable(hit.partId, ann) : null;
        if (ed) {
          return shapeDragHandler({
            ed,
            worldDown: e.worldPoint,
            tolWorld: HIT_TOLERANCE_PX / vp.zoom,
            layer: annotationLayer,
            dispatch: (a) => void dispatcher.dispatch(a),
            selectPart: () =>
              useDieViewerStore.getState().select([hit.partId], "replace"),
            selectOnClick: (shift) => selectFromHit(hit, shift),
            onPreview: (p) => editPreviewLive.set(p)
          });
        }

        // Click on a non-vertex hit → select on up (a drag is a no-op for now).
        return {
          onPointerUp: ({ dragged, modifiers }) => {
            if (!dragged) selectFromHit(hit, modifiers.shift);
          }
        };
      }

      // No annotation hit → maybe an ML cell proposal (dashed pink box).
      // Click selects it; the inspector then offers approve / dismiss.
      if (proposalLayer) {
        const pHit = proposalLayer.hitTest(e.worldPoint, tolerance);
        if (pHit) {
          return {
            onPointerUp: ({ dragged, modifiers }) => {
              if (dragged) return;
              useDieViewerStore
                .getState()
                .select([pHit.partId], modifiers.shift ? "toggle" : "replace");
            }
          };
        }
      }

      // No annotation hit → maybe an ML via. The hit-area matches the visible
      // via dot (same tolerance as the snap-to-vias path) so clicking on a
      // via reliably selects it.
      if (mlViasLayer) {
        const viaTol = viaSnapTolerance(
          vp.zoom,
          usePreferences.getState().viaSize
        );
        const mlHit = mlViasLayer.hitTestVia(e.worldPoint, viaTol);
        if (mlHit) {
          return {
            onPointerUp: ({ dragged, modifiers }) => {
              if (dragged) return;
              useDieViewerStore
                .getState()
                .select([mlHit.id], modifiers.shift ? "toggle" : "replace");
            }
          };
        }
      }

      // No rbush hit: maybe cell-grid guides (unless locked). Grab a guide
      // directly, OR start the drag *between* already-selected guides to grab
      // the whole group. Drag moves; Alt-drag duplicates (one batched undo).
      if (!usePreferences.getState().guidesLocked) {
        const guides = annotationsRef.current?.guides ?? [];
        const sel = useDieViewerStore.getState().selectedIds;
        const selectedGuides = guides.filter((x) =>
          sel.has(`guide:${x.id}`)
        );
        const hitG = guideHitTest(guides, e.worldPoint, tolerance);

        let targets: typeof guides | null = null;
        let clickSelectId: string | null = null;
        if (hitG) {
          if (sel.has(`guide:${hitG.id}`) && selectedGuides.length > 0) {
            targets = selectedGuides; // grab the existing group
          } else {
            targets = [hitG];
            clickSelectId = `guide:${hitG.id}`;
          }
        } else if (
          selectedGuides.length > 0 &&
          pointInGuidesRegion(selectedGuides, e.worldPoint, tolerance)
        ) {
          targets = selectedGuides; // grabbed between the selected guides
        }

        if (targets) {
          const set = targets;
          const start = { x: e.worldPoint.x, y: e.worldPoint.y };
          // Shift constrains the move to the dominant axis (re-evaluated live).
          const delta = (wp: { x: number; y: number }, shift: boolean) => {
            let dx = wp.x - start.x;
            let dy = wp.y - start.y;
            if (shift) {
              if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
              else dx = 0;
            }
            return { dx, dy };
          };
          const handler: DragHandler = {
            onDragStart: () => {
              if (clickSelectId && !sel.has(clickSelectId)) {
                useDieViewerStore.getState().select([clickSelectId], "replace");
              }
            },
            onDragMove: ({ worldPoint, modifiers }) => {
              const { dx, dy } = delta(worldPoint, modifiers.shift);
              guideDragLive.set({
                previews: set.map((t) => translateGuide(t, dx, dy)),
                hideIds: modifiers.alt ? [] : set.map((t) => t.id)
              });
            },
            onPointerUp: ({ dragged, worldPoint, modifiers }) => {
              guideDragLive.set(null);
              if (!dragged) {
                // Plain click: select the grabbed guide; a click between
                // guides keeps the current selection.
                if (clickSelectId) {
                  useDieViewerStore
                    .getState()
                    .select(
                      [clickSelectId],
                      modifiers.shift ? "toggle" : "replace"
                    );
                }
                return;
              }
              const { dx, dy } = delta(worldPoint, modifiers.shift);
              if (modifiers.alt) {
                const copies = set.map((t) => ({
                  ...translateGuide(t, dx, dy),
                  id: crypto.randomUUID()
                }));
                const actions: AnnotationAction[] = copies.map((guide) => ({
                  kind: "upsertGuide",
                  guide,
                  prevGuide: null
                }));
                void dispatcher.dispatch(
                  actions.length === 1 ? actions[0] : { kind: "batch", actions }
                );
                useDieViewerStore
                  .getState()
                  .select(
                    copies.map((c) => `guide:${c.id}`),
                    "replace"
                  );
              } else {
                const actions: AnnotationAction[] = set.map((t) => ({
                  kind: "upsertGuide",
                  guide: translateGuide(t, dx, dy),
                  prevGuide: t
                }));
                void dispatcher.dispatch(
                  actions.length === 1 ? actions[0] : { kind: "batch", actions }
                );
              }
            },
            onCancel: () => guideDragLive.set(null)
          };
          return handler;
        }
      }

      // Click on empty → marquee.
      const startScreen = { x: e.screenPoint.x, y: e.screenPoint.y };
      const startWorld = { x: e.worldPoint.x, y: e.worldPoint.y };
      const handler: DragHandler = {
        onDragStart: ({ screenPoint }) => {
          marqueeLive.set(rectFromPoints(startScreen, screenPoint));
        },
        onDragMove: ({ screenPoint }) => {
          marqueeLive.set(rectFromPoints(startScreen, screenPoint));
        },
        onPointerUp: ({ dragged, worldPoint, modifiers }) => {
          marqueeLive.set(null);
          if (!dragged) {
            clearSelectionFromEmpty(modifiers.shift);
            return;
          }
          const world = rectFromPoints(startWorld, worldPoint);
          const ids = annotationLayer.queryRect(world).map((a) => a.id);
          if (!usePreferences.getState().guidesLocked) {
            for (const g of guidesInRect(
              annotationsRef.current?.guides ?? [],
              world
            )) {
              ids.push(`guide:${g.id}`);
            }
          }
          // ML vias swept by the marquee — only those currently rendered
          // (i.e. above the confidence threshold). Synthetic position IDs.
          if (mlViasLayer) {
            for (const v of mlViasLayer.queryViasInRect(world)) {
              ids.push(v.id);
            }
          }
          if (proposalLayer) {
            for (const a of proposalLayer.queryRect(world)) ids.push(a.id);
          }
          selectFromMarquee(ids, modifiers.shift);
        },
        onCancel: () => marqueeLive.set(null)
      };
      return handler;
    },
    [
      annotationLayer,
      mlViasLayer,
      proposalLayer,
      marqueeLive,
      selectFromHit,
      selectFromMarquee,
      clearSelectionFromEmpty,
      viewportLive,
      wire,
      cell,
      cellRectLive,
      shapeRectLive,
      editPreviewLive,
      guideDragLive,
      commitDrawnRect,
      dispatcher,
      getNetW,
      getNetC,
      getCellC,
      getCellShapes,
      libraryCell.pointerDown
    ]
  );

  // Canvas click (pan mode, no drag) → resolve the active tool into an action.
  const onCanvasClick = useCallback(
    ({ x, y }: { x: number; y: number }) => {
      const tool = useDieViewerStore.getState().activeTool;
      if (tool === "libraryCell") {
        libraryCell.moveTo({ x, y });
        return;
      }
      if (tool === "wire") {
        wire.addWirePoint({ x, y }, shiftRef.current);
        return;
      }
      if (tool === "via") {
        // A placed via point is a `point_via` HumanAnnotation (schema v2).
        void dispatcher.dispatch({
          kind: "upsertAnnotation",
          annotation: {
            id: crypto.randomUUID(),
            class: "point_via",
            geometry: { kind: "point", x: Math.round(x), y: Math.round(y) },
            source: "human"
          },
          prevAnnotation: null
        });
        return;
      }
      if (tool === "viaPoly") {
        viaPoly.addPoint({ x, y });
        return;
      }
      if (tool === "multiWire") {
        if (multiWire.phase === 1) {
          // Snap start points to existing net vertices first (so the bus line
          // *merges into* that net via the anchor), then fall back to a nearby
          // via. Vertex wins over via — even one drawn on top of the vertex —
          // to keep the connect-to-existing-net behaviour intact.
          const vp = viewportLive.get();
          let p = { x, y };
          let anchor: { netId: string; nodeId: string } | null = null;
          if (vp) {
            const via = usePreferences.getState().snapToVias
              ? findNearestVia(
                  { x, y },
                  viaSnapTolerance(vp.zoom, usePreferences.getState().viaSize)
                )
              : null;
            const node = wire.snapVertex({ x, y }, vp.zoom, via);
            if (node) {
              p = { x: node.x, y: node.y };
              anchor = { netId: node.netId, nodeId: node.nodeId };
            } else if (via) {
              p = { x: Math.round(via.x), y: Math.round(via.y) };
            }
          }
          multiWire.addPoint(p, anchor);
        } else {
          // Phase 2: auto-end-on-via wins when any wire's projection crosses
          // a via — all such wires lock in one click (they may target
          // different vias). Then the snap-to-vias-near-cursor path; finally
          // the normal nearest-preview lock on the parallel front.
          const autos = findMultiWireAutoEndSnaps({ x, y }, shiftRef.current);
          if (autos.length > 0) {
            multiWire.endWires(autos);
          } else {
            const snap = findMultiWireEndpointViaSnap(
              { x, y },
              shiftRef.current
            );
            if (snap) {
              multiWire.endWire({ x, y }, false, {
                endpoint: snap.endpoint,
                lockIndex: snap.lockIndex
              });
            } else {
              multiWire.endWire({ x, y }, shiftRef.current);
            }
          }
        }
        return;
      }
      if (tool === "cellGuideLine") {
        guide.placeLine({ x, y });
        return;
      }
      if (tool === "cellGuideSeg") {
        guide.addSegPoint({ x, y });
        return;
      }
      if (tool === "ioPoint") {
        const pins = annotations?.pins ?? [];
        const nextNum = pins.reduce((m, p) => Math.max(m, p.pin), 0) + 1;
        void dispatcher.dispatch({
          kind: "addPin",
          pin: {
            id: crypto.randomUUID(),
            x: Math.round(x),
            y: Math.round(y),
            pin: nextNum,
            name: `pin_${nextNum}`
          }
        });
      }
      // Other tools land in future rounds.
    },
    [
      dispatcher,
      wire,
      viaPoly,
      multiWire,
      guide,
      annotations,
      annotationLayer,
      viewportLive,
      findNearestVia,
      findMultiWireEndpointViaSnap,
      findMultiWireAutoEndSnaps,
      libraryCell.moveTo
    ]
  );

  /**
   * Right-click on the canvas opens the context menu. Resolves the click to
   * the best-matching "thing here" — net vertex > manual via > ML via > empty
   * space — so the "Start wire from here" entry anchors at that thing's
   * centre (and extends the net when it's a vertex). The selection-driven
   * "Start multi-wire" item is independent: it walks the current selection
   * for via/vertex points, regardless of what was clicked.
   */
  const onCanvasContextMenu = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      event.preventDefault();
      const c = containerRef.current?.querySelector("canvas") as
        | HTMLCanvasElement
        | null;
      const vp = canvasHandle.current?.getViewport();
      if (!c || !vp) return;
      const rect = c.getBoundingClientRect();
      const world: Point = {
        x: vp.originX + (event.clientX - rect.left) / vp.zoom,
        y: vp.originY + (event.clientY - rect.top) / vp.zoom
      };

      // Resolve what's under the cursor for the "from here" entry. Annotation
      // hits win over ML vias (the manual layer paints on top), and net
      // vertices win over via annotations (most specific anchor).
      let hitPoint: Point = world;
      let hitAnchor: DrawAnchor | null = null;
      let hitLabel = "from this point";
      const tol = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer?.hitTest(world, tol) ?? null;
      if (hit) {
        const node = wire.nodeFromHit(hit);
        if (node) {
          hitPoint = { x: node.x, y: node.y };
          hitAnchor = { netId: node.netId, nodeId: node.nodeId };
          hitLabel = "from net vertex";
        } else if (
          hit.annotation.kind === "via" &&
          hit.annotation.id.startsWith("anno:")
        ) {
          // Manual via — strip the "anno:" prefix added by the annotation
          // factory, then look up the geometry to get the centroid.
          const annoId = hit.annotation.id.slice(5);
          const a = annotationsRef.current?.annotations?.find(
            (x) => x.id === annoId
          );
          const g = a?.geometry;
          if (g) {
            if (g.kind === "point") hitPoint = { x: g.x, y: g.y };
            else if (g.kind === "rectangle") {
              hitPoint = {
                x: g.x + g.width / 2,
                y: g.y + g.height / 2
              };
            } else if (g.kind === "polygon" && g.points.length > 0) {
              let sx = 0;
              let sy = 0;
              for (const p of g.points) {
                sx += p.x;
                sy += p.y;
              }
              hitPoint = {
                x: sx / g.points.length,
                y: sy / g.points.length
              };
            }
            hitLabel = "from via";
          }
        }
      } else if (mlViasLayer) {
        const viaTol = viaSnapTolerance(
          vp.zoom,
          usePreferences.getState().viaSize
        );
        const mlHit = mlViasLayer.hitTestVia(world, viaTol);
        if (mlHit) {
          hitPoint = { x: mlHit.x, y: mlHit.y };
          hitLabel = "from ML via";
        }
      }

      // The placed cell under the cursor, for the flip / rotate items. The
      // hit-test favours whatever small thing sits on top (a wire, a via),
      // so fall back to the visible cell footprint containing the point.
      // Part of the selection ⇒ act on every selected cell. The selection
      // itself is left alone: "Start multi-wire" reads it when clicked.
      const sel = useDieViewerStore.getState().selectedIds;
      const ann = annotationsRef.current;
      const cellsHidden = usePreferences.getState().hiddenKinds.includes("cell");
      const underId =
        (hit ? cell.cellFromHit(hit) : null)?.cell.id ??
        (cellsHidden
          ? undefined
          : annotationLayer
              ?.search({ x: world.x, y: world.y, width: 0, height: 0 })
              .find((a) => a.kind === "cell" && pointInRect(world, a.bbox))
              ?.id.slice("cell:".length));
      let cellIds: string[] = [];
      let cellLabel = "";
      if (underId && ann) {
        cellIds = sel.has(`cell:${underId}`)
          ? [...sel].filter((id) => id.startsWith("cell:")).map((id) => id.slice("cell:".length))
          : [underId];
        const under = ann.cells.find((c) => c.id === underId);
        const typeName = ann.cellTypes.find((ct) => ct.id === under?.cellTypeId)?.name;
        cellLabel =
          cellIds.length > 1 ? `${cellIds.length} cells` : `Cell${typeName ? ` · ${typeName}` : ""}`;
      }

      const picks = extractAnchorPointsFromSelection(sel);
      setContextMenu({
        screenX: event.clientX,
        screenY: event.clientY,
        hitPoint,
        hitAnchor,
        hitLabel,
        multiPointCount: picks.length,
        cellIds,
        cellLabel
      });
    },
    [annotationLayer, mlViasLayer, wire, cell, extractAnchorPointsFromSelection]
  );

  /** Flip / turn placed cells in place, as they lie on the die (right-click
   *  menu). One undo step. */
  const orientCells = useCallback(
    (cellIds: string[], op: DieOrientOp) => {
      const ann = annotationsRef.current;
      if (!ann) return;
      const ids = new Set(cellIds);
      const actions: AnnotationAction[] = ann.cells
        .filter((c) => ids.has(c.id))
        .map((c) => buildOrientAction(c, orientOnDie(orientOf(c), op)));
      if (actions.length === 0) return;
      void dispatcher.dispatch(
        actions.length === 1 ? actions[0] : { kind: "batch", actions }
      );
    },
    [dispatcher]
  );

  /**
   * Double-click on the canvas. In the wire tool this commits the in-flight
   * draft (dropping the spurious dbl-click second point). In the select tool
   * it's a shortcut for "start wiring from this via" — only fires when the
   * dbl-click lands on a via (manual or ML), so net-vertex dbl-clicks keep
   * their existing "promote sub-selection to whole net" meaning.
   */
  const onCanvasDoubleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const tool = useDieViewerStore.getState().activeTool;
      if (tool === "wire") {
        wire.commitWire({ dropLast: true });
        return;
      }
      if (tool !== "select") return;
      const c = containerRef.current?.querySelector("canvas") as
        | HTMLCanvasElement
        | null;
      const vp = canvasHandle.current?.getViewport();
      if (!c || !vp) return;
      const rect = c.getBoundingClientRect();
      const world: Point = {
        x: vp.originX + (event.clientX - rect.left) / vp.zoom,
        y: vp.originY + (event.clientY - rect.top) / vp.zoom
      };
      // Manual via first (annotation layer paints on top + has the tighter
      // pickable region), then ML via as the fallback.
      const tol = HIT_TOLERANCE_PX / vp.zoom;
      const hit = annotationLayer?.hitTest(world, tol) ?? null;
      if (hit && hit.annotation.kind === "via") {
        const annoId = hit.annotation.id.startsWith("anno:")
          ? hit.annotation.id.slice(5)
          : hit.annotation.id;
        const a = annotationsRef.current?.annotations?.find(
          (x) => x.id === annoId
        );
        const g = a?.geometry;
        let p: Point | null = null;
        if (g?.kind === "point") p = { x: g.x, y: g.y };
        else if (g?.kind === "rectangle") {
          p = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
        } else if (g?.kind === "polygon" && g.points.length > 0) {
          let sx = 0;
          let sy = 0;
          for (const q of g.points) {
            sx += q.x;
            sy += q.y;
          }
          p = { x: sx / g.points.length, y: sy / g.points.length };
        }
        if (p) startWireAt(p, null);
        return;
      }
      if (mlViasLayer) {
        const viaTol = viaSnapTolerance(
          vp.zoom,
          usePreferences.getState().viaSize
        );
        const mlHit = mlViasLayer.hitTestVia(world, viaTol);
        if (mlHit) startWireAt({ x: mlHit.x, y: mlHit.y }, null);
      }
    },
    [annotationLayer, mlViasLayer, wire, startWireAt]
  );

  // Zoom button handlers read the latest viewport from the live store at
  // click time, so they never need to re-bind during interaction.
  const setZoomCentered = useCallback(
    (newZoom: number) => {
      if (!die || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const vp = viewportLive.get();
      if (!vp) return;
      const worldCx = vp.originX + rect.width / 2 / vp.zoom;
      const worldCy = vp.originY + rect.height / 2 / vp.zoom;
      canvasHandle.current?.setViewport({
        originX: worldCx - rect.width / 2 / newZoom,
        originY: worldCy - rect.height / 2 / newZoom,
        zoom: newZoom
      });
    },
    [die, viewportLive]
  );

  const zoomIn = useCallback(() => {
    const vp = viewportLive.get();
    if (vp) setZoomCentered(vp.zoom * 1.5);
  }, [viewportLive, setZoomCentered]);

  const zoomOut = useCallback(() => {
    const vp = viewportLive.get();
    if (vp) setZoomCentered(vp.zoom / 1.5);
  }, [viewportLive, setZoomCentered]);

  const fitToScreen = useCallback(() => {
    if (!die || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const v = fitViewport(die.width, die.height, rect.width, rect.height, 24);
    canvasHandle.current?.setViewport(v);
  }, [die]);

  const oneToOne = useCallback(() => setZoomCentered(1), [setZoomCentered]);

  // Double-clicking an Items-panel row frames that entity (or the union of a
  // group/category's entities) in the viewport, with a margin.
  const focusOnIds = useCallback(
    (ids: string[]) => {
      if (!annotationLayer || !containerRef.current) return;
      const box = annotationLayer.unionBBox(ids);
      if (!box) return;
      const rect = containerRef.current.getBoundingClientRect();
      canvasHandle.current?.setViewport(
        fitRectViewport(box, rect.width, rect.height, 56, 32)
      );
    },
    [annotationLayer]
  );

  const minZoom = die ? (1 / Math.max(die.width, die.height)) * 50 : 0.01;

  return (
    <AppShell
      breadcrumb={die?.name ?? `die · ${dieId}`}
      meta={die ? `${die.width.toLocaleString()}×${die.height.toLocaleString()}` : undefined}
      onUndo={() => void dispatcher.undo()}
      onRedo={() => void dispatcher.redo()}
      canUndo={dispatcher.canUndo}
      canRedo={dispatcher.canRedo}
    >
      <SubBar
        right={
          <div className="row" style={{ gap: 6 }}>
            {mlJob.data?.status === "running" && (
              <span
                className="chip"
                title={`ML inference: ${mlJob.data.completedTiles}/${mlJob.data.totalTiles} tiles`}
              >
                Inference {mlJob.data.percentage}%
              </span>
            )}
            <IssuesChip />
            <div
              style={{ width: 1, height: 18, background: "var(--l2)", margin: "0 2px" }}
            />
            <button className="btn ghost" title="Zoom out" onClick={zoomOut}>
              {Ic.zoomOut}
            </button>
            <button className="btn ghost" title="Zoom in" onClick={zoomIn}>
              {Ic.zoomIn}
            </button>
            <ZoomChip store={viewportLive} />
            <button className="btn ghost" title="Fit to screen" onClick={fitToScreen}>
              {Ic.fit}
            </button>
            <button className="btn ghost" title="100%" onClick={oneToOne}>
              1:1
            </button>
          </div>
        }
      >
        <DieToolbar
          activeTool={activeTool}
          setActiveTool={setActiveTool}
          multiWireHint={multiWireHint}
          libraryCell={libraryCell}
        />
      </SubBar>
      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "248px 1fr 320px"
        }}
      >
        <aside style={panelStyle}>
          <div className="ph">
            <span className="u">Items</span>
          </div>
          <OutlineTree
            annotations={annotations}
            onFocus={focusOnIds}
            baseImages={die ? [{ id: die.id, name: die.name }] : []}
            foreignTypeOwners={foreignTypeOwners}
          />
        </aside>
        <section
          ref={containerRef}
          onPointerMove={onPointerMove}
          onPointerLeave={onPointerLeave}
          onContextMenu={onCanvasContextMenu}
          onDoubleClick={onCanvasDoubleClick}
          style={{ background: "var(--canvas-bg)", minWidth: 0, position: "relative" }}
        >
          {error && (
            <CenteredStatus>failed to load die · {error.message}</CenteredStatus>
          )}
          {!error && (isLoading || !die) && <CenteredStatus>loading die…</CenteredStatus>}
          {!error && die && initialViewport && (
            <TiledCanvas
              layers={allLayers}
              initialViewport={initialViewport}
              background="#0c0c08"
              minZoom={minZoom}
              maxZoom={32}
              cursor={
                spacePan || activeTool === "pan"
                  ? "grab"
                  : activeTool === "select"
                    ? "default"
                    : "crosshair"
              }
              handleRef={canvasHandle}
              onViewportChange={onViewportChange}
              onPointerDown={onCanvasPointerDown}
              onCanvasClick={onCanvasClick}
            />
          )}
          <MarqueeOverlay store={marqueeLive} />
          <WireDraftOverlay
            points={wire.draft?.points ?? NO_DRAFT_POINTS}
            anchored={
              wire.draft != null &&
              (wire.draft.anchor != null || wire.draft.startSplit != null)
            }
            previewStore={wirePreviewLive}
            startSnapStore={wireSnapLive}
            viewportStore={viewportLive}
          />
          <MultiWireOverlay
            points={multiWire.points}
            phase={multiWire.phase}
            ends={multiWire.ends}
            cursorStore={cursorLive}
            snapStore={multiWireSnapLive}
            endSnapStore={multiWireEndSnapLive}
            shiftStore={shiftLive}
            viewportStore={viewportLive}
          />
          <RectDraftOverlay
            rectStore={cellRectLive}
            viewportStore={viewportLive}
            color="#6dd679"
            handles
          />
          <RectDraftOverlay
            rectStore={shapeRectLive}
            viewportStore={viewportLive}
            color={
              activeTool === "roi"
                ? "#f5d68a"
                : activeTool === "ignore"
                  ? "#e36854"
                  : "#82d6a6"
            }
          />
          <PolyDraftOverlay
            points={viaPoly.points}
            previewStore={viaPolyPreviewLive}
            viewportStore={viewportLive}
          />
          <SelectionHandlesOverlay
            annotations={annotations}
            viewportStore={viewportLive}
            previewStore={editPreviewLive}
          />
          <GuidesOverlay
            annotations={annotations}
            viewportStore={viewportLive}
            cursorStore={cursorLive}
            dragStore={guideDragLive}
            segStart={guide.segStart}
          />
          {activeTool === "libraryCell" && (
            <LibraryCellOverlay tool={libraryCell} library={library} viewportStore={viewportLive} />
          )}
        </section>
        <aside style={panelStyle}>
          <InspectorPanel
            annotations={annotations}
            dispatcher={dispatcher}
            dieId={dieId}
            die={die}
            library={library}
            mlViasLayer={mlViasLayer}
            proposals={proposals}
          />
        </aside>
      </main>
      <StatusBar
        items={[
          die?.name,
          <CursorReadout key="cursor" store={cursorLive} />,
          <ZoomReadout key="zoom" store={viewportLive} />,
          annotations ? annotationsSummary(annotations) : null,
          die?.tileProgress && die.tileProgress.percentage < 100
            ? `tiling ${formatPercent(die.tileProgress.percentage)}`
            : null,
          mlJob.data?.status === "running"
            ? `inference ${mlJob.data.percentage}%`
            : null,
          activeTool === "addCell"
            ? "add cell — drag to draw · corners resize · Enter to add · Esc to cancel"
            : null,
          activeTool === "libraryCell"
            ? libraryCell.hasDraft
              ? "place library cell — drag to move · corners scale · click to move here · Enter to accept · Esc to cancel"
              : (libraryCell.notice ?? "place library cell — pick a cell in the toolbar")
            : null
        ].filter(Boolean)}
      />
      {contextMenu && (
        <DieContextMenu
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onStartWire={() =>
            startWireAt(contextMenu.hitPoint, contextMenu.hitAnchor)
          }
          onStartMultiWire={() =>
            startMultiWireFrom(
              extractAnchorPointsFromSelection(
                useDieViewerStore.getState().selectedIds
              )
            )
          }
          onOrientCells={(op) => orientCells(contextMenu.cellIds, op)}
        />
      )}
    </AppShell>
  );
}
