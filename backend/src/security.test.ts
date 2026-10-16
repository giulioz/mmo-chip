import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import express from "express";
import rawRequest from "supertest";
import sharp from "sharp";
import WebSocket from "ws";
import request from "./testRequest.test.js";
import { createApp } from "./app.js";
import { DEV_TOKEN, checkRegion, dataPath, HttpError, limits, trustedBrowserRequest, trustedProxyRequest } from "./security.js";
import { ensureDataStore, readDieRecord, readImportJob, writeAnnotations } from "./store.js";
import { attachWebSocketBroadcaster } from "./ws.js";
import { createMLRouter } from "./api/ml.js";
import { createMLPredictor } from "./ml/predict.js";
import { createWorkQueue } from "./workQueue.js";

const roots: string[] = [], servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-security-")); roots.push(root);
  const dataRoot = path.join(root, "data"); await ensureDataStore(dataRoot);
  const app = createApp({ dataRoot, tileSize: 512, limitInputPixels: 100, tileConcurrency: 1, mlSidecarUrl: "http://127.0.0.1:1", mlPredictPad: 0 });
  return { root, dataRoot, app };
}
const annotations = { version: 2 as const, rev: 0, nets: [], cellTypes: [], cells: [], grids: [] };
function record(dataRoot: string, id = "die1") {
  return { id, name: "test", originalFilename: "poc.png", originalPath: path.join(dataRoot, "dies", id, "original", "poc.png"),
    width: 1, height: 1, tileSize: 512, tileFormat: "jpg", maxZoomLevel: 0,
    levels: [{ z: 0, width: 1, height: 1, columns: 1, rows: 1, scale: 1 }],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}
async function putRecord(dataRoot: string, value: ReturnType<typeof record>, key = value.id) {
  const directory = path.join(dataRoot, "dies", key); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "metadata.json"), JSON.stringify(value));
}

test("all API work requires the dev token, including cache-generating GETs", async () => {
  const { app, dataRoot } = await harness();
  for (const url of ["/api/health", "/api/dies", "/api/dies/die1/tiles/0/0/0", "/api/dies/die1/vias?bbox=0,0,1,1", "/api/ml/status"]) {
    assert.equal((await rawRequest(app).get(url)).status, 401);
  }
  assert.equal((await rawRequest(app).post("/api/ml/train").send({ dataDir: "/tmp" })).status, 401);
  assert.equal((await request(app).get("/api/dies")).status, 200);
  assert.deepEqual(await fs.readdir(path.join(dataRoot, "dies")), []);
});

test("browser access rejects hostile origins, null origins, DNS rebinding and cross-site embeds", async () => {
  const { app } = await harness();
  for (const origin of ["http://attacker.example", "null", "http://localhost:8899"]) {
    assert.equal((await request(app).get("/api/dies").set("Origin", origin).set("Host", "127.0.0.1:3001")).status, 403);
  }
  assert.equal((await request(app).get("/api/dies").set("Origin", "http://localhost:5173").set("Host", "attacker.example:3001")).status, 403);
  assert.equal((await request(app).get("/api/dies").set("Sec-Fetch-Site", "cross-site").set("Host", "127.0.0.1:3001")).status, 403);
  const allowed = await request(app).get("/api/dies").set("Origin", "http://localhost:5173").set("Host", "127.0.0.1:3001");
  assert.equal(allowed.status, 200); assert.equal(allowed.headers["access-control-allow-origin"], undefined);
  const req = (headers: Record<string, string>) => ({ headers } as import("node:http").IncomingMessage);
  assert.equal(trustedBrowserRequest(req({ host: "localhost:5173", "sec-fetch-site": "same-site" }), ["localhost:5173"]), false);
  assert.equal(trustedBrowserRequest(req({ host: "localhost:5173", referer: "http://attacker.example/" }), ["localhost:5173"]), false);
  assert.equal(trustedProxyRequest(req({ host: "localhost:5173" }), ["localhost:5173"]), false);
  assert.equal(trustedProxyRequest(req({ host: "localhost:5173", "sec-fetch-site": "same-origin" }), ["localhost:5173"]), true);
});

