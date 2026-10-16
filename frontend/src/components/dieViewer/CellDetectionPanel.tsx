import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type {
  CellDetectionJob,
  CellImagingJob,
  CellImagingJobKind,
  DieAnnotations
} from "shared";
import type { ActionDispatcher } from "../../api/actions";
import {
  cellDetectionKeys,
  clearCellDetections,
  dismissCellDetections,
  startCellDetection,
  stopCellDetection,
  useCellDetectionJob,
  useCellDetections
} from "../../api/cellDetection";
import {
  cellImagingKeys,
  clearCellSpecimens,
  clearWireMap,
  startCellImaging,
  stopCellImaging,
  useCellImagingJob,
  useCellSpecimens,
  useWireMapInfo
} from "../../api/cellImaging";
import {
  memberSignature,
  parseMlCellId,
  resultIsStale,
  type Proposal
} from "../../lib/cellDetection";
import { buildApproveAction, orientOf } from "../../lib/mergeCells";
import { libraryMemberCount, type CellLibraryView } from "../../lib/cellLibrary";
import { useDieViewerStore } from "../../state/dieViewer";
import { usePreferences } from "../../state/preferences";

/**
 * The "Cells" inspector tab: run cell detection for one annotated cell type
 * (picked from the dropdown or by selecting a placed cell on the canvas),
 * watch the job, manage the per-type results, and tune the confidence
 * threshold that filters the pink proposal boxes on the canvas. Approval
 * happens in merge-cells (or per proposal from the Inspector tab).
 */
