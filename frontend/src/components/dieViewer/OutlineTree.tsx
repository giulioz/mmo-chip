import { COLOR_ML_CELL } from "../../renderer/annotations/cellDetections";
import { useMemo } from "react";
import type { DieAnnotations } from "shared";
import { Ic } from "../../icons";
import {
  CELL_COLOR_OPTIONS,
  NET_COLOR_OPTIONS,
  NET_MAX_WIDTH,
  NET_MIN_WIDTH
} from "../../renderer/annotations/dieAnnotations";
import {
  VIA_MAX_SIZE,
  VIA_MIN_SIZE
} from "../../renderer/annotations/style";
import { ColorSwatches, SettingsPopover } from "./SettingsPopover";
import {
  ANNOTATION_KIND_VALUES,
  type AnnotationKind
} from "../../state/annotationKinds";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import { TreeRow, TreeSep } from "../tree/TreeRow";
import { OtherDieBadge } from "../cellLibrary/OtherDieBadge";

// Re-export so existing imports keep working.
export { ANNOTATION_KIND_VALUES as ANNOTATION_KINDS };
export type { AnnotationKind };

type Props = {
  annotations: DieAnnotations | undefined;
  /** Frame these annotation ids in the viewport — fired on row double-click. */
  onFocus?: (ids: string[]) => void;
  /** Base (die background) images. One per die today; the data model will
   *  grow to multiple later. Each gets independent visibility + opacity. */
  baseImages?: { id: string; name: string }[];
  /** Cell types owned by another die of the cell library → that die's
   *  name (badged in the cell list). */
  foreignTypeOwners?: ReadonlyMap<string, string>;
};

/** Session-group key for the "ML Regions" parent (it spans two annotation
 *  kinds, so it can't key off a single AnnotationKind like other sections). */
const ML_REGIONS_KEY = "ml-regions";
const ML_KINDS: AnnotationKind[] = ["roi", "ignore"];
/** Session-group key for the "ML Results" section (live ML predictions —
 *  fetched per tile, not persisted, so not an AnnotationKind). */
const ML_RESULTS_KEY = "ml-results";
/** Session-group key for the "Guides" section (not an AnnotationKind — guides
 *  render via their own overlay, not the rbush layer). */
const GUIDES_KEY = "guides";
/** Session-group key for the "Base Images" section (die background images;
 *  not an AnnotationKind — they render via the image layer, not rbush). */
const BASE_IMAGES_KEY = "base-images";

