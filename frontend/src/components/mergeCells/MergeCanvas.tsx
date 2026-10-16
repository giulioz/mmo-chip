import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  forwardRef,
  type CSSProperties
} from "react";
import type { Cell, CellType, DieMetadata, MLPrediction } from "shared";
import { drawCellLayers } from "../../renderer/annotations/shapes";
import { COLOR_VIA, COLOR_VIA_FILL } from "../../renderer/annotations/style";
import { enterCellDieFrame } from "../../renderer/annotations/cellFrame";
import { dieRegion } from "../../renderer/dieRegion";
import type { TileBounds } from "../../renderer/types";
import { cellFootprint } from "../../lib/cellDetection";
import { applyOrientation } from "../../lib/geometry";
import { orientOf, type Orient } from "../../lib/mergeCells";

/** A whole cell type shown lined up in another type's box (merging two
 *  types): its canonical content — `imageUrl`, else an instance's pixels —
 *  mapped into the view's box by `orient` about the two boxes' centres, then
 *  shifted by (dx, dy). All in this die's pixels. */
export interface TypeAlignView {
  cellType: CellType;
  orient: Orient;
  dx: number;
  dy: number;
  /** An instance to take the pixels from, on `die` — whose pixels are
   *  1/`scale` of this die's. */
  member: { cell: Cell; die: DieMetadata; scale: number } | null;
  /** Its pixels come from another die: corner handles scale it (which
   *  sets this die's scale — see `onScaleCandidate`). */
  scalable?: boolean;
}

export interface CellView {
  cell: Cell | null;
  cellType: CellType | null;
  /** A canonical image shown instead of the instance's own pixels (which
   *  come from the die's tile pyramid): the type's clean specimen, or its
   *  template crop when there's no instance. Overlays still follow `cell`. */
  imageUrl: string | null;
  /** ML via predictions for this cell's die bbox. Drawn as small markers
   *  inside the same orientation transform as the image so they stay pinned
   *  to image features (and move with a live drag-align). Null/absent ⇒
   *  no overlay (either disabled or not loaded yet). */
  mlVias?: MLPrediction | null;
  /** Set for a whole-type candidate: drawn lined up in `cellType`'s box (the
   *  specimen's) instead of as an instance. */
  align?: TypeAlignView;
}

export interface MergeCanvasHandle {
  /** Re-fit both crops to the viewport. */
  fit: () => void;
  zoomBy: (factor: number) => void;
}

export type MergeMode =
  | "overlay"
  | "sxs"
  | "diff"
  | "specimen"
  | "candidate";

interface Props {
  mode: MergeMode;
  /** Candidate opacity 0..1 (overlay mode only). */
  opacity: number;
  showAnno: boolean;
  /** Master toggle for the ML-via overlay. When false the canvas ignores any
   *  vias passed in via the CellViews (so the page can keep the query alive
   *  and avoid a re-fetch when the user flips the toggle). */
  showMlVias: boolean;
  specimen: CellView | null;
  candidate: CellView | null;
  /** The die's tile pyramid, which instances' pixels are drawn from. */
  die: DieMetadata | null;
  /** Commit a drag-align: source-pixel delta to apply to the candidate x/y. */
  onAlign: (dxSrc: number, dySrc: number) => void;
  /** Commit a drag-align of a whole-type candidate: the shift in the
   *  specimen's canonical frame. */
  onAlignCanonical?: (dx: number, dy: number) => void;
  /** Commit a corner drag of a scalable type candidate: the factor its size
   *  should change by (about its centre). */
  onScaleCandidate?: (factor: number) => void;
}

const GAP = 24; // world-unit gap between the two boxes in side-by-side
/** Scale-handle size / grab radius, css px. */
const HANDLE_PX = 8;
const HANDLE_GRAB_PX = 10;
/** Matches the die viewer (useCanvasGestures) so trackpad zoom feels the same
 *  — the old 0.0015 was ~7× too slow. */
const WHEEL_ZOOM_FACTOR = 0.01;

interface View {
  ox: number;
  oy: number;
  zoom: number;
}

