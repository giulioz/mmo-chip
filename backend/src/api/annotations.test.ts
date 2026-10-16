import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "supertest";
import type { AnnotationBatchOp, Cell, CellType, DieAnnotations, Guide } from "shared";
import { createApp } from "../app.js";
import { ensureDataStore } from "../store.js";
import type { AnnotationBroadcaster } from "../ws.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];
afterEach(async () => {
  await Promise.all(tempServers.map((s) => new Promise<void>((res, rej) => s.close((e) => (e ? rej(e) : res())))));
  tempServers.length = 0;
  await Promise.all(tempRoots.map((r) => fs.rm(r, { recursive: true, force: true })));
  tempRoots.length = 0;
});

// Die: dark, with one bright 40×60 block at [60, 100) × [20, 80).
const DW = 200;
const DH = 120;
const BLOCK = { x: 60, y: 20, w: 40, h: 60 };

async function dieImage(): Promise<Buffer> {
  const px = Buffer.alloc(DW * DH * 3, 20);
  for (let y = BLOCK.y; y < BLOCK.y + BLOCK.h; y++) {
    px.fill(230, (y * DW + BLOCK.x) * 3, (y * DW + BLOCK.x + BLOCK.w) * 3);
  }
  return sharp(px, { raw: { width: DW, height: DH, channels: 3 } }).png().toBuffer();
}

async function harness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-annotations-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const changes: Array<[string, number]> = [];
  const broadcaster: AnnotationBroadcaster = {
    emitAnnotationChange: (dieId, rev) => changes.push([dieId, rev]),
    emitMLJob: () => {},
    emitCellJob: () => {},
    emitImagingJob: () => {},
    emitDieChange: () => {},
    close: async () => {}
  };
  const app = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2,
      mlSidecarUrl: "http://127.0.0.1:1",
      mlPredictPad: 8,
      broadcaster
    })
  );
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", () => r()));
  tempServers.push(app);

  const imp = await request(app)
    .post("/api/dies/import")
    .attach("file", await dieImage(), { filename: "die.png", contentType: "image/png" });
  let dieId = "";
  for (let i = 0; i < 300 && !dieId; i++) {
    const j = await request(app).get(`/api/import-jobs/${imp.body.id}`);
    if (j.body.status === "completed") dieId = j.body.dieId;
    else await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(dieId, "die import");
  const annPath = path.join(dataRoot, "dies", dieId, "annotations.json");
  const write = (a: DieAnnotations) => fs.writeFile(annPath, JSON.stringify(a));
  const read = async () => JSON.parse(await fs.readFile(annPath, "utf8")) as DieAnnotations;
  return { app, dataRoot, dieId, changes, write, read };
}

const type = (id: string, width: number, height: number): CellType => ({
  id,
  name: id,
  cropRect: { x: 0, y: 0, width, height },
  matched: true
});
const cell = (id: string, x: number, extra: Partial<Cell> = {}): Cell => ({
  id,
  cellTypeId: "tA",
  x,
  y: 10,
  ...extra
});

test("a batch lands as one write and one revision, applied in order", async () => {
  const h = await harness();
  const before: DieAnnotations = {
    version: 2,
    rev: 5,
    nets: [],
    grids: [],
    cellTypes: [type("tA", 30, 17)],
    cells: [cell("a", 0), cell("b", 40), cell("c", 80)]
  };
  await h.write(before);
  const guide: Guide = { id: "g1", kind: "line", axis: "x", pos: 12 };
  const ops: AnnotationBatchOp[] = [
    { op: "upsert", collection: "cellTypes", item: { ...type("tA", 17, 30), name: "NAND2" } },
    { op: "upsert", collection: "cells", item: cell("a", 6.5, { rotation: 270 }) },
    { op: "remove", collection: "cells", id: "b" },
    { op: "upsert", collection: "cells", item: cell("d", 120) },
    { op: "upsert", collection: "guides", item: guide },
    { op: "upsert", collection: "cells", item: cell("e", 160) },
    { op: "remove", collection: "cells", id: "e" }
  ];
  const res = await request(h.app).post(`/api/dies/${h.dieId}/batch`).send({ ops });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body, { ok: true, rev: 6 });

  const after = await h.read();
  assert.equal(after.rev, 6);
  assert.deepEqual(after.cellTypes, [{ ...type("tA", 17, 30), name: "NAND2" }]);
  assert.deepEqual(after.cells, [cell("a", 6.5, { rotation: 270 }), cell("c", 80), cell("d", 120)]);
  assert.deepEqual(after.guides, [guide]);
  assert.deepEqual(h.changes, [[h.dieId, 6]], "one change notification");
});

test("a malformed batch writes nothing", async () => {
  const h = await harness();
  const before: DieAnnotations = {
    version: 2,
    rev: 2,
    nets: [],
    grids: [],
    cellTypes: [type("tA", 30, 17)],
    cells: [cell("a", 0)]
  };
  await h.write(before);
  const bad: unknown[] = [
    [],
    [{ op: "upsert", collection: "cells", item: cell("z", 1) }, { op: "upsert", collection: "bogus", item: { id: "q" } }],
    [{ op: "remove", collection: "cells" }],
    [{ op: "upsert", collection: "cells", item: { x: 1 } }],
    [{ op: "move", collection: "cells", id: "a" }]
  ];
  for (const ops of bad) {
    const res = await request(h.app).post(`/api/dies/${h.dieId}/batch`).send({ ops });
    assert.equal(res.status, 400, JSON.stringify(ops));
  }
  assert.equal((await request(h.app).post(`/api/dies/${h.dieId}/batch`).send({})).status, 400);
  assert.deepEqual(await h.read(), before);
  assert.deepEqual(h.changes, []);
});

test("a cell crop covers the instance's oriented footprint", async () => {
  const h = await harness();
  // The same 40×60 block placed two ways: a 60×40 type turned a quarter turn
  // (footprint centre (50 + 30, 30 + 20) = the block's centre), and a 40×60
  // type unturned. Both must crop exactly the block.
  await h.write({
    version: 2,
    rev: 1,
    nets: [],
    grids: [],
    cellTypes: [type("tA", 60, 40), type("tB", 40, 60)],
    cells: [
      { id: "turned", cellTypeId: "tA", x: 50, y: 30, rotation: 90 },
      { id: "plain", cellTypeId: "tB", x: BLOCK.x, y: BLOCK.y }
    ]
  });
  for (const id of ["turned", "plain"]) {
    const res = await request(h.app)
      .get(`/api/dies/${h.dieId}/cells/${id}/crop`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => cb(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 200, id);
    const img = await sharp(res.body as Buffer).raw().toBuffer({ resolveWithObject: true });
    assert.deepEqual([img.info.width, img.info.height], [BLOCK.w, BLOCK.h], id);
    let sum = 0;
    for (let i = 0; i < img.data.length; i += img.info.channels) sum += img.data[i];
    const mean = sum / (img.info.width * img.info.height);
    assert.ok(mean > 200, `${id}: crop mean ${mean.toFixed(0)} — not the block`);
  }
  // Unturned footprints keep the historical cache key; turned ones add their size.
  const cached = (await fs.readdir(path.join(h.dataRoot, "dies", h.dieId, "cell-crops"))).sort();
  assert.deepEqual(cached, ["plain-60-20.jpg", "turned-60-20-40x60.jpg"]);
});