export function OutlineTree({
  annotations,
  onFocus,
  baseImages = [],
  foreignTypeOwners
}: Props) {
  const expandedSections = usePreferences((s) => s.expandedSections);
  const hiddenKinds = usePreferences((s) => s.hiddenKinds);
  const toggleSection = usePreferences((s) => s.toggleSectionExpanded);
  const toggleKindVisibility = usePreferences((s) => s.toggleKindVisibility);

  const guidesHidden = usePreferences((s) => s.guidesHidden);
  const setGuidesHidden = usePreferences((s) => s.setGuidesHidden);
  const guidesLocked = usePreferences((s) => s.guidesLocked);
  const setGuidesLocked = usePreferences((s) => s.setGuidesLocked);

  const baseImageHidden = usePreferences((s) => s.baseImageHidden);
  const setBaseImageHidden = usePreferences((s) => s.setBaseImageHidden);

  const mlResultsHidden = usePreferences((s) => s.mlResultsHidden);
  const setMlResultsHidden = usePreferences((s) => s.setMlResultsHidden);

  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const select = useDieViewerStore((s) => s.select);
  const expandedGroups = useDieViewerStore((s) => s.expandedGroups);
  const toggleGroup = useDieViewerStore((s) => s.toggleGroup);
  const mlViasCount = useDieViewerStore((s) => s.mlViasCount);
  const cellDetectionsCount = useDieViewerStore((s) => s.cellDetectionsCount);
  const cellDetectionsHidden = usePreferences((s) => s.cellDetectionsHidden);
  const setCellDetectionsHidden = usePreferences((s) => s.setCellDetectionsHidden);
  const wireMapAvailable = useDieViewerStore((s) => s.wireMapAvailable);
  const wireMapHidden = usePreferences((s) => s.wireMapHidden);
  const setWireMapHidden = usePreferences((s) => s.setWireMapHidden);

  const cellsByType = useMemo(() => groupCellsByType(annotations), [annotations]);
  const viaTotals = useMemo(() => viaCounts(annotations), [annotations]);

  if (!annotations) {
    return (
      <div className="m" style={{ padding: "12px 10px", color: "var(--ink3)", fontSize: 10.5 }}>
        loading annotations…
      </div>
    );
  }

  const isOpen = (k: AnnotationKind) => expandedSections.includes(k);
  const visibilityFor = (k: AnnotationKind) => ({
    visible: !hiddenKinds.includes(k),
    onToggle: () => toggleKindVisibility(k)
  });

  // "ML Regions" is one collapsible parent over both ML kinds. Its eye toggles
  // ROIs + ignore-rects together (no independent per-subcategory hiding).
  const mlOpen = expandedGroups.includes(ML_REGIONS_KEY);
  const mlResultsOpen = expandedGroups.includes(ML_RESULTS_KEY);
  const guidesOpen = expandedGroups.includes(GUIDES_KEY);
  const baseImagesOpen = expandedGroups.includes(BASE_IMAGES_KEY);
  const mlAnyVisible = ML_KINDS.some((k) => !hiddenKinds.includes(k));
  const mlVisibility = {
    visible: mlAnyVisible,
    onToggle: () => {
      const target = !mlAnyVisible;
      for (const k of ML_KINDS) {
        if (!hiddenKinds.includes(k) !== target) toggleKindVisibility(k);
      }
    }
  };

  // Annotation ids per category, for double-click "frame in viewport". Cheap
  // to recompute; double-click is rare.
  const netIdsAll = annotations.nets.map((n) => `net:${n.id}`);
  const cellIdsAll = annotations.cells.map((c) => `cell:${c.id}`);
  const anns = annotations.annotations ?? [];
  const pointViaIds = anns
    .filter((a) => a.class === "point_via")
    .map((a) => `anno:${a.id}`);
  const irregularViaIds = anns
    .filter((a) => a.class === "irregular_via")
    .map((a) => `anno:${a.id}`);
  const viaIdsAll = [...pointViaIds, ...irregularViaIds];
  const pinIdsAll = (annotations.pins ?? []).map((p) => `pin:${p.id}`);
  const roiIdsAll = (annotations.rois ?? []).map((r) => `roi:${r.id}`);
  const ignoreIdsAll = (annotations.ignores ?? []).map((r) => `ignore:${r.id}`);
  const focus = (ids: string[]) => {
    if (ids.length) onFocus?.(ids);
  };

  return (
    <div className="tree" style={{ overflow: "auto", flex: "1 1 auto", minHeight: 0 }}>
      {/* Nets ------------------------------------------------------------ */}
      <TreeRow
        expand={isOpen("net") ? "open" : "closed"}
        label="Nets"
        meta={annotations.nets.length}
        controls={<NetSettingsButton />}
        visibility={visibilityFor("net")}
        onToggleExpand={() => toggleSection("net")}
        onSelect={() => toggleSection("net")}
        onDoubleClick={() => focus(netIdsAll)}
      />
      {isOpen("net") &&
        annotations.nets.map((net) => {
          const id = `net:${net.id}`;
          return (
            <TreeRow
              key={id}
              depth={1}
              icon={Ic.wire}
              label={net.name || net.id}
              meta={`${net.edges.length} edges`}
              selected={selectedIds.has(id)}
              onSelect={() => select([id])}
              onDoubleClick={() => focus([id])}
            />
          );
        })}

      <TreeSep />

      {/* Cells ----------------------------------------------------------- */}
      <TreeRow
        expand={isOpen("cell") ? "open" : "closed"}
        label="Cells"
        meta={annotations.cells.length}
        controls={<CellSettingsButton />}
        visibility={visibilityFor("cell")}
        onToggleExpand={() => toggleSection("cell")}
        onSelect={() => toggleSection("cell")}
        onDoubleClick={() => focus(cellIdsAll)}
      />
      {isOpen("cell") &&
        cellsByType.map((group) => {
          const groupKey = `cellType:${group.cellType.id}`;
          const open = expandedGroups.includes(groupKey);
          return (
            <div key={groupKey}>
              <TreeRow
                depth={1}
                expand={open ? "open" : "closed"}
                label={
                  foreignTypeOwners?.has(group.cellType.id) ? (
                    <>
                      {group.cellType.name || group.cellType.id}
                      <OtherDieBadge owner={foreignTypeOwners.get(group.cellType.id)!} />
                    </>
                  ) : (
                    group.cellType.name || group.cellType.id
                  )
                }
                meta={group.cells.length}
                selected={selectedIds.has(groupKey)}
                onToggleExpand={() => toggleGroup(groupKey)}
                // Select the type together with every placed instance: the
                // canvas highlights them all, Delete removes them all (and
                // the then-empty type), and the inspector keeps showing the
                // type because the selection is "one type + only its cells".
                onSelect={() =>
                  select([groupKey, ...group.cells.map((c) => `cell:${c.id}`)])
                }
                onDoubleClick={() =>
                  focus(group.cells.map((c) => `cell:${c.id}`))
                }
              />
              {open &&
                group.cells.map((cell) => {
                  const id = `cell:${cell.id}`;
                  return (
                    <TreeRow
                      key={id}
                      depth={2}
                      icon={Ic.cell}
                      monoLabel
                      label={cell.id}
                      selected={selectedIds.has(id)}
                      onSelect={() => select([id])}
                      onDoubleClick={() => focus([id])}
                    />
                  );
                })}
            </div>
          );
        })}

      <TreeSep />

      {/* Vias (ML annotations) ------------------------------------------ */}
      <TreeRow
        expand={isOpen("via") ? "open" : "closed"}
        label="Vias"
        meta={viaTotals.total}
        controls={<ViaSettingsButton />}
        visibility={visibilityFor("via")}
        onToggleExpand={() => toggleSection("via")}
        onSelect={() => toggleSection("via")}
        onDoubleClick={() => focus(viaIdsAll)}
      />
      {isOpen("via") && (
        <>
          <TreeRow
            depth={1}
            swatch="rgba(130, 214, 166, 0.85)"
            label="point vias"
            meta={viaTotals.points}
            onDoubleClick={() => focus(pointViaIds)}
          />
          <TreeRow
            depth={1}
            swatch="rgba(130, 214, 166, 0.5)"
            label="irregular vias"
            meta={viaTotals.irregular}
            onDoubleClick={() => focus(irregularViaIds)}
          />
        </>
      )}

      <TreeSep />

      {/* I/O pins -------------------------------------------------------- */}
      <TreeRow
        expand={isOpen("pin") ? "open" : "closed"}
        label="I/O pins"
        meta={annotations.pins?.length ?? 0}
        visibility={visibilityFor("pin")}
        onToggleExpand={() => toggleSection("pin")}
        onSelect={() => toggleSection("pin")}
        onDoubleClick={() => focus(pinIdsAll)}
      />
      {isOpen("pin") &&
        annotations.pins?.map((pin) => {
          const id = `pin:${pin.id}`;
          return (
            <TreeRow
              key={id}
              depth={1}
              icon={Ic.ioPoint}
              label={pin.name || `pin ${pin.pin}`}
              meta={`#${pin.pin}`}
              selected={selectedIds.has(id)}
              onSelect={() => select([id])}
              onDoubleClick={() => focus([id])}
            />
          );
        })}

      <TreeSep />

      {/* ML Regions (ROIs + ignore rects) -------------------------------- */}
      <TreeRow
        expand={mlOpen ? "open" : "closed"}
        label="ML Regions"
        meta={(annotations.rois?.length ?? 0) + (annotations.ignores?.length ?? 0)}
        visibility={mlVisibility}
        onToggleExpand={() => toggleGroup(ML_REGIONS_KEY)}
        onSelect={() => toggleGroup(ML_REGIONS_KEY)}
        onDoubleClick={() => focus([...roiIdsAll, ...ignoreIdsAll])}
      />
      {mlOpen && (
        <>
          <TreeRow
            depth={1}
            expand={isOpen("roi") ? "open" : "closed"}
            label="ML Training ROIs"
            meta={annotations.rois?.length ?? 0}
            onToggleExpand={() => toggleSection("roi")}
            onSelect={() => toggleSection("roi")}
            onDoubleClick={() => focus(roiIdsAll)}
          />
          {isOpen("roi") &&
            annotations.rois?.map((roi, idx) => {
              const id = `roi:${roi.id}`;
              return (
                <TreeRow
                  key={id}
                  depth={2}
                  icon={Ic.roi}
                  label={`ROI · ${idx + 1}`}
                  meta={`${roi.width}×${roi.height}`}
                  selected={selectedIds.has(id)}
                  onSelect={() => select([id])}
                  onDoubleClick={() => focus([id])}
                />
              );
            })}

          <TreeRow
            depth={1}
            expand={isOpen("ignore") ? "open" : "closed"}
            label="Ignore rects"
            meta={annotations.ignores?.length ?? 0}
            onToggleExpand={() => toggleSection("ignore")}
            onSelect={() => toggleSection("ignore")}
            onDoubleClick={() => focus(ignoreIdsAll)}
          />
          {isOpen("ignore") &&
            annotations.ignores?.map((r, idx) => {
              const id = `ignore:${r.id}`;
              return (
                <TreeRow
                  key={id}
                  depth={2}
                  icon={Ic.mlIgnore}
                  label={`region ${idx + 1}`}
                  meta={`${r.width}×${r.height}`}
                  selected={selectedIds.has(id)}
                  onSelect={() => select([id])}
                  onDoubleClick={() => focus([id])}
                />
              );
            })}
        </>
      )}

      <TreeSep />

      {/* ML Results (live predictions, fetched per tile) ----------------- */}
      {/* The parent eye works like ML Regions: it hides both overlays when
          either is showing, and shows both when both are hidden. Each child
          row has its own eye for independent control. */}
      <TreeRow
        expand={mlResultsOpen ? "open" : "closed"}
        label="ML Results"
        meta={mlViasCount + cellDetectionsCount}
        visibility={{
          visible:
            !mlResultsHidden || !cellDetectionsHidden || (wireMapAvailable && !wireMapHidden),
          onToggle: () => {
            const hide =
              !mlResultsHidden || !cellDetectionsHidden || (wireMapAvailable && !wireMapHidden);
            setMlResultsHidden(hide);
            setCellDetectionsHidden(hide);
            if (wireMapAvailable) setWireMapHidden(hide);
          }
        }}
        onToggleExpand={() => toggleGroup(ML_RESULTS_KEY)}
        onSelect={() => toggleGroup(ML_RESULTS_KEY)}
      />
      {mlResultsOpen && (
        <>
          <TreeRow
            depth={1}
            swatch="rgba(130, 214, 166, 0.85)"
            label="vias"
            meta={mlViasCount}
            visibility={{
              visible: !mlResultsHidden,
              onToggle: () => setMlResultsHidden(!mlResultsHidden)
            }}
          />
          <TreeRow
            depth={1}
            swatch={COLOR_ML_CELL}
            label="cells"
            meta={cellDetectionsCount}
            visibility={{
              visible: !cellDetectionsHidden,
              onToggle: () => setCellDetectionsHidden(!cellDetectionsHidden)
            }}
          />
          <TreeRow
            depth={1}
            swatch="rgb(255, 60, 0)"
            label="wires over cells"
            meta={wireMapAvailable ? "map" : "—"}
            dimmed={!wireMapAvailable}
            visibility={
              wireMapAvailable
                ? { visible: !wireMapHidden, onToggle: () => setWireMapHidden(!wireMapHidden) }
                : undefined
            }
          />
        </>
      )}

      <TreeSep />

      {/* Cell-grid guides ------------------------------------------------ */}
      <TreeRow
        expand={guidesOpen ? "open" : "closed"}
        label="Guides"
        meta={annotations.guides?.length ?? 0}
        controls={
          <button
            type="button"
            className="trow-eye"
            title={guidesLocked ? "Unlock guides" : "Lock guides"}
            aria-pressed={guidesLocked}
            onClick={() => setGuidesLocked(!guidesLocked)}
            style={{
              display: "inline-flex",
              background: "transparent",
              border: 0,
              padding: 0,
              cursor: "pointer",
              color: guidesLocked ? "var(--accent)" : "var(--ink3)"
            }}
          >
            {Ic.lock}
          </button>
        }
        visibility={{
          visible: !guidesHidden,
          onToggle: () => setGuidesHidden(!guidesHidden)
        }}
        onToggleExpand={() => toggleGroup(GUIDES_KEY)}
        onSelect={() => toggleGroup(GUIDES_KEY)}
      />
      {guidesOpen &&
        annotations.guides?.map((g) => {
          const id = `guide:${g.id}`;
          const label =
            g.kind === "line"
              ? `${g.axis === "x" ? "vertical" : "horizontal"} @ ${g.pos}`
              : `segment (${g.x1},${g.y1})→(${g.x2},${g.y2})`;
          return (
            <TreeRow
              key={id}
              depth={1}
              icon={g.kind === "line" ? Ic.gridLine : Ic.gridSeg}
              label={label}
              dimmed={guidesLocked}
              selected={selectedIds.has(id)}
              onSelect={guidesLocked ? undefined : () => select([id])}
            />
          );
        })}

      <TreeSep />

      {/* Base images ---------------------------------------------------- */}
      <TreeRow
        expand={baseImagesOpen ? "open" : "closed"}
        label="Base Images"
        meta={baseImages.length}
        onToggleExpand={() => toggleGroup(BASE_IMAGES_KEY)}
        onSelect={() => toggleGroup(BASE_IMAGES_KEY)}
      />
      {baseImagesOpen &&
        baseImages.map((img) => {
          const visible = baseImageHidden[img.id] !== true;
          return (
            <TreeRow
              key={`baseimg:${img.id}`}
              depth={1}
              icon={Ic.image}
              label={img.name || img.id}
              controls={<BaseImageSettings id={img.id} />}
              visibility={{
                visible,
                onToggle: () => setBaseImageHidden(img.id, visible)
              }}
            />
          );
        })}
    </div>
  );
}