/** Fit a cell box centred inside a pane of `pw × ph` css px. */
function fitBox(
  b: { w: number; h: number } | null,
  pw: number,
  ph: number
): View {
  const bw = Math.max(b?.w ?? 1, 1);
  const bh = Math.max(b?.h ?? 1, 1);
  const pad = 24;
  const zoom = Math.max(
    1e-3,
    Math.min((pw - pad * 2) / bw, (ph - pad * 2) / bh)
  );
  return { zoom, ox: bw / 2 - pw / 2 / zoom, oy: bh / 2 - ph / 2 / zoom };
}

function boxOf(v: CellView | null): { w: number; h: number } | null {
  if (!v || !v.cellType) return null;
  const { width, height } = v.cellType.cropRect;
  if (width <= 0 || height <= 0) return null;
  return { w: width, h: height };
}

/** Combined content extent (world units) for the current mode. */
function contentExtent(
  mode: MergeMode,
  sp: { w: number; h: number } | null,
  cd: { w: number; h: number } | null
): { w: number; h: number } {
  if (mode === "specimen") {
    return { w: Math.max(sp?.w ?? 0, 1), h: Math.max(sp?.h ?? 0, 1) };
  }
  if (mode === "candidate") {
    return { w: Math.max(cd?.w ?? 0, 1), h: Math.max(cd?.h ?? 0, 1) };
  }
  if (mode !== "sxs") {
    const w = Math.max(sp?.w ?? 0, cd?.w ?? 0, 1);
    const h = Math.max(sp?.h ?? 0, cd?.h ?? 0, 1);
    return { w, h };
  }
  const w = (sp?.w ?? 0) + GAP + (cd?.w ?? 0);
  const h = Math.max(sp?.h ?? 0, cd?.h ?? 0, 1);
  return { w: Math.max(w, 1), h };
}

