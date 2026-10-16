import { Fragment, type ReactNode } from "react";
import { Ic } from "../../icons";
import { useLiveValue } from "../../lib/liveValue";
import type { LibraryCellTool } from "./useLibraryCellTool";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import { ToolDivider } from "../shell/SubBar";
import { AnnotationClassSelect } from "./AnnotationClassSelect";
import { BigToolDivider, Tool } from "./DieViewerUI";
import { WireLayerSelect } from "./WireLayerSelect";

/** One toolbar entry: either a real, selectable tool (`kind`) or a not-yet-
 *  built placeholder (`todo`) rendered disabled. */
type ToolItem =
  | { kind: ToolKind; icon: ReactNode; label: string }
  | { todo: true; icon: ReactNode; label: string };

interface ToolGroup {
  /** Lowercase tag rendered before the group (omit for the unlabeled
   *  navigation cluster). */
  label?: string;
  items: ToolItem[];
}

/** Ordered groups; a thin divider renders between groups. Cells come before
 *  vias so the related "draw a shape" tools cluster early in the bar. */
const TOOL_GROUPS: ToolGroup[] = [
  {
    items: [
      { kind: "select", icon: Ic.cursor, label: "Select / marquee" },
      { kind: "pan", icon: Ic.pan, label: "Pan / zoom — hold Space or middle-drag" }
    ]
  },
  {
    label: "wires",
    items: [
      { kind: "wire", icon: Ic.wire, label: "Draw wire" },
      { kind: "multiWire", icon: Ic.multiWire, label: "Draw multi-wire" }
    ]
  },
  {
    label: "cells",
    items: [
      { kind: "addCell", icon: Ic.cellRect, label: "Draw cell rectangle" },
      { kind: "cellGuideLine", icon: Ic.gridLine, label: "Draw cell-grid guide line" },
      { kind: "cellGuideSeg", icon: Ic.gridSeg, label: "Draw cell-grid guide segment" },
      { kind: "ioPoint", icon: Ic.ioPoint, label: "Place I/O point" },
      {
        kind: "libraryCell",
        icon: Ic.libraryCell,
        label: "Place library cell — fit another die's cell over one here; sets the die's scale"
      }
    ]
  },
  {
    label: "vias",
    items: [
      { kind: "via", icon: Ic.viaPoint, label: "Place via point" },
      { kind: "viaRect", icon: Ic.viaRect, label: "Draw via rectangle" },
      { kind: "viaPoly", icon: Ic.viaPolygon, label: "Draw via polygon" }
    ]
  },
  {
    label: "ml",
    items: [
      { kind: "roi", icon: Ic.roi, label: "Draw ML ROI rectangle" },
      { kind: "ignore", icon: Ic.mlIgnore, label: "Draw ML ignore rectangle" }
    ]
  }
];

/**
 * The die-viewer's left/centre toolbar: grouped tool buttons, then (only when
 * the active tool actually has options) a stronger divider followed by that
 * tool's controls.
 */
export function DieToolbar({
  activeTool,
  setActiveTool,
  multiWireHint,
  libraryCell
}: {
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
  /** Phase-aware help line for the multi-wire tool (kept short to save
   *  toolbar space; changes as the tool moves through its stages). */
  multiWireHint?: string;
  /** The "Place library cell" tool's state and controls. */
  libraryCell?: LibraryCellTool;
}) {
  const options = toolOptions(activeTool, multiWireHint, libraryCell);
  return (
    <>
      {TOOL_GROUPS.map((group, gi) => (
        <Fragment key={gi}>
          {gi > 0 && <ToolDivider />}
          {group.label && (
            <span
              className="u"
              style={{ fontSize: 10, color: "var(--ink3)", margin: "0 4px 0 2px" }}
            >
              {group.label}
            </span>
          )}
          {group.items.map((item, ii) =>
            "kind" in item ? (
              <Tool
                key={item.kind}
                icon={item.icon}
                label={item.label}
                on={activeTool === item.kind}
                onClick={() => setActiveTool(item.kind)}
              />
            ) : (
              <Tool
                key={`todo-${gi}-${ii}`}
                icon={item.icon}
                label={item.label}
                todo
              />
            )
          )}
        </Fragment>
      ))}
      {options && (
        <>
          <BigToolDivider />
          <div
            className="row"
            style={{ alignItems: "center", gap: 10, minWidth: 0 }}
          >
            {options}
          </div>
        </>
      )}
    </>
  );
}