/** Per-base-image opacity slider (visibility is the row's eye). */
function BaseImageSettings({ id }: { id: string }) {
  const opacity = usePreferences((s) => s.baseImageOpacity[id] ?? 1);
  const setOpacity = usePreferences((s) => s.setBaseImageOpacity);
  const pct = Math.round(opacity * 100);
  return (
    <SettingsPopover label="Base image settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Opacity
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pct}
          onChange={(e) => setOpacity(id, Number(e.target.value) / 100)}
        />
        <span
          className="m"
          style={{
            width: 36,
            color: "var(--ink2)",
            fontSize: 11,
            textAlign: "right"
          }}
        >
          {pct}%
        </span>
      </div>
    </SettingsPopover>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function groupCellsByType(annotations: DieAnnotations | undefined) {
  if (!annotations) return [];
  const byType = new Map<string, typeof annotations.cells>();
  for (const cell of annotations.cells) {
    const list = byType.get(cell.cellTypeId);
    if (list) list.push(cell);
    else byType.set(cell.cellTypeId, [cell]);
  }
  return annotations.cellTypes
    .map((cellType) => ({ cellType, cells: byType.get(cellType.id) ?? [] }))
    .filter((g) => g.cells.length > 0)
    .sort((a, b) => b.cells.length - a.cells.length);
}

function viaCounts(annotations: DieAnnotations | undefined) {
  let points = 0;
  let irregular = 0;
  for (const a of annotations?.annotations ?? []) {
    if (a.class === "point_via") points++;
    else if (a.class === "irregular_via") irregular++;
  }
  return { points, irregular, total: points + irregular };
}

// ── Settings popovers ───────────────────────────────────────────────

function NetSettingsButton() {
  const width = usePreferences((s) => s.netWidth);
  const setNetWidth = usePreferences((s) => s.setNetWidth);
  const netColor = usePreferences((s) => s.netColor);
  const setNetColor = usePreferences((s) => s.setNetColor);

  return (
    <SettingsPopover label="Net settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Net wire width
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={NET_MIN_WIDTH}
          max={NET_MAX_WIDTH}
          step={0.1}
          value={width}
          onChange={(e) => setNetWidth(Number(e.target.value))}
        />
        <span
          className="m"
          style={{ width: 36, color: "var(--ink2)", fontSize: 11, textAlign: "right" }}
        >
          {width.toFixed(1)}
        </span>
      </div>

      <div className="u" style={{ margin: "12px 0 8px" }}>
        Net wire color
      </div>
      <ColorSwatches options={NET_COLOR_OPTIONS} value={netColor} onPick={setNetColor} />
    </SettingsPopover>
  );
}

function ViaSettingsButton() {
  const viaSize = usePreferences((s) => s.viaSize);
  const setViaSize = usePreferences((s) => s.setViaSize);
  return (
    <SettingsPopover label="Via settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Via radius
      </div>
      <div className="row" style={{ gap: 10 }}>
        <input
          type="range"
          min={VIA_MIN_SIZE}
          max={VIA_MAX_SIZE}
          step={0.5}
          value={viaSize}
          onChange={(e) => setViaSize(Number(e.target.value))}
        />
        <span
          className="m"
          style={{ width: 36, color: "var(--ink2)", fontSize: 11, textAlign: "right" }}
        >
          {viaSize.toFixed(1)}
        </span>
      </div>
    </SettingsPopover>
  );
}

function CellSettingsButton() {
  const cellColor = usePreferences((s) => s.cellColor);
  const setCellColor = usePreferences((s) => s.setCellColor);
  const cellShowShapes = usePreferences((s) => s.cellShowShapes);
  const setCellShowShapes = usePreferences((s) => s.setCellShowShapes);

  return (
    <SettingsPopover label="Cell settings">
      <div className="u" style={{ marginBottom: 8 }}>
        Cell color
      </div>
      <ColorSwatches options={CELL_COLOR_OPTIONS} value={cellColor} onPick={setCellColor} />

      <label className="check" style={{ marginTop: 12 }}>
        <input
          type="checkbox"
          checked={cellShowShapes}
          onChange={(e) => setCellShowShapes(e.target.checked)}
        />
        Show cell details
      </label>
    </SettingsPopover>
  );
}