export const MergeCanvas = forwardRef<MergeCanvasHandle, Props>(function MergeCanvas(
  {
    mode,
    opacity,
    showAnno,
    showMlVias,
    specimen,
    candidate,
    die,
    onAlign,
    onAlignCanonical,
    onScaleCandidate
  },
  ref
) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // One shared view for every mode. In side-by-side both panes render with
  // this same view, so panning / zooming over either pane moves both in
  // lock-step (linked comparison).
  const viewRef = useRef<View>({ ox: 0, oy: 0, zoom: 1 });
  const sizeRef = useRef({ w: 1, h: 1 });
  const dragRef = useRef<{
    kind: "pan" | "align" | "scale";
    sx: number;
    sy: number;
    startOx: number;
    startOy: number;
    dx: number;
    dy: number;
    /** Scale drags: the candidate's centre and the grabbed corner (canvas css
     *  px), and the live factor. */
    centre?: { x: number; y: number };
    corner?: { x: number; y: number };
    factor?: number;
  } | null>(null);
  const [overHandle, setOverHandle] = useState<null | "nwse" | "nesw">(null);
  const spaceRef = useRef(false);
  const [, force] = useState(0);
  const redraw = useCallback(() => force((n) => n + 1), []);

  // Latest props mirrored into a ref so the canvas callbacks/effects can stay
  // referentially stable (no ResizeObserver churn during a pan/align drag).
  const propsRef = useRef({
    mode,
    opacity,
    showAnno,
    showMlVias,
    specimen,
    candidate,
    onAlign,
    onAlignCanonical,
    onScaleCandidate
  });
  propsRef.current = {
    mode,
    opacity,
    showAnno,
    showMlVias,
    specimen,
    candidate,
    onAlign,
    onAlignCanonical,
    onScaleCandidate
  };

  /** A scalable type candidate's box on screen (canvas css px) in the single-
   *  view modes — its centre and corners — else null. */
  const scalableBox = useCallback((): {
    centre: { x: number; y: number };
    corners: Array<{ x: number; y: number }>;
  } | null => {
    const p = propsRef.current;
    const a = p.candidate?.align;
    if (!a?.scalable || p.mode === "sxs" || p.mode === "specimen") return null;
    const sp = boxOf(p.specimen);
    const cd = boxOf(p.candidate);
    if (!cd) return null;
    const ext = contentExtent(p.mode, sp, cd);
    const v = viewRef.current;
    const quarter = a.orient.rotation === 90 || a.orient.rotation === 270;
    const hw = (quarter ? a.cellType.cropRect.height : a.cellType.cropRect.width) / 2;
    const hh = (quarter ? a.cellType.cropRect.width : a.cellType.cropRect.height) / 2;
    const wx = (ext.w - cd.w) / 2 + cd.w / 2 + a.dx;
    const wy = (ext.h - cd.h) / 2 + cd.h / 2 + a.dy;
    const at = (x: number, y: number) => ({ x: (x - v.ox) * v.zoom, y: (y - v.oy) * v.zoom });
    return {
      centre: at(wx, wy),
      corners: [at(wx - hw, wy - hh), at(wx + hw, wy - hh), at(wx + hw, wy + hh), at(wx - hw, wy + hh)]
    };
  }, []);
  const handleAt = useCallback(
    (x: number, y: number) => {
      const box = scalableBox();
      if (!box) return null;
      const i = box.corners.findIndex(
        (c) => Math.abs(c.x - x) <= HANDLE_GRAB_PX && Math.abs(c.y - y) <= HANDLE_GRAB_PX
      );
      return i < 0
        ? null
        : { centre: box.centre, corner: box.corners[i], cursor: i % 2 === 0 ? ("nwse" as const) : ("nesw" as const) };
    },
    [scalableBox]
  );

  // ── Image cache ────────────────────────────────────────────────────
  const imgCache = useRef(new Map<string, HTMLImageElement>());
  const getImage = useCallback(
    (url: string | null): HTMLImageElement | null => {
      if (!url) return null;
      const cache = imgCache.current;
      const hit = cache.get(url);
      if (hit) return hit.complete && hit.naturalWidth > 0 ? hit : null;
      const img = new Image();
      img.decoding = "async";
      img.onload = redraw;
      img.onerror = redraw;
      img.src = url;
      cache.set(url, img);
      return null;
    },
    [redraw]
  );

  // A released align drag keeps showing its offset (canonical px) until the
  // candidate's new position arrives — the dispatch lands a moment after the
  // pointer-up redraw, and without this the cell would flick back to where
  // it was for a frame or two. Dropped as soon as the position changes (or
  // after a few seconds, should the edit never land).
  const settlingRef = useRef<{
    cellId: string;
    x: number;
    y: number;
    dx: number;
    dy: number;
    until: number;
  } | null>(null);

  // CSS-x offset of the pane the cursor is over (0 unless side-by-side and
  // over the right half) — used to anchor cursor-centred zoom correctly.
  const paneOffsetX = useCallback((cssX: number): number => {
    if (propsRef.current.mode !== "sxs") return 0;
    const half = sizeRef.current.w / 2;
    return cssX < half ? 0 : half;
  }, []);

  // ── Fit ────────────────────────────────────────────────────────────
  const fit = useCallback(() => {
    const p = propsRef.current;
    const sp = boxOf(p.specimen);
    const cd = boxOf(p.candidate);
    const { w: cw, h: ch } = sizeRef.current;
    if (p.mode === "sxs") {
      // Linked: one shared view sized so the larger of the two cells fits a
      // half-pane; both panes then render at the same scale/region.
      const box = {
        w: Math.max(sp?.w ?? 0, cd?.w ?? 0, 1),
        h: Math.max(sp?.h ?? 0, cd?.h ?? 0, 1)
      };
      viewRef.current = fitBox(box, cw / 2, ch);
      redraw();
      return;
    }
    const ext = contentExtent(p.mode, sp, cd);
    const pad = 32;
    const zoom = Math.max(
      1e-3,
      Math.min((cw - pad * 2) / ext.w, (ch - pad * 2) / ext.h)
    );
    viewRef.current = {
      zoom,
      ox: ext.w / 2 - cw / 2 / zoom,
      oy: ext.h / 2 - ch / 2 / zoom
    };
    redraw();
  }, [redraw]);

  useImperativeHandle(ref, () => ({
    fit,
    zoomBy: (factor: number) => {
      const v = viewRef.current;
      const { w, h } = sizeRef.current;
      const cx = v.ox + w / 2 / v.zoom;
      const cy = v.oy + h / 2 / v.zoom;
      const zoom = Math.min(64, Math.max(1e-3, v.zoom * factor));
      viewRef.current = {
        zoom,
        ox: cx - w / 2 / zoom,
        oy: cy - h / 2 / zoom
      };
      redraw();
    }
  }));

  // Re-fit when the content identity, a box's shape (a type turned a
  // quarter turn) or the mode changes (stable string key).
  const sizeKey = (v: CellView | null) => {
    const b = boxOf(v);
    return b ? `${b.w}x${b.h}` : "-";
  };
  const fitKey = `${mode}|${specimen?.cell?.id ?? specimen?.cellType?.id ?? "-"}|${
    candidate?.cell?.id ?? "-"
  }|${sizeKey(specimen)}|${sizeKey(candidate)}`;
  const fitKeyRef = useRef("");
  useEffect(() => {
    if (fitKey !== fitKeyRef.current) {
      fitKeyRef.current = fitKey;
      fit();
    }
  }, [fitKey, fit]);

  // ── Resize observer (stable: subscribes once) ──────────────────────
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const ro = new ResizeObserver(() => {
      const r = host.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        const first = sizeRef.current.w === 1 && sizeRef.current.h === 1;
        sizeRef.current = { w: r.width, h: r.height };
        if (first) fit();
        else redraw();
      }
    });
    ro.observe(host);
    return () => ro.disconnect();
  }, [fit, redraw]);

  // ── Keyboard (space = pan modifier) ─────────────────────────────────
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = true;
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // ── Draw ───────────────────────────────────────────────────────────
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const { w: cw, h: ch } = sizeRef.current;
    canvas.width = Math.max(1, Math.round(cw * dpr));
    canvas.height = Math.max(1, Math.round(ch * dpr));
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const sp = boxOf(specimen);
    const cd = boxOf(candidate);

    const mkBounds = (zoom: number): TileBounds => ({
      size: 0,
      i: 0,
      j: 0,
      world: { x: 0, y: 0, width: 0, height: 0 },
      dpr,
      zoom
    });

    // Place the world transform for a pane offset `pxX` css px from the left.
    const setWorld = (view: View, pxX: number) => {
      ctx.setTransform(
        dpr * view.zoom,
        0,
        0,
        dpr * view.zoom,
        (pxX - view.ox * view.zoom) * dpr,
        -view.oy * view.zoom * dpr
      );
    };

    /** A whole-type candidate, lined up in the specimen's `box`. */
    const drawAligned = (
      view: CellView,
      a: TypeAlignView,
      box: { w: number; h: number },
      originX: number,
      originY: number,
      alpha: number,
      live: { dx: number; dy: number; scale?: number },
      zoom: number,
      composite: GlobalCompositeOperation
    ) => {
      const cw = a.cellType.cropRect.width;
      const ch = a.cellType.cropRect.height;
      const img = getImage(view.imageUrl);
      const m = a.member;
      // The instance's footprint on its own die, in that die's pixels.
      const region =
        !img && m
          ? dieRegion(
              m.die,
              cellFootprint(m.cell, { cropRect: { x: 0, y: 0, width: cw / m.scale, height: ch / m.scale } }),
              zoom * dpr * m.scale,
              redraw
            )
          : null;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(originX + live.dx, originY + live.dy);
      ctx.globalCompositeOperation = composite;
      ctx.imageSmoothingEnabled = zoom < 3;
      // Specimen frame → the candidate's canonical frame.
      ctx.translate(box.w / 2 + a.dx, box.h / 2 + a.dy);
      ctx.rotate((a.orient.rotation * Math.PI) / 180);
      ctx.scale(a.orient.flippedH ? -1 : 1, a.orient.flippedV ? -1 : 1);
      // A corner drag in flight scales it about its centre.
      if (live.scale) ctx.scale(live.scale, live.scale);
      ctx.translate(-cw / 2, -ch / 2);
      if (img) {
        ctx.drawImage(img, 0, 0, cw, ch);
      } else if (region && m) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, cw, ch);
        ctx.clip();
        ctx.scale(m.scale, m.scale);
        enterCellDieFrame(ctx, m.cell, cw / m.scale, ch / m.scale);
        const r = region.rect;
        ctx.drawImage(region.canvas, r.x, r.y, r.width, r.height);
        ctx.restore();
      } else if (composite === "source-over") {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(0, 0, cw, ch);
      }
      ctx.globalCompositeOperation = "source-over";
      if (showAnno) drawCellLayers(ctx, a.cellType.layers, mkBounds(zoom), { outline: false });
      // Its own box, dashed (the specimen's gets the usual outline).
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(127,178,255,0.75)";
      ctx.lineWidth = 1 / zoom;
      ctx.setLineDash([4 / zoom, 3 / zoom]);
      ctx.strokeRect(0, 0, cw, ch);
      ctx.restore();
    };

    const drawCell = (
      view: CellView,
      box: { w: number; h: number },
      originX: number,
      originY: number,
      alpha: number,
      live: { dx: number; dy: number; scale?: number },
      zoom: number,
      composite: GlobalCompositeOperation = "source-over"
    ) => {
      if (view.align) {
        drawAligned(view, view.align, box, originX, originY, alpha, live, zoom, composite);
        return;
      }
      // A URL image is canonical already (clean specimen, or the type's
      // template when there's no instance); otherwise the instance's pixels
      // come straight from the die's tile pyramid at the level the zoom
      // needs, seen through its orientation and clipped to the box — one
      // composed image, so alpha / "difference" apply to it as a whole.
      const img = getImage(view.imageUrl);
      const region =
        !view.imageUrl && view.cell && view.cellType && die
          ? dieRegion(die, cellFootprint(view.cell, view.cellType), zoom * dpr, redraw)
          : null;
      ctx.save();
      ctx.globalAlpha = alpha;
      // The cell's canonical frame: origin at its box's top-left.
      ctx.translate(originX + live.dx, originY + live.dy);
      ctx.globalCompositeOperation = composite;
      ctx.imageSmoothingEnabled = zoom < 3;
      if (region && view.cell) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, box.w, box.h);
        ctx.clip();
        enterCellDieFrame(ctx, view.cell, box.w, box.h);
        const r = region.rect;
        ctx.drawImage(region.canvas, r.x, r.y, r.width, r.height);
        ctx.restore();
      } else if (img) {
        ctx.drawImage(img, 0, 0, box.w, box.h);
      } else if (composite === "source-over") {
        ctx.fillStyle = "rgba(255,255,255,0.04)";
        ctx.fillRect(0, 0, box.w, box.h);
      }
      // Annotations + outline always composite normally on top of the image.
      ctx.globalCompositeOperation = "source-over";
      if (showAnno) {
        // Merge-cells compares two cell crops side-by-side; outlining each
        // little shape muddies that visual diff. Keep the translucent fills,
        // skip the strokes — the RE page keeps both for individual editing.
        drawCellLayers(ctx, view.cellType?.layers, mkBounds(zoom), {
          outline: false
        });
      }
      // ML via overlay. Drawn in die coordinates through the same frame as
      // the crop so vias stay pinned to the underlying image features and
      // visibly move with a live drag.
      if (showMlVias && view.mlVias && view.cell) {
        ctx.save();
        enterCellDieFrame(ctx, view.cell, box.w, box.h);
        drawMlVias(ctx, view.mlVias, zoom);
        ctx.restore();
      }
      // Box outline.
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "rgba(245,214,138,0.5)";
      ctx.lineWidth = 1 / zoom;
      ctx.strokeRect(0, 0, box.w, box.h);
      ctx.restore();
    };

    if (mode === "sxs") {
      // Two independent panes: specimen left, candidate right. Each clipped
      // to its half, each with its own pan/zoom view.
      const half = cw / 2;
      const drawPane = (
        pxX: number,
        pw: number,
        view: View,
        cell: CellView | null,
        box: { w: number; h: number } | null
      ) => {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.rect(
          Math.round(pxX * dpr),
          0,
          Math.round(pw * dpr),
          Math.round(ch * dpr)
        );
        ctx.clip();
        setWorld(view, pxX);
        if (cell && box)
          drawCell(cell, box, 0, 0, 1, { dx: 0, dy: 0 }, view.zoom);
        ctx.restore();
      };
      // Same shared view in both panes → linked pan/zoom.
      // Candidate on the left, target/specimen on the right.
      const v = viewRef.current;
      drawPane(0, half, v, candidate, cd);
      drawPane(half, cw - half, v, specimen, sp);
    } else {
      // Stacked / single layout. overlay+diff draw both (diff with the
      // "difference" blend — black where they agree, bright where they
      // disagree); specimen / candidate draw just one.
      const v = viewRef.current;
      setWorld(v, 0);
      // The candidate's in-flight offset: the live align drag, or a released
      // one still waiting for its new position to land.
      const settling = settlingRef.current;
      const cc = candidate?.cell;
      const settled =
        !settling ||
        !cc ||
        cc.id !== settling.cellId ||
        cc.x !== settling.x ||
        cc.y !== settling.y ||
        performance.now() > settling.until;
      if (settled) settlingRef.current = null;
      const pending = !settled && settling ? settling : { dx: 0, dy: 0 };
      const drag = dragRef.current;
      const live =
        drag && drag.kind === "align"
          ? {
              dx: drag.dx / v.zoom + pending.dx,
              dy: drag.dy / v.zoom + pending.dy
            }
          : { dx: pending.dx, dy: pending.dy, scale: drag?.kind === "scale" ? drag.factor : undefined };
      const ext = contentExtent(mode, sp, cd);
      const showSpecimen = mode !== "candidate";
      const showCandidate = mode !== "specimen";
      if (showSpecimen && sp && specimen)
        drawCell(
          specimen,
          sp,
          (ext.w - sp.w) / 2,
          (ext.h - sp.h) / 2,
          1,
          { dx: 0, dy: 0 },
          v.zoom
        );
      if (showCandidate && cd && candidate)
        drawCell(
          candidate,
          cd,
          (ext.w - cd.w) / 2,
          (ext.h - cd.h) / 2,
          mode === "diff" ? 1 : mode === "overlay" ? opacity : 1,
          live,
          v.zoom,
          mode === "diff" ? "difference" : "source-over"
        );
      // Scale handles on a type candidate whose pixels come from another die.
      const handles = showCandidate && (!drag || drag.kind === "scale") ? scalableBox() : null;
      if (handles) {
        const f = drag?.kind === "scale" ? (drag.factor ?? 1) : 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#fff";
        ctx.strokeStyle = "rgba(127,178,255,0.95)";
        ctx.lineWidth = 1.5;
        for (const c of handles.corners) {
          const x = handles.centre.x + (c.x - handles.centre.x) * f;
          const y = handles.centre.y + (c.y - handles.centre.y) * f;
          ctx.beginPath();
          ctx.rect(x - HANDLE_PX / 2, y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
          ctx.fill();
          ctx.stroke();
        }
      }
    }
  });

  // ── Pointer interaction ────────────────────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.setPointerCapture(e.pointerId);
    const v = viewRef.current;
    const panMode = spaceRef.current || e.button === 1 || e.button === 2;
    // Aligning is single-view only (you need the specimen behind the
    // candidate to judge it); side-by-side just pans the shared view.
    const m = propsRef.current.mode;
    const canAlign =
      m !== "sxs" && !!propsRef.current.candidate && m !== "specimen";
    // A corner handle of a scalable type candidate: scale it.
    const rect = canvas.getBoundingClientRect();
    const grab = !panMode && canAlign ? handleAt(e.clientX - rect.left, e.clientY - rect.top) : null;
    dragRef.current = {
      kind: grab ? "scale" : panMode || !canAlign ? "pan" : "align",
      sx: e.clientX,
      sy: e.clientY,
      startOx: v.ox,
      startOy: v.oy,
      dx: 0,
      dy: 0,
      ...(grab ? { centre: grab.centre, corner: grab.corner, factor: 1 } : {})
    };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    const canvas = canvasRef.current;
    if (!d) {
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const over = handleAt(e.clientX - rect.left, e.clientY - rect.top)?.cursor ?? null;
      if (over !== overHandle) setOverHandle(over);
      return;
    }
    if (d.kind === "scale" && d.centre && d.corner && canvas) {
      // Uniform: the pointer projected onto the centre → corner diagonal.
      const rect = canvas.getBoundingClientRect();
      const px = e.clientX - rect.left - d.centre.x;
      const py = e.clientY - rect.top - d.centre.y;
      const kx = d.corner.x - d.centre.x;
      const ky = d.corner.y - d.centre.y;
      const len2 = kx * kx + ky * ky;
      d.factor = len2 > 0 ? Math.min(20, Math.max(0.05, (px * kx + py * ky) / len2)) : 1;
      redraw();
      return;
    }
    const v = viewRef.current;
    if (d.kind === "pan") {
      viewRef.current = {
        ...v,
        ox: d.startOx - (e.clientX - d.sx) / v.zoom,
        oy: d.startOy - (e.clientY - d.sy) / v.zoom
      };
    } else {
      d.dx = e.clientX - d.sx;
      d.dy = e.clientY - d.sy;
    }
    redraw();
  };
  const endDrag = (e: React.PointerEvent) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d) return;
    canvasRef.current?.releasePointerCapture(e.pointerId);
    if (d.kind === "scale") {
      if (d.factor && Math.abs(d.factor - 1) > 1e-4) propsRef.current.onScaleCandidate?.(d.factor);
      redraw();
      return;
    }
    if (d.kind === "align" && (d.dx !== 0 || d.dy !== 0)) {
      const v = viewRef.current;
      // Drag vector in screen-aligned world units.
      const wx = d.dx / v.zoom;
      const wy = d.dy / v.zoom;
      // A whole-type candidate moves in the specimen's frame directly.
      if (propsRef.current.candidate?.align) {
        propsRef.current.onAlignCanonical?.(wx, wy);
        redraw();
        return;
      }
      // The cell origin (cell.x/cell.y) lives in die space, and the displayed
      // image is the die seen through the inverse placement orientation
      // (O⁻¹, O = R(θ)·S). Moving the origin by δ shifts the view by −O⁻¹·δ,
      // so a screen-space drag Δ bakes in as δ = −O · Δ.
      const o = propsRef.current.candidate?.cell
        ? orientOf(propsRef.current.candidate.cell)
        : { flippedH: false, flippedV: false, rotation: 0 as const };
      const delta = applyOrientation({ x: wx, y: wy }, o, 0, 0);
      // Keep showing the dragged position until the new one lands (see
      // `settlingRef`), stacking onto a previous release still in flight.
      const cell = propsRef.current.candidate?.cell;
      if (cell) {
        const prev = settlingRef.current;
        const stack = prev && prev.cellId === cell.id && prev.x === cell.x && prev.y === cell.y;
        settlingRef.current = {
          cellId: cell.id,
          x: cell.x,
          y: cell.y,
          dx: wx + (stack ? prev.dx : 0),
          dy: wy + (stack ? prev.dy : 0),
          until: performance.now() + 3000
        };
      }
      onAlign(-delta.x, -delta.y);
    }
    redraw();
  };
  // Wheel/trackpad: bound natively & non-passively (like the die viewer's
  // useCanvasGestures) so preventDefault actually suppresses the horizontal
  // overscroll back-swipe and the ctrl/⌘-wheel browser page zoom. Safari
  // pinch `gesture*` events are swallowed too.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const cssX = e.clientX - rect.left;
      const cssY = e.clientY - rect.top;
      const v = viewRef.current;
      // Cursor px relative to the pane the pointer is over (so zoom anchors
      // on the same cell-local point in the shared/linked view).
      const px = cssX - paneOffsetX(cssX);
      const py = cssY;
      if (e.ctrlKey || e.metaKey) {
        // Zoom about the cursor — shared view, so both panes follow.
        const wx = v.ox + px / v.zoom;
        const wy = v.oy + py / v.zoom;
        const zoom = Math.min(
          64,
          Math.max(1e-3, v.zoom * Math.exp(-e.deltaY * WHEEL_ZOOM_FACTOR))
        );
        viewRef.current = { zoom, ox: wx - px / zoom, oy: wy - py / zoom };
      } else if (e.shiftKey) {
        viewRef.current = {
          ...v,
          ox: v.ox + e.deltaY / v.zoom,
          oy: v.oy + e.deltaX / v.zoom
        };
      } else {
        viewRef.current = {
          ...v,
          ox: v.ox + e.deltaX / v.zoom,
          oy: v.oy + e.deltaY / v.zoom
        };
      }
      redraw();
    };
    const preventGesture = (e: Event) => e.preventDefault();
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("gesturestart", preventGesture, { passive: false });
    canvas.addEventListener("gesturechange", preventGesture, { passive: false });
    canvas.addEventListener("gestureend", preventGesture, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("gesturestart", preventGesture);
      canvas.removeEventListener("gesturechange", preventGesture);
      canvas.removeEventListener("gestureend", preventGesture);
    };
  }, [redraw, paneOffsetX]);

  const cursor: CSSProperties["cursor"] = spaceRef.current
    ? "grab"
    : overHandle
      ? `${overHandle}-resize`
    : mode === "sxs"
      ? "grab"
      : candidate && mode !== "specimen"
        ? "move"
      : "default";

  return (
    <div
      ref={hostRef}
      style={{
        position: "relative",
        flex: "1 1 auto",
        minHeight: 0,
        background: "var(--canvas-bg)",
        overflow: "hidden",
        overscrollBehavior: "none"
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          cursor,
          touchAction: "none",
          overscrollBehavior: "none"
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => e.preventDefault()}
      />
      {mode === "sxs" && (
        <>
          <PaneHeader side="left" tone="accent">
            {candidate?.cell
              ? `Candidate · cell ${candidate.cell.id.slice(0, 6)}`
              : "Candidate · —"}
          </PaneHeader>
          <PaneHeader side="right" tone="ok">
            {specimen?.cellType
              ? `Merge into · ${specimen.cellType.name}`
              : "Merge into · —"}
          </PaneHeader>
          <div
            style={{
              position: "absolute",
              top: 0,
              bottom: 0,
              left: "calc(50% - 1px)",
              width: 2,
              background: "var(--l2)",
              boxShadow: "0 0 0 1px rgba(0,0,0,0.4)",
              pointerEvents: "none"
            }}
          />
        </>
      )}
      {!specimen && (
        <div
          className="m"
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--ink3)",
            fontSize: 11,
            letterSpacing: 0.5,
            pointerEvents: "none"
          }}
        >
          select a cell type to begin
        </div>
      )}
    </div>
  );
});

