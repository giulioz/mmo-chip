import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { CellExtraction } from "../../lib/extraction";
import {
  layoutNetlist,
  type NetlistLayout,
} from "../../lib/schematic/netlist";
import { dumpNetlist } from "../../lib/schematic/netlistDump";
import { netDisplayName } from "../../lib/labels";
import type { HoverEntity } from "./hoverEntity";

/**
 * Logic-level netlist canvas. Renders the cell as one symbol per CMOS
 * domain plus boundary I/O pins, wired together by net through
 * ELK-laid-out orthogonal Manhattan routes.
 *
 * Where the previous (Phase 2) implementation collapsed `cell.logic`
 * into a single decomposed tree and only worked for trivial
 * combinational cells, this view operates directly on the domain
 * structure — so it works for ANY cell with at least one domain, not
 * just single-output combinational. Multi-output cells, sequential
 * loops, and chains all render naturally; ELK handles the placement +
 * routing.
 *
 * Pan/zoom mirrors `SchematicCanvas` for muscle-memory consistency.
 * Hover sync routes through the shared `HoverEntity` so wires and
 * gates highlight the matching rows in the right panel.
 *
 * Phase 3a scope: domain gates + I/O pins only. TGs and pass
 * transistors don't appear yet (Phase 3b); cells that rely on them
 * will look incomplete in this view.
 */

interface Props {
  extraction: CellExtraction | null;
  /** Currently-hovered entity (from anywhere — schematic, right
   *  panel, image canvas). The canvas narrowly highlights only the
   *  wires / nodes that match. */
  hover?: HoverEntity;
  /** Fires on cursor enter / leave a wire / gate / I/O pin. Page
   *  routes through shared hover state. */
  onHoverEntity?: (entity: HoverEntity) => void;
}

