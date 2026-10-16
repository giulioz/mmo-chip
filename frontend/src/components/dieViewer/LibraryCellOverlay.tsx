import { useEffect, useRef } from "react";
import type { CellLibraryView } from "../../lib/cellLibrary";
import { cellFootprint } from "../../lib/cellDetection";
import { placementBox, placementFootprint, rectCornerPoints } from "../../lib/libraryPlacement";
import type { LiveValue } from "../../lib/liveValue";
import { enterCellDieFrame } from "../../renderer/annotations/cellFrame";
import { drawCellLayers } from "../../renderer/annotations/shapes";
import { dieRegion } from "../../renderer/dieRegion";
import type { TileBounds, Viewport } from "../../renderer/types";
import type { LibraryCellTool } from "./useLibraryCellTool";

/** Visual handle size in CSS px — matches the other editable overlays. */
const HANDLE_PX = 10;
const COLOR = "#7fb2ff";

/**
 * The "Place library cell" template: the chosen type drawn where the draft
 * sits — its layer annotations (and, when asked, its pixels from its own die)
 * scaled and oriented as fitted — with a dashed footprint, corner handles
 * and a name / scale tag. Its own canvas above the tiled one, redrawn on
 * draft / viewport changes.
 */
export function LibraryCellOverlay({
  tool,
  library,
  viewportStore
}: {
  tool: LibraryCellTool;
  library: CellLibraryView;
  viewportStore: LiveValue<Viewport | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { draftLive, showImage, ownerDie, ownerMember } = tool;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;

    let raf = 0;
    const schedule = () => {
      if (raf === 0) raf = requestAnimationFrame(draw);
    };
    function draw() {
      raf = 0;
      if (!canvas || !ctx) return;
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const cw = Math.max(1, Math.round(rect.width * dpr));
      const ch = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, cw, ch);
      const d = draftLive.get();
      const vp = viewportStore.get();
      const f = d ? library.foreign.get(d.typeId) : undefined;
      if (!d || !vp || !f) return;
      const T = f.type;
      const { w, h } = placementBox(d, T);

      // Die → device pixels, then the placed cell's frame (as the die
      // renderer draws cells), then the owner's canonical units.
      ctx.setTransform(dpr * vp.zoom, 0, 0, dpr * vp.zoom, -vp.originX * vp.zoom * dpr, -vp.originY * vp.zoom * dpr);
      ctx.save();
      ctx.translate(d.cx, d.cy);
      ctx.rotate((d.rotation * Math.PI) / 180);
      ctx.scale(d.flippedH ? -1 : 1, d.flippedV ? -1 : 1);
      ctx.translate(-w / 2, -h / 2);
      ctx.fillStyle = "rgba(127,178,255,0.10)";
      ctx.fillRect(0, 0, w, h);
      ctx.scale(d.k, d.k);
      const zoom = vp.zoom * d.k;
      if (showImage && ownerDie && ownerMember) {
        const region = dieRegion(ownerDie, cellFootprint(ownerMember, T), zoom * dpr, schedule);
        if (region) {
          ctx.save();
          ctx.beginPath();
          ctx.rect(0, 0, T.cropRect.width, T.cropRect.height);
          ctx.clip();
          ctx.globalAlpha = 0.6;
          enterCellDieFrame(ctx, ownerMember, T.cropRect.width, T.cropRect.height);
          const r = region.rect;
          ctx.drawImage(region.canvas, r.x, r.y, r.width, r.height);
          ctx.restore();
        }
      }
      const bounds: TileBounds = {
        size: 0,
        i: 0,
        j: 0,
        world: { x: 0, y: 0, width: 0, height: 0 },
        dpr,
        zoom
      };
      drawCellLayers(ctx, T.layers, bounds, { outline: true });
      // Orientation mark: the type's own top-left corner.
      const m = Math.min(T.cropRect.width, T.cropRect.height) * 0.18;
      ctx.fillStyle = COLOR;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(m, 0);
      ctx.lineTo(0, m);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      // Footprint, handles and tag in screen space.
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const fp = placementFootprint(d, T);
      const sx = (fp.x - vp.originX) * vp.zoom;
      const sy = (fp.y - vp.originY) * vp.zoom;
      const sw = fp.width * vp.zoom;
      const sh = fp.height * vp.zoom;
      ctx.strokeStyle = COLOR;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(sx, sy, sw, sh);
      ctx.setLineDash([]);
      ctx.fillStyle = "#fff";
      for (const c of rectCornerPoints({ x: sx, y: sy, width: sw, height: sh })) {
        ctx.beginPath();
        ctx.rect(c.x - HANDLE_PX / 2, c.y - HANDLE_PX / 2, HANDLE_PX, HANDLE_PX);
        ctx.fill();
        ctx.stroke();
      }
      const tag = `${T.name} · ×${d.k.toFixed(4)}`;
      ctx.font = "500 11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(tag).width + 10;
      const ty = sy - 24 < 0 ? sy + sh + 6 : sy - 24;
      ctx.fillStyle = "rgba(20,24,32,0.85)";
      ctx.fillRect(sx, ty, tw, 18);
      ctx.fillStyle = COLOR;
      ctx.fillText(tag, sx + 5, ty + 13);
    }

    draw();
    const unsubDraft = draftLive.subscribe(schedule);
    const unsubVp = viewportStore.subscribe(schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(canvas);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unsubDraft();
      unsubVp();
      ro.disconnect();
    };
  }, [draftLive, viewportStore, library, showImage, ownerDie, ownerMember]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        pointerEvents: "none"
      }}
    />
  );
}