/** The active tool's inline options, or null when it has none. Each tool's
 *  controls will grow here as later phases land. */
function toolOptions(
  tool: ToolKind,
  multiWireHint?: string,
  libraryCell?: LibraryCellTool
): ReactNode {
  if (tool === "libraryCell" && libraryCell) return <LibraryCellOptions tool={libraryCell} />;
  if (tool === "wire") return <WireOptions />;
  if (tool === "multiWire") return <WireOptions hint={multiWireHint} />;
  if (tool === "addCell") return <CellOptions />;
  if (tool === "roi") return <RoiOptions />;
  if (tool === "cellGuideLine") return <GuideLineOptions />;
  // others (incl. cellGuideSeg) have no options.
  return null;
}

const OPTION_SELECT_STYLE: React.CSSProperties = {
  maxWidth: 280,
  minWidth: 0,
  background: "var(--panel)",
  color: "var(--ink)",
  border: "1px solid var(--l1)",
  borderRadius: 4,
  padding: "2px 6px",
  fontSize: 11,
  fontFamily: "var(--mono)"
};

/** Pick a library cell (biggest first), turn / flip the template, accept. */
function LibraryCellOptions({ tool }: { tool: LibraryCellTool }) {
  const draft = useLiveValue(tool.draftLive);
  const hint = (text: string) => (
    <span className="m" style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}>
      {text}
    </span>
  );
  if (!tool.libraryName) {
    return hint("Set a cell library in the die properties first (Inspector, nothing selected)");
  }
  if (tool.types.length === 0) {
    return hint(`No matched cell types on the other dies of ${tool.libraryName} yet`);
  }
  const owners = new Set(tool.types.map((f) => f.ownerDieId));
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Cell
      </span>
      <select
        value={tool.chosen?.type.id ?? ""}
        onChange={(e) => tool.choose(e.target.value || null)}
        style={OPTION_SELECT_STYLE}
      >
        <option value="">pick a library cell…</option>
        {tool.types.map((f) => (
          <option key={f.type.id} value={f.type.id} title={`from ${f.ownerName}`}>
            {f.type.name} · {Math.round(f.scaled.cropRect.width)}×{Math.round(f.scaled.cropRect.height)}
            {owners.size > 1 ? ` · ${f.ownerName}` : ""}
          </option>
        ))}
      </select>
      <span className="row" style={{ gap: 2 }}>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Rotate 90° counter-clockwise"
          onClick={() => tool.orient("rotateCcw")}
        >
          {Ic.rotateCcw}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Rotate 90° clockwise"
          onClick={() => tool.orient("rotateCw")}
        >
          {Ic.rotateCw}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Flip horizontally"
          onClick={() => tool.orient("flipH")}
        >
          {Ic.flipH}
        </button>
        <button
          type="button"
          className="btn ghost"
          disabled={!draft}
          title="Flip vertically"
          onClick={() => tool.orient("flipV")}
        >
          {Ic.flipV}
        </button>
      </span>
      <label className="check" title="Show the cell's pixels (from its own die) under its annotations">
        <input
          type="checkbox"
          checked={tool.showImage}
          onChange={(e) => tool.setShowImage(e.target.checked)}
        />
        Image
      </label>
      {draft && (
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink2)" }}
          title="This die's pixels per pixel of the cell's own die"
        >
          ×{draft.k.toFixed(4)}
        </span>
      )}
      <button
        type="button"
        className="btn accent"
        disabled={!draft || tool.busy}
        title="Place the cell here and set this die's scale from the fit (Enter)"
        onClick={() => void tool.accept()}
      >
        {Ic.check} Accept
      </button>
      {tool.error
        ? <span className="m" style={{ fontSize: 10.5, color: "var(--err)" }}>{tool.error}</span>
        : !draft && tool.chosen && hint("click the die to put the template there")}
    </>
  );
}

