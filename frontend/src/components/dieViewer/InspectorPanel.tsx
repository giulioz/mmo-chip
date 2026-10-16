import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DieAnnotations, DieMetadata, MLInferenceJob, WireLayer } from "shared";
import type { CellLibraryView } from "../../lib/cellLibrary";
import { DieProperties } from "./DieProperties";
import type { ActionDispatcher } from "../../api/actions";
import {
  exportMlData,
  mlJobKey,
  selectMLModel,
  startMLJob,
  stopMLJob,
  useMLJob,
  useMLModels,
  useMLStatus
} from "../../api/ml";
import { parseNetPartId } from "../../lib/netGraph";
import {
  isMlViaId,
  type MLViasLayer
} from "../../renderer/layers/MLViasLayer";
import { useDieViewerStore, type InspectorTab } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";
import { WireLayerSelect } from "./WireLayerSelect";
import { AnnotationClassSelect } from "./AnnotationClassSelect";
import { CellDetectionPanel, ProposalInspector } from "./CellDetectionPanel";
import { isMlCellId, type Proposal } from "../../lib/cellDetection";

const TAB_LABELS: Record<InspectorTab, string> = {
  inspector: "Inspector",
  ml: "ML",
  cells: "Cells"
};

/** A single labelled property row (`.prop` matches the hifi spec). */
function Prop({
  label,
  children
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="prop">
      <span className="lbl">{label}</span>
      <span className="val" style={{ minWidth: 0 }}>
        {children}
      </span>
    </div>
  );
}

/** Sub-section header inside the inspector (e.g. the selected segment). */
function SubHeader({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 12px",
        borderTop: "1px solid var(--l1)",
        borderBottom: "1px solid var(--l1)",
        background: "var(--panel)"
      }}
    >
      <span className="u">{children}</span>
    </div>
  );
}

/** Editable name field. Uncontrolled + keyed by uid so it resets when the
 *  selection changes; commits on blur / Enter, reverts on Escape. */
function NameField({
  uid,
  value,
  onCommit
}: {
  uid: string;
  value: string;
  onCommit: (next: string) => void;
}) {
  const commit = (el: HTMLInputElement) => {
    const next = el.value.trim();
    if (!next || next === value) {
      el.value = value;
      return;
    }
    onCommit(next);
  };
  return (
    <label className="input" style={{ flex: 1 }}>
      <input
        key={uid}
        defaultValue={value}
        spellCheck={false}
        onBlur={(e) => commit(e.currentTarget)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === "Escape") {
            e.currentTarget.value = value;
            e.currentTarget.blur();
          }
        }}
      />
    </label>
  );
}

const short = (id: string) => (id.length > 10 ? id.slice(0, 8) + "…" : id);

interface Resolved {
  typeLabel: string;
  displayName: string;
  uid: string;
  /** Present only when the entity carries an editable name. */
  name?: { value: string; onCommit: (next: string) => void };
  /** Extra property rows shown after `uid` (text or interactive controls,
   *  e.g. the ROI class selector). */
  rows?: [string, ReactNode][];
  /** Net sub-part (segment / vertex) detail panel. Row values may be plain
   *  text or an interactive control (e.g. the segment layer selector). */
  sub?: { kind: string; id: string; rows: [string, ReactNode][] };
}