test("WebSockets require token and trusted browser origin; allowed clients still receive pong", async () => {
  const server = createServer(); servers.push(server);
  const broadcaster = attachWebSocketBroadcaster(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/api/ws`;
  async function denied(headers: Record<string, string>) {
    const socket = new WebSocket(url, { headers });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => { socket.terminate(); reject(new Error("Unexpected upgrade")); });
      socket.once("error", () => resolve());
    });
  }
  try {
    await denied({});
    await denied({ "x-chiptool-token": DEV_TOKEN, Origin: "http://attacker.example", Host: "127.0.0.1:3001" });
    const socket = new WebSocket(url, { headers: { "x-chiptool-token": DEV_TOKEN, Origin: "http://localhost:5173", Host: "127.0.0.1:3001" } });
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    const response = new Promise<unknown>(resolve => socket.once("message", data => resolve(JSON.parse(String(data)))));
    socket.send("null"); socket.send("[]");
    socket.send(JSON.stringify({ type: "ping" })); assert.deepEqual(await response, { type: "pong" });
    await new Promise<void>(resolve => { socket.once("close", () => resolve()); socket.close(); });
  } finally { await broadcaster.close(); }
});

test("die/job traversal is rejected before outside reads, writes or deletes", async () => {
  const { app, root, dataRoot } = await harness();
  const outside = path.join(root, "outside"); await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "metadata.json"), JSON.stringify(record(dataRoot)));
  await fs.writeFile(path.join(root, "secret.json"), '{"secret":"keep"}');
  const id = "..%2F..%2Foutside";
  assert.equal((await request(app).get(`/api/dies/${id}`)).status, 400);
  assert.equal((await request(app).put(`/api/dies/${id}/annotations`).send(annotations)).status, 400);
  assert.equal((await request(app).delete(`/api/dies/${id}/cell-specimens`)).status, 400);
  assert.equal((await request(app).get("/api/import-jobs/..%2F..%2Fsecret")).status, 400);
  await assert.rejects(fs.access(path.join(outside, "annotations.json")));
  await assert.rejects(readDieRecord(dataRoot, "../../outside"), HttpError);
  await assert.rejects(readImportJob(dataRoot, "../../secret"), HttpError);
  await assert.rejects(writeAnnotations(dataRoot, "../escape", annotations), HttpError);
});

test("metadata cannot substitute a destructive ID or an external original image", async () => {
  const { app, root, dataRoot } = await harness();
  const victim = path.join(root, "victim"); await fs.mkdir(victim); await fs.writeFile(path.join(victim, "marker"), "keep");
  await putRecord(dataRoot, { ...record(dataRoot), id: "../../victim" }, "die1");
  assert.equal((await request(app).delete("/api/dies/die1")).status, 400);
  await fs.access(path.join(victim, "marker"));
  await putRecord(dataRoot, record(dataRoot, "valid"));
  await fs.writeFile(path.join(dataRoot, "index.json"), JSON.stringify({ dies: ["die1", "valid"] }));
  const list = await request(app).get("/api/dies");
  assert.equal(list.status, 200); assert.deepEqual(list.body.map((item: { id: string }) => item.id), ["valid"]);
  await putRecord(dataRoot, { ...record(dataRoot), originalPath: path.join(root, "secret.png") });
  assert.equal((await request(app).get("/api/dies/die1")).status, 400);
  await putRecord(dataRoot, { ...record(dataRoot), levels: [{ z: 0, width: 1, height: 1, columns: 1, rows: 1, scale: 99999 }] });
  assert.equal((await request(app).get("/api/dies/die1")).status, 400);
});

test("symlinked metadata, originals, annotation files and derived paths fail closed", async () => {
  const { app, root, dataRoot } = await harness();
  const outside = path.join(root, "outside.json"); await fs.writeFile(outside, JSON.stringify(annotations));
  await putRecord(dataRoot, record(dataRoot));
  await fs.symlink(outside, path.join(dataRoot, "dies", "die1", "annotations.json"));
  assert.equal((await request(app).put("/api/dies/die1/annotations").send(annotations)).status, 400);
  assert.deepEqual(JSON.parse(await fs.readFile(outside, "utf8")), annotations);
  await fs.mkdir(path.join(dataRoot, "dies", "die1", "original"));
  await fs.symlink(outside, record(dataRoot).originalPath);
  assert.equal((await request(app).get("/api/dies/die1")).status, 400);
  await fs.symlink(root, path.join(dataRoot, "dies", "linked"));
  assert.throws(() => dataPath(dataRoot, "dies", "linked", "any"), HttpError);
  const predictor = createMLPredictor({ dataRoot, mlSidecarUrl: "http://127.0.0.1:1", mlPredictPad: 0 });
  const predictionDir = predictor.cacheDirFor("die1", "abc"); await fs.mkdir(predictionDir, { recursive: true });
  await fs.symlink(outside, path.join(predictionDir, "0_0_0.json"));
  assert.throws(() => predictor.tileCachePath("die1", "abc", 0, 0, 0), HttpError);
});

test("model selection rejects traversal and failed reloads do not invalidate cache", async () => {
  const { dataRoot } = await harness(); let calls = 0, clears = 0, loaded = false;
  const sidecar = createServer(async (req, res) => {
    calls++; const chunks = []; for await (const c of req) chunks.push(c);
    assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString()), { checkpoint_path: "model.pt" });
    assert.equal(req.headers["x-chiptool-token"], DEV_TOKEN);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model_loaded: loaded, checkpoint: "model.pt", checkpoint_hash: "abc" }));
  }); servers.push(sidecar); await new Promise<void>(resolve => sidecar.listen(0, "127.0.0.1", resolve));
  const config = { dataRoot, mlSidecarUrl: `http://127.0.0.1:${(sidecar.address() as import("node:net").AddressInfo).port}`, mlPredictPad: 0 };
  const predictor = createMLPredictor(config); predictor.clearMemCache = () => { clears++; };
  const app = express(); app.use(express.json()); app.use(createMLRouter({ ...config, predictor }));
  app.use((err: HttpError, _req: unknown, res: express.Response, _next: unknown) => res.status(err.status ?? 500).json({ error: err.message }));
  for (const name of ["../../package.json", "../model.pt", "/tmp/model.pt", "model.txt"]) assert.equal((await request(app).post("/api/ml/model").send({ name })).status, 400);
  assert.equal(calls, 0);
  assert.equal((await request(app).post("/api/ml/model").send({ name: "model.pt" })).status, 502); assert.equal(clears, 0);
  loaded = true;
  assert.equal((await request(app).post("/api/ml/model").send({ name: "model.pt" })).status, 200); assert.equal(clears, 1);
});

test("training is disabled by default and enabled requests cannot escape exports or select output paths", async () => {
  const { app, dataRoot } = await harness();
  const previous = process.env.CHIPTOOL_ENABLE_TRAINING; delete process.env.CHIPTOOL_ENABLE_TRAINING;
  try {
    assert.equal((await request(app).post("/api/ml/train").send({ dataDir: "/tmp" })).status, 403);
    process.env.CHIPTOOL_ENABLE_TRAINING = "1";
    await fs.mkdir(path.join(dataRoot, "ml_exports", "export1"), { recursive: true });
    for (const body of [{ dataDir: "/tmp" }, { dataDir: "ml_exports/export1", output: "/tmp/overwrite.pt" },
      { dataDir: "ml_exports/export1", epochs: 999999 }, { dataDir: "ml_exports/export1", batchSize: 100 },
      { dataDir: "ml_exports/export1", cropSize: 33 }, { dataDir: "ml_exports/export1", epochs: 200, stepsPerEpoch: 1000, batchSize: 16 }]) {
      assert.equal((await request(app).post("/api/ml/train").send(body)).status, 400);
    }
  } finally { if (previous === undefined) delete process.env.CHIPTOOL_ENABLE_TRAINING; else process.env.CHIPTOOL_ENABLE_TRAINING = previous; }
});

test("image and ML regions are bounded before decoding or contacting the sidecar", async () => {
  const { dataRoot } = await harness();
  assert.throws(() => checkRegion(4096, 4096), HttpError);
  assert.throws(() => checkRegion(Infinity, 1), HttpError);
  const predictor = createMLPredictor({ dataRoot, mlSidecarUrl: "http://127.0.0.1:1", mlPredictPad: 0 });
  await assert.rejects(predictor.runPrediction({ originalPath: "unused", dieWidth: 100000, dieHeight: 100000,
    keep: [0, 0, 9000, 9000], threshold: 0.3, minDistance: 4, wantHeatmap: false }), (err: HttpError) => err.status === 413);
});

test("upload limits reject oversized files and configured pixel ceilings reject imports", async () => {
  const { app } = await harness();
  // Temporarily lower the upload cap for a new app; no large allocation needed.
  const saved = limits.uploadBytes; limits.uploadBytes = 32;
  try {
    const { app: bounded } = await harness();
    assert.equal((await request(bounded).post("/api/dies/import").attach("file", Buffer.alloc(64), { filename: "poc.png", contentType: "image/png" })).status, 413);
  } finally { limits.uploadBytes = saved; }
  const image = await sharp({ create: { width: 11, height: 10, channels: 3, background: "white" } }).png().toBuffer();
  const imported = await request(app).post("/api/dies/import").attach("file", image, { filename: "poc.png", contentType: "image/png" });
  assert.equal(imported.status, 202);
  let job;
  for (let i = 0; i < 100; i++) {
    job = (await request(app).get(`/api/import-jobs/${imported.body.id}`)).body;
    if (["failed", "completed"].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(job.status, "failed");
});

test("work queues bound pending jobs and recover capacity after errors", async () => {
  const run = createWorkQueue(1, 1); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = run(async () => { await gate; throw new Error("work failed"); });
  const second = run(async () => "second");
  await assert.rejects(run(async () => "overflow"), (err: HttpError) => err.status === 429);
  release(); await assert.rejects(first, /work failed/); assert.equal(await second, "second");
  assert.equal(await run(async () => "recovered"), "recovered");
});
