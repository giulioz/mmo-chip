import { useCallback, useEffect, useRef } from "react";
import type { AnnotationNet, DieAnnotations } from "shared";
import {
  netChangesToAction,
  type ActionDispatcher,
  type AnnotationAction
} from "../../api/actions";
import { isTypingTarget } from "../../lib/keyboard";
import {
  deleteSelection,
  parseNetPartId,
  type NetSelection
} from "../../lib/netGraph";
import { useDieViewerStore } from "../../state/dieViewer";

/**
 * Generic, kind-agnostic deletion of the current selection. Resolves every
 * selected id (`<prefix>:<entityId>`, plus net node/edge sub-ids) back to a
 * remove action carrying the full entity (so undo can restore it), then
 * dispatches the whole mixed selection as a single `batch` — one undo step.
 *
 * Lives on its own (not in `useWireTool`) because nothing here is
 * wire-specific; it just happens to be triggered by the same Delete key.
 */
export function useSelectionDelete(opts: {
  dispatcher: ActionDispatcher;
  annotations: DieAnnotations | undefined;
}): { deleteSelection: () => void } {
  const { dispatcher, annotations } = opts;

  // Always-fresh snapshots so the callback stays referentially stable.
  const annotationsRef = useRef<DieAnnotations | undefined>(undefined);
  annotationsRef.current = annotations;
  const netsRef = useRef<AnnotationNet[]>([]);
  netsRef.current = annotations?.nets ?? [];

  const deleteSelectionNow = useCallback(() => {
    const ids = useDieViewerStore.getState().selectedIds;
    if (ids.size === 0) return;
    const netIds = new Set<string>();
    const nodeIds = new Map<string, Set<string>>();
    const edgeIds = new Map<string, Set<string>>();
    const add = (m: Map<string, Set<string>>, k: string, v: string) => {
      const s = m.get(k);
      if (s) s.add(v);
      else m.set(k, new Set([v]));
    };

    // Resolve a non-net annotation id back to the remove action that carries
    // its full entity (needed for undo).
    const removeActionFor = (id: string): AnnotationAction | null => {
      const ci = id.indexOf(":");
      if (ci < 0) return null;
      const prefix = id.slice(0, ci);
      const eid = id.slice(ci + 1);
      const a = annotationsRef.current;
      switch (prefix) {
        case "cell": {
          const cell = a?.cells.find((c) => c.id === eid);
          return cell ? { kind: "removeCell", cell } : null;
        }
        case "anno": {
          const annotation = a?.annotations?.find((v) => v.id === eid);
          return annotation ? { kind: "removeAnnotation", annotation } : null;
        }
        case "roi": {
          const roi = a?.rois?.find((v) => v.id === eid);
          return roi ? { kind: "removeRoi", roi } : null;
        }
        case "ignore": {
          const ignore = a?.ignores?.find((v) => v.id === eid);
          return ignore ? { kind: "removeIgnore", ignore } : null;
        }
        case "pin": {
          const pin = a?.pins?.find((v) => v.id === eid);
          return pin ? { kind: "removePin", pin } : null;
        }
        case "block": {
          const block = a?.blocks?.find((v) => v.id === eid);
          return block ? { kind: "removeBlock", block } : null;
        }
        case "guide": {
          const guide = a?.guides?.find((v) => v.id === eid);
          return guide ? { kind: "removeGuide", guide } : null;
        }
        default:
          return null;
      }
    };

    // Collect every removal into one action so a mixed selection (nets +
    // cells + vias + pins + rois …) undoes in a single step.
    const actions: AnnotationAction[] = [];
    for (const id of ids) {
      if (id.startsWith("net:")) {
        const p = parseNetPartId(id);
        if (!p) continue;
        if (p.part === "net") netIds.add(p.netId);
        else if (p.part === "node" && p.partId) add(nodeIds, p.netId, p.partId);
        else if (p.part === "edge" && p.partId) add(edgeIds, p.netId, p.partId);
        continue;
      }
      const rm = removeActionFor(id);
      if (rm) actions.push(rm);
    }

    const sel: NetSelection = { netIds, nodeIds, edgeIds };
    const netAction = netChangesToAction(deleteSelection(netsRef.current, sel));
    if (netAction) {
      // Flatten so the whole gesture stays one undo step.
      if (netAction.kind === "batch") actions.unshift(...netAction.actions);
      else actions.unshift(netAction);
    }

    // Cascade: every cell carries a (often singleton) cell type. A type left
    // with zero cells after this deletion would be an unreachable zombie, so
    // remove it in the same batch — one undo step; the batch inverse restores
    // the type before the cell (cells reference types).
    const removedCellIds = new Set<string>();
    for (const act of actions) {
      if (act.kind === "removeCell") removedCellIds.add(act.cell.id);
    }
    if (removedCellIds.size > 0) {
      const a = annotationsRef.current;
      const stillUsed = new Set(
        (a?.cells ?? [])
          .filter((c) => !removedCellIds.has(c.id))
          .map((c) => c.cellTypeId)
      );
      const seen = new Set<string>();
      for (const act of actions) {
        if (act.kind !== "removeCell") continue;
        const typeId = act.cell.cellTypeId;
        if (seen.has(typeId) || stillUsed.has(typeId)) continue;
        seen.add(typeId);
        const cellType = a?.cellTypes.find((ct) => ct.id === typeId);
        if (cellType) actions.push({ kind: "removeCellType", cellType });
      }
    }

    if (actions.length > 0) {
      void dispatcher.dispatch(
        actions.length === 1 ? actions[0] : { kind: "batch", actions }
      );
    }
    useDieViewerStore.getState().clearSelection();
  }, [dispatcher]);

  // Delete / Backspace removes the current selection (ignored while typing in
  // a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      if (isTypingTarget(e.target)) return;
      if (useDieViewerStore.getState().selectedIds.size === 0) return;
      e.preventDefault();
      deleteSelectionNow();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [deleteSelectionNow]);

  return { deleteSelection: deleteSelectionNow };
}