function resolve(
  id: string,
  ann: DieAnnotations,
  dispatcher: ActionDispatcher,
  mlViasLayer: MLViasLayer | null,
  library: CellLibraryView
): Resolved | null {
  // A type shared from another die of the cell library says whose it is.
  const ownerRow = (typeId: string): [string, ReactNode][] => {
    const f = library.foreign.get(typeId);
    return f ? [["from", `${f.ownerName} · ×${f.ratio.toFixed(3)}`]] : [];
  };
  // ── ML vias (synthetic position id; no persistent annotation) ──────
  // Checked first because the prefix is unambiguous and the layer lookup
  // is cheap — keeps `parseNetPartId` and the prefix switch focused on
  // the persisted-annotation paths below.
  if (isMlViaId(id)) {
    const v = mlViasLayer?.findViaById(id) ?? null;
    if (!v) {
      // Tile evicted (model switch / refetch) — keep the slot so the user
      // sees *something* and can deselect; we just don't have score/kind.
      return {
        typeLabel: "ML via",
        displayName: `ML via ${short(id)}`,
        uid: id,
        rows: [["status", "not in current cache"]]
      };
    }
    const typeLabel = v.kind === "point" ? "ML via point" : "ML via region";
    return {
      typeLabel,
      displayName: `${typeLabel} ${short(id)}`,
      uid: id,
      rows: [
        ["confidence", `${(v.score * 100).toFixed(1)}%`],
        ["position", `(${Math.round(v.x)}, ${Math.round(v.y)})`],
        ["source", "ML prediction"]
      ]
    };
  }

  // ── Nets (incl. a selected segment / vertex sub-part) ──────────────
  const net = parseNetPartId(id);
  if (net) {
    const n = ann.nets.find((x) => x.id === net.netId);
    if (!n) return null;
    const base: Resolved = {
      typeLabel: "Net",
      displayName: n.name || `Net ${short(n.id)}`,
      uid: n.id,
      name: {
        value: n.name ?? "",
        onCommit: (name) =>
          void dispatcher.dispatch({
            kind: "upsertNet",
            net: { ...n, name },
            prevNet: n
          })
      }
    };
    if (net.part === "edge" && net.partId) {
      const e = n.edges.find((x) => x.id === net.partId);
      const a = e && n.nodes.find((nd) => nd.id === e.from);
      const b = e && n.nodes.find((nd) => nd.id === e.to);
      if (e && a && b) {
        const len = Math.round(Math.hypot(b.x - a.x, b.y - a.y));
        const setLayer = (layer: WireLayer | null) => {
          const edges = n.edges.map((x) => {
            if (x.id !== e.id) return x;
            if (layer) return { ...x, layer };
            const { layer: _drop, ...rest } = x;
            return rest;
          });
          void dispatcher.dispatch({
            kind: "upsertNet",
            net: { ...n, edges },
            prevNet: n
          });
        };
        base.sub = {
          kind: "Segment",
          id: e.id,
          rows: [
            ["from", `(${Math.round(a.x)}, ${Math.round(a.y)})`],
            ["to", `(${Math.round(b.x)}, ${Math.round(b.y)})`],
            ["length", `${len} px`],
            [
              "layer",
              <WireLayerSelect
                key="layer"
                value={e.layer ?? null}
                onChange={setLayer}
              />
            ]
          ]
        };
      }
    } else if (net.part === "node" && net.partId) {
      const nd = n.nodes.find((x) => x.id === net.partId);
      if (nd) {
        const deg = n.edges.filter(
          (e) => e.from === nd.id || e.to === nd.id
        ).length;
        base.sub = {
          kind: "Vertex",
          id: nd.id,
          rows: [
            ["position", `(${Math.round(nd.x)}, ${Math.round(nd.y)})`],
            ["edges", String(deg)]
          ]
        };
      }
    }
    return base;
  }

  const [prefix, eid] = splitId(id);
  switch (prefix) {
    case "cellType": {
      const ct = ann.cellTypes.find((x) => x.id === eid);
      if (!ct) return null;
      return {
        typeLabel: "Cell type",
        displayName: ct.name || `Cell type ${short(ct.id)}`,
        uid: ct.id,
        name: {
          value: ct.name ?? "",
          onCommit: (name) =>
            void dispatcher.dispatch({
              kind: "upsertCellType",
              cellType: { ...ct, name },
              prevCellType: ct
            })
        },
        rows: ownerRow(ct.id)
      };
    }
    case "cell": {
      const c = ann.cells.find((x) => x.id === eid);
      if (!c) return null;
      const ct = ann.cellTypes.find((t) => t.id === c.cellTypeId);
      // Like net→segment: the cell *type* is the editable top-level entity;
      // the placed instance is a read-only sub-section underneath.
      const base: Resolved = ct
        ? {
            typeLabel: "Cell type",
            displayName: ct.name || `Cell type ${short(ct.id)}`,
            uid: ct.id,
            name: {
              value: ct.name ?? "",
              onCommit: (name) =>
                void dispatcher.dispatch({
                  kind: "upsertCellType",
                  cellType: { ...ct, name },
                  prevCellType: ct
                })
            },
            rows: ownerRow(ct.id)
          }
        : { typeLabel: "Cell", displayName: `Cell ${short(c.id)}`, uid: c.id };
      const rows: [string, string][] = [
        ["position", `(${Math.round(c.x)}, ${Math.round(c.y)})`]
      ];
      if (ct) {
        rows.push(["size", `${Math.round(ct.cropRect.width)}×${Math.round(ct.cropRect.height)}`]);
      }
      rows.push(["flipped", c.flippedV ? "vertical" : "no"]);
      base.sub = { kind: "Cell", id: c.id, rows };
      return base;
    }
    case "pin": {
      const p = ann.pins?.find((x) => x.id === eid);
      if (!p) return null;
      return {
        typeLabel: "I/O pin",
        displayName: p.name || `pin ${p.pin}`,
        uid: p.id,
        name: {
          value: p.name ?? "",
          onCommit: (name) =>
            void dispatcher.dispatch({
              kind: "upsertPin",
              pin: { ...p, name },
              prevPin: p
            })
        }
      };
    }
    case "anno": {
      const a = ann.annotations?.find((x) => x.id === eid);
      if (!a) return null;
      const g = a.geometry;
      const typeLabel = a.class === "point_via" ? "Via point" : "Via region";
      const geomRow: [string, ReactNode] =
        g.kind === "point"
          ? ["point", `(${Math.round(g.x)}, ${Math.round(g.y)})`]
          : g.kind === "rectangle"
            ? ["size", `${Math.round(g.width)}×${Math.round(g.height)}`]
            : ["points", `${g.points.length} pts`];
      return {
        typeLabel,
        displayName: `${typeLabel} ${short(a.id)}`,
        uid: a.id,
        rows: [["class", a.class], geomRow]
      };
    }
    case "roi": {
      const r = ann.rois?.find((x) => x.id === eid);
      if (!r) return null;
      const classes = r.classes ?? [];
      return {
        typeLabel: "ML ROI",
        displayName: `ML ROI ${short(r.id)}`,
        uid: r.id,
        rows: [
          ["size", `${r.width}×${r.height}`],
          [
            "labels",
            <AnnotationClassSelect
              key="cls"
              value={classes}
              onChange={(next) =>
                void dispatcher.dispatch({
                  kind: "upsertRoi",
                  roi: { ...r, classes: next },
                  prevRoi: r
                })
              }
            />
          ]
        ]
      };
    }
    case "ignore": {
      const i = ann.ignores?.find((x) => x.id === eid);
      if (!i) return null;
      return {
        typeLabel: "Ignore region",
        displayName: `Ignore region ${short(i.id)}`,
        uid: i.id,
        rows: [["size", `${i.width}×${i.height}`]]
      };
    }
    default: {
      if (!eid) return null;
      const typeLabel = cap(prefix);
      return { typeLabel, displayName: `${typeLabel} ${short(eid)}`, uid: eid };
    }
  }
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function splitId(id: string): [string, string] {
  const i = id.indexOf(":");
  return i < 0 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}

/**
 * Right-side panel: tabbed Inspector / ML. The Inspector shows the selected
 * object's type + name in a common title bar, then its properties (name
 * editable where supported, uid read-only), with a sub-panel for a selected
 * net segment or vertex. ML is intentionally empty for now.
 */
export function InspectorPanel({
  annotations,
  dispatcher,
  dieId,
  die,
  library,
  mlViasLayer,
  proposals
}: {
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  dieId: string;
  die: DieMetadata | undefined;
  /** The die's cell library (other dies' types it shares). */
  library: CellLibraryView;
  /** Live ML via layer — the inspector resolves `ml-via:` selection ids
   *  through it to fetch score / class. May be null while the page is still
   *  bootstrapping. */
  mlViasLayer: MLViasLayer | null;
  /** Visible ML cell proposals — resolves `ml-cell:` selection ids. */
  proposals: Proposal[];
}) {
  const tab = usePreferences((s) => s.inspectorTab);
  const setTab = usePreferences((s) => s.setInspectorTab);
  const selectedIds = useDieViewerStore((s) => s.selectedIds);

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0, flex: "1 1 auto" }}>
      <div
        className="ph"
        style={{ padding: 0, gap: 0, height: 30 }}
      >
        {(["inspector", "ml", "cells"] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={"tab" + (tab === k ? " on" : "")}
            style={{ background: "transparent", cursor: "pointer" }}
            onClick={() => setTab(k)}
          >
            {TAB_LABELS[k]}
          </button>
        ))}
      </div>

      <div style={{ flex: "1 1 auto", overflow: "auto", minHeight: 0 }}>
        {tab === "ml" ? (
          <MLPanel dieId={dieId} />
        ) : tab === "cells" ? (
          <CellDetectionPanel dieId={dieId} annotations={annotations} library={library} />
        ) : (
          <InspectorBody
            annotations={annotations}
            dispatcher={dispatcher}
            dieId={dieId}
            die={die}
            library={library}
            ids={selectedIds}
            mlViasLayer={mlViasLayer}
            proposals={proposals}
          />
        )}
      </div>
    </div>
  );
}

