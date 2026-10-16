import { Fragment, type ReactNode } from "react";
import type { Cell, CellPlacementScore, CellType, DieAnnotations, DieMetadata } from "shared";
import { TreeRow, TreeSep } from "../tree/TreeRow";
import { OtherDieBadge } from "../cellLibrary/OtherDieBadge";
import type { ForeignType } from "../../lib/cellLibrary";
import { Ic } from "../../icons";
import { useMergeStore } from "../../state/mergeCells";
import {
  candidatesFor,
  cellTypeById,
  groupCellTypes,
  membersOf,
  type Candidate
} from "../../lib/mergeCells";
import { CellThumb } from "./CellThumb";
import { TypeThumb } from "./TypeThumb";
import {
  compareByMemberScore,
  mlCellId,
  type Proposal
} from "../../lib/cellDetection";
import { usePreferences } from "../../state/preferences";
import { COLOR_ML_CELL } from "../../renderer/annotations/cellDetections";

interface Props {
  /** The die's tile pyramid, which the candidate thumbnails are drawn from. */
  die: DieMetadata | null;
  annotations: DieAnnotations;
  /** Visible ML cell proposals (already threshold / overlap filtered). */
  proposals: Proposal[];
  /** Placed members' template-match scores (cell id → score), from the
   *  latest detection run of their type. */
  memberScores: ReadonlyMap<string, CellPlacementScore>;
  /** Types owned by another die of the cell library (badged, listed after
   *  this die's own). */
  foreignTypes?: ReadonlyMap<string, ForeignType>;
  /** The page's candidate list (cells, proposals, then whole types); when
   *  absent the panel derives the cell candidates itself. */
  candidates?: Candidate[];
  onCandidateContextMenu: (cell: Cell, clientX: number, clientY: number) => void;
}

