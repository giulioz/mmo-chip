import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "../testRequest.test.js";
import type { CellDetectionResult, DieAnnotations, MLPrediction } from "shared";
import { createApp } from "../app.js";
import { ensureDataStore } from "../store.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(
    tempServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
  tempServers.length = 0;
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function createHarness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-celldet-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2,
      // Nothing listens here — detection must work with the sidecar down.
      mlSidecarUrl: "http://127.0.0.1:1",
      mlPredictPad: 8
    })
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  tempServers.push(server);
  return { app: server, dataRoot };
}

async function importDie(app: import("node:http").Server): Promise<string> {
  const png = await sharp({
    create: { width: 512, height: 256, channels: 3, background: { r: 40, g: 40, b: 40 } }
  })
    .png()
    .toBuffer();
  const res = await request(app)
    .post("/api/dies/import")
    .attach("file", png, { filename: "die.png", contentType: "image/png" });
  assert.equal(res.status, 202);
  for (let i = 0; i < 300; i++) {
    const job = await request(app).get(`/api/import-jobs/${res.body.id}`);
    if (job.body.status === "completed") return job.body.dieId as string;
    if (job.body.status === "failed") throw new Error(job.body.error);
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("import timed out");
}

const W = 60;
const H = 80;
const PATTERN = [
  { x: 6, y: 8 },
  { x: 30, y: 10 },
  { x: 52, y: 18 },
  { x: 12, y: 40 },
  { x: 44, y: 50 },
  { x: 8, y: 72 },
  { x: 50, y: 74 }
];

test("cell-detection job proposes placements from cached vias; dismiss/clear endpoints", async () => {
  const { app, dataRoot } = await createHarness();
  const dieId = await importDie(app);
  const die = (await request(app).get(`/api/dies/${dieId}`)).body as {
    maxZoomLevel: number;
    tileSize: number;
    levels: { z: number; columns: number; rows: number }[];
  };
  const z = die.maxZoomLevel;
  const level = die.levels.find((l) => l.z === z)!;

  // One placed member at (40, 40); an unlabelled copy at (300, 60), and a
  // horizontally mirrored copy at (120, 150).
  const annotations: DieAnnotations = {
    version: 2,
    rev: 7,
    nets: [],
    grids: [],
    cellTypes: [{ id: "ct1", name: "NAND2", cropRect: { x: 0, y: 0, width: W, height: H } }],
    cells: [{ id: "c1", cellTypeId: "ct1", x: 40, y: 40 }]
  };
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify(annotations)
  );

  const vias: { x: number; y: number; score: number }[] = [];
  for (const p of PATTERN) vias.push({ x: 40 + p.x, y: 40 + p.y, score: 0.9 });
  for (const p of PATTERN) vias.push({ x: 300 + p.x, y: 60 + p.y, score: 0.8 });
  for (const p of PATTERN) vias.push({ x: 120 + (W - p.x), y: 150 + p.y, score: 0.7 });
  // Stray noise.
  vias.push({ x: 450, y: 200, score: 0.5 }, { x: 470, y: 30, score: 0.5 });

  // Fake a completed via sweep at "nohash" (sidecar down → persisted job →
  // null hash). Every native tile gets a file so coverage is complete.
  const cacheDir = path.join(dataRoot, "predictions", dieId, "nohash");
  await fs.mkdir(cacheDir, { recursive: true });
  for (let ty = 0; ty < level.rows; ty++) {
    for (let tx = 0; tx < level.columns; tx++) {
      const x0 = tx * die.tileSize;
      const y0 = ty * die.tileSize;
      const x1 = x0 + die.tileSize;
      const y1 = y0 + die.tileSize;
      const pred: MLPrediction = {
        pointVias: vias.filter((v) => v.x >= x0 && v.x < x1 && v.y >= y0 && v.y < y1),
        irregularVias: [],
        traces: [],
        bbox: [x0, y0, x1, y1],
        checkpointHash: null
      };
      await fs.writeFile(path.join(cacheDir, `${z}_${tx}_${ty}.json`), JSON.stringify(pred));
    }
  }

  // No job yet.
  assert.equal((await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body, null);
  assert.deepEqual((await request(app).get(`/api/dies/${dieId}/cell-detections`)).body, []);

  // Bad requests.
  assert.equal(
    (await request(app).post(`/api/dies/${dieId}/cell-detections/job/start`).send({})).status,
    400
  );
  assert.equal(
    (
      await request(app)
        .post(`/api/dies/${dieId}/cell-detections/job/start`)
        .send({ cellTypeId: "nope" })
    ).status,
    400
  );

  const start = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1", allowFlipY: false });
  assert.equal(start.status, 200);
  assert.equal(start.body.status, "running");
  assert.equal(start.body.cellTypeName, "NAND2");

  let job = start.body;
  for (let i = 0; i < 500 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    job = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
  }
  assert.equal(job.status, "completed", job.error ?? "");
  assert.equal(job.percentage, 100);
  assert.equal(job.detections, 2);

  const list = (await request(app).get(`/api/dies/${dieId}/cell-detections`))
    .body as CellDetectionResult[];
  assert.equal(list.length, 1);
  const result = list[0];
  assert.equal(result.cellTypeId, "ct1");
  assert.equal(result.annotationsRev, 7);
  assert.equal(result.memberCount, 1);
  assert.equal(result.templateVias, PATTERN.length);
  assert.deepEqual(result.options, {
    allowFlipX: true,
    allowFlipY: false,
    avoidExistingCells: true
  });
  // The placed member is scored against the template it seeded.
  assert.equal(result.memberScores?.c1.score, 1);
  assert.equal(result.memberScores?.c1.matched, PATTERN.length);
  assert.equal(result.detections.length, 2);
  const upright = result.detections.find((d) => Math.abs(d.x - 300) <= 2 && Math.abs(d.y - 60) <= 2);
  const mirrored = result.detections.find((d) => Math.abs(d.x - 120) <= 2 && Math.abs(d.y - 150) <= 2);
  assert.ok(upright && !upright.flippedH && !upright.rotation, "upright copy");
  assert.ok(mirrored && mirrored.flippedH === true && !mirrored.rotation, "mirrored copy");
  assert.ok(upright.score > 0.9 && mirrored.score > 0.9);

  // The results file lives beside — never inside — annotations.json.
  const raw = await fs.readFile(path.join(dataRoot, "dies", dieId, "annotations.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), annotations);
  const files = await fs.readdir(path.join(dataRoot, "dies", dieId, "cell-detections"));
  assert.deepEqual(files, ["ct1.json"]);

  // Dismiss one, un-dismiss it, then clear.
  const dismiss = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [upright.id, "unknown-id"] });
  assert.equal(dismiss.status, 200);
  assert.deepEqual(dismiss.body.dismissed, [upright.id]);
  const undismiss = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [upright.id], dismissed: false });
  assert.deepEqual(undismiss.body.dismissed, []);
  assert.equal(
    (await request(app).post(`/api/dies/${dieId}/cell-detections/zzz/dismiss`).send({ ids: [] }))
      .status,
    404
  );

  // A rerun carries the dismissal forward by placement (ids are fresh).
  await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [mirrored.id] });
  const rerun = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1" });
  assert.equal(rerun.status, 200);
  for (let i = 0; i < 500; i++) {
    const j = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
    if (j.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const rerunResult = (await request(app).get(`/api/dies/${dieId}/cell-detections`))
    .body[0] as CellDetectionResult;
  const mirrored2 = rerunResult.detections.find((d) => d.flippedH === true)!;
  assert.ok(mirrored2 && mirrored2.id !== mirrored.id);
  assert.deepEqual(rerunResult.dismissed, [mirrored2.id]);
  await request(app)
    .post(`/api/dies/${dieId}/cell-detections/ct1/dismiss`)
    .send({ ids: [mirrored2.id], dismissed: false });

  // Rect crop endpoint serves proposal thumbnails.
  const crop = await request(app).get(`/api/dies/${dieId}/crop?x=300&y=60&w=${W}&h=${H}`);
  assert.equal(crop.status, 200);
  assert.match(crop.headers["content-type"], /image\/jpeg/);
  assert.equal((await request(app).get(`/api/dies/${dieId}/crop?x=1&y=1&w=0&h=5`)).status, 400);

  assert.equal((await request(app).delete(`/api/dies/${dieId}/cell-detections/ct1`)).status, 200);
  assert.deepEqual((await request(app).get(`/api/dies/${dieId}/cell-detections`)).body, []);
  assert.equal((await request(app).delete(`/api/dies/${dieId}/cell-detections`)).status, 200);
  // Human annotations untouched by clear.
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(dataRoot, "dies", dieId, "annotations.json"), "utf8")),
    annotations
  );
});

