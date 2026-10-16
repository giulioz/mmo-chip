import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import sharp from "sharp";
import request from "./testRequest.test.js";
import { createApp } from "./app.js";
import { ensureDataStore } from "./store.js";

const tempRoots: string[] = [];
const tempServers: Array<import("node:http").Server> = [];

afterEach(async () => {
  await Promise.all(
    tempServers.map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        })
    )
  );
  tempServers.length = 0;
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots.length = 0;
});

test("imports an image and exposes list/detail/tile endpoints", async () => {
  const { app, dataRoot } = await createHarness();

  const imageBuffer = await sharp({
    create: {
      width: 512,
      height: 256,
      channels: 3,
      background: { r: 200, g: 120, b: 80 }
    }
  })
    .png()
    .toBuffer();

  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", imageBuffer, {
      filename: "test-die.png",
      contentType: "image/png"
    });
  assert.equal(importResponse.status, 202);
  assert.equal(importResponse.body.originalFilename, "test-die.png");

  const completedJob = await waitForCompletedJob(app, importResponse.body.id);
  assert.equal(completedJob.status, "completed");
  assert.ok(completedJob.dieId);

  const listResponse = await request(app).get("/api/dies");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 1);

  const detailResponse = await request(app).get(`/api/dies/${completedJob.dieId}`);
  assert.equal(detailResponse.status, 200);
  assert.ok(detailResponse.body.levels.length > 0);
  assert.equal(detailResponse.body.tileFormat, "jpg");
  const tileResponse = await request(app).get(
    `/api/dies/${completedJob.dieId}/tiles/${detailResponse.body.maxZoomLevel}/0/0`
  );
  assert.equal(tileResponse.status, 200);
  assert.match(tileResponse.headers["content-type"] ?? "", /image\/jpeg/);
  const lazyTilePath = path.join(
    dataRoot,
    "dies",
    completedJob.dieId,
    "tiles",
    String(detailResponse.body.maxZoomLevel),
    "0_0.jpg"
  );
  await fs.access(lazyTilePath);
});

test("rejects unsupported file types", async () => {
  const { app } = await createHarness();

  const response = await request(app)
    .post("/api/dies/import")
    .attach("file", Buffer.from("hello"), {
      filename: "notes.txt",
      contentType: "text/plain"
    });
  assert.equal(response.status, 202);
  const failedJob = await waitForCompletedJob(app, response.body.id);
  assert.equal(failedJob.status, "failed");
  assert.match(failedJob.error, /PNG and JPEG/);
});

test("deletes a die and its stored data", async () => {
  const { app, dataRoot } = await createHarness();

  const imageBuffer = await sharp({
    create: {
      width: 256,
      height: 256,
      channels: 3,
      background: { r: 40, g: 80, b: 160 }
    }
  })
    .png()
    .toBuffer();

  const importResponse = await request(app)
    .post("/api/dies/import")
    .attach("file", imageBuffer, {
      filename: "delete-me.png",
      contentType: "image/png"
    });
  assert.equal(importResponse.status, 202);

  const completedJob = await waitForCompletedJob(app, importResponse.body.id);
  assert.equal(completedJob.status, "completed");
  assert.ok(completedJob.dieId);

  const tileResponse = await request(app).get(`/api/dies/${completedJob.dieId}/tiles/0/0/0`);
  assert.equal(tileResponse.status, 200);

  const dieDir = path.join(dataRoot, "dies", completedJob.dieId);
  await fs.access(dieDir);

  const deleteResponse = await request(app).delete(`/api/dies/${completedJob.dieId}`);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(deleteResponse.body, { ok: true });

  const listResponse = await request(app).get("/api/dies");
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.body.length, 0);

  const detailResponse = await request(app).get(`/api/dies/${completedJob.dieId}`);
  assert.equal(detailResponse.status, 404);

  await assert.rejects(fs.access(dieDir));
});

async function createHarness() {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-test-"));
  tempRoots.push(dataRoot);
  await ensureDataStore(dataRoot);
  const server = createServer(
    createApp({
      dataRoot,
      tileSize: 128,
      limitInputPixels: false,
      tileConcurrency: 2
    })
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  tempServers.push(server);
  return { app: server, dataRoot };
}

async function waitForCompletedJob(
  app: import("node:http").Server,
  jobId: string
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await request(app).get(`/api/import-jobs/${jobId}`);
    if (response.body.status === "completed" || response.body.status === "failed") {
      return response.body;
    }

    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for import job ${jobId}`);
}
