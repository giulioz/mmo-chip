import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "../testRequest.test.js";
import type { CellImagingJob, CellSpecimenIndex, DieAnnotations, WireMapInfo } from "shared";
import { createApp } from "../app.js";
import { ensureDataStore } from "../store.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];
afterEach(async () => {
  await Promise.all(tempServers.map((s) => new Promise<void>((res, rej) => s.close((e) => (e ? rej(e) : res())))));
  tempServers.length = 0;
  await Promise.all(tempRoots.map((r) => fs.rm(r, { recursive: true, force: true })));
  tempRoots.length = 0;
});

const DW = 512;
const DH = 256;
const W = 48;
const H = 40;

/** Non-periodic blocky texture (registration-friendly), canonical coords. */
function cellPixel(x: number, y: number): number {
  let v = 70;
  if (x > 4 && x < 16 && y > 5 && y < 30) v = 170;
  if (x > 22 && x < 30 && y > 12 && y < 36) v = 120;
  if (x > 34 && x < 44 && y > 3 && y < 14) v = 190;
  if (y > 32 && x > 6 && x < 20) v = 40;
  if ((x === 20 || x === 21) && y < 22) v = 30;
  return v;
}

interface Placed { id: string; x: number; y: number; flippedH: boolean; wireOffset: number }
const CELLS: Placed[] = [];
const ROW1 = [6, 14, 22, 30, 38, 44];
const ROW2 = [10, 18, 26, 34, 42, 8];
for (let i = 0; i < 6; i++) {
  CELLS.push({ id: `a${i}`, x: 20 + i * 80, y: 30, flippedH: i % 2 === 1, wireOffset: ROW1[i] });
  CELLS.push({ id: `b${i}`, x: 20 + i * 80, y: 150, flippedH: i % 2 === 1, wireOffset: ROW2[i] });
}

async function dieImage(): Promise<Buffer> {
  const px = Buffer.alloc(DW * DH * 3, 95);
  for (const c of CELLS) {
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const v = cellPixel(c.flippedH ? W - 1 - x : x, y);
        px.fill(v, ((c.y + y) * DW + c.x + x) * 3, ((c.y + y) * DW + c.x + x) * 3 + 3);
      }
    }
    // A bright 3px "wire" running over the cell (and its whole half of the die).
    const y0 = c.y < 128 ? 0 : 128;
    for (let y = y0; y < y0 + 128; y++) {
      for (let k = -1; k <= 1; k++) px.fill(250, (y * DW + c.x + c.wireOffset + k) * 3, (y * DW + c.x + c.wireOffset + k) * 3 + 3);
    }
  }
  return sharp(px, { raw: { width: DW, height: DH, channels: 3 } }).png().toBuffer();
}

