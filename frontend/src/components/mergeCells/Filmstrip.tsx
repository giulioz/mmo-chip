import { Fragment } from "react";
import type { Cell, DieMetadata } from "shared";
import type { ForeignType } from "../../lib/cellLibrary";
import type { Candidate } from "../../lib/mergeCells";
import { COLOR_ML_CELL } from "../../renderer/annotations/cellDetections";
import { CellThumb } from "./CellThumb";
import { TypeThumb } from "./TypeThumb";

interface Props {
  /** The die's tile pyramid, which the thumbnails are drawn from. */
  die: DieMetadata | null;
  candidates: Candidate[];
  selectedId: string | null;
  onPick: (cell: Cell) => void;
  onContextMenu: (cell: Cell, clientX: number, clientY: number) => void;
  /** Types owned by another die of the cell library (named in tooltips). */
  foreignTypes?: ReadonlyMap<string, ForeignType>;
}

/** Horizontal, scrollable strip of the candidates still left to match
 *  (already-merged ones are dropped — they live in the left panel). */
export function Filmstrip({ die, candidates, selectedId, onPick, onContextMenu, foreignTypes }: Props) {
  const visible = candidates.filter((c) => !c.done);
  // Whole cell types come after the cells, past a divider.
  const firstType = visible.findIndex((c) => c.mergeType);
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 72,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 8px",
        overflowX: "auto",
        overflowY: "hidden",
        background: "var(--card)",
        borderTop: "1px solid var(--l2)"
      }}
    >
      {visible.length === 0 && (
        <span className="m" style={{ fontSize: 10, color: "var(--ink3)", padding: "0 6px" }}>
          nothing left to match
        </span>
      )}
      {visible.map((c, i) => {
        const { cell, proposal, mergeType } = c;
        const sel = selectedId === cell.id;
        const owner = mergeType ? foreignTypes?.get(c.cellType.id)?.ownerName : undefined;
        return (
          <Fragment key={cell.id}>
          {i === firstType && (
            <div
              title="Whole cell types — merge one with the target type"
              style={{ flex: "0 0 auto", alignSelf: "stretch", display: "flex", alignItems: "center", gap: 6 }}
            >
              {i > 0 && <div style={{ width: 1, alignSelf: "stretch", background: "var(--l2)" }} />}
              <span className="u" style={{ fontSize: 9, color: "var(--ink3)", writingMode: "vertical-rl", transform: "rotate(180deg)" }}>
                types
              </span>
            </div>
          )}
          <div
            title={
              mergeType
                ? `cell type ${c.cellType.name}${owner ? ` · other die (${owner})` : ""}`
                : proposal
                  ? `ML proposal · ${proposal.detection.score.toFixed(2)}`
                  : `cell ${cell.id.slice(0, 8)}`
            }
            onClick={() => onPick(cell)}
            onContextMenu={(e) => {
              e.preventDefault();
              onPick(cell);
              onContextMenu(cell, e.clientX, e.clientY);
            }}
            style={{
              position: "relative",
              flex: "0 0 auto",
              width: 84,
              height: 58,
              borderRadius: 3,
              overflow: "hidden",
              cursor: "pointer",
              background: "var(--canvas-bg)",
              // Longhands (not the `border` shorthand) so the proposal's
              // pink top edge can differ from the other sides without React
              // warning about conflicting style properties.
              borderStyle: "solid",
              borderWidth: proposal ? "2px 1px 1px" : 1,
              borderColor: proposal
                ? `${COLOR_ML_CELL} ${sel ? "var(--accent)" : "var(--l2)"} ${sel ? "var(--accent)" : "var(--l2)"}`
                : sel
                  ? "var(--accent)"
                  : "var(--l2)",
              outline: sel ? "1px solid var(--accent)" : "none"
            }}
          >
            {mergeType ? (
              <>
                <TypeThumb source={mergeType.source} />
                <span
                  className="m"
                  style={{
                    position: "absolute",
                    left: 0,
                    right: 0,
                    bottom: 0,
                    padding: "1px 4px",
                    fontSize: 9,
                    color: "#fff",
                    background: "rgba(20,24,32,0.72)",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis"
                  }}
                >
                  {owner ? "◆ " : ""}
                  {c.cellType.name}
                </span>
              </>
            ) : (
              <CellThumb die={die} cell={c.cell} cellType={c.cellType} />
            )}
          </div>
          </Fragment>
        );
      })}
    </div>
  );
}
