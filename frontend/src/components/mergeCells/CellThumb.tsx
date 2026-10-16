import { useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { Cell, CellType, DieMetadata } from "shared";
import { cellFootprint } from "../../lib/cellDetection";
import { dieRegion } from "../../renderer/dieRegion";

/**
 * A cell's die pixels as a thumbnail filling its box (like `object-fit:
 * cover`), as they lie on the die — drawn from the die's tile pyramid at the
 * level the thumbnail's size needs, rather than from a per-cell crop. Only
 * draws once scrolled into view, so a long candidate list pulls just the
 * tiles it shows.
 */
export function CellThumb({
  die,
  cell,
  cellType
}: {
  die: DieMetadata | null;
  cell: Cell;
  cellType: CellType;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const [seen, setSeen] = useState(false);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setSeen(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);

  useLayoutEffect(() => {
    const canvas = ref.current;
    if (!canvas || !seen || !die) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const fp = cellFootprint(cell, cellType);
    if (!width || !height || fp.width <= 0 || fp.height <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Cover: CSS px per die px. The level follows CSS px (as the die viewer
    // does) — a thumbnail doesn't need retina-sharp tiles.
    const scale = Math.max(width / fp.width, height / fp.height);
    const region = dieRegion(die, fp, scale, () => {
      if (alive.current) redraw();
    });
    if (!region) return;
    const k = scale * dpr;
    ctx.setTransform(
      k,
      0,
      0,
      k,
      canvas.width / 2 - (fp.x + fp.width / 2) * k,
      canvas.height / 2 - (fp.y + fp.height / 2) * k
    );
    const r = region.rect;
    ctx.drawImage(region.canvas, r.x, r.y, r.width, r.height);
  });

  return <canvas ref={ref} style={{ width: "100%", height: "100%", display: "block" }} />;
}