async function waitJob(app: import("node:http").Server, dieId: string): Promise<CellImagingJob> {
  for (let i = 0; i < 1500; i++) {
    const j = (await request(app).get(`/api/dies/${dieId}/cell-imaging/job`)).body as CellImagingJob;
    if (j && j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("imaging job timed out");
}

test("specimens come out wire-free and the wire map lights up on the wires only", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-imaging-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const app = createServer(
    createApp({ dataRoot, tileSize: 128, limitInputPixels: false, tileConcurrency: 2, mlSidecarUrl: "http://127.0.0.1:1", mlPredictPad: 8 })
  );
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  tempServers.push(app);

  const imp = await request(app).post("/api/dies/import").attach("file", await dieImage(), { filename: "die.png", contentType: "image/png" });
  let dieId = "";
  for (let i = 0; i < 300 && !dieId; i++) {
    const j = await request(app).get(`/api/import-jobs/${imp.body.id}`);
    if (j.body.status === "completed") dieId = j.body.dieId;
    else await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(dieId);
  const annotations: DieAnnotations = {
    version: 2,
    rev: 3,
    nets: [],
    grids: [],
    cellTypes: [{ id: "ct1", name: "INV", cropRect: { x: 0, y: 0, width: W, height: H }, matched: true }],
    cells: CELLS.map((c) => ({ id: c.id, cellTypeId: "ct1", x: c.x, y: c.y, ...(c.flippedH ? { flippedH: true } : {}) }))
  };
  const annPath = path.join(dataRoot, "dies", dieId, "annotations.json");
  await fs.writeFile(annPath, JSON.stringify(annotations));

  // Wire map before specimens → refused.
  assert.equal((await request(app).post(`/api/dies/${dieId}/cell-imaging/job/start`).send({ kind: "wireMap" })).status, 400);
  assert.equal((await request(app).post(`/api/dies/${dieId}/cell-imaging/job/start`).send({ kind: "nope" })).status, 400);
  assert.equal((await request(app).get(`/api/dies/${dieId}/cell-specimens`)).body, null);

  // ── Specimens ─────────────────────────────────────────────────────
  assert.equal((await request(app).post(`/api/dies/${dieId}/cell-imaging/job/start`).send({ kind: "specimens" })).status, 200);
  const sj = await waitJob(app, dieId);
  assert.equal(sj.status, "completed", sj.error ?? "");
  const index = (await request(app).get(`/api/dies/${dieId}/cell-specimens`)).body as CellSpecimenIndex;
  assert.equal(index.specimens.length, 1);
  assert.deepEqual(
    { w: index.specimens[0].width, h: index.specimens[0].height, n: index.specimens[0].instancesUsed },
    { w: W, h: H, n: 12 }
  );
  const fetchPng = (url: string) =>
    request(app).get(url).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
  // Default image = the sharpened 2× display rendering.
  assert.equal(index.specimens[0].displayScale, 2);
  assert.deepEqual(index.specimens[0].orientationMismatchIds, []);
  const hiRes = await fetchPng(`/api/dies/${dieId}/cell-specimens/ct1/image`);
  assert.equal(hiRes.status, 200);
  const hiMeta = await sharp(hiRes.body as Buffer).metadata();
  assert.deepEqual([hiMeta.width, hiMeta.height], [W * 2, H * 2]);
  const hiPx = await sharp(hiRes.body as Buffer).removeAlpha().raw().toBuffer();
  // Wire-free too. Judged on flat background spots that sit under a wire in
  // some instance (sharpening legitimately overshoots at the synthetic die's
  // razor-sharp block edges, so "no bright pixel anywhere" would be wrong).
  for (const [cx, cy] of [[38, 25], [30, 8], [17, 30]]) {
    assert.equal(cellPixel(cx, cy), 70, "test spot must be plain background");
    const v = hiPx[((cy * 2 + 1) * W * 2 + cx * 2 + 1) * 3];
    assert.ok(v < 130, `2x specimen shows a wire at canonical (${cx},${cy}): ${v}`);
  }
  // `?scale=1` = the plain median the wire map measures against.
  const img = await fetchPng(`/api/dies/${dieId}/cell-specimens/ct1/image?scale=1`);
  assert.equal(img.status, 200);
  const spec = await sharp(img.body as Buffer).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([spec.info.width, spec.info.height], [W, H]);
  // Contrast is normalised, so compare structure: correlation with the clean
  // texture must be near-perfect, and no pixel may be wire-bright.
  let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, brightest = 0;
  const n = W * H;
  for (let i = 0; i < n; i++) { sa += spec.data[i * 3]; sb += cellPixel(i % W, Math.floor(i / W)); }
  for (let i = 0; i < n; i++) {
    const a = spec.data[i * 3] - sa / n;
    const b = cellPixel(i % W, Math.floor(i / W)) - sb / n;
    sab += a * b; saa += a * a; sbb += b * b;
    brightest = Math.max(brightest, spec.data[i * 3]);
  }
  const corr = sab / Math.sqrt(saa * sbb);
  assert.ok(corr > 0.97, `specimen vs clean texture correlation ${corr.toFixed(3)}`);
  assert.ok(brightest < 235, `specimen still has a wire-bright pixel (${brightest})`);

  // ── Wire map ──────────────────────────────────────────────────────
  assert.equal((await request(app).post(`/api/dies/${dieId}/cell-imaging/job/start`).send({ kind: "wireMap" })).status, 200);
  const wj = await waitJob(app, dieId);
  assert.equal(wj.status, "completed", wj.error ?? "");
  const info = (await request(app).get(`/api/dies/${dieId}/wire-map`)).body as WireMapInfo;
  assert.equal(info.cellsProcessed, 12);
  assert.equal(info.cellsSkipped, 0);
  assert.equal(info.annotationsRev, 3);
  assert.ok(info.minZoomLevel < info.maxZoomLevel);

  const alphaAt = async (x: number, y: number) => {
    const file = path.join(dataRoot, "dies", dieId, "wire-map", String(info.maxZoomLevel), `${Math.floor(x / 128)}_${Math.floor(y / 128)}.png`);
    const t = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return t.data[(((y % 128) * t.info.width + (x % 128)) * 4) + 3];
  };
  for (const c of [CELLS[0], CELLS[3], CELLS[8]]) {
    const onWire = await alphaAt(c.x + c.wireOffset, c.y + 20);
    assert.ok(onWire > 150, `${c.id}: wire pixel alpha ${onWire}`);
    // Away from the wire the cell must be essentially clear. Judged over the
    // whole cell rather than one pixel: the synthetic die has razor-sharp
    // edges, and JPEG ringing beside them can nudge an isolated column.
    let lit = 0;
    let total = 0;
    for (let y = 2; y < H - 2; y += 3) {
      for (let x = 0; x < W; x++) {
        if (Math.abs(x - c.wireOffset) <= 3) continue;
        total += 1;
        if ((await alphaAt(c.x + x, c.y + y)) > 100) lit += 1;
      }
    }
    assert.ok(lit / total < 0.06, `${c.id}: ${((lit / total) * 100).toFixed(1)}% of non-wire pixels lit`);
  }
  // Tiles: a real one, an empty one (transparent stub, not a 404), a coarse one.
  const real = await request(app).get(`/api/dies/${dieId}/wire-map/tiles/${info.maxZoomLevel}/0/0`);
  assert.equal(real.status, 200);
  assert.match(real.headers["content-type"], /image\/png/);
  assert.equal((await request(app).get(`/api/dies/${dieId}/wire-map/tiles/${info.maxZoomLevel}/99/99`)).status, 200);
  await fs.access(path.join(dataRoot, "dies", dieId, "wire-map", String(info.minZoomLevel)));

  // Derived data only: annotations untouched, and clearing removes just the folders.
  assert.deepEqual(JSON.parse(await fs.readFile(annPath, "utf8")), annotations);
  assert.equal((await request(app).delete(`/api/dies/${dieId}/wire-map`)).status, 200);
  assert.equal((await request(app).get(`/api/dies/${dieId}/wire-map`)).body, null);
  assert.equal((await request(app).delete(`/api/dies/${dieId}/cell-specimens`)).status, 200);
  assert.equal((await request(app).get(`/api/dies/${dieId}/cell-specimens`)).body, null);
  assert.deepEqual(JSON.parse(await fs.readFile(annPath, "utf8")), annotations);
});

test("pooled specimens stack a type's instances from the library's other dies too", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-imaging-pool-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const app = createServer(
    createApp({ dataRoot, tileSize: 128, limitInputPixels: false, tileConcurrency: 2, mlSidecarUrl: "http://127.0.0.1:1", mlPredictPad: 8 })
  );
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  tempServers.push(app);
  const importPng = async (png: Buffer) => {
    const imp = await request(app).post("/api/dies/import").attach("file", png, { filename: "die.png", contentType: "image/png" });
    for (let i = 0; i < 300; i++) {
      const j = await request(app).get(`/api/import-jobs/${imp.body.id}`);
      if (j.body.status === "completed") return j.body.dieId as string;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error("import timed out");
  };
  const full = await dieImage();
  const dieId = await importPng(full);
  // The same die photographed at half the magnification.
  const halfId = await importPng(await sharp(full).resize(DW / 2, DH / 2, { kernel: "linear" }).png().toBuffer());
  await request(app).patch(`/api/dies/${dieId}`).send({ cellLibrary: "lib" }).expect(200);
  await request(app).patch(`/api/dies/${halfId}`).send({ cellLibrary: "lib", cellScale: 0.5 }).expect(200);
  const type = { id: "ct1", name: "INV", cropRect: { x: 0, y: 0, width: W, height: H }, matched: true };
  const flip = (c: Placed) => (c.flippedH ? { flippedH: true } : {});
  // Here: the first row only. There: the second row, pointing at the type.
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify({ version: 2, rev: 1, nets: [], grids: [], cellTypes: [type],
      cells: CELLS.filter((c) => c.id.startsWith("a")).map((c) => ({ id: c.id, cellTypeId: "ct1", x: c.x, y: c.y, ...flip(c) })) })
  );
  await fs.writeFile(
    path.join(dataRoot, "dies", halfId, "annotations.json"),
    JSON.stringify({ version: 2, rev: 1, nets: [], grids: [], cellTypes: [],
      cells: CELLS.filter((c) => c.id.startsWith("b")).map((c) => ({ id: `h${c.id}`, cellTypeId: "ct1", cellTypeDieId: dieId, x: c.x / 2, y: c.y / 2, ...flip(c) })) })
  );

  const run = async (allDies: boolean) => {
    assert.equal((await request(app).post(`/api/dies/${dieId}/cell-imaging/job/start`).send({ kind: "specimens", allDies })).status, 200);
    const j = await waitJob(app, dieId);
    assert.equal(j.status, "completed", j.error ?? "");
    return ((await request(app).get(`/api/dies/${dieId}/cell-specimens`)).body as CellSpecimenIndex).specimens[0];
  };
  const alone = await run(false);
  assert.equal(alone.instancesUsed, 6);
  assert.equal(alone.dies, undefined);
  const pooled = await run(true);
  assert.deepEqual([pooled.instancesUsed, pooled.dies, pooled.width, pooled.height], [12, 2, W, H]);
  // Still this die's cell, at this die's size, wires voted out.
  const px = await sharp(
    (await request(app).get(`/api/dies/${dieId}/cell-specimens/ct1/image?scale=1`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    })).body as Buffer
  ).removeAlpha().raw().toBuffer();
  for (const [x, y, want] of [[10, 15, 170], [38, 25, 70], [26, 25, 120]] as const) {
    assert.ok(Math.abs(px[(y * W + x) * 3] - want) < 25, `(${x},${y}) = ${px[(y * W + x) * 3]}, want ~${want}`);
  }
});