export function CellDetectionPanel({
  dieId,
  annotations,
  library
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  /** Other dies' types (shared through the cell library) are detectable
   *  here too — from their owner's template while few are placed here. */
  library: CellLibraryView;
}) {
  const qc = useQueryClient();
  const job = useCellDetectionJob(dieId);
  const results = useCellDetections(dieId);
  const typeId = useDieViewerStore((s) => s.cellDetectionTypeId);
  const setTypeId = useDieViewerStore((s) => s.setCellDetectionTypeId);
  const selectedIds = useDieViewerStore((s) => s.selectedIds);
  const visibleCount = useDieViewerStore((s) => s.cellDetectionsCount);
  const threshold = usePreferences((s) => s.cellDetectionThreshold);
  const setThreshold = usePreferences((s) => s.setCellDetectionThreshold);
  const hidden = usePreferences((s) => s.cellDetectionsHidden);
  const setHidden = usePreferences((s) => s.setCellDetectionsHidden);
  const allowFlipX = usePreferences((s) => s.cellDetectAllowFlipX);
  const setAllowFlipX = usePreferences((s) => s.setCellDetectAllowFlipX);
  const allowFlipY = usePreferences((s) => s.cellDetectAllowFlipY);
  const setAllowFlipY = usePreferences((s) => s.setCellDetectAllowFlipY);
  const avoidExisting = usePreferences((s) => s.cellDetectAvoidExisting);
  const setAvoidExisting = usePreferences((s) => s.setCellDetectAvoidExisting);
  const allDiesPref = usePreferences((s) => s.cellDetectAllDies);
  const setAllDies = usePreferences((s) => s.setCellDetectAllDies);
  // Pooling only means something inside a cell library.
  const allDies = !!library.name && allDiesPref;
  const [busy, setBusy] = useState<null | "job" | "clear">(null);
  const [err, setErr] = useState<string | null>(null);

  const running = job.data?.status === "running";
  const cellTypes = [...(annotations?.cellTypes ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true })
  );
  // Another die's type counts its instances there too: its template can be
  // borrowed from them.
  const memberCount = (id: string) =>
    !annotations
      ? 0
      : library.foreign.has(id) || allDies
        ? libraryMemberCount(library, annotations, id)
        : annotations.cells.filter((c) => c.cellTypeId === id).length;
  const typeLabel = (id: string, name: string) =>
    library.foreign.has(id) ? `${name} (other die)` : name;
  const chosen = cellTypes.find((ct) => ct.id === typeId) ?? null;
  const chosenMembers = chosen ? memberCount(chosen.id) : 0;

  // Pick the type from the canvas: selecting a single placed cell (or a
  // type row in the outline) while this tab is open adopts its type. Locked
  // while a job runs — the running job's type can't change anyway.
  useEffect(() => {
    if (running || !annotations || selectedIds.size !== 1) return;
    const only = selectedIds.values().next().value as string;
    let next: string | null = null;
    if (only.startsWith("cell:")) {
      next = annotations.cells.find((c) => c.id === only.slice(5))?.cellTypeId ?? null;
    } else if (only.startsWith("cellType:")) {
      next = only.slice("cellType:".length);
    }
    if (next && next !== typeId) setTypeId(next);
  }, [selectedIds, annotations, running, typeId, setTypeId]);

  // A stale type id (type deleted) shouldn't stick.
  useEffect(() => {
    if (typeId && annotations && !annotations.cellTypes.some((ct) => ct.id === typeId)) {
      setTypeId(null);
    }
  }, [typeId, annotations, setTypeId]);

  const toggleJob = async () => {
    setBusy("job");
    setErr(null);
    try {
      if (running) {
        const next = await stopCellDetection(dieId);
        qc.setQueryData(cellDetectionKeys.job(dieId), next);
      } else if (typeId) {
        const next = await startCellDetection(dieId, typeId, {
          allowFlipX,
          allowFlipY,
          avoidExistingCells: avoidExisting,
          allDies
        });
        qc.setQueryData(cellDetectionKeys.job(dieId), next);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : "cell detection failed");
    } finally {
      setBusy(null);
    }
  };

  const clear = async (cellTypeId?: string) => {
    if (
      !cellTypeId &&
      !window.confirm(
        "Clear every cell-detection result for this die? Placed cells and " +
          "all other annotations are untouched."
      )
    ) {
      return;
    }
    setBusy("clear");
    setErr(null);
    try {
      await clearCellDetections(dieId, cellTypeId);
      await qc.invalidateQueries({ queryKey: cellDetectionKeys.results(dieId) });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "clear failed");
    } finally {
      setBusy(null);
    }
  };

  const list = results.data ?? [];
  const totalDetections = list.reduce((n, r) => n + r.detections.length, 0);
  const pct = job.data?.percentage ?? 0;

  return (
    <div>
      <SectionHeader>Cell detection</SectionHeader>
      <div style={{ padding: 12 }}>
        <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 6 }}>
          <span className="u" style={{ fontSize: 10, minWidth: 38 }}>
            Type
          </span>
          <select
            value={chosen ? chosen.id : ""}
            disabled={running || busy !== null || cellTypes.length === 0}
            onChange={(e) => setTypeId(e.target.value || null)}
            style={SELECT_STYLE}
          >
            <option value="">
              {cellTypes.length === 0 ? "no cell types yet" : "pick a cell type…"}
            </option>
            {cellTypes.map((ct) => (
              <option
                key={ct.id}
                value={ct.id}
                title={
                  library.foreign.has(ct.id)
                    ? `Cell type of ${library.foreign.get(ct.id)!.ownerName} (cell library)`
                    : undefined
                }
              >
                {typeLabel(ct.id, ct.name)} · {memberCount(ct.id)} placed
              </option>
            ))}
          </select>
        </div>
        <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 10 }}>
          {running
            ? "Type is locked while detection runs."
            : "Or select a placed cell on the canvas to pick its type. The " +
              "template is built from every placed instance's ML vias, so " +
              "run via inference first."}
        </div>

        <div className="row" style={{ gap: 12, marginBottom: 10 }}>
          <label
            className="check"
            title="Also propose copies mirrored across the cell's vertical axis (rotations are always searched)"
          >
            <input
              type="checkbox"
              checked={allowFlipX}
              disabled={running}
              onChange={(e) => setAllowFlipX(e.target.checked)}
            />
            Flipped X
          </label>
          <label
            className="check"
            title="Also propose copies mirrored across the cell's horizontal axis (rotations are always searched)"
          >
            <input
              type="checkbox"
              checked={allowFlipY}
              disabled={running}
              onChange={(e) => setAllowFlipY(e.target.checked)}
            />
            Flipped Y
          </label>
        </div>
        <label
          className="check"
          style={{ marginBottom: 10 }}
          title="On: drop candidates overlapping any placed cell by more than 30%. Off: only near-duplicates of this type's own placed cells are dropped, so proposals may land on cells of other types (useful for finding misclassified ones)"
        >
          <input
            type="checkbox"
            checked={avoidExisting}
            disabled={running}
            onChange={(e) => setAvoidExisting(e.target.checked)}
          />
          Avoid existing cells
        </label>
        {library.name && (
          <label
            className="check"
            style={{ marginBottom: 10 }}
            title="Build the via template from this type's instances on every die of the cell library (scaled to this die), not just the ones placed here"
          >
            <input
              type="checkbox"
              checked={allDies}
              disabled={running}
              onChange={(e) => setAllDies(e.target.checked)}
            />
            Instances from all dies
          </label>
        )}

        <button
          type="button"
          className={"btn" + (running ? "" : " accent")}
          style={{ width: "100%", cursor: "pointer" }}
          disabled={
            busy !== null || (!running && (!chosen || chosenMembers === 0))
          }
          title={
            !running && chosen && chosenMembers === 0
              ? "Place at least one instance of this type first"
              : undefined
          }
          onClick={() => void toggleJob()}
        >
          {busy === "job"
            ? "…"
            : running
              ? "Cancel detection"
              : chosen
                ? `Start detection for ${typeLabel(chosen.id, chosen.name)}`
                : "Start detection"}
        </button>

        <div className="m" style={{ fontSize: 10.5, color: "var(--ink2)", margin: "8px 0 6px" }}>
          {jobLine(job.data)}
        </div>
        <div style={{ height: 5, borderRadius: 3, background: "var(--l1)", overflow: "hidden" }}>
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
      </div>

      <SectionHeader>Results</SectionHeader>
      <div style={{ padding: 12 }}>
        {list.length === 0 && (
          <div className="m" style={{ fontSize: 10.5, color: "var(--ink3)" }}>
            {results.isLoading ? "loading…" : "no detection results yet"}
          </div>
        )}
        {list.map((r) => {
          const ct = annotations?.cellTypes.find((x) => x.id === r.cellTypeId);
          const stale = annotations ? resultIsStale(r, annotations) : false;
          const dismissed = r.dismissed?.length ?? 0;
          return (
            <div
              key={r.cellTypeId}
              className="row"
              style={{ gap: 6, alignItems: "center", padding: "3px 0" }}
            >
              <span
                className="m"
                style={{
                  fontSize: 10.5,
                  color: ct ? "var(--ink)" : "var(--ink3)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  flex: 1
                }}
                title={
                  `${r.detections.length} detections · template ${r.templateVias} vias ` +
                  (r.pooledFrom
                    ? `from ${r.pooledFrom.reduce((n, p) => n + p.memberCount, 0)} instance(s) on ${r.pooledFrom.length} die(s): ` +
                      r.pooledFrom.map((p) => `${p.dieName} ${p.memberCount}`).join(", ")
                    : r.templateSource
                      ? `from ${r.templateSource.memberCount} member(s) on ${r.templateSource.dieName} (×${r.templateSource.ratio.toFixed(3)})`
                      : `from ${r.memberCount} member(s)`) +
                  ` · ${new Date(r.createdAt).toLocaleString()}` +
                  (dismissed ? ` · ${dismissed} dismissed` : "") +
                  (r.options
                    ? ` · flips: ${r.options.allowFlipX ? "X" : ""}${r.options.allowFlipY ? "Y" : ""}`.replace(/: $/, ": none") +
                      (r.options.avoidExistingCells === false ? " · overlaps allowed" : "")
                    : "")
                }
              >
                {ct ? typeLabel(ct.id, ct.name) : `${r.cellTypeName} (type removed)`}
              </span>
              {stale && (
                <span
                  className="chip"
                  style={{ fontSize: 9 }}
                  title="The type's placed cells changed since this ran — re-run to refresh the template"
                >
                  stale
                </span>
              )}
              <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }}>
                {r.detections.length}
              </span>
              <button
                type="button"
                className="trow-eye"
                title="Clear this type's results"
                disabled={busy !== null}
                onClick={() => void clear(r.cellTypeId)}
                style={{
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  cursor: "pointer",
                  color: "var(--ink3)",
                  fontSize: 12,
                  lineHeight: 1
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {list.length > 0 && (
          <>
            <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 6 }}>
              {visibleCount} of {totalDetections} shown at the current threshold
              (dismissed and already-placed ones hidden).{" "}
              <Link to={`/merge?die=${dieId}`} style={{ color: "var(--accent)" }}>
                Review in Merge cells
              </Link>
            </div>
            <button
              type="button"
              className="btn"
              style={{ width: "100%", marginTop: 10, cursor: "pointer" }}
              disabled={busy !== null || running}
              onClick={() => void clear()}
            >
              {busy === "clear" ? "…" : "Clear cell detection results"}
            </button>
          </>
        )}

        <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

        <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
          <span className="u" style={{ fontSize: 10 }}>
            Confidence threshold
          </span>
          <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
            {threshold.toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={threshold}
          style={{ width: "100%" }}
          onChange={(e) => setThreshold(Number(e.target.value))}
        />
        <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginTop: 4 }}>
          Hides proposals scoring below this (F1 between the type's via
          template and the vias found under the footprint).
        </div>
        <label className="check" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={!hidden}
            onChange={(e) => setHidden(!e.target.checked)}
          />
          Show proposals on the canvas
        </label>
      </div>

      <CellImagingSection dieId={dieId} annotations={annotations} inLibrary={!!library.name} />
    </div>
  );
}

