import { useCallback, useEffect, useMemo, useRef, type ReactNode } from "react";
import type { Cell, CellType, DieAnnotations, LayerType } from "shared";
import { TreeRow, TreeSep } from "../tree/TreeRow";
import { OtherDieBadge } from "../cellLibrary/OtherDieBadge";
import type { ForeignType, RemoteInstance } from "../../lib/cellLibrary";
import { Ic } from "../../icons";
import {
  selectReLayerVisible,
  usePreferences
} from "../../state/preferences";
import {
  LAYER_LONG,
  useCellREStore
} from "../../state/cellRE";
import {
  cellTypeById,
  groupCellTypes,
  membersOf
} from "../../lib/mergeCells";
import { COLOR_LAYER, COLOR_VIA, NET_COLOR } from "../../renderer/annotations/style";

interface Props {
  annotations: DieAnnotations;
  /** Types owned by another die of the cell library (badged, listed after
   *  this die's own). */
  foreignTypes?: ReadonlyMap<string, ForeignType>;
  /** A type's instances on the library's other dies — listed after this
   *  die's own, badged. */
  remoteMembersOf?: (cellTypeId: string) => RemoteInstance[];
  /** `dieId` is set for an instance on another die. */
  onCellContextMenu: (cell: Cell, clientX: number, clientY: number, dieId?: string) => void;
  onCellTypeContextMenu: (
    cellType: CellType,
    clientX: number,
    clientY: number
  ) => void;
}

const SHAPE_LAYERS: LayerType[] = ["diffusion", "polysilicon", "metal1", "metal2"];
const VIA_LAYERS: LayerType[] = ["contact", "via1"];
// Hitbox is editable too (drawn with the same tools as the shape layers) but
// it's an extraction artefact, not a real physical layer — keep it on its own
// row so the visual hierarchy reflects that.
const HITBOX_LAYERS: LayerType[] = ["wire_hitbox"];
const DV_OVERLAY_KEYS = ["_dvWires", "_dvVias"] as const;

/**
 * Every toggleable visibility key the panel knows about, in display order.
 * Drives the "solo on double-click" action so it can flip all the other keys
 * in one shot. Disabled rows (inferred / ML) aren't part of this set — they
 * have no togglable state to flip.
 */
const ALL_TOGGLEABLE_LAYER_KEYS: ReadonlyArray<string> = [
  ...SHAPE_LAYERS,
  ...VIA_LAYERS,
  ...HITBOX_LAYERS,
  ...DV_OVERLAY_KEYS,
];

/** Two-section left panel: cell-types tree on top (with the same "matched /
 *  unmatched / ML" grouping as merge-cells) and a layer-visibility list
 *  below. The visibility list also surfaces (disabled) the inferred
 *  transistors/nets group and the die-viewer overlay group as
 *  forward-looking placeholders. */
