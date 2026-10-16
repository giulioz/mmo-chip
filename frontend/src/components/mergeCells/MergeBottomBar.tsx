import { ToolDivider } from "../shell/SubBar";

/** The die-scale control, offered while the comparison puts this die's
 *  pixels next to another die's (a cell type shared through the library). */
export interface ScaleControl {
  /** This die's pixels per pixel of the other die. */
  ratio: number;
  otherName: string;
  /** A scale being tried out, not saved yet. */
  pending: boolean;
  busy: boolean;
  /** Nudge it: ×1.001 (`coarse`: ×1.01) up, or down. */
  onStep: (up: boolean, coarse: boolean) => void;
  onSetRatio: (ratio: number) => void;
  onSave: () => void;
  onReset: () => void;
}

interface Props {
  /** A candidate is loaded (enables the orientation + tinder controls). */
  hasCandidate: boolean;
  /** A specimen type is selected (enables Merge). */
  specimenName: string | null;
  onFlipH: () => void;
  onFlipV: () => void;
  onRotateCw: () => void;
  /** Vias for both cells loaded — auto-align is actionable. Pass null when
   *  the page hasn't fetched both sets yet (or when the user has the ML-via
   *  overlay toggled off): the button stays present but disabled. */
  onAutoAlign: (() => void) | null;
  onSkip: () => void;
  onMerge: () => void;
  /** The candidate is an ML proposal: Merge reads "Approve" and Dismiss
   *  becomes available. */
  candidateIsProposal?: boolean;
  onDismiss?: (() => void) | null;
  /** Merging two whole types: the button names the outcome ("Merge A into
   *  B") and auto-align isn't offered. */
  typeMergeLabel?: string | null;
  scale?: ScaleControl | null;
}

export function MergeBottomBar({
  hasCandidate,
  specimenName,
  onFlipH,
  onFlipV,
  onRotateCw,
  onAutoAlign,
  onSkip,
  onMerge,
  candidateIsProposal = false,
  onDismiss = null,
  typeMergeLabel = null,
  scale = null
}: Props) {
  const canMerge = hasCandidate && !!specimenName;
  return (
    <div
      style={{
        flex: "0 0 auto",
        height: 44,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 10px",
        background: "var(--card)",
        borderTop: "1px solid var(--l2)"
      }}
    >
      <button
        className="btn"
        disabled={!hasCandidate}
        onClick={onFlipH}
        title="Flip horizontally (F)"
      >
        {FLIP_H} Flip H <Kb>F</Kb>
      </button>
      <button
        className="btn"
        disabled={!hasCandidate}
        onClick={onFlipV}
        title="Flip vertically (G)"
      >
        {FLIP_V} Flip V <Kb>G</Kb>
      </button>
      <button
        className="btn"
        disabled={!hasCandidate}
        onClick={onRotateCw}
        title="Rotate 90° clockwise (H)"
      >
        {ROTATE} 90° <Kb>H</Kb>
      </button>
      <button
        className="btn"
        disabled={!hasCandidate || !onAutoAlign}
        onClick={onAutoAlign ?? undefined}
        title={
          onAutoAlign
            ? "Auto-align from ML vias (J)"
            : "Enable the ML vias overlay above and wait for both cells to load"
        }
      >
        {ALIGN} Auto align <Kb>J</Kb>
      </button>
      {scale && <ScaleGroup scale={scale} />}
      <div style={{ flex: 1 }} />
      {candidateIsProposal && (
        <button
          className="btn"
          disabled={!hasCandidate || !onDismiss}
          onClick={onDismiss ?? undefined}
          title="Reject this ML proposal (N)"
        >
          Dismiss <Kb>N</Kb>
        </button>
      )}
      <button className="btn" disabled={!hasCandidate} onClick={onSkip}>
        Skip
      </button>
      <ToolDivider />
      <button
        className="btn accent"
        disabled={!canMerge}
        onClick={onMerge}
        title={
          typeMergeLabel
            ? "Merge the two cell types into one — every instance of either, on every die, keeps its pixels; the type with more annotations survives (Y)"
            : candidateIsProposal
              ? "Approve proposal (Y)"
              : "Accept & merge (Y)"
        }
      >
        {CHECK}{" "}
        {typeMergeLabel ??
          `${candidateIsProposal ? "Approve" : "Merge"}${specimenName ? ` into ${specimenName}` : ""}`}{" "}
        <Kb>Y</Kb>
      </button>
    </div>
  );
}