function GuideLineOptions() {
  const axis = useDieViewerStore((s) => s.guideAxis);
  const setAxis = useDieViewerStore((s) => s.setGuideAxis);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Orientation
      </span>
      <span className="row" style={{ gap: 4 }}>
        {(
          [
            ["x", "vertical"],
            ["y", "horizontal"]
          ] as const
        ).map(([a, label]) => (
          <button
            key={a}
            type="button"
            className={"chip" + (axis === a ? " on" : "")}
            style={{ cursor: "pointer" }}
            onClick={() => setAxis(a)}
          >
            {label}
          </button>
        ))}
      </span>
    </>
  );
}

function RoiOptions() {
  const roiClasses = usePreferences((s) => s.roiClasses);
  const setRoiClasses = usePreferences((s) => s.setRoiClasses);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        ROI labels
      </span>
      <AnnotationClassSelect value={roiClasses} onChange={setRoiClasses} />
    </>
  );
}

function WireOptions({ hint }: { hint?: string }) {
  const wireLayer = useDieViewerStore((s) => s.wireLayer);
  const setWireLayer = useDieViewerStore((s) => s.setWireLayer);
  const snapToVias = usePreferences((s) => s.snapToVias);
  const setSnapToVias = usePreferences((s) => s.setSnapToVias);
  const autoEndOnVia = usePreferences((s) => s.wireAutoEndOnVia);
  const setAutoEndOnVia = usePreferences((s) => s.setWireAutoEndOnVia);
  return (
    <>
      <span className="u" style={{ fontSize: 10 }}>
        Layer
      </span>
      <WireLayerSelect value={wireLayer} onChange={setWireLayer} />
      <label
        className="check"
        title="Snap click positions to the nearest via (ML or manually placed)"
      >
        <input
          type="checkbox"
          checked={snapToVias}
          onChange={(e) => setSnapToVias(e.target.checked)}
        />
        Snap to vias
      </label>
      <label
        className="check"
        title="Snap the next point onto any via the projected wire passes through. Single wire keeps drafting from the via so you can chain more segments; multi-wire locks each wire on its own via and commits when all are locked."
      >
        <input
          type="checkbox"
          checked={autoEndOnVia}
          onChange={(e) => setAutoEndOnVia(e.target.checked)}
        />
        Auto-end on via
      </label>
      {hint && (
        <span
          className="m"
          style={{ fontSize: 10.5, color: "var(--ink3)", fontStyle: "italic" }}
        >
          {hint}
        </span>
      )}
    </>
  );
}

function CellOptions() {
  const snap = usePreferences((s) => s.cellSnapToGuides);
  const setSnap = usePreferences((s) => s.setCellSnapToGuides);
  return (
    <label className="check">
      <input
        type="checkbox"
        checked={snap}
        onChange={(e) => setSnap(e.target.checked)}
      />
      Snap to guides
    </label>
  );
}

/** Placeholder errors/warnings chip. Wires to a real validation pass later;
 *  for now it always reads zero so the slot/position is locked in. */
export function IssuesChip({
  errors = 0,
  warnings = 0
}: {
  errors?: number;
  warnings?: number;
}) {
  const tone = errors > 0 ? "err" : warnings > 0 ? "warn" : "";
  return (
    <span
      className={"chip" + (tone ? ` ${tone}` : "")}
      title={`${errors} error${errors === 1 ? "" : "s"}, ${warnings} warning${
        warnings === 1 ? "" : "s"
      }`}
    >
      {Ic.mlExclude}
      {errors} / {warnings}
    </span>
  );
}