interface View {
  tx: number;
  ty: number;
  scale: number;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 8;
const WHEEL_FACTOR = 0.01;
/** Wire-stroke widths. The hit overlay is wider than the visible line
 *  so the user can hover thin wires without pixel-perfect aiming. */
const WIRE_STROKE = 1.4;
const WIRE_HIT_WIDTH = 12;
const HL_COLOR = "#7fb2ff";

export function LogicSchematicCanvas({
  extraction,
  hover,
  onHoverEntity,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ tx: 0, ty: 0, scale: 1 });
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);

  // Resize observer: re-fits when the right panel slides or the window
  // changes. Same pattern as SchematicCanvas.
  useLayoutEffect(() => {
    const el = hostRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Net-id → display label. Used inside the layout for I/O pin labels
  // and at the canvas level for hover labels. Uses the shared
  // `netDisplayName` cascade (customName > label > netN).
  const netName = useMemo(() => {
    const labels = new Map<number, string>();
    if (extraction?.kind === "inferred") {
      for (const n of extraction.nets) labels.set(n.id, netDisplayName(n));
    }
    return (id: number) => labels.get(id) ?? `net${id}`;
  }, [extraction]);

  // Async netlist layout. ELK returns a Promise so we hold the result
  // in state and gate re-runs on the extraction identity. Cancellation
  // via a sentinel flag — if the user switches cells before layout
  // finishes, we drop the stale result on arrival.
  const [layout, setLayout] = useState<NetlistLayout | null>(null);
  const [laying, setLaying] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  useEffect(() => {
    if (extraction?.kind !== "inferred") {
      setLayout(null);
      setLayoutError(null);
      return;
    }
    if (extraction.domains.length === 0) {
      setLayout(null);
      setLayoutError(null);
      return;
    }
    let cancelled = false;
    setLaying(true);
    setLayoutError(null);
    layoutNetlist(extraction, netName)
      .then((result) => {
        if (cancelled) return;
        setLayout(result);
        setLaying(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setLayoutError(err instanceof Error ? err.message : String(err));
        setLaying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [extraction, netName]);

  // Auto-fit on layout / size change. Keyed on the bbox + viewport
  // size so a re-render with identical inputs doesn't fight a user
  // pan/zoom in progress.
  const lastFitKey = useRef<string | null>(null);
  useEffect(() => {
    if (!layout || size.w === 0 || size.h === 0) return;
    const { bbox } = layout;
    if (bbox.width === 0 || bbox.height === 0) return;
    const key = `${bbox.width}x${bbox.height}|${size.w}x${size.h}`;
    if (lastFitKey.current === key) return;
    lastFitKey.current = key;
    const margin = 24;
    const scale = clamp(
      Math.min(
        (size.w - margin * 2) / bbox.width,
        (size.h - margin * 2) / bbox.height,
      ),
      MIN_SCALE,
      MAX_SCALE,
    );
    const tx = size.w / 2 - (bbox.width / 2) * scale;
    const ty = size.h / 2 - (bbox.height / 2) * scale;
    setView({ tx, ty, scale });
  }, [layout, size.w, size.h]);

  // Wheel + gesture handling. Same conventions as SchematicCanvas;
  // re-binds when `showSvg` flips so placeholder → canvas transitions
  // don't lose the listeners (the bug we fixed earlier).
  const showSvg = !!layout;
  useEffect(() => {
    if (!showSvg) return;
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = svg.getBoundingClientRect();
      const cx = e.clientX - r.left;
      const cy = e.clientY - r.top;
      setView((v) => {
        if (e.ctrlKey || e.metaKey) {
          const next = clamp(v.scale * Math.exp(-e.deltaY * WHEEL_FACTOR), MIN_SCALE, MAX_SCALE);
          if (next === v.scale) return v;
          const worldX = (cx - v.tx) / v.scale;
          const worldY = (cy - v.ty) / v.scale;
          return { scale: next, tx: cx - worldX * next, ty: cy - worldY * next };
        } else if (e.shiftKey) {
          return { ...v, tx: v.tx - e.deltaY, ty: v.ty - e.deltaX };
        } else {
          return { ...v, tx: v.tx - e.deltaX, ty: v.ty - e.deltaY };
        }
      });
    };
    const preventGesture = (e: Event) => e.preventDefault();
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("gesturestart", preventGesture, { passive: false });
    svg.addEventListener("gesturechange", preventGesture, { passive: false });
    svg.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("gesturestart", preventGesture);
      svg.removeEventListener("gesturechange", preventGesture);
      svg.removeEventListener("gestureend", preventGesture);
    };
  }, [showSvg]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      if (e.button !== 0 && e.button !== 1) return;
      svgRef.current?.setPointerCapture(e.pointerId);
      dragRef.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
    },
    [view.tx, view.ty],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const d = dragRef.current;
      if (!d) return;
      setView((v) => ({
        ...v,
        tx: d.tx + (e.clientX - d.sx),
        ty: d.ty + (e.clientY - d.sy),
      }));
    },
    [],
  );
  const endDrag = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    svgRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  // Cheap predicates for the narrow hover highlight.
  const netHovered = useCallback(
    (netId: number | undefined) =>
      hover?.kind === "net" && netId != null && hover.netId === netId,
    [hover],
  );
  const domainHovered = useCallback(
    (domainId: string) =>
      hover?.kind === "domain" && hover.domainId === domainId,
    [hover],
  );

  // ── Render ────────────────────────────────────────────────

  if (extraction?.kind !== "inferred") {
    return (
      <Placeholder host={hostRef}>
        select a cell type to view its logic schematic
      </Placeholder>
    );
  }
  if (extraction.domains.length === 0) {
    return (
      <Placeholder host={hostRef}>
        <div>no CMOS domains detected</div>
        <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 6 }}>
          the cell needs at least one CMOS pull-up/pull-down pair to
          render a logic netlist
        </div>
      </Placeholder>
    );
  }
  if (layoutError) {
    return (
      <Placeholder host={hostRef}>
        <div>layout failed</div>
        <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 6 }}>
          {layoutError}
        </div>
      </Placeholder>
    );
  }
  if (!layout) {
    return (
      <Placeholder host={hostRef}>{laying ? "laying out…" : "loading…"}</Placeholder>
    );
  }

  return (
    <div
      ref={hostRef}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: 0,
        background: "var(--canvas-bg)",
        overflow: "hidden",
        overscrollBehavior: "none",
      }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        style={{
          display: "block",
          cursor: dragRef.current ? "grabbing" : "default",
          touchAction: "none",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        <g transform={`translate(${view.tx}, ${view.ty}) scale(${view.scale})`}>
          {/* Wires first so symbol bodies cover the endpoints cleanly.
              Each hyperedge from ELK may have multiple polyline
              sections (one per source-to-target branch) that share
              segments visually; render them independently and the
              visual overlap looks like a single net. */}
          {layout.edges.map((e) => {
            const on = netHovered(e.netId);
            return (
              <g
                key={e.id}
                onMouseEnter={() => onHoverEntity?.({ kind: "net", netId: e.netId })}
                onMouseLeave={() => onHoverEntity?.(null)}
              >
                {e.polylines.map((line, li) => {
                  const pts = line.map((p) => `${p.x},${p.y}`).join(" ");
                  return (
                    <g key={li}>
                      {/* Invisible wide hit overlay so thin wires are
                          easy to pick — same trick the CMOS schematic
                          uses. */}
                      <polyline
                        points={pts}
                        fill="none"
                        stroke="transparent"
                        strokeWidth={WIRE_HIT_WIDTH}
                        pointerEvents="stroke"
                      />
                      <polyline
                        points={pts}
                        fill="none"
                        stroke={on ? HL_COLOR : "var(--ink2)"}
                        strokeWidth={on ? WIRE_STROKE + 1.2 : WIRE_STROKE}
                        strokeLinejoin="round"
                        strokeLinecap="round"
                        pointerEvents="none"
                      />
                    </g>
                  );
                })}
              </g>
            );
          })}
          {/* Junction dots — explicit 3+-way meetings ELK computed for
              hyperedges. Drawn ABOVE the wires so the dot is the top
              layer, READS as the electrical join. */}
          {layout.junctions.map((j, i) => {
            const on = netHovered(j.netId);
            return (
              <circle
                key={`j-${i}`}
                cx={j.x}
                cy={j.y}
                r={2.6}
                fill={on ? HL_COLOR : "var(--ink2)"}
                pointerEvents="none"
              />
            );
          })}
          {/* Symbols last so their bodies sit above the wire ends. */}
          {layout.nodes.map((n) => {
            let on = false;
            let entityOnHover: HoverEntity = null;
            switch (n.meta.kind) {
              case "gate":
                on = domainHovered(n.meta.domainId);
                entityOnHover = { kind: "domain", domainId: n.meta.domainId };
                break;
              case "tg":
                on = hover?.kind === "tg" && hover.tgId === n.meta.tgId;
                entityOnHover = { kind: "tg", tgId: n.meta.tgId };
                break;
              case "pass":
                on =
                  hover?.kind === "transistor" &&
                  hover.transistorId === n.meta.transistorId;
                entityOnHover = {
                  kind: "transistor",
                  transistorId: n.meta.transistorId,
                };
                break;
              case "cell-input":
              case "cell-output":
              case "rail-input":
              case "orphan-input":
                on = netHovered(n.meta.netId);
                entityOnHover = { kind: "net", netId: n.meta.netId };
                break;
            }
            return (
              <g
                key={n.id}
                transform={`translate(${n.x}, ${n.y})`}
                onMouseEnter={() => onHoverEntity?.(entityOnHover)}
                onMouseLeave={() => onHoverEntity?.(null)}
              >
                {/* Hover halo behind the symbol so the lines stay crisp. */}
                {on && (
                  <rect
                    x={-3}
                    y={-3}
                    width={n.width + 6}
                    height={n.height + 6}
                    rx={5}
                    fill={HL_COLOR}
                    fillOpacity={0.18}
                    stroke={HL_COLOR}
                    strokeWidth={1.6}
                    pointerEvents="none"
                  />
                )}
                {n.svg}
                {/* Transparent hit overlay so the whole bounding box
                    receives pointer events, not just the painted
                    strokes (matters most for the I/O pin rectangles
                    whose interior is a fill-no-stroke text). */}
                <rect
                  x={0}
                  y={0}
                  width={n.width}
                  height={n.height}
                  fill="transparent"
                  pointerEvents="all"
                />
              </g>
            );
          })}
        </g>
      </svg>
      <CopyDumpButton extraction={extraction} netName={netName} />
    </div>
  );
}