test("cell-detection job fails cleanly without cached vias", async () => {
  const { app, dataRoot } = await createHarness();
  const dieId = await importDie(app);
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify({
      version: 2,
      rev: 1,
      nets: [],
      grids: [],
      cellTypes: [{ id: "ct1", name: "X", cropRect: { x: 0, y: 0, width: W, height: H } }],
      cells: [{ id: "c1", cellTypeId: "ct1", x: 40, y: 40 }]
    })
  );
  const start = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1" });
  assert.equal(start.status, 200);
  let job = start.body;
  for (let i = 0; i < 300 && job.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    job = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
  }
  assert.equal(job.status, "failed");
  assert.match(job.error, /no cached via predictions/);
});

/** Fake a completed via sweep for a die (sidecar down ⇒ "nohash" cache). */
async function writeVias(
  app: import("node:http").Server,
  dataRoot: string,
  dieId: string,
  vias: { x: number; y: number; score: number }[]
) {
  const die = (await request(app).get(`/api/dies/${dieId}`)).body as {
    maxZoomLevel: number;
    tileSize: number;
    levels: { z: number; columns: number; rows: number }[];
  };
  const z = die.maxZoomLevel;
  const level = die.levels.find((l) => l.z === z)!;
  const cacheDir = path.join(dataRoot, "predictions", dieId, "nohash");
  await fs.mkdir(cacheDir, { recursive: true });
  for (let ty = 0; ty < level.rows; ty++) {
    for (let tx = 0; tx < level.columns; tx++) {
      const [x0, y0] = [tx * die.tileSize, ty * die.tileSize];
      const [x1, y1] = [x0 + die.tileSize, y0 + die.tileSize];
      const pred: MLPrediction = {
        pointVias: vias.filter((v) => v.x >= x0 && v.x < x1 && v.y >= y0 && v.y < y1),
        irregularVias: [],
        traces: [],
        bbox: [x0, y0, x1, y1],
        checkpointHash: null
      };
      await fs.writeFile(path.join(cacheDir, `${z}_${tx}_${ty}.json`), JSON.stringify(pred));
    }
  }
}

