import type { LayerType, ShapeLabel } from "shared";

/**
 * Visual tokens + sizing math for die annotations. Pure constants/functions —
 * shared by the per-kind annotation builders and a few UI surfaces (color
 * pickers, the wire-draft overlay).
 */

// ── Cell-layer palette ───────────────────────────────────────────────
//
// Two sources of truth: the opaque base color (used for outline strokes and
// as the colour reference everywhere — chip swatches, the layer-visibility
// list, live tool previews) and the per-layer fill opacity (alpha applied on
// top of the base when the shape body is painted). Keeping them split lets
// fills stay translucent (so stacked layers composite legibly) while strokes
// stay crisp (so shape boundaries don't blur into the imagery underneath).

/** Opaque base colour per layer. Saturated by design so the layer reads at a
 *  glance both on the canvas and in the side-panel swatch. */
export const COLOR_LAYER: Record<LayerType, string> = {
  diffusion: "#e0a030",
  polysilicon: "#a0d030",
  metal1: "#00e0e0",
  metal2: "#e060e0",
  contact: "#c0a000",
  via1: "#a030a0",
  wire_hitbox: "#f3b351"
};

/** Alpha multiplier applied to the layer's fill (stroke is always full
 *  alpha). Diffusion sits lowest so the imagery underneath stays visible
 *  through the large active-area regions; hitbox is barely-there because
 *  it's a click target, not a visible artefact. */
export const LAYER_FILL_OPACITY: Record<LayerType, number> = {
  diffusion: 0.2,
  polysilicon: 0.4,
  metal1: 0.4,
  metal2: 0.4,
  contact: 0.4,
  via1: 0.4,
  wire_hitbox: 0.15
};

/** Per-label override colour: `shape.label` overrides the layer's base colour
 *  for shapes the user has tagged with a role. The tagged shape still gets
 *  the layer's fill alpha. `input` / `output` are forced-net overrides for
 *  cells whose structural classification needs a manual hint. */
export const COLOR_LABEL: Record<ShapeLabel, string> = {
  vcc: "#ff4040",
  gnd: "#4080ff",
  io: "#f1c40f",
  input: "#22d3ee",   // cyan — clearly distinct from gnd blue
  output: "#34d399"   // green — matches --ok in the dark palette
};

// ── Cells ────────────────────────────────────────────────────────────

/** Preset colors offered for cell outline + block fill (chosen in the cell
 *  settings popover). Deliberately warm/neutral so cells (large translucent
 *  containers) contrast the cool, saturated wire palette and stay clear of the
 *  amber selection accent. First entry is the default (neutral white). */
export const CELL_COLOR_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "White", value: "#ffffff" },
  { label: "Slate", value: "#94a3b8" },
  { label: "Rose", value: "#fb7185" },
  { label: "Orange", value: "#f97316" },
  { label: "Red", value: "#ef4444" }
];

/** Default cell color (neutral white — current look). */
export const CELL_COLOR = CELL_COLOR_OPTIONS[0].value;
/** Alpha applied to the chosen cell color for the outline / block fill. */
export const CELL_OUTLINE_ALPHA = 0.8;
export const CELL_FILL_ALPHA = 0.16;
/** Cell outline width in screen px (constant regardless of zoom). */
export const CELL_OUTLINE_PX = 2;

// ── Nets ─────────────────────────────────────────────────────────────

/** Preset colors offered for unselected wires + vertices (chosen in the net
 *  settings popover). All are bright/opaque and distinct from the amber
 *  selection accent. First entry is the default (legacy viewer blue). */
export const NET_COLOR_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "Blue", value: "#2e97ff" },
  { label: "Cyan", value: "#22d3ee" },
  { label: "Green", value: "#34d399" },
  { label: "Violet", value: "#a78bfa" },
  { label: "Magenta", value: "#e879f9" }
];

/** Default base color for unselected wires + vertices (legacy viewer blue). */
export const NET_COLOR = NET_COLOR_OPTIONS[0].value;

/** Per-conductor-layer wire color. "unknown" (absent layer) is intentionally
 *  not here — it falls back to the user-configurable base net color. Chosen
 *  bright/opaque and mutually distinct (orange / teal / violet). */
export const WIRE_LAYER_COLOR: Record<"poly" | "metal1" | "metal2", string> = {
  poly: "#fb923c",
  metal1: "#2dd4bf",
  metal2: "#a78bfa"
};

