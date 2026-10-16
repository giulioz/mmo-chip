import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Cell, DieMetadata } from "shared";
import { cellScaleOf } from "shared/cellLibrary";
import type { ActionDispatcher } from "../../api/actions";
import { applyDieUpdate, updateDie, useDie } from "../../api/dies";
import { placeableTypes, type CellLibraryView, type ForeignType } from "../../lib/cellLibrary";
import { pointInRect, type Point } from "../../lib/geometry";
import { isTypingTarget } from "../../lib/keyboard";
import {
  placementCell,
  placementFootprint,
  rectCornerPoints,
  resizeFromCorner,
  type LibraryPlacement
} from "../../lib/libraryPlacement";
import { createLiveValue, type LiveValue } from "../../lib/liveValue";
import { orientOnDie, type DieOrientOp } from "../../lib/mergeCells";
import type { Interaction, PointerEventData } from "../../renderer/interaction";
import type { Viewport } from "../../renderer/types";
import { useDieViewerStore, type ToolKind } from "../../state/dieViewer";

/** Corner-handle grab radius, css px. */
const HANDLE_TOL_PX = 8;

export interface LibraryCellTool {
  /** The die's cell library (null ⇒ none: nothing to place). */
  libraryName: string | null;
  /** Placeable types — the library's other dies' matched ones, biggest first. */
  types: ForeignType[];
  chosen: ForeignType | null;
  choose: (typeId: string | null) => void;
  /** The template being fitted (hot path: the overlay and scale readout
   *  subscribe; the page doesn't re-render while it's dragged). */
  draftLive: LiveValue<LibraryPlacement | null>;
  hasDraft: boolean;
  orient: (op: DieOrientOp) => void;
  /** Place the cell and set the die's scale from the fit. */
  accept: () => Promise<void>;
  cancel: () => void;
  /** Canvas click: the template jumps there (or appears, once a type is
   *  picked). */
  moveTo: (p: Point) => void;
  pointerDown: (e: PointerEventData) => Interaction;
  /** Show the type's pixels (an instance on its own die) under its layers. */
  showImage: boolean;
  setShowImage: (on: boolean) => void;
  /** The chosen type's owner die (its tiles feed the image) and an instance
   *  there to take them from. */
  ownerDie: DieMetadata | undefined;
  ownerMember: Cell | null;
  busy: boolean;
  error: string | null;
  /** Last acceptance, for the status line. */
  notice: string | null;
}

/**
 * The "Place library cell" tool: pick a cell type another die of the library
 * owns, fit its template (drawn with its layer annotations) over an instance
 * on this die — drag to move, corners to scale, toolbar buttons to turn and
 * flip — and accept: a cell of that type lands there and the die's scale
 * becomes whatever makes the type that size here.
 */
