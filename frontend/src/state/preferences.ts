import { create } from "zustand";
import { persist, subscribeWithSelector } from "zustand/middleware";
import type { AnnotationClass, LayerType } from "shared";
import {
  CELL_COLOR,
  NET_COLOR,
  NET_DEFAULT_WIDTH
} from "../renderer/annotations/dieAnnotations";
import { VIA_DEFAULT_SIZE } from "../renderer/annotations/style";
import type { Viewport } from "../renderer/types";
import type { InspectorTab } from "./dieViewer";
import {
  ANNOTATION_KIND_VALUES,
  type AnnotationKind
} from "./annotationKinds";

interface PreferencesState {
  /** Base width (world units) for net wires. The renderer's screen clamp
   *  applies on top of this. */
  netWidth: number;
  /** Base color for unselected wires + vertices (one of NET_COLOR_OPTIONS). */
  netColor: string;
  /** Cell outline + block-fill color (one of CELL_COLOR_OPTIONS). */
  cellColor: string;
  /** When true, cells draw their inner layer shapes at every zoom level;
   *  when false, they always render as a solid block. */
  cellShowShapes: boolean;
  /** When true, the cell-rectangle tool snaps the drawn rect's edges to
   *  nearby grid guides (guide behaviour itself lands in a later phase). */
  cellSnapToGuides: boolean;
  /** Cell-grid guides hidden on the canvas. */
  guidesHidden: boolean;
  /** Guides locked — not selectable / movable (still visible). */
  guidesLocked: boolean;
  /** Classes a newly-drawn ML ROI fully labels (schema §1 — load-bearing).
   *  Editable in the ROI tool options; each new ROI is stamped with this. */
  roiClasses: AnnotationClass[];
  /** Per-base-image hidden flag, keyed by base-image id (absent = visible).
   *  Today there's one base image per die (keyed by die id); the map shape is
   *  ready for multiple base images landing in the annotations later. */
  baseImageHidden: Record<string, boolean>;
  /** Per-base-image opacity 0..1, keyed by base-image id (absent = 1). */
  baseImageOpacity: Record<string, number>;
  /** Annotation kinds that are hidden on the canvas. Inverse of "visible" so
   *  default empty array means "everything visible". */
  hiddenKinds: AnnotationKind[];
  /** Outline tree sections that should render expanded. */
  expandedSections: AnnotationKind[];
  /** Merge-cells canvas mode. */
  mergeMode: "overlay" | "sxs" | "diff" | "specimen" | "candidate";
  /** Candidate opacity 0..1 in merge-cells overlay mode. */
  mergeOpacity: number;
  /** Show cell-type layer annotations over the merge-cells crops. */
  mergeShowAnno: boolean;
  /** Overlay ML via predictions on each merge-cells crop (helps eyeball
   *  align by comparing detected via positions specimen-vs-candidate). */
  mergeShowMlVias: boolean;
  /** Last viewport per die (pan/zoom). Written throttled from the page so
   *  reload restores the user's framing. */
  savedViewports: Record<string, Viewport>;
  /** Die-viewer: hide the "ML Results" overlay (live ML via predictions
   *  fetched per tile). One global toggle — the user usually wants to flip
   *  it the same way across dies. */
  mlResultsHidden: boolean;
  /** Wire / multi-wire: snap the click position to the nearest via (ML or
   *  manually placed) when within tolerance. Helps stitch nets onto via
   *  centres without eyeballing. */
  snapToVias: boolean;
  /** Wire / multi-wire: when any via lies on the projected segment from the
   *  last placed point toward the cursor, force the wire endpoint onto that
   *  via and finish the wire there (each wire in a multi-wire bus snaps
   *  independently on its own projected line). Off by default. */
  wireAutoEndOnVia: boolean;
  /** Render radius for point vias (world / source-pixel units). Shared by
   *  the manual via annotation render path and the ML-via overlay, and used
   *  as the snap-to-via tolerance. One setting because the user thinks of
   *  "via size" as a single physical property, not a per-source style. */
  viaSize: number;
  /** Minimum model confidence (0..1) for an ML via to be shown / counted.
   *  Inference caches every detection with its score; this slider filters
   *  the cached results client-side — no re-inference on change. */
  viaConfidenceThreshold: number;
  /** Minimum score (0..1) for an ML cell proposal to be shown / offered in
   *  merge-cells. Separate from the via threshold so the two overlays can be
   *  tuned independently. */
  cellDetectionThreshold: number;
  /** Die-viewer: hide the ML cell proposals overlay. */
  cellDetectionsHidden: boolean;
  /** Cell detection: search for horizontally / vertically mirrored copies. */
  cellDetectAllowFlipX: boolean;
  cellDetectAllowFlipY: boolean;
  /** Cell detection: drop candidates overlapping any placed cell. */
  cellDetectAvoidExisting: boolean;
  /** Cell detection: build the template from the type's instances on every
   *  die of the cell library. */
  cellDetectAllDies: boolean;
  /** Specimens: stack instances from every die of the cell library too. */
  specimensAllDies: boolean;
  /** Die-viewer: hide the wire-likelihood overlay. */
  wireMapHidden: boolean;
  /** Wire-likelihood overlay opacity 0..1. */
  wireMapOpacity: number;
  /** Merge cells / Cell RE: show a type's clean specimen (when generated)
   *  instead of one raw instance crop. */
  useCleanSpecimens: boolean;
  /** Die-viewer right-panel tab (Inspector / ML). Persisted so the panel
   *  re-opens where the user left it. The ML tab also drives a canvas
   *  render mode (traces/vias sized from mlConfig). */
  inspectorTab: InspectorTab;
  /** Hidden cell-layer keys on the Cells-RE page (absent ⇒ visible). The two
   *  non-editable "groups" (inferred, die-viewer overlay) use the special
   *  keys `_inferred` / `_dieViewer`. */
  reLayerHidden: Record<string, boolean>;
}

