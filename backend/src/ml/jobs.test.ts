import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import express from "express";
import request from "supertest";
import type { MLInferenceJob } from "shared";
import { createMLRouter } from "../api/ml.js";
import { ensureDataStore, writeDieRecord } from "../store.js";
import type { DieRecord } from "../types.js";
import { createMLJobManager } from "./jobs.js";
import { createMLPredictor, type MLPredictor } from "./predict.js";

const tempRoots: string[] = [];
afterEach(async () => {
  await Promise.all(tempRoots.map((r) => fs.rm(r, { recursive: true, force: true })));
  tempRoots.length = 0;
});

async function tempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-jobs-"));
  tempRoots.push(root);
  await ensureDataStore(root);
  return root;
}

/** A 2×2 native-tile die record (no image needed — the predictor is faked). */
async function writeDie(root: string): Promise<DieRecord> {
  const now = new Date().toISOString();
  const record: DieRecord = {
    id: "die1",
    name: "die1",
    originalFilename: "die1.png",
    originalPath: path.join(root, "nope.png"),
    width: 256,
    height: 256,
    tileSize: 128,
    tileFormat: "jpg",
    maxZoomLevel: 1,
    levels: [
      { z: 0, width: 128, height: 128, columns: 1, rows: 1, scale: 2 },
      { z: 1, width: 256, height: 256, columns: 2, rows: 2, scale: 1 }
    ],
    createdAt: now,
    updatedAt: now
  };
  await writeDieRecord(root, record);
  return record;
}

/**
 * Fake predictor: real cache/paths (reuses the production implementation for
 * those), but `getCheckpointHash` is scripted and `runPrediction` blocks on a
 * gate so a test can hold a sweep open.
 */
function fakePredictor(root: string, hashes: () => string) {
  const real = createMLPredictor({ mlSidecarUrl: "http://127.0.0.1:1", dataRoot: root, mlPredictPad: 0 });
  let release: (() => void) | null = null;
  const gate = new Promise<void>((r) => (release = r));
  let calls = 0;
  const predictor: MLPredictor = {
    ...real,
    getCheckpointHash: async () => hashes(),
    runPrediction: async () => {
      calls += 1;
      await gate;
      return { pointVias: [{ x: 1, y: 1, score: 0.9 }], irregularVias: [], traces: [] };
    }
  };
  return { predictor, release: () => release?.(), calls: () => calls };
}

async function waitFor(
  get: () => Promise<MLInferenceJob>,
  done: (j: MLInferenceJob) => boolean
): Promise<MLInferenceJob> {
  for (let i = 0; i < 200; i++) {
    const j = await get();
    if (done(j)) return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timed out");
}

test("a sweep fails loudly when the sidecar's checkpoint changes mid-run", async () => {
  const root = await tempRoot();
  await writeDie(root);
  let hash = "aaaa";
  const fake = fakePredictor(root, () => hash);
  const jobs = createMLJobManager({ dataRoot: root, predictor: fake.predictor });

  const started = await jobs.startJob("die1");
  assert.equal(started.status, "running");
  assert.equal(started.checkpointHash, "aaaa");
  assert.ok(jobs.hasActiveJobs());

  // Swap the model underneath the sweep, then let the in-flight tiles finish.
  hash = "bbbb";
  fake.release();
  const final = await waitFor(
    () => jobs.getJob("die1"),
    (j) => j.status !== "running"
  );
  assert.equal(final.status, "failed");
  assert.match(final.error ?? "", /model changed during sweep/);
  assert.ok(!jobs.hasActiveJobs());
  // Nothing was filed under the new hash, and the old dir holds at most the
  // tiles that were already in flight when the model changed.
  const newDir = fake.predictor.cacheDirFor("die1", "bbbb");
  await assert.rejects(fs.readdir(newDir));
});

test("a sweep completes when the checkpoint stays put", async () => {
  const root = await tempRoot();
  await writeDie(root);
  const fake = fakePredictor(root, () => "aaaa");
  const jobs = createMLJobManager({ dataRoot: root, predictor: fake.predictor });
  await jobs.startJob("die1");
  fake.release();
  const final = await waitFor(() => jobs.getJob("die1"), (j) => j.status !== "running");
  assert.equal(final.status, "completed", final.error ?? "");
  assert.equal(final.completedTiles, 4);
});

test("POST /api/ml/model is refused while a sweep is running", async () => {
  const root = await tempRoot();
  await writeDie(root);
  const fake = fakePredictor(root, () => "aaaa");
  const app = express();
  app.use(express.json());
  app.use(
    createMLRouter({
      mlSidecarUrl: "http://127.0.0.1:1",
      dataRoot: root,
      mlPredictPad: 0,
      predictor: fake.predictor
    })
  );

  const start = await request(app).post("/api/dies/die1/ml/job/start");
  assert.equal(start.status, 200);
  assert.equal(start.body.status, "running");

  const sw = await request(app).post("/api/ml/model").send({ name: "other.pt" });
  assert.equal(sw.status, 409);
  assert.match(sw.body.error, /inference sweep is running/);

  // Stop it, let it drain; the switch then gets past the guard (and fails
  // only because there's no sidecar at that URL).
  await request(app).post("/api/dies/die1/ml/job/stop");
  fake.release();
  for (let i = 0; i < 200; i++) {
    const j = await request(app).get("/api/dies/die1/ml/job");
    if (j.body.status !== "running") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  const sw2 = await request(app).post("/api/ml/model").send({ name: "other.pt" });
  assert.equal(sw2.status, 503);
});
