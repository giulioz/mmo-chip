import { useEffect, useRef } from "react";
import type {
  ForcedDiffusionType,
  LayerShape,
  LayerType,
  ShapeLabel,
} from "shared";

/** The shape the menu opened on — the label / diffusion-type sections key
 *  off its layer. */
export interface ShapeMenuAnchor {
  layer: LayerType;
  shape: LayerShape;
}

export interface ShapeContextMenuState {
  x: number;
  y: number;
  /** Null when the menu opened on a multi-selection's group box rather than
   *  on a shape: only the selection-wide actions apply. */
  anchor: ShapeMenuAnchor | null;
}

/**
 * Shared label state across every shape the label action would touch (the
 * right-clicked shape plus any other selected shapes on the same category).
 *   - `null`     — none of the targets are labelled.
 *   - a label    — every target shares this label.
 *   - `"mixed"`  — targets disagree; no ✓ is shown.
 */
export type AppliedLabel = ShapeLabel | null | "mixed";

/** Same shape as `AppliedLabel`, but for the diffusion-only `forcedType` field. */
export type AppliedForcedType = ForcedDiffusionType | null | "mixed";

interface Props {
  menu: ShapeContextMenuState;
  /** Selection size at the moment the menu was opened — controls plural-form
   *  copy on Duplicate / Copy / Delete. */
  selectionCount: number;
  /** Number of shapes the label action will actually touch (the menu's
   *  layer-category filtered against the selection). Drives the "Label (N)"
   *  hint in the metal section header. */
  labelTargetCount: number;
  /** Shared label across all label targets. */
  appliedLabel: AppliedLabel;
  /** Number of diffusion shapes the forced-type action will touch. */
  forcedTypeTargetCount: number;
  /** Shared forcedType across the diffusion targets. */
  appliedForcedType: AppliedForcedType;
  /** Show Paste as enabled when the clipboard has at least one shape. */
  hasClipboard: boolean;
  /** A quarter turn / a mirror of the selection would move something (not
   *  a lone point, square or rect). */
  canRotate: boolean;
  canFlipH: boolean;
  canFlipV: boolean;
  onClose: () => void;
  /** Set / clear `label` on the metal label-group targets. `null` clears. */
  onSetLabel: (label: ShapeLabel | null) => void;
  /** Set / clear `forcedType` on the diffusion targets. Independent of
   *  `onSetLabel` — diffusion no longer overloads the label field. */
  onSetForcedType: (type: ForcedDiffusionType | null) => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onPaste: () => void;
  /** Quarter-turn the selection about the centre of its bounds (90 =
   *  clockwise). */
  onRotate: (deg: 90 | -90) => void;
  /** Mirror the selection across its bounds' centre line ("h" = left↔right). */
  onFlip: (axis: "h" | "v") => void;
  onDelete: () => void;
}

/**
 * Right-click menu on a shape in the Cells-RE canvas. The visible items
 * adapt to the shape's layer:
 *   - metal1 / metal2 → Label as VDD / GND / Chip I/O / Input / Output
 *                       (+ Clear when set)
 *   - diffusion       → Force P-type (VDD body) / N-type (GND body) (+ Clear)
 *   - all layers      → Duplicate / Copy / Paste (gated) / Flip H / V and
 *                       Rotate 90° both ways (about the selection's centre) /
 *                       Delete
 * Opened on a multi-selection's group box (no anchor shape), only the
 * selection-wide actions show.
 *
 * Dismissal / positioning mirror `CellREContextMenu` so right-click feels
 * consistent across the RE page.
 */
