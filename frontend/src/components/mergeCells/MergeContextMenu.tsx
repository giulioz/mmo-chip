import { useEffect, useRef } from "react";
import type { Proposal } from "../../lib/cellDetection";

export interface ContextMenuState {
  x: number;
  y: number;
  cellId: string;
  /** The cell currently belongs to a matched type (unmatch is meaningful). */
  canUnmatch: boolean;
  /** Set when the row is an ML proposal — offers Dismiss instead of Unmatch. */
  proposal: Proposal | null;
}

interface Props {
  menu: ContextMenuState;
  onClose: () => void;
  onUnmatch: () => void;
  onDismiss: () => void;
  onJumpToDie: () => void;
}

export function MergeContextMenu({ menu, onClose, onUnmatch, onDismiss, onJumpToDie }: Props) {
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

  // Keep the menu on-screen.
  const x = Math.min(menu.x, window.innerWidth - 200);
  const y = Math.min(menu.y, window.innerHeight - 100);

  return (
    <div
      ref={ref}
      className="menu"
      style={{ position: "fixed", left: x, top: y, zIndex: 1000, minWidth: 180 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.proposal ? (
        <button
          className="menu-item"
          onClick={() => {
            onDismiss();
            onClose();
          }}
        >
          Dismiss proposal
        </button>
      ) : (
        <button
          className="menu-item"
          disabled={!menu.canUnmatch}
          onClick={() => {
            onUnmatch();
            onClose();
          }}
        >
          Unmatch (own new type)
        </button>
      )}
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
