import assert from "node:assert/strict";
import test from "node:test";
import type { DieLevelMetadata, DieMetadata } from "shared";

// Browser stand-ins, installed before the module loads: images "load" when
// the test says so, and canvases record what's drawn into them.
const images = new Map<string, FakeImage>();
class FakeImage {
  decoding = "";
  naturalWidth = 0;
  naturalHeight = 0;
  private listeners: Record<string, Array<() => void>> = {};
  private url = "";
  addEventListener(type: string, fn: () => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  set src(url: string) {
    this.url = url;
    images.set(url, this);
  }
  get src() {
    return this.url;
  }
  fire(type: "load" | "error", w = 0, h = 0) {
    this.naturalWidth = w;
    this.naturalHeight = h;
    for (const fn of this.listeners[type] ?? []) fn();
  }
}
interface Draw {
  url: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
const g = globalThis as unknown as Record<string, unknown>;
g.Image = FakeImage;
g.document = {
  createElement: () => {
    const draws: Draw[] = [];
    return {
      width: 0,
      height: 0,
      draws,
      getContext: () => ({
        clearRect: () => draws.splice(0),
        drawImage: (img: FakeImage, x: number, y: number, w: number, h: number) =>
          draws.push({ url: img.src, x, y, w, h })
      })
    };
  }
};
const { dieRegion, levelForScale } = await import("./dieRegion");

// 3000×2000 die in 512 px tiles: levels z0 (÷8) … z3 (full resolution).
function makeDie(): DieMetadata {
  const maxZoomLevel = 3;
  const levels: DieLevelMetadata[] = [0, 1, 2, 3].map((z) => {
    const scale = 2 ** (maxZoomLevel - z);
    const width = Math.ceil(3000 / scale);
    const height = Math.ceil(2000 / scale);
    return { z, width, height, columns: Math.ceil(width / 512), rows: Math.ceil(height / 512), scale };
  });
  return {
    id: "d",
    name: "d",
    originalFilename: "d.jpg",
    width: 3000,
    height: 2000,
    tileSize: 512,
    maxZoomLevel,
    createdAt: "",
    updatedAt: "",
    tileFormat: "jpg",
    levels
  };
}
const die = makeDie();
const load = (z: number, x: number, y: number) => {
  const lv = die.levels[z];
  const w = Math.min(512, lv.width - x * 512);
  const h = Math.min(512, lv.height - y * 512);
  images.get(`/api/dies/d/tiles/${z}/${x}/${y}`)!.fire("load", w, h);
};
const drawsOf = (c: unknown) => (c as { draws: Draw[] }).draws;

test("levelForScale picks the coarsest level fine enough for the display", () => {
  assert.equal(levelForScale(die, 4), 3, "zoomed in: full resolution");
  assert.equal(levelForScale(die, 1), 3);
  assert.equal(levelForScale(die, 0.5), 2);
  assert.equal(levelForScale(die, 0.3), 2, "÷4 pixels would be 1.2 display px — too coarse");
  assert.equal(levelForScale(die, 0.25), 1);
  assert.equal(levelForScale(die, 0.01), 0);
});

test("a region composes the target level's tiles on whole pixels", () => {
  // Full resolution, straddling tile columns 0 | 1 in row 1: die x 500..560,
  // y 600..630.
  let calls = 0;
  const first = dieRegion(die, { x: 500.4, y: 600, width: 60, height: 30 }, 2, () => calls++);
  assert.ok(first);
  assert.equal(first.complete, false);
  assert.deepEqual(first.rect, { x: 500, y: 600, width: 61, height: 30 }, "snapped out to level pixels");
  assert.deepEqual([...images.keys()].sort(), [
    "/api/dies/d/tiles/3/0/1",
    "/api/dies/d/tiles/3/1/1"
  ]);
  load(3, 0, 1);
  load(3, 1, 1);
  assert.equal(calls, 2, "each landing tile asks for a redraw");
  const done = dieRegion(die, { x: 500.4, y: 600, width: 60, height: 30 }, 2, () => {});
  assert.ok(done?.complete);
  assert.deepEqual(drawsOf(done.canvas), [
    { url: "/api/dies/d/tiles/3/0/1", x: -500, y: -88, w: 512, h: 512 },
    { url: "/api/dies/d/tiles/3/1/1", x: 12, y: -88, w: 512, h: 512 }
  ]);
});

test("cached coarser tiles stand in, upscaled, while the target loads", () => {
  // Level 1 (÷4) tile covering the die's top-left 2048 px, already cached.
  dieRegion(die, { x: 0, y: 0, width: 100, height: 100 }, 0.25, () => {});
  load(1, 0, 0);
  // Now ask for level 2 (÷2) over die 1200..1300 × 40..80.
  const r = dieRegion(die, { x: 1200, y: 40, width: 100, height: 40 }, 0.5, () => {});
  assert.ok(r);
  assert.equal(r.complete, false);
  assert.deepEqual(r.rect, { x: 1200, y: 40, width: 100, height: 40 });
  // Level-1 pixels are 2 level-2 pixels: the 512×500 tile lands at −600, −20,
  // scaled ×2.
  assert.deepEqual(drawsOf(r.canvas), [
    { url: "/api/dies/d/tiles/1/0/0", x: -600, y: -20, w: 1024, h: 1000 }
  ]);
  load(2, 1, 0);
  const full = dieRegion(die, { x: 1200, y: 40, width: 100, height: 40 }, 0.5, () => {});
  assert.ok(full?.complete);
  assert.deepEqual(drawsOf(full.canvas).at(-1), {
    url: "/api/dies/d/tiles/2/1/0",
    x: -88,
    y: -20,
    w: 512,
    h: 512
  });
});

test("a region off the die has nothing to draw", () => {
  assert.equal(dieRegion(die, { x: 4000, y: 0, width: 10, height: 10 }, 1, () => {}), null);
});