export function useLibraryCellTool({
  dieId,
  library,
  dispatcher,
  viewportLive,
  containerRef,
  activeTool
}: {
  dieId: string;
  library: CellLibraryView;
  dispatcher: ActionDispatcher;
  viewportLive: LiveValue<Viewport | null>;
  containerRef: RefObject<HTMLElement | null>;
  activeTool: ToolKind;
}): LibraryCellTool {
  const qc = useQueryClient();
  const draftLive = useMemo(() => createLiveValue<LibraryPlacement | null>(null), []);
  const [hasDraft, setHasDraft] = useState(false);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [showImage, setShowImage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const libraryRef = useRef(library);
  libraryRef.current = library;

  const types = useMemo(() => placeableTypes(library), [library]);
  const chosen = (typeId && library.foreign.get(typeId)) || null;
  const ownerDie = useDie(chosen?.ownerDieId).data;
  const ownerMember = useMemo(() => {
    if (!chosen) return null;
    const cells = library.annotations.get(chosen.ownerDieId)?.cells ?? [];
    return (
      cells.find(
        (c) => c.cellTypeId === chosen.type.id && (c.cellTypeDieId ?? chosen.ownerDieId) === chosen.ownerDieId
      ) ?? null
    );
  }, [chosen, library]);

  const setDraft = useCallback(
    (d: LibraryPlacement | null) => {
      draftLive.set(d);
      setHasDraft(d !== null);
    },
    [draftLive]
  );

  // Leaving the tool drops the template; so does its type disappearing.
  useEffect(() => {
    if (activeTool !== "libraryCell") setDraft(null);
  }, [activeTool, setDraft]);
  useEffect(() => {
    if (typeId && !library.foreign.has(typeId) && !library.loading) {
      setTypeId(null);
      setDraft(null);
    }
  }, [typeId, library, setDraft]);

  const viewportCentre = useCallback((): Point => {
    const vp = viewportLive.get();
    const el = containerRef.current;
    if (!vp || !el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return { x: vp.originX + r.width / 2 / vp.zoom, y: vp.originY + r.height / 2 / vp.zoom };
  }, [viewportLive, containerRef]);

  /** A fresh template of `f` centred on `at`: at the die's current scale —
   *  or, when swapping between types of the same die, the one being fitted. */
  const spawn = useCallback(
    (f: ForeignType, at: Point) => {
      const prev = draftLive.get();
      const prevOwner = prev && libraryRef.current.foreign.get(prev.typeId)?.ownerDieId;
      setDraft({
        typeId: f.type.id,
        cx: at.x,
        cy: at.y,
        k: prev && prevOwner === f.ownerDieId ? prev.k : f.ratio,
        rotation: 0,
        flippedH: false,
        flippedV: false
      });
    },
    [draftLive, setDraft]
  );

  const choose = useCallback(
    (id: string | null) => {
      setTypeId(id);
      setError(null);
      const f = id ? libraryRef.current.foreign.get(id) : undefined;
      if (!f) {
        setDraft(null);
        return;
      }
      const d = draftLive.get();
      spawn(f, d ? { x: d.cx, y: d.cy } : viewportCentre());
      // Nothing annotated to line up by ⇒ show the cell's pixels instead.
      const layers = f.type.layers ?? {};
      setShowImage(!Object.values(layers).some((s) => s && s.length > 0));
    },
    [draftLive, setDraft, spawn, viewportCentre]
  );

  const orient = useCallback(
    (op: DieOrientOp) => {
      const d = draftLive.get();
      if (d) setDraft(orientOnDie(d, op));
    },
    [draftLive, setDraft]
  );

  const cancel = useCallback(() => setDraft(null), [setDraft]);

  const moveTo = useCallback(
    (p: Point) => {
      const d = draftLive.get();
      if (d) setDraft({ ...d, cx: p.x, cy: p.y });
      else if (chosen) spawn(chosen, p);
    },
    [draftLive, setDraft, chosen, spawn]
  );

  const accept = useCallback(async () => {
    const d = draftLive.get();
    const f = d ? libraryRef.current.foreign.get(d.typeId) : undefined;
    if (!d || !f || busy) return;
    setBusy(true);
    setError(null);
    try {
      // This die's pixels per library unit: the owner's, times the fit.
      const scale = cellScaleOf(libraryRef.current.dies.get(f.ownerDieId)) * d.k;
      applyDieUpdate(qc, await updateDie(dieId, { cellScale: scale }));
      const cell = placementCell(d, f.type, f.ownerDieId, crypto.randomUUID());
      await dispatcher.dispatch({ kind: "upsertCell", cell, prevCell: null });
      setDraft(null);
      useDieViewerStore.getState().select([`cell:${cell.id}`], "replace");
      setNotice(`placed ${f.type.name} · scale ${Number(scale.toFixed(5))} px / library unit`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "placing the cell failed");
    } finally {
      setBusy(false);
    }
  }, [draftLive, busy, qc, dieId, dispatcher, setDraft]);

  // Enter accepts, Escape drops the template.
  useEffect(() => {
    if (activeTool !== "libraryCell") return;
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && draftLive.get()) {
        e.preventDefault();
        void accept();
      } else if (e.key === "Escape" && draftLive.get()) {
        e.preventDefault();
        setDraft(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTool, accept, draftLive, setDraft]);

  const pointerDown = useCallback(
    (e: PointerEventData): Interaction => {
      const d = draftLive.get();
      const f = d ? libraryRef.current.foreign.get(d.typeId) : undefined;
      const vp = viewportLive.get();
      if (!d || !f || !vp) return "pan";
      const fp = placementFootprint(d, f.type);
      const tol = HANDLE_TOL_PX / vp.zoom;
      const corner = rectCornerPoints(fp).findIndex(
        (c) => Math.abs(c.x - e.worldPoint.x) <= tol && Math.abs(c.y - e.worldPoint.y) <= tol
      );
      if (corner >= 0) {
        // Corner: scale uniformly, the opposite corner pinned.
        const resize = (wp: Point) => draftLive.set(resizeFromCorner(d, f.type, corner, wp));
        return {
          onDragStart: ({ worldPoint }) => resize(worldPoint),
          onDragMove: ({ worldPoint }) => resize(worldPoint),
          onPointerUp: ({ dragged, worldPoint }) => {
            if (dragged) resize(worldPoint);
          },
          onCancel: () => draftLive.set(d)
        };
      }
      if (pointInRect(e.worldPoint, fp)) {
        // Body: move.
        const move = (wp: Point, from: Point) =>
          draftLive.set({ ...d, cx: d.cx + wp.x - from.x, cy: d.cy + wp.y - from.y });
        return {
          onDragStart: ({ worldPoint, startWorld }) => move(worldPoint, startWorld),
          onDragMove: ({ worldPoint, startWorld }) => move(worldPoint, startWorld),
          onPointerUp: ({ dragged, worldPoint, startWorld }) => {
            if (dragged) move(worldPoint, startWorld);
          },
          onCancel: () => draftLive.set(d)
        };
      }
      // Elsewhere: pan (a plain click moves the template there).
      return "pan";
    },
    [draftLive, viewportLive]
  );

  return {
    libraryName: library.name,
    types,
    chosen,
    choose,
    draftLive,
    hasDraft,
    orient,
    accept,
    cancel,
    moveTo,
    pointerDown,
    showImage,
    setShowImage,
    ownerDie,
    ownerMember,
    busy,
    error,
    notice
  };
}