function InspectorBody({
  annotations,
  dispatcher,
  dieId,
  die,
  library,
  ids,
  mlViasLayer,
  proposals
}: {
  annotations: DieAnnotations | undefined;
  dispatcher: ActionDispatcher;
  dieId: string;
  die: DieMetadata | undefined;
  library: CellLibraryView;
  ids: ReadonlySet<string>;
  mlViasLayer: MLViasLayer | null;
  proposals: Proposal[];
}) {
  // Nothing selected: the die itself.
  if (ids.size === 0) return <DieProperties die={die} library={library} />;
  if (!annotations) return <Empty>loading…</Empty>;

  // A cell type selected from the outline tree comes with all of its placed
  // instances (so they highlight / delete together). Keep the type's
  // inspector up in that case and just report how many instances are in.
  let only: string;
  let extraRows: [string, ReactNode][] = [];
  if (ids.size > 1) {
    const typeIds = [...ids].filter((id) => id.startsWith("cellType:"));
    const typeId = typeIds.length === 1 ? typeIds[0] : null;
    const allOwnCells =
      typeId !== null &&
      [...ids].every((id) => {
        if (id === typeId) return true;
        if (!id.startsWith("cell:")) return false;
        const c = annotations.cells.find((x) => x.id === id.slice(5));
        return !!c && `cellType:${c.cellTypeId}` === typeId;
      });
    if (!allOwnCells || typeId === null) {
      return <Empty>{ids.size} items selected</Empty>;
    }
    only = typeId;
    extraRows = [["selected", `${ids.size - 1} instance${ids.size - 1 === 1 ? "" : "s"} — Delete removes them all`]];
  } else {
    only = ids.values().next().value as string;
  }
  if (isMlCellId(only)) {
    return (
      <ProposalInspector
        dieId={dieId}
        id={only}
        dispatcher={dispatcher}
        proposals={proposals}
      />
    );
  }
  const r = resolve(only, annotations, dispatcher, mlViasLayer, library);
  if (!r) return <Empty>Selection not found</Empty>;

  return (
    <div>
      <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l1)" }}>
        <div className="u">{r.typeLabel}</div>
        <div
          style={{
            fontSize: 15,
            fontWeight: 600,
            color: "var(--ink)",
            marginTop: 3,
            fontFamily: "var(--mono)",
            wordBreak: "break-word"
          }}
        >
          {r.displayName}
        </div>
      </div>

      {r.name && (
        <Prop label="name">
          <NameField uid={r.uid} value={r.name.value} onCommit={r.name.onCommit} />
        </Prop>
      )}
      <Prop label="uid">
        <span
          title={r.uid}
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: "var(--ink2)"
          }}
        >
          {r.uid}
        </span>
      </Prop>

      {[...(r.rows ?? []), ...extraRows].map(([label, value]) => (
        <Prop key={label} label={label}>
          {value}
        </Prop>
      ))}

      {r.sub && (
        <>
          <SubHeader>
            {r.sub.kind} · {short(r.sub.id)}
          </SubHeader>
          {r.sub.rows.map(([label, value]) => (
            <Prop key={label} label={label}>
              {value}
            </Prop>
          ))}
        </>
      )}
    </div>
  );
}