interface PreferencesActions {
  setNetWidth: (width: number) => void;
  setNetColor: (color: string) => void;
  setCellColor: (color: string) => void;
  setCellShowShapes: (show: boolean) => void;
  setCellSnapToGuides: (snap: boolean) => void;
  setGuidesHidden: (hidden: boolean) => void;
  setGuidesLocked: (locked: boolean) => void;
  setBaseImageHidden: (id: string, hidden: boolean) => void;
  setBaseImageOpacity: (id: string, opacity: number) => void;
  setMergeMode: (
    mode: "overlay" | "sxs" | "diff" | "specimen" | "candidate"
  ) => void;
  setMergeOpacity: (opacity: number) => void;
  setMergeShowAnno: (show: boolean) => void;
  setMergeShowMlVias: (show: boolean) => void;
  setRoiClasses: (classes: AnnotationClass[]) => void;
  setReLayerHidden: (key: string, hidden: boolean) => void;
  /**
   * "Solo" toggle for the Cells-RE layer visibility list. `key` is the layer
   * being soloed; `allKeys` is the full set of toggleable keys the panel
   * knows about (real `LayerType`s + virtual overlay keys).
   *
   * Behaviour: if `key` is currently the only visible layer in `allKeys`,
   * restores everything to visible. Otherwise hides every other key and
   * makes `key` visible. The whole thing is one `set()` call so the canvas
   * only paints once per double-click.
   */
  soloReLayer: (key: string, allKeys: ReadonlyArray<string>) => void;
  setMlResultsHidden: (hidden: boolean) => void;
  setSnapToVias: (snap: boolean) => void;
  setWireAutoEndOnVia: (enabled: boolean) => void;
  setViaSize: (size: number) => void;
  setViaConfidenceThreshold: (threshold: number) => void;
  setCellDetectionThreshold: (threshold: number) => void;
  setCellDetectionsHidden: (hidden: boolean) => void;
  setCellDetectAllowFlipX: (allow: boolean) => void;
  setCellDetectAllowFlipY: (allow: boolean) => void;
  setCellDetectAvoidExisting: (avoid: boolean) => void;
  setCellDetectAllDies: (all: boolean) => void;
  setSpecimensAllDies: (all: boolean) => void;
  setWireMapHidden: (hidden: boolean) => void;
  setWireMapOpacity: (opacity: number) => void;
  setUseCleanSpecimens: (use: boolean) => void;
  setInspectorTab: (tab: InspectorTab) => void;
  toggleKindVisibility: (kind: AnnotationKind) => void;
  toggleSectionExpanded: (kind: AnnotationKind) => void;
  saveViewport: (dieId: string, viewport: Viewport) => void;
  clearSavedViewport: (dieId: string) => void;
}

const DEFAULT_EXPANDED_SECTIONS: AnnotationKind[] = ["net", "via", "roi"];