async function waitForJob(app: import("node:http").Server, dieId: string) {
  let job = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
  for (let i = 0; i < 500 && job?.status === "running"; i++) {
    await new Promise((r) => setTimeout(r, 10));
    job = (await request(app).get(`/api/dies/${dieId}/cell-detections/job`)).body;
  }
  return job;
}

test("die properties: cell library + scale via PATCH, validated and normalised", async () => {
  const { app } = await createHarness();
  const dieId = await importDie(app);
  const patch = (body: unknown) => request(app).patch(`/api/dies/${dieId}`).send(body as object);

  const set = await patch({ cellLibrary: "  roland   gate array ", cellScale: 1.25 });
  assert.equal(set.status, 200);
  assert.equal(set.body.cellLibrary, "roland gate array");
  assert.equal(set.body.cellScale, 1.25);
  const listed = (await request(app).get("/api/dies")).body.find((d: { id: string }) => d.id === dieId);
  assert.equal(listed.cellLibrary, "roland gate array");
  assert.equal(listed.cellScale, 1.25);

  // A field left out is kept; null / blank clears.
  assert.equal((await patch({ cellScale: 2 })).body.cellLibrary, "roland gate array");
  const cleared = await patch({ cellLibrary: "   ", cellScale: null });
  assert.equal(cleared.status, 200);
  assert.equal("cellLibrary" in cleared.body, false);
  assert.equal("cellScale" in cleared.body, false);

  for (const bad of [{}, { cellScale: 0 }, { cellScale: -1 }, { cellScale: "2" }, { cellLibrary: 3 }]) {
    assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await request(app).patch("/api/dies/nope").send({ cellScale: 1 })).status, 404);
});

