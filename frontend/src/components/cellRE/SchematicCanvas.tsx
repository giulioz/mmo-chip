import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  CmosDomain,
  ExtractedNet,
  InferredCellExtraction,
  Transistor,
} from "../../lib/extraction";
import {
  renderDomain,
  type GateInput,
  type PlacedSymbol,
  type Point,
  type Wire,
} from "../../lib/schematic/domain";
import { dumpCmos } from "../../lib/schematic/cmosDump";
import { netDisplayName } from "../../lib/labels";
import type { HoverEntity } from "./hoverEntity";

interface Props {
  domain: CmosDomain | null;
  transistors: ReadonlyArray<Transistor>;
  nets: ReadonlyArray<ExtractedNet>;
  /** Full extraction — used only by the "copy text" dump button.
   *  Omitting it hides the button (e.g. before extraction completes). */
  extraction?: InferredCellExtraction | null;
  /** Currently hovered entity (shared across schematic, right panel and
   *  image canvas). The schematic only narrowly highlights the `net` and
   *  `transistor` kinds; other kinds (`diffusion`, `domain`, …) are
   *  intentionally ignored — they have no schematic representation. */
  hover?: HoverEntity;
  /** Fired when the cursor enters / leaves a schematic element (wire, rail,
   *  output label, transistor body, gate stub). The payload is a typed
   *  entity the page can route through the rest of the UI; `null` clears. */
  onHoverEntity?: (entity: HoverEntity) => void;
}

interface View {
  tx: number;
  ty: number;
  scale: number;
}

const MIN_SCALE = 0.1;
const MAX_SCALE = 6;
const WHEEL_FACTOR = 0.01;

/**
 * Schematic-tab canvas. Pure SVG; pan/zoom via a single `<g transform>` on
 * the root group. Renders one `CmosDomain` at a time (the active one),
 * decomposed and placed by `renderDomain`. Symbols are normal SVG groups,
 * so hover and click are stock DOM events — no extra hit-testing needed.
 *
 * The hover plumbing intentionally only carries a transistor id back to
 * the page. The page already knows how to fold a transistor into its
 * (gate poly + parent diffusion) shape keys, and routing that mapping
 * through here would duplicate logic.
 */