function imagingLine(job: CellImagingJob | null | undefined): string {
  if (!job) return "Idle";
  const what = job.kind === "specimens" ? "Specimens" : "Wire map";
  switch (job.status) {
    case "running":
      return `${what} · ${job.phase} (${job.percentage}%)`;
    case "completed":
      return `${what} complete`;
    case "failed":
      return `${what} failed${job.error ? ` · ${job.error}` : ""}`;
    case "stopped":
      return `${what} cancelled`;
  }
}

/**
 * Clean specimens + wire map. Specimens: the per-pixel median of every
 * instance of a type — wires routed over the cell and debris drop out. Wire
 * map: each placed cell minus its type's specimen, keeping long straight
 * residue, pasted back over the die as a translucent overlay.
 */
function CellImagingSection({
  dieId,
  annotations,
  inLibrary
}: {
  dieId: string;
  annotations: DieAnnotations | undefined;
  /** The die shares a cell library: specimens can pool other dies' instances. */
  inLibrary: boolean;
}) {
  const qc = useQueryClient();
  const job = useCellImagingJob(dieId);
  const specimens = useCellSpecimens(dieId).data ?? null;
  const wireMap = useWireMapInfo(dieId).data ?? null;
  const wireMapHidden = usePreferences((s) => s.wireMapHidden);
  const setWireMapHidden = usePreferences((s) => s.setWireMapHidden);
  const wireMapOpacity = usePreferences((s) => s.wireMapOpacity);
  const setWireMapOpacity = usePreferences((s) => s.setWireMapOpacity);
  const useClean = usePreferences((s) => s.useCleanSpecimens);
  const setUseClean = usePreferences((s) => s.setUseCleanSpecimens);
  const allDiesPref = usePreferences((s) => s.specimensAllDies);
  const setAllDies = usePreferences((s) => s.setSpecimensAllDies);
  const allDies = inLibrary && allDiesPref;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const running = job.data?.status === "running";
  const runningKind = running ? job.data!.kind : null;
  const placedTypes = annotations
    ? new Set(annotations.cells.map((c) => c.cellTypeId)).size
    : 0;
  // Types whose members moved / changed since their specimen was built.
  const staleTypes =
    specimens && annotations
      ? specimens.specimens.filter(
          (s) =>
            memberSignature(annotations.cells.filter((c) => c.cellTypeId === s.cellTypeId)) !==
            s.memberSignature
        ).length +
        Math.max(0, placedTypes - specimens.specimens.length)
      : 0;
  const wireMapOutdated = !!wireMap && !!specimens && wireMap.specimensCreatedAt !== specimens.createdAt;
  // Instances that only registered once mirrored relative to their annotation.
  const flippedTypes = (specimens?.specimens ?? []).filter((s) => (s.orientationMismatches ?? 0) > 0);
  const flippedCount = flippedTypes.reduce((n, s) => n + (s.orientationMismatches ?? 0), 0);

  const run = async (kind: CellImagingJobKind) => {
    setBusy(true);
    setErr(null);
    try {
      const next = running
        ? await stopCellImaging(dieId)
        : await startCellImaging(dieId, kind, { allDies: kind === "specimens" && allDies });
      qc.setQueryData(cellImagingKeys.job(dieId), next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "imaging job failed");
    } finally {
      setBusy(false);
    }
  };
  const clear = async (what: "specimens" | "wireMap") => {
    setBusy(true);
    setErr(null);
    try {
      if (what === "specimens") await clearCellSpecimens(dieId);
      else await clearWireMap(dieId);
      await Promise.all([
        qc.invalidateQueries({ queryKey: cellImagingKeys.specimens(dieId) }),
        qc.invalidateQueries({ queryKey: cellImagingKeys.wireMap(dieId) })
      ]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "clear failed");
    } finally {
      setBusy(false);
    }
  };

  const clearBtn = (what: "specimens" | "wireMap", title: string) => (
    <button
      type="button"
      className="trow-eye"
      title={title}
      disabled={busy || running}
      onClick={() => void clear(what)}
      style={{ background: "transparent", border: 0, padding: 0, cursor: "pointer", color: "var(--ink3)", fontSize: 12, lineHeight: 1 }}
    >
      ×
    </button>
  );
  const pct = job.data?.percentage ?? 0;

  return (
    <>
      <SectionHeader>Specimens &amp; wire map</SectionHeader>
      <div style={{ padding: 12 }}>
        <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 10 }}>
          A clean specimen is the per-pixel median of every instance of a type, so
          wires routed over the cell and debris drop out. The wire map is each
          placed cell minus its specimen, overlaid on the die.
        </div>

        <button
          type="button"
          className="btn"
          style={{ width: "100%", cursor: "pointer" }}
          disabled={busy || (running && runningKind !== "specimens") || (!running && placedTypes === 0)}
          onClick={() => void run("specimens")}
        >
          {runningKind === "specimens" ? "Cancel" : specimens ? "Regenerate specimens" : "Generate specimens"}
        </button>
        {inLibrary && (
          <label
            className="check"
            style={{ marginTop: 6 }}
            title="Also stack each type's instances from the other dies of the cell library — resampled to this die's scale and matched in brightness / contrast. More instances, cleaner median; the sharpest are used for the display image."
          >
            <input
              type="checkbox"
              checked={allDies}
              disabled={running}
              onChange={(e) => setAllDies(e.target.checked)}
            />
            Instances from all dies
          </label>
        )}
        <div className="row" style={{ gap: 6, alignItems: "center", margin: "6px 0 10px" }}>
          <span className="m" style={{ fontSize: 10, color: "var(--ink3)", flex: 1 }}>
            {specimens
              ? `${specimens.specimens.length} types · ${new Date(specimens.createdAt).toLocaleString()}` +
                (specimens.specimens.some((sp) => (sp.dies ?? 1) > 1) ? " · pooled across dies" : "")
              : "not generated yet"}
          </span>
          {flippedCount > 0 && (
            <span
              className="chip"
              style={{ fontSize: 9, color: "var(--err, #e36854)", borderColor: "var(--err, #e36854)" }}
              title="Instances that only align when mirrored — listed below"
            >
              {flippedCount} flipped?
            </span>
          )}
          {specimens && staleTypes > 0 && (
            <span
              className="chip"
              style={{ fontSize: 9 }}
              title="Types whose placed cells changed (or are new) since the specimens were built"
            >
              {staleTypes} outdated
            </span>
          )}
          {specimens && clearBtn("specimens", "Delete the specimens")}
        </div>

        {flippedTypes.length > 0 && (
          <div style={{ margin: "0 0 10px", padding: "6px 8px", border: "1px solid var(--l1)", borderRadius: 4 }}>
            <div className="u" style={{ fontSize: 9, color: "var(--err, #e36854)", marginBottom: 4 }}>
              Instances that only align when mirrored
            </div>
            <div className="m" style={{ fontSize: 10, color: "var(--ink3)", marginBottom: 6 }}>
              Their flip flags are probably wrong. Select them to see them on the
              canvas (the inspector stays on the type; Delete removes them all).
            </div>
            {flippedTypes.map((s) => {
              const ids = s.orientationMismatchIds ?? [];
              return (
                <div key={s.cellTypeId} className="row" style={{ gap: 6, alignItems: "center", padding: "2px 0" }}>
                  <span className="m" style={{ fontSize: 10.5, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {s.cellTypeName}
                  </span>
                  <span className="m" style={{ fontSize: 10, color: "var(--ink3)" }} title={ids.map((id) => id.slice(0, 8)).join(", ")}>
                    {s.orientationMismatches} of {s.instancesUsed}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    style={{ fontSize: 10, padding: "1px 6px", cursor: "pointer" }}
                    disabled={ids.length === 0}
                    title="Select these instances on the canvas"
                    onClick={() =>
                      useDieViewerStore
                        .getState()
                        .select([`cellType:${s.cellTypeId}`, ...ids.map((id) => `cell:${id}`)])
                    }
                  >
                    select
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <button
          type="button"
          className="btn"
          style={{ width: "100%", cursor: "pointer" }}
          disabled={busy || (running && runningKind !== "wireMap") || (!running && !specimens)}
          title={!specimens ? "Generate the specimens first" : undefined}
          onClick={() => void run("wireMap")}
        >
          {runningKind === "wireMap" ? "Cancel" : wireMap ? "Regenerate wire map" : "Generate wire map"}
        </button>
        <div className="row" style={{ gap: 6, alignItems: "center", margin: "6px 0 8px" }}>
          <span
            className="m"
            style={{ fontSize: 10, color: "var(--ink3)", flex: 1 }}
            title={
              wireMap && wireMap.cellsSkipped > 0
                ? `${wireMap.cellsSkipped} cells skipped: types with fewer than 5 instances (no reliable spread), a changed crop size, or a footprint leaving the die`
                : undefined
            }
          >
            {wireMap
              ? `${wireMap.cellsProcessed} cells${wireMap.cellsSkipped ? ` · ${wireMap.cellsSkipped} skipped` : ""} · ${new Date(wireMap.createdAt).toLocaleString()}`
              : "not generated yet"}
          </span>
          {wireMapOutdated && (
            <span className="chip" style={{ fontSize: 9 }} title="The specimens were regenerated after this map was built">
              outdated
            </span>
          )}
          {wireMap && clearBtn("wireMap", "Delete the wire map")}
        </div>

        <div className="m" style={{ fontSize: 10.5, color: "var(--ink2)", margin: "4px 0 6px" }}>
          {imagingLine(job.data)}
        </div>
        <div style={{ height: 5, borderRadius: 3, background: "var(--l1)", overflow: "hidden" }}>
          <div
            style={{
              height: "100%",
              width: `${Math.min(100, Math.max(0, running ? pct : 0))}%`,
              background: "var(--accent, #7fb2ff)",
              transition: "width 0.2s"
            }}
          />
        </div>
        {err && (
          <div className="m" style={{ marginTop: 8, fontSize: 10.5, color: "var(--danger, #e36854)", wordBreak: "break-word" }}>
            {err}
          </div>
        )}

        <div style={{ borderTop: "1px solid var(--l1)", margin: "14px 0 12px" }} />

        <div className="row" style={{ justifyContent: "space-between", marginBottom: 4 }}>
          <span className="u" style={{ fontSize: 10 }}>
            Wire map opacity
          </span>
          <span className="m" style={{ fontSize: 11, color: "var(--ink2)" }}>
            {Math.round(wireMapOpacity * 100)}%
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={wireMapOpacity}
          disabled={!wireMap}
          style={{ width: "100%" }}
          onChange={(e) => setWireMapOpacity(Number(e.target.value))}
        />
        <label className="check" style={{ marginTop: 8 }}>
          <input
            type="checkbox"
            checked={!wireMapHidden}
            disabled={!wireMap}
            onChange={(e) => setWireMapHidden(!e.target.checked)}
          />
          Show the wire map on the canvas
        </label>
        <label
          className="check"
          style={{ marginTop: 6 }}
          title="Merge cells' reference pane and the Cell RE background use the clean specimen instead of one raw instance crop"
        >
          <input
            type="checkbox"
            checked={useClean}
            onChange={(e) => setUseClean(e.target.checked)}
          />
          Use clean specimens in Merge cells and Cell RE
        </label>
      </div>
    </>
  );
}

function jobLine(job: CellDetectionJob | null | undefined): string {
  if (!job) return "Idle";
  switch (job.status) {
    case "running":
      return `Running · ${job.cellTypeName} · ${job.phase} (${job.percentage}%)`;
    case "completed":
      return `Complete · ${job.cellTypeName} · ${job.detections ?? 0} proposals`;
    case "failed":
      return `Failed · ${job.cellTypeName}${job.error ? ` · ${job.error}` : ""}`;
    case "stopped":
      return `Cancelled · ${job.cellTypeName}`;
  }
}

/**
 * Inspector body for a selected ML cell proposal (`ml-cell:` id): its type,
 * score and placement, with one-click approve / dismiss. Approval creates a
 * merged member of the type exactly like merge-cells does.
 */
export function ProposalInspector({
  dieId,
  id,
  dispatcher,
  proposals
}: {
  dieId: string;
  id: string;
  dispatcher: ActionDispatcher;
  proposals: Proposal[];
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const detId = parseMlCellId(id);
  const p = proposals.find((x) => x.detection.id === detId) ?? null;

  if (!p) {
    return (
      <div>
        <Title label="ML cell proposal" name={`proposal ${(detId ?? id).slice(0, 8)}`} />
        <Prop label="status">not visible (approved, dismissed or below the threshold)</Prop>
      </div>
    );
  }

  const { detection: d, cell, cellType } = p;
  const orient = orientOf(cell);
  const orientText =
    [
      orient.rotation ? `${orient.rotation}°` : null,
      orient.flippedH ? "flip H" : null,
      orient.flippedV ? "flip V" : null
    ]
      .filter(Boolean)
      .join(" · ") || "upright";

  const approve = () => {
    void dispatcher.dispatch(
      buildApproveAction(cellType, { ...orient, x: cell.x, y: cell.y })
    );
    useDieViewerStore.getState().clearSelection();
  };
  const dismiss = async () => {
    setBusy(true);
    try {
      await dismissCellDetections(dieId, cellType.id, [d.id]);
      await qc.invalidateQueries({ queryKey: cellDetectionKeys.results(dieId) });
      useDieViewerStore.getState().clearSelection();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <Title label="ML cell proposal" name={cellType.name} />
      <Prop label="confidence">{(d.score * 100).toFixed(1)}%</Prop>
      <Prop label="vias">
        {d.matched} / {p.result.templateVias} matched · {d.extra} extra
      </Prop>
      <Prop label="position">
        ({Math.round(cell.x)}, {Math.round(cell.y)})
      </Prop>
      <Prop label="orientation">{orientText}</Prop>
      <Prop label="uid">
        <span title={d.id} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink2)" }}>
          {d.id}
        </span>
      </Prop>
      <div className="row" style={{ gap: 6, padding: "10px 12px" }}>
        <button
          type="button"
          className="btn accent"
          style={{ flex: 1, cursor: "pointer" }}
          disabled={busy}
          onClick={approve}
          title={`Create a ${cellType.name} instance here`}
        >
          Approve
        </button>
        <button
          type="button"
          className="btn"
          style={{ flex: 1, cursor: "pointer" }}
          disabled={busy}
          onClick={() => void dismiss()}
          title="Reject this proposal"
        >
          Dismiss
        </button>
      </div>
      <div className="m" style={{ padding: "0 12px 10px", fontSize: 10, color: "var(--ink3)" }}>
        <Link
          to={`/merge?die=${dieId}&type=${cellType.id}&cand=${encodeURIComponent(cell.id)}`}
          style={{ color: "var(--accent)" }}
        >
          Align & review in Merge cells
        </Link>
      </div>
    </div>
  );
}

// ── Small shared bits (mirror InspectorPanel's private helpers) ───────

function SectionHeader({ children }: { children: ReactNode }) {
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

function Title({ label, name }: { label: string; name: string }) {
  return (
    <div style={{ padding: "10px 12px", borderBottom: "1px solid var(--l1)" }}>
      <div className="u">{label}</div>
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
        {name}
      </div>
    </div>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="prop">
      <span className="lbl">{label}</span>
      <span className="val" style={{ minWidth: 0 }}>
        {children}
      </span>
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
