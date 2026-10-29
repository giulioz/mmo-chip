import type { DieAnnotations } from "shared";
import type { Rect } from "../../lib/geometry";
import { formatPercent } from "../../lib/format";
import { useLiveValue, type LiveValue } from "../../lib/liveValue";
import type { Viewport } from "../../renderer/types";

/** Small presentational pieces for the Die viewer. Kept dumb so they can
 *  subscribe to hot-path LiveValues without re-rendering the page. */

export function MarqueeOverlay({ store }: { store: LiveValue<Rect | null> }) {
  const rect = useLiveValue(store);
  if (!rect) return null;
  return (
    <div
      style={{
        position: "absolute",
        left: rect.x,
        top: rect.y,
        width: rect.width,
        height: rect.height,
        border: "1px solid rgba(58, 169, 255, 0.95)",
        background: "rgba(58, 169, 255, 0.12)",
        pointerEvents: "none"
      }}
    />
  );
}

export function ZoomChip({ store }: { store: LiveValue<Viewport | null> }) {
  const vp = useLiveValue(store);
  return <span className="chip">{vp ? formatPercent(vp.zoom * 100) : "—"}</span>;
}

export function ZoomReadout({ store }: { store: LiveValue<Viewport | null> }) {
  const vp = useLiveValue(store);
  return <span>{vp ? formatPercent(vp.zoom * 100) : "—"}</span>;
}

export function CursorReadout({
  store
}: {
  store: LiveValue<{ x: number; y: number } | null>;
}) {
  const c = useLiveValue(store);
  if (!c) return <span style={{ color: "var(--ink3)" }}>x — · y —</span>;
  return (
    <span>
      x {Math.round(c.x).toLocaleString()} · y {Math.round(c.y).toLocaleString()}
    </span>
  );
}

export function annotationsSummary(a: DieAnnotations): string | null {
  const counts: string[] = [];
  if (a.cells.length) counts.push(`${a.cells.length} cells`);
  if (a.nets.length) counts.push(`${a.nets.length} nets`);
  if (a.blocks?.length) counts.push(`${a.blocks.length} blocks`);
  const vias = a.annotations?.length ?? 0;
  if (vias) counts.push(`${vias} vias`);
  if (a.rois?.length) counts.push(`${a.rois.length} rois`);
  if (a.ignores?.length) counts.push(`${a.ignores.length} ignores`);
  if (a.pins?.length) counts.push(`${a.pins.length} pins`);
  return counts.length ? counts.join(" · ") : null;
}

export const panelStyle: React.CSSProperties = {
  background: "var(--card)",
  borderRight: "1px solid var(--l2)",
  display: "flex",
  flexDirection: "column",
  minHeight: 0
};

export function Tool({
  icon,
  on,
  label,
  todo,
  onClick
}: {
  icon: React.ReactNode;
  on?: boolean;
  label?: string;
  /** Not implemented yet — renders disabled with a "(coming soon)" hint. */
  todo?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={"tool" + (on ? " on" : "") + (todo ? " todo" : "")}
      title={todo ? `${label ?? ""} (coming soon)` : label}
      disabled={todo}
      onClick={todo ? undefined : onClick}
    >
      {icon}
    </button>
  );
}

/** A wider, slightly stronger separator between major toolbar regions
 *  (e.g. tools → per-tool options). */
export function BigToolDivider() {
  return (
    <div
      style={{
        width: 1,
        height: 22,
        background: "var(--l3)",
        margin: "0 10px"
      }}
    />
  );
}

export function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 10.5,
        letterSpacing: 0.6,
        textTransform: "uppercase",
        color: "var(--ink3)"
      }}
    >
      {children}
    </div>
  );
}

export function CenteredStatus({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "rgba(255,255,255,0.6)",
        fontSize: 11,
        letterSpacing: 0.4
      }}
    >
      {children}
    </div>
  );
}