export function SchematicCanvas({
  domain,
  transistors,
  nets,
  extraction,
  hover,
  onHoverEntity,
}: Props) {
  // Tiny adapters around the unified `onHoverEntity` callback so the
  // individual element components stay terse (they don't have to construct
  // entity objects themselves).
  const emitNet = useCallback(
    (netId: number | null) =>
      onHoverEntity?.(netId == null ? null : { kind: "net", netId }),
    [onHoverEntity],
  );
  const emitTransistor = useCallback(
    (transistorId: string | null) =>
      onHoverEntity?.(
        transistorId == null
          ? null
          : { kind: "transistor", transistorId },
      ),
    [onHoverEntity],
  );
  const hostRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [view, setView] = useState<View>({ tx: 0, ty: 0, scale: 1 });
  const dragRef = useRef<{ sx: number; sy: number; tx: number; ty: number } | null>(null);

  // Observe host size so resizing the right panel (or the window) rebuilds
  // the fit-to-viewport scale. Falls back to a single read on mount when
  // ResizeObserver isn't around (tests, very old browsers).
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

  // Recompute the schematic whenever inputs change. `renderDomain` is pure
  // — it'll happily re-run on every prop tick — but it's still O(N²) in
  // transistor count via the SP-decompose so we memo on identity.
  const result = useMemo(() => {
    if (!domain) return null;
    return renderDomain(domain, transistors, nets);
  }, [domain, transistors, nets]);

  // Cheap O(1) predicates over the typed hover target. Each schematic
  // element type asks "does this hover apply to me?" — narrow on purpose
  // so e.g. hovering a net doesn't light up every transistor that
  // touches it.
  const netHovered = useCallback(
    (netId: number | undefined) =>
      hover?.kind === "net" && netId != null && hover.netId === netId,
    [hover],
  );
  const transistorHovered = useCallback(
    (id: string) => hover?.kind === "transistor" && hover.transistorId === id,
    [hover],
  );

  // Auto-fit to viewport on first render of a new schematic. Re-fits on
  // domain switch (different bbox) and on container resize. We compare the
  // bbox identity rather than store an explicit "fitted" flag because
  // `view` is the canonical source of truth for the transform.
  const lastFittedBboxKey = useRef<string | null>(null);
  useEffect(() => {
    if (!result || !result.ok || size.w === 0 || size.h === 0) return;
    const { bbox } = result.view;
    const key = `${domain?.id}|${bbox.x},${bbox.y},${bbox.width},${bbox.height}|${size.w}x${size.h}`;
    if (lastFittedBboxKey.current === key) return;
    lastFittedBboxKey.current = key;
    const margin = 24;
    const scale = clamp(
      Math.min(
        (size.w - margin * 2) / bbox.width,
        (size.h - margin * 2) / bbox.height,
      ),
      MIN_SCALE,
      MAX_SCALE,
    );
    const tx = size.w / 2 - (bbox.x + bbox.width / 2) * scale;
    const ty = size.h / 2 - (bbox.y + bbox.height / 2) * scale;
    setView({ tx, ty, scale });
  }, [result, size.w, size.h, domain?.id]);

  // ── Pan / zoom ────────────────────────────────────────────────
  //
  // Wheel semantics match the rest of the app's canvases:
  //   - ctrl / meta + wheel  → zoom around the cursor (also fires when a
  //     trackpad pinch-gesture comes in synthesised as a ctrl+wheel)
  //   - plain wheel          → pan via deltaX / deltaY (two-finger
  //     trackpad scroll, vertical mouse wheel acts as vertical pan)
  // The handler is attached via raw addEventListener with {passive:false}
  // so we can preventDefault — React's onWheel is passive in React 17+.
  // We also block Safari's pinch-zoom-the-page gesture events.
  //
  // `showSvg` in deps is load-bearing: the canvas can transition
  // through a placeholder (no domain, no result, non-SP error) and
  // back when the user switches cells or domains. Without re-running
  // this effect on every placeholder ↔ canvas transition, the new SVG
  // element after a transition never gets the wheel / gesture
  // listeners and pan + zoom break silently. Keying on the boolean
  // makes the subscription follow the mounted element.
  const showSvg = !!(domain && result && result.ok);
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

  const onPointerDown = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    // Only middle-button or space-less left-button drag on empty canvas
    // pans. Single left-click on a symbol fires its own onClick first
    // (event bubbling).
    if (e.button !== 0 && e.button !== 1) return;
    svgRef.current?.setPointerCapture(e.pointerId);
    dragRef.current = { sx: e.clientX, sy: e.clientY, tx: view.tx, ty: view.ty };
  }, [view.tx, view.ty]);

  const onPointerMove = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d) return;
    setView((v) => ({
      ...v,
      tx: d.tx + (e.clientX - d.sx),
      ty: d.ty + (e.clientY - d.sy),
    }));
  }, []);

  const endDrag = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    svgRef.current?.releasePointerCapture(e.pointerId);
  }, []);

  // ── Render ────────────────────────────────────────────────────

  if (!domain) {
    return (
      <Placeholder host={hostRef}>select a domain on the right to view its schematic</Placeholder>
    );
  }
  if (!result) {
    return <Placeholder host={hostRef}>loading…</Placeholder>;
  }
  if (!result.ok) {
    return (
      <Placeholder host={hostRef}>
        <div>schematic unavailable</div>
        <div style={{ fontSize: 11, color: "var(--ink3)", marginTop: 6 }}>
          {result.error.message}
        </div>
      </Placeholder>
    );
  }
  const { view: schematic } = result;

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
          {/* Wires under symbols + junctions so the junction dots paint on
              top of the wire intersections and cleanly hide any pixel-level
              join artefacts. */}
          {schematic.wires.map((w, i) => (
            <WirePath
              key={i}
              wire={w}
              highlight={netHovered(w.netId)}
              onHover={emitNet}
            />
          ))}
          {schematic.junctions.map((j, i) => (
            <Junction key={i} point={j} />
          ))}
          {schematic.symbols.map((s) => {
            // Per-kind narrow highlight:
            //   - transistor: only when THIS transistor is the hover target
            //   - rail: only when its own net is the hover target (so the
            //     VDD bar lights up only when the VDD net is hovered)
            //   - junction (output label text): same net rule
            let on = false;
            if (s.data.kind === "transistor") {
              on = transistorHovered(s.data.transistorId);
            } else if (s.data.kind === "rail") {
              on = netHovered(s.data.netId);
            } else if (s.data.kind === "junction") {
              on = netHovered(s.data.netId);
            }
            return (
              <Symbol
                key={s.id}
                s={s}
                highlight={on}
                onHoverTransistor={emitTransistor}
                onHoverNet={emitNet}
              />
            );
          })}
          {/* Gate input stubs on the left of each transistor — short wire
              plus a net label so the inputs are readable even without
              cross-module routing in place. */}
          {schematic.gates.map((g, i) => (
            <GateStub
              key={i}
              gate={g}
              nets={nets}
              highlight={netHovered(g.netId)}
              onHover={emitNet}
            />
          ))}
        </g>
      </svg>
      {extraction && extraction.kind === "inferred" && (
        <CmosDumpButton extraction={extraction} />
      )}
    </div>
  );
}

