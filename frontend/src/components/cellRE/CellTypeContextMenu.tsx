import { useEffect, useRef } from "react";

export interface CellTypeContextMenuState {
  x: number;
  y: number;
  cellTypeId: string;
  /** Placed instances of the type — what the rotate actions turn. */
  memberCount: number;
  /** The type is still an unmatched placeholder (offers "Mark as matched"). */
  unmatched: boolean;
}

interface Props {
  menu: CellTypeContextMenuState;
  onClose: () => void;
  onRotate: (deg: 90 | -90) => void;
  onFlip: (axis: "h" | "v") => void;
  /** Promote an unmatched placeholder to a matched type. */
  onMarkMatched: () => void;
}

/** Right-click menu on a cell-type row in the left tree: promote an unmatched
 *  placeholder to a matched type, and flip or turn the whole type (every
 *  instance, plus the layer shapes drawn on it). */
export function CellTypeContextMenu({
  menu,
  onClose,
  onRotate,
  onFlip,
  onMarkMatched
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

  const x = Math.min(menu.x, window.innerWidth - 240);
  const y = Math.min(menu.y, window.innerHeight - 200);

  const n = menu.memberCount;
  const canRotate = n > 0;
  const noCells = canRotate ? undefined : "This type has no placed instances";

  return (
    <div
      ref={ref}
      className="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 1000, minWidth: 220 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.unmatched && (
        <>
          <button
            className="menu-item"
            title="Remove the unmatched status: list it with the matched cell types"
            onClick={() => {
              onMarkMatched();
              onClose();
            }}
          >
            Mark as matched
          </button>
          <div className="menu-sep" />
        </>
      )}
      <div className="menu-section">
        {n === 0 ? "No cells" : n === 1 ? "1 cell" : `All ${n} cells`}
      </div>
      <button
        className="menu-item"
        disabled={!canRotate}
        title={noCells}
        onClick={() => {
          onFlip("h");
          onClose();
        }}
      >
        Flip horizontally
      </button>
      <button
        className="menu-item"
        disabled={!canRotate}
        title={noCells}
        onClick={() => {
          onFlip("v");
          onClose();
        }}
      >
        Flip vertically
      </button>
      <button
        className="menu-item"
        disabled={!canRotate}
        title={noCells}
        onClick={() => {
          onRotate(90);
          onClose();
        }}
      >
        Rotate 90° clockwise
      </button>
      <button
        className="menu-item"
        disabled={!canRotate}
        title={noCells}
        onClick={() => {
          onRotate(-90);
          onClose();
        }}
      >
        Rotate 90° counter-clockwise
      </button>
    </div>
  );
}