export function CellRELeftPanel({
  annotations,
  foreignTypes,
  remoteMembersOf,
  onCellContextMenu,
  onCellTypeContextMenu
}: Props) {
  const remoteOf = (id: string): RemoteInstance[] => remoteMembersOf?.(id) ?? [];
  const activeCellTypeId = useCellREStore((s) => s.activeCellTypeId);
  const activeCellId = useCellREStore((s) => s.activeCellId);
  const expandedTypes = useCellREStore((s) => s.expandedTypes);
  const unmatchedOpen = useCellREStore((s) => s.unmatchedOpen);
  const mlOpen = useCellREStore((s) => s.mlOpen);
  const inferredOpen = useCellREStore((s) => s.inferredOpen);
  const dieViewerLayersOpen = useCellREStore((s) => s.dieViewerLayersOpen);
  const setActiveCellType = useCellREStore((s) => s.setActiveCellType);
  const setActiveCell = useCellREStore((s) => s.setActiveCell);
  const toggleType = useCellREStore((s) => s.toggleType);
  const setUnmatchedOpen = useCellREStore((s) => s.setUnmatchedOpen);
  const setMlOpen = useCellREStore((s) => s.setMlOpen);
  const setInferredOpen = useCellREStore((s) => s.setInferredOpen);
  const setDieViewerLayersOpen = useCellREStore((s) => s.setDieViewerLayersOpen);

  // This die's own types first, then the ones shared from other dies.
  const { matched, unmatched, firstShared } = useMemo(() => {
    const g = groupCellTypes(annotations);
    const shared = (ct: CellType) => foreignTypes?.has(ct.id) === true;
    const matched = [...g.matched.filter((ct) => !shared(ct)), ...g.matched.filter(shared)];
    return { matched, unmatched: g.unmatched, firstShared: matched.findIndex(shared) };
  }, [annotations, foreignTypes]);
  const typeLabel = (ct: CellType): ReactNode => {
    const f = foreignTypes?.get(ct.id);
    return f ? (
      <>
        {ct.name}
        <OtherDieBadge owner={f.ownerName} />
      </>
    ) : (
      ct.name
    );
  };

  // ── Arrow-key navigation through the cell-types list ──────────────
  // Flat list of (cellTypeId, cellId|null) entries in the order they'd render
  // — used to step prev/next when the tree pane has focus. cellId is null on
  // the cell-type row itself; instance rows carry the cell id.
  const flat = useMemo(() => {
    const out: Array<{ ctId: string; cellId: string | null }> = [];
    for (const ct of matched) {
      out.push({ ctId: ct.id, cellId: null });
      if (expandedTypes.includes(ct.id)) {
        for (const m of membersOf(annotations, ct.id))
          out.push({ ctId: ct.id, cellId: m.id });
        for (const r of remoteMembersOf?.(ct.id) ?? [])
          out.push({ ctId: ct.id, cellId: r.cell.id });
      }
    }
    if (unmatchedOpen) {
      for (const ct of unmatched) out.push({ ctId: ct.id, cellId: null });
    }
    return out;
  }, [annotations, matched, unmatched, expandedTypes, unmatchedOpen, remoteMembersOf]);

  const treeRef = useRef<HTMLDivElement | null>(null);
  const step = useCallback(
    (delta: number) => {
      if (flat.length === 0) return;
      const idx = flat.findIndex(
        (e) => e.ctId === activeCellTypeId && e.cellId === activeCellId
      );
      const base =
        idx === -1
          ? delta > 0
            ? -1
            : flat.length
          : idx;
      const next = Math.min(flat.length - 1, Math.max(0, base + delta));
      const e = flat[next];
      if (e) {
        if (e.cellId == null) setActiveCellType(e.ctId, null);
        else if (e.ctId === activeCellTypeId) setActiveCell(e.cellId);
        else setActiveCellType(e.ctId, e.cellId);
      }
    },
    [flat, activeCellTypeId, activeCellId, setActiveCellType, setActiveCell]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Only steer if the focus is on this tree (or no actionable focus).
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable))
        return;
      // The tree-aware arrow handling only kicks in while the tree itself
      // (or a child) is focused; otherwise the canvas / page owns the keys.
      if (!treeRef.current || !treeRef.current.contains(document.activeElement)) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step]);

  return (
    <aside style={panelStyle}>
      {/* ── Cell types & instances ─────────────────────────────── */}
      <div className="ph">
        <span className="u">Cell Types & Instances</span>
        <span className="m" style={{ fontSize: 10, color: "var(--ink3)", marginLeft: "auto" }}>
          {matched.length + unmatched.length}
        </span>
      </div>
      <div
        ref={treeRef}
        tabIndex={0}
        style={{ overflow: "auto", flex: "1 1 55%", minHeight: 80, outline: "none" }}
      >
        {matched.map((ct, i) => {
          const open = expandedTypes.includes(ct.id);
          const members = membersOf(annotations, ct.id);
          const remote = remoteOf(ct.id);
          return (
            <div key={ct.id}>
              {i > 0 && i === firstShared && <TreeSep />}
              <div
                onContextMenu={(e) => {
                  e.preventDefault();
                  setActiveCellType(ct.id, null);
                  onCellTypeContextMenu(ct, e.clientX, e.clientY);
                }}
              >
                <TreeRow
                  icon={Ic.cell}
                  expand={members.length + remote.length ? (open ? "open" : "closed") : "leaf"}
                  label={typeLabel(ct)}
                  meta={remote.length ? `${members.length}+${remote.length}` : members.length}
                  monoLabel
                  selected={activeCellTypeId === ct.id && activeCellId == null}
                  onToggleExpand={() => toggleType(ct.id)}
                  onSelect={() => setActiveCellType(ct.id, null)}
                />
              </div>
              {open &&
                members.map((m) => (
                  <div
                    key={m.id}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setActiveCellType(ct.id, m.id);
                      onCellContextMenu(m, e.clientX, e.clientY);
                    }}
                  >
                    <TreeRow
                      depth={1}
                      icon={Ic.cell}
                      label={`cell ${m.id.slice(0, 6)}`}
                      monoLabel
                      selected={activeCellTypeId === ct.id && activeCellId === m.id}
                      onSelect={() => {
                        if (activeCellTypeId !== ct.id) setActiveCellType(ct.id, m.id);
                        else setActiveCell(m.id);
                      }}
                    />
                  </div>
                ))}
              {open &&
                // Instances on the library's other dies, after this die's own.
                remote.map((r) => (
                  <div
                    key={`${r.dieId}:${r.cell.id}`}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setActiveCellType(ct.id, r.cell.id);
                      onCellContextMenu(r.cell, e.clientX, e.clientY, r.dieId);
                    }}
                  >
                    <TreeRow
                      depth={1}
                      icon={Ic.cell}
                      label={
                        <>
                          {`cell ${r.cell.id.slice(0, 6)}`}
                          <OtherDieBadge owner={r.dieName} />
                        </>
                      }
                      monoLabel
                      dimmed
                      selected={activeCellTypeId === ct.id && activeCellId === r.cell.id}
                      onSelect={() => {
                        if (activeCellTypeId !== ct.id) setActiveCellType(ct.id, r.cell.id);
                        else setActiveCell(r.cell.id);
                      }}
                    />
                  </div>
                ))}
            </div>
          );
        })}

        <TreeSep />
        <TreeRow
          icon={Ic.cell}
          expand={unmatched.length ? (unmatchedOpen ? "open" : "closed") : "leaf"}
          label="Unmatched"
          meta={unmatched.length}
          dimmed
          onToggleExpand={() => setUnmatchedOpen(!unmatchedOpen)}
          onSelect={() => setUnmatchedOpen(!unmatchedOpen)}
        />
        {unmatchedOpen &&
          unmatched.map((ct) => (
            <div
              key={ct.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setActiveCellType(ct.id, null);
                onCellTypeContextMenu(ct, e.clientX, e.clientY);
              }}
            >
              <TreeRow
                depth={1}
                icon={Ic.cell}
                label={typeLabel(ct)}
                meta={membersOf(annotations, ct.id).length}
                monoLabel
                dimmed
                selected={activeCellTypeId === ct.id}
                onSelect={() => setActiveCellType(ct.id, null)}
              />
            </div>
          ))}

        <TreeRow
          icon={Ic.cell}
          expand={mlOpen ? "open" : "closed"}
          label="ML"
          meta={0}
          dimmed
          onToggleExpand={() => setMlOpen(!mlOpen)}
          onSelect={() => setMlOpen(!mlOpen)}
        />
        {mlOpen && (
          <div
            className="m"
            style={{ padding: "6px 16px", fontSize: 10, color: "var(--ink3)" }}
          >
            no ML-proposed cells yet
          </div>
        )}
      </div>

      <TreeSep />

      {/* ── Layer visibility ───────────────────────────────────── */}
      <div className="ph">
        <span className="u">Layers</span>
      </div>
      <div style={{ overflow: "auto", flex: "1 1 45%", minHeight: 120 }}>
        {/* Editable group: the cell layers the user actually draws on. */}
        {SHAPE_LAYERS.map((layer) => (
          <LayerRow key={layer} layer={layer} />
        ))}
        {VIA_LAYERS.map((layer) => (
          <LayerRow key={layer} layer={layer} />
        ))}
        {HITBOX_LAYERS.map((layer) => (
          <LayerRow key={layer} layer={layer} />
        ))}

        <TreeSep />
        <TreeRow
          icon={Ic.cell}
          expand={inferredOpen ? "open" : "closed"}
          label="Inferred"
          dimmed
          onToggleExpand={() => setInferredOpen(!inferredOpen)}
          onSelect={() => setInferredOpen(!inferredOpen)}
        />
        {inferredOpen && (
          <>
            <DisabledLayerRow label="Transistors" />
            <DisabledLayerRow label="Nets" />
            <DisabledLayerRow label="Diffusion regions" />
          </>
        )}

        <TreeRow
          icon={Ic.image}
          expand={dieViewerLayersOpen ? "open" : "closed"}
          label="From die viewer"
          dimmed
          onToggleExpand={() => setDieViewerLayersOpen(!dieViewerLayersOpen)}
          onSelect={() => setDieViewerLayersOpen(!dieViewerLayersOpen)}
        />
        {dieViewerLayersOpen && (
          <>
            {/* Wires + vias are drawn from the die viewer's data onto the
                RE canvas, clipped to the active cell's die rect. ML
                predictions need the cached prediction API plumbing first. */}
            <DvLayerRow label="Wires" swatch={NET_COLOR} prefKey="_dvWires" />
            <DvLayerRow label="Vias" swatch={COLOR_VIA} prefKey="_dvVias" />
            <DisabledLayerRow label="ML results" />
          </>
        )}
      </div>
    </aside>
  );
}