/**
 * The ML tab: an Inference section (model selection, the die-wide inference
 * job + its live progress, confidence threshold) and a Training section
 * (mask sizing + dataset export). Inference job state is shared via WS so
 * progress a teammate triggered shows here too.
 */
function MLPanel({ dieId }: { dieId: string }) {
  return (
    <div>
      <MLSectionHeader>Inference</MLSectionHeader>
      <InferenceSection dieId={dieId} />
      <MLSectionHeader>Training</MLSectionHeader>
      <TrainingSection dieId={dieId} />
    </div>
  );
}

function MLSectionHeader({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: "7px 12px",
        borderBottom: "1px solid var(--l1)",
        background: "var(--panel)"
      }}
    >
      <span className="u">{children}</span>
    </div>
  );
}

const SELECT_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: "var(--panel)",
  color: "var(--ink)",
  border: "1px solid var(--l1)",
  borderRadius: 4,
  padding: "3px 6px",
  fontSize: 11,
  fontFamily: "var(--mono)"
};

function jobStatusLine(job: MLInferenceJob | null | undefined): string {
  if (!job) return "—";
  const { status, completedTiles: done, totalTiles: total, percentage } = job;
  if (status === "running")
    return `Running · ${done}/${total} tiles (${percentage}%)`;
  if (status === "completed") return `Complete · ${total} tiles`;
  if (status === "failed")
    return `Failed${job.error ? ` · ${job.error}` : ""}`;
  if (done > 0)
    return `Stopped · ${done}/${total} tiles cached (${percentage}%)`;
  return `Idle · 0/${total} tiles`;
}