/**
 * Floating "Copy text" button in the canvas corner. Dumps the cell's
 * full netlist as a text description (see `dumpNetlist`) and copies
 * it to the clipboard. Use case: paste into a chat with an LLM and
 * ask "what does this cell implement?" — the dump includes
 * everything the LLM needs (boolean per domain, TG connectivity,
 * pass-tx wiring, net driver/consumer map).
 */
function CopyDumpButton({
  extraction,
  netName,
}: {
  extraction: Extract<CellExtraction, { kind: "inferred" }>;
  netName: (id: number) => string;
}) {
  const [copied, setCopied] = useState(false);
  const onClick = useCallback(async () => {
    const text = dumpNetlist(extraction, netName);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can fail on insecure origins or when the user
      // denies permission — fall back to a window prompt so the text
      // is at least selectable manually.
      window.prompt("Netlist dump (Cmd+C to copy):", text);
    }
  }, [extraction, netName]);
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy a text representation of this cell's netlist to the clipboard (paste into a chat to analyse the cell)"
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1,
        padding: "4px 8px",
        fontFamily: "var(--mono, ui-monospace)",
        fontSize: 10,
        color: copied ? "var(--ok)" : "var(--ink2)",
        background: "var(--card)",
        border: "1px solid var(--l2)",
        borderRadius: 3,
        cursor: "pointer",
      }}
    >
      {copied ? "copied ✓" : "copy text"}
    </button>
  );
}

function Placeholder({
  host,
  children,
}: {
  host: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  return (
    <div
      ref={host}
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--canvas-bg)",
        color: "var(--ink3)",
        fontSize: 12,
        textAlign: "center",
        padding: 24,
      }}
    >
      {children}
    </div>
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