function LayerRow({ layer }: { layer: LayerType }) {
  const visible = usePreferences(selectReLayerVisible(layer));
  const setHidden = usePreferences((s) => s.setReLayerHidden);
  const solo = usePreferences((s) => s.soloReLayer);
  return (
    <TreeRow
      depth={0}
      swatch={COLOR_LAYER[layer]}
      label={LAYER_LONG[layer]}
      // Double-click "solos" this layer — hides every other toggleable layer
      // so the user can focus on a single shape stack without manually eye-
      // clicking through the rest. Double-clicking an already-soloed row
      // restores everything (see `soloReLayer`).
      onDoubleClick={() => solo(layer, ALL_TOGGLEABLE_LAYER_KEYS)}
      visibility={{
        visible,
        onToggle: () => setHidden(layer, visible)
      }}
    />
  );
}

/** A die-viewer overlay row — same shape as `LayerRow` but keyed by a virtual
 *  `_dv*` preference key (no `LayerType` of its own), and the swatch colour
 *  matches what the canvas paints for that overlay (NET_COLOR for wires,
 *  COLOR_VIA for vias) so the legend is self-explanatory. */
function DvLayerRow({
  label,
  swatch,
  prefKey
}: {
  label: string;
  swatch: string;
  prefKey: string;
}) {
  const hidden = usePreferences((s) => s.reLayerHidden[prefKey] === true);
  const setHidden = usePreferences((s) => s.setReLayerHidden);
  const solo = usePreferences((s) => s.soloReLayer);
  return (
    <TreeRow
      depth={0}
      swatch={swatch}
      label={label}
      onDoubleClick={() => solo(prefKey, ALL_TOGGLEABLE_LAYER_KEYS)}
      visibility={{
        visible: !hidden,
        onToggle: () => setHidden(prefKey, !hidden)
      }}
    />
  );
}

/** A row for a non-editable layer (inferred / die-viewer overlay) — surfaces
 *  the eye but it's disabled until the corresponding feature lands. */
function DisabledLayerRow({ label }: { label: string }) {
  return (
    <div className="trow" style={{ paddingLeft: 16, opacity: 0.45, cursor: "not-allowed" }}>
      <span style={{ width: 10 }} />
      <span style={{ width: 8, height: 8 }} />
      <span style={{ fontFamily: "var(--font)", fontSize: 11, flex: 1 }}>{label}</span>
      <span className="m" style={{ fontSize: 9, color: "var(--ink3)" }}>todo</span>
    </div>
  );
}

const panelStyle: React.CSSProperties = {
  width: 248,
  flex: "0 0 auto",
  background: "var(--card)",
  borderRight: "1px solid var(--l2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0
};
