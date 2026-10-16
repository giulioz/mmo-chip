import { useEffect, useRef } from "react";

export interface ReContextMenuState {
  x: number;
  y: number;
  cellId: string;
  /** Same as merge: enabled only when the type has > 1 member. */
  canUnmatch: boolean;
  /** The instance is on another die of the cell library (edits go there). */
  dieId?: string;
}

interface Props {
  menu: ReContextMenuState;
  onClose: () => void;
  onFlipH: () => void;
  onFlipV: () => void;
  onRotate: () => void;
  onUnmatch: () => void;
  onJumpToDie: () => void;
}

/** Right-click menu on a cell-instance row in the left tree. Item set mirrors
 *  the spec: flip / rotate, remove from cell type (unmatch), jump to die view. */
export function CellREContextMenu({
  menu,
  onClose,
  onFlipH,
  onFlipV,
  onRotate,
  onUnmatch,
  onJumpToDie
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

  const x = Math.min(menu.x, window.innerWidth - 220);
  const y = Math.min(menu.y, window.innerHeight - 200);

  return (
    <div
      ref={ref}
      className="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 1000, minWidth: 200 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className="menu-item"
        onClick={() => {
          onFlipH();
          onClose();
        }}
      >
        Flip horizontally
      </button>
      <button
        className="menu-item"
        onClick={() => {
          onFlipV();
          onClose();
        }}
      >
        Flip vertically
      </button>
      <button
        className="menu-item"
        onClick={() => {
          onRotate();
          onClose();
        }}
      >
        Rotate 90° clockwise
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        disabled={!menu.canUnmatch}
        onClick={() => {
          onUnmatch();
          onClose();
        }}
      >
        Remove from cell type
      </button>
      <button
        className="menu-item"
        onClick={() => {
          onJumpToDie();
          onClose();
        }}
      >
        Jump to die view
      </button>
    </div>
  );
}