test("a library type is detected on another die from its owner's template, scaled over", async () => {
  const { app, dataRoot } = await createHarness();
  const ownerId = await importDie(app);
  const dieId = await importDie(app);
  // The second die is photographed 1.5× larger: its pixels per library unit.
  await request(app).patch(`/api/dies/${ownerId}`).send({ cellLibrary: "lib" }).expect(200);
  await request(app).patch(`/api/dies/${dieId}`).send({ cellLibrary: "lib", cellScale: 1.5 }).expect(200);

  // Owner: the type and two members; this die: nothing placed yet.
  const owner: DieAnnotations = {
    version: 2,
    rev: 3,
    nets: [],
    grids: [],
    cellTypes: [
      { id: "ct1", name: "NAND2", matched: true, cropRect: { x: 0, y: 0, width: W, height: H } }
    ],
    cells: [
      { id: "a1", cellTypeId: "ct1", x: 40, y: 40 },
      { id: "a2", cellTypeId: "ct1", x: 300, y: 60 }
    ]
  };
  await fs.writeFile(path.join(dataRoot, "dies", ownerId, "annotations.json"), JSON.stringify(owner));
  const pattern = (x: number, y: number, k: number, score: number) =>
    PATTERN.map((p) => ({ x: x + p.x * k, y: y + p.y * k, score }));
  await writeVias(app, dataRoot, ownerId, [...pattern(40, 40, 1, 0.9), ...pattern(300, 60, 1, 0.9)]);
  await writeVias(app, dataRoot, dieId, [
    ...pattern(200, 60, 1.5, 0.85),
    { x: 30, y: 200, score: 0.6 }
  ]);

  const start = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1" });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.cellTypeName, "NAND2");
  const job = await waitForJob(app, dieId);
  assert.equal(job.status, "completed", job.error ?? "");

  const [result] = (await request(app).get(`/api/dies/${dieId}/cell-detections`))
    .body as CellDetectionResult[];
  assert.equal(result.cellTypeDieId, ownerId);
  assert.deepEqual(result.templateSource, {
    dieId: ownerId,
    dieName: "die",
    memberCount: 2,
    ratio: 1.5
  });
  assert.equal(result.templateVias, PATTERN.length);
  assert.equal(result.detections.length, 1);
  const [d] = result.detections;
  assert.ok(Math.abs(d.x - 200) <= 2 && Math.abs(d.y - 60) <= 2, JSON.stringify(d));
  assert.ok(d.score > 0.9, String(d.score));

  // Approved into this die (pointing at the owner), the cell crops at the
  // type's size here: 1.5× the owner's box.
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify({
      version: 2,
      rev: 1,
      nets: [],
      grids: [],
      cellTypes: [],
      cells: [{ id: "b1", cellTypeId: "ct1", cellTypeDieId: ownerId, x: 200, y: 60 }]
    } satisfies DieAnnotations)
  );
  const crop = await request(app).get(`/api/dies/${dieId}/cells/b1/crop?x=200&y=60`);
  assert.equal(crop.status, 200);
  const meta = await sharp(crop.body as Buffer).metadata();
  assert.deepEqual([meta.width, meta.height], [W * 1.5, H * 1.5]);

  // Out of the library, the cell still finds its type through its owner.
  await request(app).patch(`/api/dies/${dieId}`).send({ cellLibrary: null }).expect(200);
  assert.equal((await request(app).get(`/api/dies/${dieId}/cells/b1/crop?x=200&y=60`)).status, 200);
  // …and a type nobody points at isn't visible any more.
  const again = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1" });
  assert.equal(again.status, 200, "still reachable through the placed cell");
  await waitForJob(app, dieId);
});

test("pooling a type's instances from every die of the library into one template", async () => {
  const { app, dataRoot } = await createHarness();
  const ownerId = await importDie(app);
  const dieId = await importDie(app);
  await request(app).patch(`/api/dies/${ownerId}`).send({ cellLibrary: "lib" }).expect(200);
  await request(app).patch(`/api/dies/${dieId}`).send({ cellLibrary: "lib", cellScale: 1.5 }).expect(200);
  const type = { id: "ct1", name: "NAND2", matched: true, cropRect: { x: 0, y: 0, width: W, height: H } };
  await fs.writeFile(
    path.join(dataRoot, "dies", ownerId, "annotations.json"),
    JSON.stringify({ version: 2, rev: 1, nets: [], grids: [], cellTypes: [type], cells: [{ id: "a1", cellTypeId: "ct1", x: 40, y: 40 }] })
  );
  // One placed here (so without pooling it'd be a 1-member template) and an
  // unlabelled copy to find.
  await fs.writeFile(
    path.join(dataRoot, "dies", dieId, "annotations.json"),
    JSON.stringify({
      version: 2, rev: 1, nets: [], grids: [], cellTypes: [],
      cells: [{ id: "b1", cellTypeId: "ct1", cellTypeDieId: ownerId, x: 200, y: 60 }]
    })
  );
  const pattern = (x: number, y: number, k: number) => PATTERN.map((p) => ({ x: x + p.x * k, y: y + p.y * k, score: 0.9 }));
  await writeVias(app, dataRoot, ownerId, pattern(40, 40, 1));
  await writeVias(app, dataRoot, dieId, [...pattern(200, 60, 1.5), ...pattern(330, 100, 1.5)]);

  const start = await request(app)
    .post(`/api/dies/${dieId}/cell-detections/job/start`)
    .send({ cellTypeId: "ct1", allDies: true });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const job = await waitForJob(app, dieId);
  assert.equal(job.status, "completed", job.error ?? "");
  const [result] = (await request(app).get(`/api/dies/${dieId}/cell-detections`)).body as CellDetectionResult[];
  assert.deepEqual(
    result.pooledFrom?.map((s) => [s.dieId, s.memberCount, s.ratio]),
    [[dieId, 1, 1], [ownerId, 1, 1.5]]
  );
  assert.equal(result.templateSource, undefined);
  assert.equal(result.options?.allDies, true);
  assert.equal(result.templateVias, PATTERN.length, "both dies' instances agree on every via");
  // (Weak partial matches of this sparse synthetic pattern may come along;
  // the confidence threshold hides those.)
  const strong = result.detections.filter((d) => d.score >= 0.9);
  assert.equal(strong.length, 1, JSON.stringify(result.detections));
  const [d] = strong;
  assert.ok(Math.abs(d.x - 330) <= 2 && Math.abs(d.y - 100) <= 2, JSON.stringify(d));
});
