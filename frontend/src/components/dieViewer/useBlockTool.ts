import { useCallback, useEffect } from "react";
import type { Block, DieAnnotations } from "shared";
import type { ActionDispatcher } from "../../api/actions";
import { normalizeRect, type Rect } from "../../lib/geometry";
import { isTypingTarget } from "../../lib/keyboard";
import type { LiveValue } from "../../lib/liveValue";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";

/** Below this (image px) a drawn rectangle is treated as an accidental click
 *  and discarded instead of committed. */
const MIN_BLOCK_SIZE = 1;

export interface BlockTool {
  /** Commit the pending draft rect as a block named from the toolbar field
   *  (or "Block N" when it's empty). No-op without a usable draft. */
  commitBlock: () => void;
  /** Make a block around `rect` straight away (e.g. around a selection). */
  createBlock: (rect: Rect) => void;
}

/**
 * The "Draw block" tool: the same draft-rect interaction as the add-cell
 * tool (drag a rectangle into `blockRectLive`, then drag a corner / the body
 * to adjust it) — **Enter** commits it as a named `Block`, **Escape**
 * discards it. Blocks are plain named outlines: no cell type, no layers.
 */
export function useBlockTool(opts: {
  dispatcher: ActionDispatcher;
  annotations: DieAnnotations | undefined;
  blockRectLive: LiveValue<Rect | null>;
  activeTool: ToolKind;
  setActiveTool: (tool: ToolKind) => void;
}): BlockTool {
  const { dispatcher, annotations, blockRectLive, activeTool, setActiveTool } =
    opts;

  const createBlock = useCallback(
    (rect: Rect) => {
      const n = normalizeRect(rect);
      if (n.width < MIN_BLOCK_SIZE || n.height < MIN_BLOCK_SIZE) return;
      const store = useDieViewerStore.getState();
      const block: Block = {
        id: crypto.randomUUID(),
        name:
          store.blockName.trim() ||
          `Block ${(annotations?.blocks?.length ?? 0) + 1}`,
        x: Math.round(n.x),
        y: Math.round(n.y),
        width: Math.round(n.width),
        height: Math.round(n.height)
      };
      void dispatcher.dispatch({ kind: "upsertBlock", block, prevBlock: null });
      store.setBlockName("");
      // Select it so the inspector shows it, ready to be renamed.
      store.select([`block:${block.id}`], "replace");
    },
    [annotations, dispatcher]
  );

  const commitBlock = useCallback(() => {
    const rect = blockRectLive.get();
    if (!rect) return;
    blockRectLive.set(null);
    createBlock(rect);
  }, [blockRectLive, createBlock]);

  const cancel = useCallback(() => {
    if (blockRectLive.get()) {
      blockRectLive.set(null);
    } else {
      setActiveTool("select");
    }
  }, [blockRectLive, setActiveTool]);

  // Leaving the tool abandons any uncommitted rectangle.
  useEffect(() => {
    if (activeTool !== "addBlock" && blockRectLive.get()) blockRectLive.set(null);
  }, [activeTool, blockRectLive]);

  // Keyboard: Enter commits the pending draft rect, Escape discards it (or
  // leaves the tool when there's nothing to discard). The toolbar's name
  // field handles its own Enter.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (useDieViewerStore.getState().activeTool !== "addBlock") return;
      if (isTypingTarget(e.target)) return;
      if (e.key === "Enter") {
        if (!blockRectLive.get()) return;
        e.preventDefault();
        commitBlock();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cancel, commitBlock, blockRectLive]);

  return { commitBlock, createBlock };
}