export function MergeLeftPanel({
  die,
  annotations,
  proposals,
  memberScores,
  foreignTypes,
  candidates: pageCandidates,
  onCandidateContextMenu
}: Props) {
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
  const lowScore = usePreferences((s) => s.cellDetectionThreshold);
  const byScore = compareByMemberScore(memberScores);
  /** Score badge for a placed member (null when its type hasn't been run). */
  const scoreMeta = (cellId: string) => {
    const s = memberScores.get(cellId);
    if (!s) return null;
    return (
      <span
        title={`${s.matched} template vias matched · ${s.extra} unexplained`}
        style={{ color: s.score < lowScore ? "var(--err, #e36854)" : undefined }}
      >
        {s.score.toFixed(2)}
      </span>
    );
  };
  const specimenTypeId = useMergeStore((s) => s.specimenTypeId);
  const specimenCellId = useMergeStore((s) => s.specimenCellId);
  const candidateCellId = useMergeStore((s) => s.candidateCellId);
  const expandedTypes = useMergeStore((s) => s.expandedTypes);
  const unmatchedOpen = useMergeStore((s) => s.unmatchedOpen);
  const mlOpen = useMergeStore((s) => s.mlOpen);
  const setSpecimen = useMergeStore((s) => s.setSpecimen);
  const setSpecimenCell = useMergeStore((s) => s.setSpecimenCell);
  const setCandidate = useMergeStore((s) => s.setCandidate);
  const toggleType = useMergeStore((s) => s.toggleType);
  const setUnmatchedOpen = useMergeStore((s) => s.setUnmatchedOpen);
  const setMlOpen = useMergeStore((s) => s.setMlOpen);
  const proposalOverrides = useMergeStore((s) => s.proposalOverrides);

  const grouped = groupCellTypes(annotations);
  const unmatched = grouped.unmatched;
  // This die's own types first, then the ones shared from other dies.
  const matched = [
    ...grouped.matched.filter((ct) => !foreignTypes?.has(ct.id)),
    ...grouped.matched.filter((ct) => foreignTypes?.has(ct.id))
  ];
  const firstShared = matched.findIndex((ct) => foreignTypes?.has(ct.id));
  const specimenType = cellTypeById(annotations, specimenTypeId);
  const candidates =
    pageCandidates ??
    candidatesFor(annotations, specimenType, proposals, proposalOverrides, memberScores);
  // Whole cell types follow the cells, under their own heading.
  const firstType = candidates.findIndex((c) => c.mergeType);
  // Proposals grouped by type, best first within each (input is score-sorted).
  const mlGroups: { cellType: Proposal["cellType"]; items: Proposal[] }[] = [];
  for (const p of proposals) {
    const g = mlGroups.find((x) => x.cellType.id === p.cellType.id);
    if (g) g.items.push(p);
    else mlGroups.push({ cellType: p.cellType, items: [p] });
  }
  mlGroups.sort((a, b) => a.cellType.name.localeCompare(b.cellType.name, undefined, { numeric: true }));
  // Index of the first not-yet-matched candidate (done ones sort first); a
  // separator goes here when there are matched ones above it.
  const firstUndone = candidates.findIndex((c) => !c.done);

  return (
    <aside style={panelStyle}>
      {/* ── Cell Types ─────────────────────────────────────────── */}
      <div className="ph">
        <span className="u">Cell Types</span>
        <span className="m" style={{ fontSize: 10, color: "var(--ink3)", marginLeft: "auto" }}>
          {matched.length + unmatched.length}
        </span>
      </div>
      <div style={{ overflow: "auto", flex: "1 1 40%", minHeight: 60 }}>
        {matched.map((ct, i) => {
          const open = expandedTypes.includes(ct.id);
          const members = membersOf(annotations, ct.id);
          return (
            <div key={ct.id}>
              {i > 0 && i === firstShared && <TreeSep />}
              <TreeRow
                icon={Ic.cell}
                expand={members.length ? (open ? "open" : "closed") : "leaf"}
                label={typeLabel(ct)}
                meta={members.length}
                monoLabel
                selected={specimenTypeId === ct.id}
                onToggleExpand={() => toggleType(ct.id)}
                onSelect={() => setSpecimen(ct.id, null)}
              />
              {open &&
                // Worst template match first (unscored last) so a member
                // that doesn't belong stands out at the top of the list.
                [...members].sort(byScore).map((m) => (
                  <TreeRow
                    key={m.id}
                    depth={1}
                    icon={Ic.cell}
                    label={`cell ${m.id.slice(0, 6)}`}
                    meta={scoreMeta(m.id)}
                    monoLabel
                    selected={specimenTypeId === ct.id && specimenCellId === m.id}
                    onSelect={() => {
                      if (specimenTypeId !== ct.id) setSpecimen(ct.id, m.id);
                      else setSpecimenCell(m.id);
                    }}
                  />
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
            <TreeRow
              key={ct.id}
              depth={1}
              icon={Ic.cell}
              label={typeLabel(ct)}
              meta={membersOf(annotations, ct.id).length}
              monoLabel
              dimmed
              selected={specimenTypeId === ct.id}
              onSelect={() => setSpecimen(ct.id, null)}
            />
          ))}

        <TreeRow
          icon={Ic.cell}
          expand={mlOpen ? "open" : "closed"}
          label="ML proposals"
          meta={proposals.length}
          dimmed={proposals.length === 0}
          onToggleExpand={() => setMlOpen(!mlOpen)}
          onSelect={() => setMlOpen(!mlOpen)}
        />
        {mlOpen && mlGroups.length === 0 && (
          <div
            className="m"
            style={{ padding: "6px 16px", fontSize: 10, color: "var(--ink3)" }}
          >
            no ML-proposed cells — run cell detection from the die viewer's
            Cells tab
          </div>
        )}
        {mlOpen &&
          mlGroups.map((g) => (
            <TreeRow
              key={g.cellType.id}
              depth={1}
              icon={Ic.cell}
              label={typeLabel(g.cellType)}
              meta={g.items.length}
              monoLabel
              selected={specimenTypeId === g.cellType.id}
              onSelect={() => {
                // Review this type's proposals: specimen = the type, first
                // (best) proposal loaded as the candidate.
                setSpecimen(g.cellType.id, null);
                setCandidate(mlCellId(g.items[0].detection.id));
              }}
            />
          ))}
      </div>

      <TreeSep />

      {/* ── Candidates ─────────────────────────────────────────── */}
      <div className="ph">
        <span className="u">Candidates</span>
        {specimenType && (
          <span
            className="m"
            style={{ fontSize: 10, color: "var(--ink3)", marginLeft: "auto" }}
          >
            → {specimenType.name}
          </span>
        )}
      </div>
      <div style={{ overflow: "auto", flex: "1 1 60%", minHeight: 80 }}>
        {candidates.length === 0 && (
          <div
            className="m"
            style={{ padding: "10px 16px", fontSize: 10, color: "var(--ink3)" }}
          >
            {specimenType ? "nothing left to match" : "pick a cell type above"}
          </div>
        )}
        {candidates.map((c, i) => {
          const { cell, cellType, done, proposal, memberScore, mergeType } = c;
          const sel = candidateCellId === cell.id;
          const showSep = i === firstUndone && firstUndone > 0 && !mergeType;
          if (mergeType) {
            const owner = foreignTypes?.get(cellType.id)?.ownerName;
            return (
              <Fragment key={cell.id}>
                {i === firstType && (
                  <div
                    style={{
                      margin: "8px 8px 4px",
                      paddingTop: 8,
                      borderTop: "1px solid var(--l2)"
                    }}
                    title="Merge a whole cell type with the target: line it up, then Merge"
                  >
                    <span className="u" style={{ fontSize: 9, color: "var(--ink3)" }}>
                      other cell types
                    </span>
                  </div>
                )}
                <div
                  className={"trow" + (sel ? " sel" : "")}
                  style={{ padding: "5px 8px", alignItems: "center", cursor: "pointer", gap: 8 }}
                  onClick={() => setCandidate(cell.id)}
                >
                  <div
                    style={{
                      width: 40,
                      height: 28,
                      flex: "0 0 auto",
                      borderRadius: 3,
                      overflow: "hidden",
                      position: "relative",
                      border: "1px dashed var(--l2)",
                      background: "var(--canvas-bg)"
                    }}
                  >
                    <TypeThumb source={mergeType.source} />
                  </div>
                  <div className="col" style={{ minWidth: 0, gap: 1, flex: 1 }}>
                    <span
                      className="m"
                      style={{
                        fontSize: 10.5,
                        color: "var(--ink)",
                        fontWeight: 500,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap"
                      }}
                    >
                      {cellType.name}
                    </span>
                    <span style={{ fontSize: 9.5, color: "var(--ink3)" }}>
                      {Math.round(cellType.cropRect.width)}×{Math.round(cellType.cropRect.height)} px
                    </span>
                  </div>
                  {owner ? (
                    <OtherDieBadge owner={owner} />
                  ) : (
                    <span className="chip" style={{ fontSize: 9 }} title="A whole cell type of this die">
                      type
                    </span>
                  )}
                </div>
              </Fragment>
            );
          }
          return (
            <Fragment key={cell.id}>
              {showSep && (
                <div
                  style={{
                    margin: "8px 8px 4px",
                    paddingTop: 8,
                    borderTop: "1px solid var(--l2)"
                  }}
                >
                  <span className="u" style={{ fontSize: 9, color: "var(--ink3)" }}>
                    to match
                  </span>
                </div>
              )}
              <div
                className={"trow" + (sel ? " sel" : "")}
              style={{
                padding: "5px 8px",
                alignItems: "center",
                cursor: "pointer",
                gap: 8
              }}
              onClick={() => setCandidate(cell.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setCandidate(cell.id);
                onCandidateContextMenu(cell, e.clientX, e.clientY);
              }}
            >
              <div
                style={{
                  width: 40,
                  height: 28,
                  flex: "0 0 auto",
                  borderRadius: 3,
                  overflow: "hidden",
                  position: "relative",
                  border: "1px solid var(--l2)",
                  background: "var(--canvas-bg)"
                }}
              >
                <CellThumb die={die} cell={c.cell} cellType={c.cellType} />
                {done && (
                  <span
                    style={{
                      position: "absolute",
                      inset: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "rgba(20,40,28,0.45)",
                      color: "var(--ok)"
                    }}
                  >
                    {CHECK}
                  </span>
                )}
              </div>
              <div className="col" style={{ minWidth: 0, gap: 1, flex: 1 }}>
                <span
                  className="m"
                  style={{ fontSize: 10.5, color: "var(--ink)", fontWeight: 500 }}
                >
                  {proposal
                    ? `ML · ${proposal.detection.score.toFixed(2)}`
                    : `cell ${cell.id.slice(0, 6)}`}
                </span>
                <span style={{ fontSize: 9.5, color: "var(--ink3)" }}>
                  {Math.round(cellType.cropRect.width)}×
                  {Math.round(cellType.cropRect.height)} px
                </span>
              </div>
              {proposal && !done && (
                <span
                  className="chip"
                  style={{ fontSize: 9, color: COLOR_ML_CELL, borderColor: COLOR_ML_CELL }}
                  title={`${proposal.detection.matched} template vias matched, ${proposal.detection.extra} unexplained`}
                >
                  ML
                </span>
              )}
              {done && memberScore && (
                <span
                  className="chip"
                  style={{
                    fontSize: 9,
                    color: memberScore.score < lowScore ? "var(--err, #e36854)" : undefined,
                    borderColor: memberScore.score < lowScore ? "var(--err, #e36854)" : undefined
                  }}
                  title={`Template match: ${memberScore.matched} vias matched · ${memberScore.extra} unexplained`}
                >
                  {memberScore.score.toFixed(2)}
                </span>
              )}
              {done && (
                <span className="chip ok" style={{ fontSize: 9 }}>
                  merged
                </span>
              )}
              </div>
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}

const CHECK = (
  <svg viewBox="0 0 16 16" className="ico" fill="none" stroke="currentColor" strokeWidth={2}>
    <path d="M3 8.5l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const panelStyle: React.CSSProperties = {
  width: 248,
  flex: "0 0 auto",
  background: "var(--card)",
  borderRight: "1px solid var(--l2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0
};