export function ShapeContextMenu({
  menu,
  selectionCount,
  labelTargetCount,
  appliedLabel,
  forcedTypeTargetCount,
  appliedForcedType,
  hasClipboard,
  canRotate,
  canFlipH,
  canFlipV,
  onClose,
  onSetLabel,
  onSetForcedType,
  onDuplicate,
  onCopy,
  onPaste,
  onRotate,
  onFlip,
  onDelete
}: Props) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // Clamp into the viewport — same trick as the cell-instance context menu.
  // The width estimate has to cover the longest item; "Force N-type (GND body)"
  // is ~210 px at the current font, so 240 leaves a tiny safety margin.
  const MENU_W = 240;
  const MENU_H = 390;
  const x = Math.min(menu.x, window.innerWidth - MENU_W);
  const y = Math.min(menu.y, window.innerHeight - MENU_H);

  const layer = menu.anchor?.layer;
  const isMetal = layer === "metal1" || layer === "metal2";
  const isDiffusion = layer === "diffusion";
  const plural = selectionCount > 1 ? ` (${selectionCount})` : "";
  // Section-header hint. We only surface the count when it's >1 — the single-
  // shape case is the obvious default and the chrome would be noise.
  const labelHint = labelTargetCount > 1 ? ` (${labelTargetCount})` : "";
  const diffTypeHint = forcedTypeTargetCount > 1 ? ` (${forcedTypeTargetCount})` : "";
  // `mixed` is shown verbatim so the user understands why no ✓ is painted on
  // any option. Same data flows into Label/DiffType item for the per-item ✓.
  const labelMixed = appliedLabel === "mixed";
  const diffTypeMixed = appliedForcedType === "mixed";

  // Convenience wrapper: every menu action also dismisses, so we don't have to
  // remember to call onClose() in five callbacks.
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div
      ref={ref}
      className="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 1000, minWidth: MENU_W }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isMetal && (
        <>
          <div className="menu-section">
            Label{labelHint}
            {labelMixed && <span style={{ marginLeft: 6, color: "var(--warn)" }}>mixed</span>}
          </div>
          <LabelItem
            label="Label as VDD"
            target="vcc"
            current={appliedLabel}
            onPick={(l) => run(() => onSetLabel(l))()}
          />
          <LabelItem
            label="Label as GND"
            target="gnd"
            current={appliedLabel}
            onPick={(l) => run(() => onSetLabel(l))()}
          />
          <LabelItem
            label="Label as Chip I/O"
            target="io"
            current={appliedLabel}
            onPick={(l) => run(() => onSetLabel(l))()}
          />
          <LabelItem
            label="Label as Input"
            target="input"
            current={appliedLabel}
            onPick={(l) => run(() => onSetLabel(l))()}
          />
          <LabelItem
            label="Label as Output"
            target="output"
            current={appliedLabel}
            onPick={(l) => run(() => onSetLabel(l))()}
          />
          {(appliedLabel !== null) && (
            <button className="menu-item" onClick={run(() => onSetLabel(null))}>
              Clear label
            </button>
          )}
          <div className="menu-sep" />
        </>
      )}

      {isDiffusion && (
        <>
          <div className="menu-section">
            Diffusion type{diffTypeHint}
            {diffTypeMixed && <span style={{ marginLeft: 6, color: "var(--warn)" }}>mixed</span>}
          </div>
          <DiffTypeItem
            label="Force P-type (VDD body)"
            target="p"
            current={appliedForcedType}
            onPick={(t) => run(() => onSetForcedType(t))()}
          />
          <DiffTypeItem
            label="Force N-type (GND body)"
            target="n"
            current={appliedForcedType}
            onPick={(t) => run(() => onSetForcedType(t))()}
          />
          {(appliedForcedType !== null) && (
            <button className="menu-item" onClick={run(() => onSetForcedType(null))}>
              Clear (auto-infer)
            </button>
          )}
          <div className="menu-sep" />
        </>
      )}

      <button className="menu-item" onClick={run(onDuplicate)}>
        Duplicate{plural}
      </button>
      <button className="menu-item" onClick={run(onCopy)}>
        Copy{plural}
      </button>
      <button className="menu-item" disabled={!hasClipboard} onClick={run(onPaste)}>
        Paste
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        disabled={!canFlipH}
        onClick={run(() => onFlip("h"))}
      >
        Flip horizontally{plural}
      </button>
      <button
        className="menu-item"
        disabled={!canFlipV}
        onClick={run(() => onFlip("v"))}
      >
        Flip vertically{plural}
      </button>
      <button
        className="menu-item"
        disabled={!canRotate}
        onClick={run(() => onRotate(90))}
      >
        Rotate 90° clockwise{plural}
      </button>
      <button
        className="menu-item"
        disabled={!canRotate}
        onClick={run(() => onRotate(-90))}
      >
        Rotate 90° counter-clockwise{plural}
      </button>
      <div className="menu-sep" />
      <button className="menu-item danger" onClick={run(onDelete)}>
        Delete{plural}
      </button>
    </div>
  );
}

// ── Internals ────────────────────────────────────────────────────

export function LabelItem({
  label,
  target,
  current,
  onPick
}: {
  label: string;
  /** ShapeLabel this item applies. Clicking when already current clears it. */
  target: ShapeLabel;
  /** Shared label across the targets (see `AppliedLabel`). `"mixed"` paints
   *  no ✓ on any option — there's no single value to invert. */
  current: AppliedLabel;
  onPick: (next: ShapeLabel | null) => void;
}) {
  const active = current === target;
  return (
    <button
      className={"menu-item" + (active ? " on" : "")}
      onClick={() => onPick(active ? null : target)}
      // The check mark on the right reads as a toggle indicator — clicking an
      // active item flips it off, matching how Mac menu bars behave.
      style={{
        justifyContent: "space-between",
        background: active ? "var(--accentBg)" : undefined,
        color: active ? "var(--accent)" : undefined
      }}
    >
      <span>{label}</span>
      <span style={{ width: 12, textAlign: "right" }}>{active ? "✓" : ""}</span>
    </button>
  );
}

export function DiffTypeItem({
  label,
  target,
  current,
  onPick
}: {
  label: string;
  /** ForcedDiffusionType this item applies. Clicking when active clears it. */
  target: ForcedDiffusionType;
  /** Shared forcedType across the targets (see `AppliedForcedType`). */
  current: AppliedForcedType;
  onPick: (next: ForcedDiffusionType | null) => void;
}) {
  const active = current === target;
  return (
    <button
      className={"menu-item" + (active ? " on" : "")}
      onClick={() => onPick(active ? null : target)}
      style={{
        justifyContent: "space-between",
        background: active ? "var(--accentBg)" : undefined,
        color: active ? "var(--accent)" : undefined
      }}
    >
      <span>{label}</span>
      <span style={{ width: 12, textAlign: "right" }}>{active ? "✓" : ""}</span>
    </button>
  );
}