/** Model dropdown, start/stop, live job progress, confidence threshold. */
function InferenceSection({ dieId }: { dieId: string }) {
  const qc = useQueryClient();
  const models = useMLModels();
  const status = useMLStatus();
  const job = useMLJob(dieId);
  const confidence = usePreferences((s) => s.viaConfidenceThreshold);
  const setConfidence = usePreferences((s) => s.setViaConfidenceThreshold);
  const [busy, setBusy] = useState<null | "model" | "job">(null);
  const [err, setErr] = useState<string | null>(null);

  const modelList = models.data?.models ?? [];
  const residentName =
    modelList.find((m) => m.resident)?.name ?? status.data?.checkpoint ?? "";
  const running = job.data?.status === "running";
  const sidecarDown = status.data?.reachable === false;

  const switchModel = async (name: string) => {
    if (!name || name === residentName) return;
    // Cached predictions are per checkpoint: switching just changes which
    // cache the viewer reads, and switching back restores the old one.
    setBusy("model");
    setErr(null);
    try {
      await selectMLModel(name);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["mlModels"] }),
        qc.invalidateQueries({ queryKey: ["mlStatus"] }),
        qc.invalidateQueries({ queryKey: mlJobKey(dieId) })
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "model switch failed");
    } finally {
      setBusy(null);
    }
  };

  const toggleJob = async () => {
    setBusy("job");
    setErr(null);
    try {
      const next = running ? await stopMLJob(dieId) : await startMLJob(dieId);
      qc.setQueryData(mlJobKey(dieId), next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "inference job failed");
    } finally {
      setBusy(null);
    }
  };

  const pct = job.data?.percentage ?? 0;

  return (
    <div style={{ padding: "12px" }}>
      {/* Model selection */}
      <div
        className="row"
        style={{ gap: 8, alignItems: "center", marginBottom: 10 }}
      >
        <span className="u" style={{ fontSize: 10, minWidth: 38 }}>
          Model
        </span>
        <select
          value={modelList.length > 0 ? residentName : ""}
          disabled={busy !== null || running || modelList.length === 0}
          onChange={(e) => void switchModel(e.target.value)}
          style={SELECT_STYLE}
        >
          {modelList.length === 0 && (
            <option value="">
              {sidecarDown ? "sidecar offline" : "no models"}
            </option>
          )}
          {modelList.map((m) => (
            <option key={m.name} value={m.name}>
              {m.name}
            </option>
          ))}
        </select>
      </div>

      {/* Start / stop */}
      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        disabled={busy !== null || sidecarDown}
        onClick={() => void toggleJob()}
      >
        {busy === "job"
          ? "…"
          : running
            ? "Stop inference"
            : "Start inference"}
      </button>

      {/* Job status + progress */}
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink2)", margin: "8px 0 6px" }}
      >
        {jobStatusLine(job.data)}
      </div>
      <div
        style={{
          height: 5,
          borderRadius: 3,
          background: "var(--l1)",
          overflow: "hidden"
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${Math.min(100, Math.max(0, pct))}%`,
            background: "var(--accent, #7fb2ff)",
            transition: "width 0.2s"
          }}
        />
      </div>

      {err && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {err}
        </div>
      )}

      <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

      {/* Confidence threshold */}
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          Confidence threshold
        </span>
        <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
          {confidence.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={confidence}
        style={{ width: "100%" }}
        onChange={(e) => setConfidence(Number(e.target.value))}
      />
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
      >
        Filters ML vias below this model confidence.
      </div>
    </div>
  );
}

/** Mask sizing (source-px) + dataset export. */
function TrainingSection({ dieId }: { dieId: string }) {
  const mlConfig = useDieViewerStore((s) => s.mlConfig);
  const setMlConfig = useDieViewerStore((s) => s.setMlConfig);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<
    { ok: true } | { ok: false; msg: string } | null
  >(null);

  const runExport = async () => {
    setExporting(true);
    setResult(null);
    try {
      await exportMlData(dieId, Math.max(1, Math.round(mlConfig.pointViaSize)));
      setResult({ ok: true });
    } catch (e) {
      setResult({ ok: false, msg: e instanceof Error ? e.message : "failed" });
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{ padding: "12px 12px 16px" }}>
      <div
        className="m"
        style={{ fontSize: 10.5, color: "var(--ink3)", marginBottom: 10 }}
      >
        Real-die sizes baked into the generated training pixel masks. The
        canvas previews these while this tab is open.
      </div>

      <MLSlider
        label="Trace width"
        min={1}
        max={40}
        value={mlConfig.traceWidth}
        onChange={(v) => setMlConfig({ traceWidth: v })}
      />
      <MLSlider
        label="Via size"
        min={1}
        max={30}
        value={mlConfig.pointViaSize}
        onChange={(v) => setMlConfig({ pointViaSize: v })}
      />

      <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

      <button
        type="button"
        className="btn"
        style={{ width: "100%", cursor: "pointer" }}
        disabled={exporting}
        onClick={() => void runExport()}
      >
        {exporting ? "Exporting…" : "Export training data"}
      </button>
      {result && (
        <div
          className="m"
          style={{
            marginTop: 8,
            fontSize: 10.5,
            color: result.ok ? "var(--ink2)" : "var(--danger, #e36854)",
            wordBreak: "break-word"
          }}
        >
          {result.ok
            ? "Export started — written to the server's ML exports dir (see server logs)."
            : `Export failed: ${result.msg}`}
        </div>
      )}

      <button
        type="button"
        className="btn"
        style={{ width: "100%", marginTop: 8, opacity: 0.55 }}
        disabled
        title="Not implemented yet"
      >
        Start training
      </button>
      <div
        className="m"
        style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}
      >
        Training from the UI not available yet, please use the CLI.
      </div>
    </div>
  );
}

function MLSlider({
  label,
  min,
  max,
  value,
  onChange
}: {
  label: string;
  min: number;
  max: number;
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="row"
        style={{ justifyContent: "space-between", marginBottom: 4 }}
      >
        <span className="u" style={{ fontSize: 10 }}>
          {label}
        </span>
        <span
          className="m"
          style={{ fontSize: 11, color: "var(--ink2)" }}
        >
          {value} px
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={1}
        value={value}
        style={{ width: "100%" }}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 120,
        fontSize: 11,
        color: "var(--ink3)"
      }}
    >
      {children}
    </div>
  );
}