/**
 * Floating "copy text" button matching the one on the logic
 * schematic. Dumps the whole-cell CMOS-level netlist (every
 * transistor with its S/D/G + structural role) to the clipboard;
 * paste into a chat to analyse the cell at the MOSFET level.
 *
 * Renders only when an inferred extraction is available so the
 * button can't fire on a cell that hasn't extracted yet.
 */
function CmosDumpButton({
  extraction,
}: {
  extraction: InferredCellExtraction;
}) {
  const [copied, setCopied] = useState(false);
  // Same name-resolution rule as the schematic itself: user-labelled
  // nets show by name (VDD / GND / explicit inputs), the rest as
  // `netN`. Built fresh from the extraction's net labels.
  const netName = useMemo(() => {
    const labels = new Map<number, string>();
    for (const n of extraction.nets) labels.set(n.id, netDisplayName(n));
    return (id: number) => labels.get(id) ?? `net${id}`;
  }, [extraction]);
  const onClick = useCallback(async () => {
    const text = dumpCmos(extraction, netName);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("CMOS dump (Cmd+C to copy):", text);
    }
  }, [extraction, netName]);
  return (
    <button
      type="button"
      onClick={onClick}
      title="Copy a transistor-level text dump of this cell to the clipboard (paste into a chat to analyse)"
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

// ── Sub-elements ─────────────────────────────────────────────────

const WIRE_COLOR = "#cfd6e0";
const WIRE_W = 1.4;
/** Single accent colour for hover highlight (steel-blue — matches the
 *  image canvas's hover halo). Selection isn't a schematic concept any
 *  more, so one shade is enough. */
const HL_COLOR = "#7fb2ff";
/** Width of the invisible hit overlay sitting under each wire — makes
 *  the thin wires easy to pick without changing visuals. */
const WIRE_HIT_W = 12;

function hlStroke(on: boolean, base: string): string {
  return on ? HL_COLOR : base;
}
function hlWidth(on: boolean, base: number): number {
  return on ? base + 1.2 : base;
}

function WirePath({
  wire,
  highlight,
  onHover,
}: {
  wire: Wire;
  highlight: boolean;
  onHover?: (netId: number | null) => void;
}) {
  const interactive = wire.netId != null;
  return (
    <g
      onMouseEnter={interactive ? () => onHover?.(wire.netId!) : undefined}
      onMouseLeave={interactive ? () => onHover?.(null) : undefined}
    >
      {/* Transparent hit overlay — `pointer-events="stroke"` lets it
          receive events without painting anything. Visible width stays
          tiny while the hit-target spans ~12px around the wire. */}
      {interactive && (
        <line
          x1={wire.from.x}
          y1={wire.from.y}
          x2={wire.to.x}
          y2={wire.to.y}
          stroke="transparent"
          strokeWidth={WIRE_HIT_W}
          pointerEvents="stroke"
        />
      )}
      <line
        x1={wire.from.x}
        y1={wire.from.y}
        x2={wire.to.x}
        y2={wire.to.y}
        stroke={hlStroke(highlight, WIRE_COLOR)}
        strokeWidth={hlWidth(highlight, WIRE_W)}
        strokeLinecap="round"
        pointerEvents="none"
      />
    </g>
  );
}

function Symbol({
  s,
  highlight,
  onHoverTransistor,
  onHoverNet,
}: {
  s: PlacedSymbol;
  highlight: boolean;
  onHoverTransistor?: (id: string | null) => void;
  onHoverNet?: (netId: number | null) => void;
}) {
  switch (s.data.kind) {
    case "transistor":
      return (
        <TransistorSymbol
          x={s.x}
          y={s.y}
          type={s.data.type}
          tid={s.data.transistorId}
          highlight={highlight}
          onHover={onHoverTransistor}
        />
      );
    case "rail":
      return (
        <RailSymbol
          x={s.x}
          y={s.y}
          rail={s.data.rail}
          highlight={highlight}
          netId={s.data.netId}
          onHover={onHoverNet}
        />
      );
    case "junction": {
      // The "junction" symbol is the output-net label text at the end of
      // the side branch. Wrap it in a <g> with a transparent hit rect so
      // the whole label is hoverable (the <text> alone only picks up
      // events on rendered glyph pixels).
      const text = s.data.label ?? "";
      // Rough heuristic for the hit-rect width — every glyph is ~7px at
      // fontSize 11 in the mono font. Slightly generous so the rect
      // forgives sub-pixel rounding.
      const hitW = Math.max(12, text.length * 7 + 8);
      const netId = s.data.netId;
      const interactive = netId != null;
      return (
        <g
          onMouseEnter={interactive ? () => onHoverNet?.(netId!) : undefined}
          onMouseLeave={interactive ? () => onHoverNet?.(null) : undefined}
        >
          <rect
            x={s.x - 4}
            y={s.y - 8}
            width={hitW}
            height={16}
            fill="transparent"
            pointerEvents={interactive ? "all" : "none"}
          />
          <text
            x={s.x}
            y={s.y}
            dy={4}
            fontFamily="var(--mono, ui-monospace)"
            fontSize={11}
            fill={hlStroke(highlight, "var(--ink2)")}
            fontWeight={highlight ? 700 : "normal"}
            pointerEvents="none"
          >
            {text}
          </text>
        </g>
      );
    }
  }
}

/**
 * Schematic MOSFET symbol in the conventional form: drain and source
 * pins are colinear on a vertical axis (the topPort/bottomPort), the
 * channel sits offset to the left, and short horizontal "wings" connect
 * the channel ends to the main pin axis. PMOS adds a small bubble
 * between the gate input and the gate post; NMOS is bare.
 *
 *          |          drain (top pin, on the main axis)
 *          |
 *      ╴───┘          ← top wing
 *      ┃              ← channel (offset to the left)
 *  G ──┃              ← gate input + gate post (small oxide gap)
 *      ┃
 *      ╶───┐          ← bottom wing
 *          |
 *          |          source (bottom pin)
 *
 * Geometry (symbol box is SYM_W × SYM_H = 60 × 60):
 *   main pin axis: x=30  (matches the layout's topPort / bottomPort.x)
 *   channel:       x=14
 *   gate post:     x=10
 *   gate input:    enters at (0, 30)
 *   pmos bubble:   at (6, 30), r=2.5
 *
 * Hover events fire on an invisible bounding-box rect so the whole 60×60
 * area is hot, not just the painted strokes. */
function TransistorSymbol({
  x,
  y,
  type,
  tid,
  highlight,
  onHover,
}: {
  x: number;
  y: number;
  type: "pmos" | "nmos" | "unknown";
  tid: string;
  highlight: boolean;
  onHover?: (id: string | null) => void;
}) {
  // Channel / gate-post tint matches the PMOS / NMOS palette the right
  // panel uses, so a swatch in one place reads as the same device type
  // in the other.
  const accent =
    type === "pmos" ? "#e07ab0" : type === "nmos" ? "#5fb8d0" : "#9a9a9a";
  return (
    <g
      transform={`translate(${x}, ${y})`}
      onMouseEnter={() => onHover?.(tid)}
      onMouseLeave={() => onHover?.(null)}
    >
      <rect
        x={0}
        y={0}
        width={60}
        height={60}
        fill="none"
        stroke="none"
        pointerEvents="all"
      />
      {/* Highlight halo — a translucent rounded outline around the symbol
          when the user is hovering this transistor (in the schematic or
          via its row in the right panel). Behind the symbol so the device
          lines stay crisp. */}
      {highlight && (
        <rect
          x={3}
          y={3}
          width={54}
          height={54}
          rx={6}
          fill={HL_COLOR}
          fillOpacity={0.18}
          stroke={HL_COLOR}
          strokeWidth={1.8}
          pointerEvents="none"
        />
      )}
      {/* Main pin axis (drain + source as one continuous vertical line
          running through the symbol). */}
      <line x1={30} y1={0} x2={30} y2={16} stroke={WIRE_COLOR} strokeWidth={WIRE_W} />
      <line x1={30} y1={44} x2={30} y2={60} stroke={WIRE_COLOR} strokeWidth={WIRE_W} />
      {/* Top + bottom wings — short horizontal connectors from the channel
          ends to the main pin axis. Tinted like the channel so the whole
          (wings + channel) shape reads as one device piece, not as wires. */}
      <line x1={14} y1={16} x2={30} y2={16} stroke={accent} strokeWidth={1.8} />
      <line x1={14} y1={44} x2={30} y2={44} stroke={accent} strokeWidth={1.8} />
      {/* Channel (thick vertical, offset to the left of the pin axis). */}
      <line x1={14} y1={16} x2={14} y2={44} stroke={accent} strokeWidth={3} strokeLinecap="butt" />
      {/* Gate post — same length as the channel, with a small oxide gap. */}
      <line x1={10} y1={16} x2={10} y2={44} stroke={accent} strokeWidth={1.8} />
      {/* Gate input wire — NMOS goes flush to the post; PMOS stops short
          to leave room for the bubble. */}
      <line
        x1={0}
        y1={30}
        x2={type === "pmos" ? 4 : 10}
        y2={30}
        stroke={WIRE_COLOR}
        strokeWidth={WIRE_W}
      />
      {type === "pmos" && (
        <circle cx={7} cy={30} r={2.5} fill="var(--canvas-bg)" stroke={accent} strokeWidth={1.4} />
      )}
    </g>
  );
}

function RailSymbol({
  x,
  y,
  rail,
  highlight,
  netId,
  onHover,
}: {
  x: number;
  y: number;
  rail: "vcc" | "gnd";
  highlight: boolean;
  /** Net the rail terminates — used to fire `onHoverNet` so hovering the
   *  VDD bar highlights the VDD net everywhere. */
  netId?: number;
  onHover?: (netId: number | null) => void;
}) {
  // The rail's local (0,0) IS the bar that the wire connects to. The
  // label sits above (VDD) or below (GND) the bar but isn't part of the
  // electrical connection. With this convention the caller drops the
  // wire directly to the symbol's anchor coordinate and there's no gap.
  // Highlight (=its own net hovered) widens the bars + swaps to accent.
  const baseColor = rail === "vcc" ? "#ff4040" : "#4080ff";
  const railStroke = hlStroke(highlight, baseColor);
  const railWidth = hlWidth(highlight, 1.8);
  const interactive = netId != null;
  // Transparent hit overlay spans the bar + label. The two rails have
  // different vertical extents: VDD's label sits above the bar at y=-10,
  // GND's three bars + label sit below from y=0 to y=24.
  const hitRect = rail === "vcc"
    ? { x: -10, y: -14, width: 50, height: 16 }
    : { x: -10, y: -2, width: 50, height: 28 };
  return (
    <g
      transform={`translate(${x}, ${y})`}
      onMouseEnter={interactive ? () => onHover?.(netId!) : undefined}
      onMouseLeave={interactive ? () => onHover?.(null) : undefined}
    >
      <rect
        x={hitRect.x}
        y={hitRect.y}
        width={hitRect.width}
        height={hitRect.height}
        fill="transparent"
        pointerEvents={interactive ? "all" : "none"}
      />
      {rail === "vcc" ? (
        <>
          <line x1={0} y1={0} x2={30} y2={0} stroke={railStroke} strokeWidth={railWidth} />
          <text
            x={15}
            y={-10}
            textAnchor="middle"
            fontFamily="var(--mono, ui-monospace)"
            fontSize={11}
            fontWeight={700}
            fill="#ff4040"
          >
            VDD
          </text>
        </>
      ) : (
        <>
          {/* Three-bar GND glyph below the connection point, uniform stroke. */}
          <line x1={0} y1={0} x2={30} y2={0} stroke={railStroke} strokeWidth={railWidth} />
          <line x1={5} y1={5} x2={25} y2={5} stroke={railStroke} strokeWidth={railWidth} />
          <line x1={10} y1={10} x2={20} y2={10} stroke={railStroke} strokeWidth={railWidth} />
          <text
            x={15}
            y={24}
            textAnchor="middle"
            fontFamily="var(--mono, ui-monospace)"
            fontSize={11}
            fontWeight={700}
            fill="#4080ff"
          >
            GND
          </text>
        </>
      )}
    </g>
  );
}

/** Filled circle marking a 3+ way wire meeting — the standard schematic
 *  convention for "these wires are electrically connected". */
function Junction({ point }: { point: Point }) {
  return (
    <circle
      cx={point.x}
      cy={point.y}
      r={3}
      fill={WIRE_COLOR}
      stroke="none"
    />
  );
}

/** Short horizontal stub + label coming out of each transistor's gate
 *  pin. Until multi-module routing lands, this is how the user sees which
 *  input drives which gate. We don't try to dedup gate stubs that share a
 *  net — every transistor gets its own label so the schematic reads top-
 *  down without cross-references. */
function GateStub({
  gate,
  nets,
  highlight,
  onHover,
}: {
  gate: GateInput;
  nets: ReadonlyArray<ExtractedNet>;
  highlight: boolean;
  onHover?: (netId: number | null) => void;
}) {
  const net = nets.find((n) => n.id === gate.netId);
  const label = net ? netDisplayName(net) : `net${gate.netId}`;
  const stubLen = 22;
  return (
    <g
      onMouseEnter={() => onHover?.(gate.netId)}
      onMouseLeave={() => onHover?.(null)}
    >
      {/* Transparent hit overlay (stub + label area) so the whole label
          region picks up hover, not just the thin stub line. */}
      <rect
        x={gate.port.x - stubLen - 40}
        y={gate.port.y - 8}
        width={stubLen + 40}
        height={16}
        fill="transparent"
        pointerEvents="all"
      />
      <line
        x1={gate.port.x - stubLen}
        y1={gate.port.y}
        x2={gate.port.x}
        y2={gate.port.y}
        stroke={hlStroke(highlight, WIRE_COLOR)}
        strokeWidth={hlWidth(highlight, WIRE_W)}
        pointerEvents="none"
      />
      <text
        x={gate.port.x - stubLen - 4}
        y={gate.port.y}
        dy={4}
        textAnchor="end"
        fontFamily="var(--mono, ui-monospace)"
        fontSize={10.5}
        fill={hlStroke(highlight, "var(--ink2)")}
        fontWeight={highlight ? 700 : "normal"}
        pointerEvents="none"
      >
        {label}
      </text>
    </g>
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