/** Screen-px sizes for the ML-via markers — kept constant on screen by
 *  dividing by zoom so they stay legible at every magnification. */
const ML_POINT_VIA_PX = 3;
const ML_IRREGULAR_STROKE_PX = 1;
/** Drop point-vias whose score is below this — the server already filters
 *  by `threshold` but at the merge canvas we want only obvious hits. */
const ML_MIN_SCORE = 0.5;

/**
 * Paint ML via predictions at their raw die coordinates. The caller has
 * already entered the cell's die frame (`enterCellDieFrame`), so they land
 * on the matching image features.
 */
function drawMlVias(
  ctx: CanvasRenderingContext2D,
  vias: MLPrediction,
  zoom: number
): void {
  ctx.save();
  // Point vias: filled green dot with a thin opaque ring for pop against
  // dark imagery. Score gates suppress weak detections.
  const r = ML_POINT_VIA_PX / zoom;
  ctx.fillStyle = COLOR_VIA;
  ctx.strokeStyle = COLOR_VIA;
  ctx.lineWidth = ML_IRREGULAR_STROKE_PX / zoom;
  for (const v of vias.pointVias) {
    if (v.score < ML_MIN_SCORE) continue;
    ctx.beginPath();
    ctx.arc(v.x, v.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Irregular vias: bbox outline + translucent fill.
  ctx.fillStyle = COLOR_VIA_FILL;
  for (const reg of vias.irregularVias) {
    if (reg.score < ML_MIN_SCORE) continue;
    const [x, y, w, h] = reg.bbox;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }
  ctx.restore();
}

/** Floating label at the top of one side-by-side pane. */
function PaneHeader({
  side,
  tone,
  children
}: {
  side: "left" | "right";
  tone: "ok" | "accent";
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 8,
        left: side === "left" ? 0 : "50%",
        width: "50%",
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none"
      }}
    >
      <span
        className="m"
        style={{
          fontSize: 10.5,
          fontWeight: 600,
          color: tone === "ok" ? "var(--ok)" : "var(--accent)",
          background: "rgba(20,20,18,0.78)",
          border: "1px solid var(--l2)",
          borderRadius: 4,
          padding: "3px 8px",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          maxWidth: "92%"
        }}
      >
        {children}
      </span>
    </div>
  );
}