export const usePreferences = create<PreferencesState & PreferencesActions>()(
  subscribeWithSelector(
    persist(
      (set) => ({
        netWidth: NET_DEFAULT_WIDTH,
        netColor: NET_COLOR,
        cellColor: CELL_COLOR,
        cellShowShapes: true,
        cellSnapToGuides: false,
        guidesHidden: false,
        guidesLocked: false,
        baseImageHidden: {},
        baseImageOpacity: {},
        roiClasses: ["point_via", "irregular_via"],
        hiddenKinds: [],
        expandedSections: DEFAULT_EXPANDED_SECTIONS,
        mergeMode: "overlay",
        mergeOpacity: 0.5,
        mergeShowAnno: true,
        mergeShowMlVias: false,
        savedViewports: {},
        reLayerHidden: {},
        mlResultsHidden: true,
        snapToVias: false,
        wireAutoEndOnVia: false,
        viaSize: VIA_DEFAULT_SIZE,
        viaConfidenceThreshold: 0.5,
        cellDetectionThreshold: 0.5,
        cellDetectionsHidden: false,
        cellDetectAllowFlipX: true,
        cellDetectAllowFlipY: true,
        cellDetectAvoidExisting: true,
        cellDetectAllDies: false,
        specimensAllDies: false,
        wireMapHidden: false,
        wireMapOpacity: 0.8,
        useCleanSpecimens: true,
        inspectorTab: "inspector",

        setNetWidth: (width) => set({ netWidth: width }),
        setNetColor: (color) => set({ netColor: color }),
        setCellColor: (color) => set({ cellColor: color }),
        setCellShowShapes: (show) => set({ cellShowShapes: show }),
        setCellSnapToGuides: (snap) => set({ cellSnapToGuides: snap }),
        setGuidesHidden: (hidden) => set({ guidesHidden: hidden }),
        setGuidesLocked: (locked) => set({ guidesLocked: locked }),
        setBaseImageHidden: (id, hidden) =>
          set((state) => ({
            baseImageHidden: { ...state.baseImageHidden, [id]: hidden }
          })),
        setBaseImageOpacity: (id, opacity) =>
          set((state) => ({
            baseImageOpacity: {
              ...state.baseImageOpacity,
              [id]: Math.min(1, Math.max(0, opacity))
            }
          })),
        setMergeMode: (mode) => set({ mergeMode: mode }),
        setMergeOpacity: (opacity) =>
          set({ mergeOpacity: Math.min(1, Math.max(0, opacity)) }),
        setMergeShowAnno: (show) => set({ mergeShowAnno: show }),
        setMergeShowMlVias: (show) => set({ mergeShowMlVias: show }),
        setRoiClasses: (classes) => set({ roiClasses: classes }),
        setReLayerHidden: (key, hidden) =>
          set((state) => {
            // Strip the entry when the layer is visible so the map stays tidy
            // and the persisted JSON doesn't accumulate stale keys.
            if (!hidden) {
              if (!(key in state.reLayerHidden)) return state;
              const { [key]: _, ...rest } = state.reLayerHidden;
              return { reLayerHidden: rest };
            }
            return { reLayerHidden: { ...state.reLayerHidden, [key]: true } };
          }),
        soloReLayer: (key, allKeys) =>
          set((state) => {
            const isOtherHidden = (k: string) => state.reLayerHidden[k] === true;
            const others = allKeys.filter((k) => k !== key);
            // Already soloed when this key is visible AND every other known key
            // is hidden. Toggling in that state restores the world to visible.
            const alreadySoloed =
              !isOtherHidden(key) && others.length > 0 && others.every(isOtherHidden);
            if (alreadySoloed) {
              // Drop just our known keys; leave any unrelated entries alone.
              const next = { ...state.reLayerHidden };
              for (const k of allKeys) delete next[k];
              return { reLayerHidden: next };
            }
            const next = { ...state.reLayerHidden };
            for (const k of allKeys) {
              if (k === key) delete next[k];
              else next[k] = true;
            }
            return { reLayerHidden: next };
          }),
        setMlResultsHidden: (hidden) => set({ mlResultsHidden: hidden }),
        setSnapToVias: (snap) => set({ snapToVias: snap }),
        setWireAutoEndOnVia: (enabled) => set({ wireAutoEndOnVia: enabled }),
        setViaSize: (size) => set({ viaSize: size }),
        setViaConfidenceThreshold: (threshold) =>
          set({
            viaConfidenceThreshold: Math.min(1, Math.max(0, threshold))
          }),
        setCellDetectionThreshold: (threshold) =>
          set({
            cellDetectionThreshold: Math.min(1, Math.max(0, threshold))
          }),
        setCellDetectionsHidden: (hidden) => set({ cellDetectionsHidden: hidden }),
        setCellDetectAllowFlipX: (allow) => set({ cellDetectAllowFlipX: allow }),
        setCellDetectAllowFlipY: (allow) => set({ cellDetectAllowFlipY: allow }),
        setCellDetectAvoidExisting: (avoid) => set({ cellDetectAvoidExisting: avoid }),
        setCellDetectAllDies: (all) => set({ cellDetectAllDies: all }),
        setSpecimensAllDies: (all) => set({ specimensAllDies: all }),
        setWireMapHidden: (hidden) => set({ wireMapHidden: hidden }),
        setWireMapOpacity: (opacity) => set({ wireMapOpacity: Math.min(1, Math.max(0, opacity)) }),
        setUseCleanSpecimens: (use) => set({ useCleanSpecimens: use }),
        setInspectorTab: (tab) => set({ inspectorTab: tab }),
        toggleKindVisibility: (kind) =>
          set((state) => ({
            hiddenKinds: state.hiddenKinds.includes(kind)
              ? state.hiddenKinds.filter((k) => k !== kind)
              : [...state.hiddenKinds, kind]
          })),
        toggleSectionExpanded: (kind) =>
          set((state) => ({
            expandedSections: state.expandedSections.includes(kind)
              ? state.expandedSections.filter((k) => k !== kind)
              : [...state.expandedSections, kind]
          })),
        saveViewport: (dieId, viewport) =>
          set((state) => ({
            savedViewports: { ...state.savedViewports, [dieId]: viewport }
          })),
        clearSavedViewport: (dieId) =>
          set((state) => {
            if (!(dieId in state.savedViewports)) return state;
            const { [dieId]: _, ...rest } = state.savedViewports;
            return { savedViewports: rest };
          })
      }),
      {
        name: "mmo-chip-preferences",
        version: 1,
        // Strip out any unknown kinds that may have been persisted before a
        // schema change, so the UI never references a removed kind.
        partialize: (state) => ({
          netWidth: state.netWidth,
          netColor: state.netColor,
          cellColor: state.cellColor,
          cellShowShapes: state.cellShowShapes,
          cellSnapToGuides: state.cellSnapToGuides,
          guidesHidden: state.guidesHidden,
          guidesLocked: state.guidesLocked,
          baseImageHidden: state.baseImageHidden,
          baseImageOpacity: state.baseImageOpacity,
          roiClasses: state.roiClasses,
          hiddenKinds: state.hiddenKinds.filter((k) =>
            ANNOTATION_KIND_VALUES.includes(k)
          ),
          expandedSections: state.expandedSections.filter((k) =>
            ANNOTATION_KIND_VALUES.includes(k)
          ),
          mergeMode: state.mergeMode,
          mergeOpacity: state.mergeOpacity,
          mergeShowAnno: state.mergeShowAnno,
          mergeShowMlVias: state.mergeShowMlVias,
          savedViewports: state.savedViewports,
          reLayerHidden: state.reLayerHidden,
          mlResultsHidden: state.mlResultsHidden,
          snapToVias: state.snapToVias,
          wireAutoEndOnVia: state.wireAutoEndOnVia,
          viaSize: state.viaSize,
          viaConfidenceThreshold: state.viaConfidenceThreshold,
          cellDetectionThreshold: state.cellDetectionThreshold,
          cellDetectionsHidden: state.cellDetectionsHidden,
          cellDetectAllowFlipX: state.cellDetectAllowFlipX,
          cellDetectAllowFlipY: state.cellDetectAllowFlipY,
          cellDetectAvoidExisting: state.cellDetectAvoidExisting,
          cellDetectAllDies: state.cellDetectAllDies,
          specimensAllDies: state.specimensAllDies,
          wireMapHidden: state.wireMapHidden,
          wireMapOpacity: state.wireMapOpacity,
          useCleanSpecimens: state.useCleanSpecimens,
          inspectorTab: state.inspectorTab
        })
      }
    )
  )
);

/** Helper selector: is this annotation kind currently visible on the canvas? */
export function selectIsKindVisible(kind: AnnotationKind) {
  return (state: PreferencesState) => !state.hiddenKinds.includes(kind);
}

/** Helper selector: is this outline section expanded? */
export function selectIsSectionExpanded(kind: AnnotationKind) {
  return (state: PreferencesState) => state.expandedSections.includes(kind);
}

/** Base-image visibility (defaults to visible when never toggled). */
export function selectBaseImageVisible(id: string) {
  return (state: PreferencesState) => state.baseImageHidden[id] !== true;
}

/** Base-image opacity 0..1 (defaults to 1 when never set). */
export function selectBaseImageOpacity(id: string) {
  return (state: PreferencesState) => state.baseImageOpacity[id] ?? 1;
}

/** Cells-RE layer visibility (defaults to visible when never toggled). The
 *  same selector covers real `LayerType` keys plus the two virtual groups
 *  (`_inferred`, `_dieViewer`) shown in the visibility list. */
export function selectReLayerVisible(key: LayerType | "_inferred" | "_dieViewer") {
  return (state: PreferencesState) => state.reLayerHidden[key] !== true;
}