// Net wires scale geometrically with zoom (so they thicken as you zoom in,
// matching the imagery), but clamped so they're never invisible at very low
// zoom and never absurdly fat at very high zoom. The base world width is
// user-tunable via a slider in the outline tree.
export const NET_DEFAULT_WIDTH = 10;
export const NET_MIN_WIDTH = 0.5;
export const NET_MAX_WIDTH = 20;
export const NET_MIN_SCREEN_PX = 0.5;
export const NET_MAX_SCREEN_PX = 32;
export const NET_NODE_RADIUS_MULT = 1.6;

export function netScreenWidth(zoom: number, worldWidth: number): number {
  return Math.min(NET_MAX_SCREEN_PX, Math.max(NET_MIN_SCREEN_PX, worldWidth * zoom));
}

/**
 * Largest radius (screen px) a net vertex is ever drawn at for the given zoom
 * and base width — including the selected-node multiplier. The wire-draft
 * snap halo uses this so it always sits *outside* the rendered vertex
 * (vertices scale with zoom and would otherwise swallow a fixed-size halo).
 */
export function netNodeScreenRadius(zoom: number, netWidth: number): number {
  return netScreenWidth(zoom, netWidth) * NET_NODE_RADIUS_MULT * SELECT_NODE_MULT;
}

// ── Via / ML annotations ─────────────────────────────────────────────

export const COLOR_VIA = "rgba(130, 214, 166, 0.85)"; // green-power
export const COLOR_VIA_FILL = "rgba(130, 214, 166, 0.25)";

/** Default render radius for point vias (world / source-pixel units). Single
 *  source of truth for both manual and ML vias, and the snap-to-via
 *  tolerance for the wire / multi-wire tools. */
export const VIA_DEFAULT_SIZE = 6;
export const VIA_MIN_SIZE = 1;
export const VIA_MAX_SIZE = 40;
/** Floor / ceiling on the rendered radius in CSS px so vias don't disappear
 *  when zoomed way out and don't dominate the view when zoomed way in. The
 *  snap tolerance applies the same floor so click-areas stay usable at any
 *  zoom. (Net widths follow the same pattern — see `netScreenWidth`.) */
export const VIA_MIN_SCREEN_PX = 2;
export const VIA_MAX_SCREEN_PX = 48;

/** Map a world-unit via radius to the CSS-px radius actually drawn at the
 *  current zoom, clamped so the dot stays visible without ballooning. */
export function viaScreenRadius(zoom: number, worldR: number): number {
  return Math.min(
    VIA_MAX_SCREEN_PX,
    Math.max(VIA_MIN_SCREEN_PX, worldR * zoom)
  );
}

/** World-unit snap tolerance for "click on a via" — matches the rendered
 *  radius (click inside the visible dot = snap). Floored at the same CSS-px
 *  minimum used by the render so the snap area stays usable when zoomed
 *  out enough that the world radius would shrink below a pixel on screen. */
export function viaSnapTolerance(zoom: number, worldR: number): number {
  return Math.max(worldR, VIA_MIN_SCREEN_PX / zoom);
}
export const COLOR_IGNORE = "rgba(227, 104, 84, 0.8)";
export const COLOR_IGNORE_FILL = "rgba(227, 104, 84, 0.12)";
export const COLOR_ROI = "rgba(245, 214, 138, 0.9)";
export const COLOR_PIN = "rgba(127, 178, 255, 0.95)";
export const COLOR_PIN_FILL = "rgba(127, 178, 255, 0.18)";

// ── Selection accent ─────────────────────────────────────────────────

// Amber/gold selection accent — deliberately contrasts the blue net base so
// selected geometry reads at a glance (matches the legacy viewer convention).
export const SELECT_COLOR = "#f3b351";
export const SELECT_FILL = "rgba(243, 179, 81, 0.22)";
/** White ring around selected point/vertex handles, for pop against imagery. */
export const SELECT_RING = "#ffffff";
export const SELECT_OUTLINE_PX = 1.5;
/** Selected nets render thicker / larger so the selection is obvious. */
export const SELECT_WIDTH_MULT = 1.5;
export const SELECT_NODE_MULT = 1.4;

// ── Misc sizing + pick precedence ────────────────────────────────────

// Constant-screen-pixel sizes (in CSS pixels). Divide by zoom for world size.
export const VIA_RADIUS_PX = 2.5;
export const OUTLINE_WIDTH_PX = 1;

// Click precedence (higher wins). Foreground geometry (vias, wires/vertices,
// pins) must beat cells, which are large background containers — otherwise
// clicking a wire that runs through a cell selects the cell.
export const PICK = {
  via: 3,
  pin: 3,
  net: 2,
  roi: 1,
  ignore: 1,
  cell: 0
} as const;