const formatRatio = (r: number) => r.toFixed(4);

function ScaleGroup({ scale }: { scale: ScaleControl }) {
  const shown = formatRatio(scale.ratio);
  const commit = (el: HTMLInputElement) => {
    const v = Number(el.value.trim().replace(/^×/, ""));
    if (!Number.isFinite(v) || v <= 0 || formatRatio(v) === shown) {
      el.value = shown;
      return;
    }
    scale.onSetRatio(v);
  };
  return (
    <>
      <ToolDivider />
      <span
        className="u"
        style={{ fontSize: 10 }}
        title={`This die's pixels per pixel of ${scale.otherName} — sets the die's scale, so every cell type from that die resizes`}
      >
        Scale
      </span>
      <button
        className="btn ghost"
        title="Smaller by 0.1% — Shift: 1% ( [ )"
        onClick={(e) => scale.onStep(false, e.shiftKey)}
      >
        −
      </button>
      <label className="input" style={{ width: 70 }} title={`× ${scale.otherName}'s pixels`}>
        <input
          key={shown}
          defaultValue={shown}
          inputMode="decimal"
          spellCheck={false}
          onBlur={(e) => commit(e.currentTarget)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") {
              e.currentTarget.value = shown;
              e.currentTarget.blur();
            }
          }}
        />
      </label>
      <button
        className="btn ghost"
        title="Bigger by 0.1% — Shift: 1% ( ] )"
        onClick={(e) => scale.onStep(true, e.shiftKey)}
      >
        +
      </button>
      {scale.pending && (
        <>
          <button
            className="btn"
            style={{ color: "var(--accent)", borderColor: "var(--accent)" }}
            disabled={scale.busy}
            title="Save this die's scale (Merge saves it too)"
            onClick={scale.onSave}
          >
            Set scale
          </button>
          <button className="btn ghost" title="Back to the saved scale" onClick={scale.onReset}>
            ↺
          </button>
        </>
      )}
    </>
  );
}

/** Tiny inline keyboard-shortcut hint. */
function Kb({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        minWidth: 12,
        padding: "0 3px",
        marginLeft: 4,
        borderRadius: 3,
        border: "1px solid var(--l2)",
        background: "var(--panel)",
        font: "inherit",
        fontSize: 9,
        lineHeight: "13px",
        textAlign: "center",
        color: "var(--ink3)"
      }}
    >
      {children}
    </kbd>
  );
}

const ico = (children: React.ReactNode) => (
  <svg
    viewBox="0 0 16 16"
    className="ico"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.4}
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    {children}
  </svg>
);

const FLIP_H = ico(
  <>
    <path d="M8 2v12" strokeDasharray="2 1.6" />
    <path d="M6 5L2.5 8 6 11zM10 5l3.5 3-3.5 3z" />
  </>
);
const FLIP_V = ico(
  <>
    <path d="M2 8h12" strokeDasharray="2 1.6" />
    <path d="M5 6L8 2.5 11 6zM5 10l3 3.5 3-3.5z" />
  </>
);
const ROTATE = ico(
  <>
    <path d="M13 8a5 5 0 11-1.5-3.5" />
    <path d="M13 2v3h-3" />
  </>
);
const ALIGN = ico(
  <>
    <circle cx="4" cy="4" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="4" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="8" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <path d="M4 4h8M4 4l4 8M12 4l-4 8" />
  </>
);
const CHECK = ico(<path d="M3 8.5l3 3 7-7" />);
