import { useEffect, useRef } from "react";
import type { DieOrientOp } from "../../lib/mergeCells";

/**
 * What the canvas right-click handler resolved at the cursor: the world point
 * to anchor "start wire from here" at, plus an optional `DrawAnchor` when the
 * cursor landed on an existing net vertex (so the new wire extends that net
 * instead of starting a fresh one), plus how many *selected* points the
 * "start multi-wire" entry should fan out across (0–N — the menu disables the
 * item when there's nothing usable).
 */
export interface DieContextMenuState {
  /** Viewport-relative screen coords for menu placement. */
  screenX: number;
  screenY: number;
  /** World point used by "Start wire from here". */
  hitPoint: { x: number; y: number };
  /** Existing net vertex the cursor landed on, or null. */
  hitAnchor: { netId: string; nodeId: string } | null;
  /** Human-readable label for the "from here" item (e.g. "from ML via",
   *  "from net vertex", "from this point"). */
  hitLabel: string;
  /** How many points the current selection contributes to multi-wire. */
  multiPointCount: number;
  /** Placed cells the flip / rotate items act on: the one under the cursor,
   *  or every selected cell when it's part of the selection. Empty ⇒ the
   *  right-click missed every cell and the cell items don't show. */
  cellIds: string[];
  /** Header for the cell items ("Cell · NAND2", "3 cells"). */
  cellLabel: string;
}

interface Props {
  menu: DieContextMenuState;
  onClose: () => void;
  onStartWire: () => void;
  onStartMultiWire: () => void;
  /** Flip / turn `menu.cellIds` in place, as they lie on the die. */
  onOrientCells: (op: DieOrientOp) => void;
}

/** Right-click menu on the die-viewer canvas. On a placed cell: flip it or
 *  turn it a quarter turn about its centre. Always: start a single wire from
 *  the cursor, and start a multi-wire bus from the current selection's
 *  via/vertex points (enabled with ≥2 sources). */
export function DieContextMenu({
  menu,
  onClose,
  onStartWire,
  onStartMultiWire,
  onOrientCells
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

  const hasCells = menu.cellIds.length > 0;
  // Clamp inside the viewport — same simple guard the other context menus use.
  const x = Math.min(menu.screenX, window.innerWidth - 240);
  const y = Math.min(menu.screenY, window.innerHeight - (hasCells ? 250 : 120));

  const canMulti = menu.multiPointCount >= 2;
  const orient = (op: DieOrientOp) => () => {
    onOrientCells(op);
    onClose();
  };

  return (
    <div
      ref={ref}
      className="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 1000, minWidth: 220 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {hasCells && (
        <>
          <div className="menu-section">{menu.cellLabel}</div>
          <button className="menu-item" onClick={orient("flipH")}>
            Flip horizontally
          </button>
          <button className="menu-item" onClick={orient("flipV")}>
            Flip vertically
          </button>
          <button className="menu-item" onClick={orient("rotateCw")}>
            Rotate 90° clockwise
          </button>
          <button className="menu-item" onClick={orient("rotateCcw")}>
            Rotate 90° counter-clockwise
          </button>
          <div className="menu-sep" />
        </>
      )}
      <button
        className="menu-item"
        onClick={() => {
          onStartWire();
          onClose();
        }}
      >
        Start wire {menu.hitLabel}
      </button>
      <button
        className="menu-item"
        disabled={!canMulti}
        title={
          canMulti
            ? undefined
            : "Select two or more vias or net vertices first"
        }
        onClick={() => {
          if (!canMulti) return;
          onStartMultiWire();
          onClose();
        }}
      >
        {canMulti
          ? `Start multi-wire from ${menu.multiPointCount} points`
          : "Start multi-wire from selection"}
      </button>
    </div>
  );
}
