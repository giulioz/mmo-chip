import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { buildLevels, importDieShot } from "./importer.js";

test("builds a complete zoom pyramid", () => {
  const levels = buildLevels(4096, 2048, 512, 3);
  assert.deepEqual(levels, [
    { z: 0, width: 512, height: 256, columns: 1, rows: 1, scale: 8 },
    { z: 1, width: 1024, height: 512, columns: 2, rows: 1, scale: 4 },
    { z: 2, width: 2048, height: 1024, columns: 4, rows: 2, scale: 2 },
    { z: 3, width: 4096, height: 2048, columns: 8, rows: 4, scale: 1 }
  ]);
});

test("prebuilt tiles match the lazy tile grid", async () => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chiptool-import-"));
  try {
    const filePath = path.join(dataRoot, "odd.jpg");
    await sharp({ create: { width: 1501, height: 1099, channels: 3, background: "#808080" } }).jpeg().toFile(filePath);
    const record = await importDieShot({
      dataRoot,
      filePath,
      originalFilename: "odd.jpg",
      mimeType: "image/jpeg",
      tileSize: 256,
      limitInputPixels: false,
      tileConcurrency: 1,
      tiledOriginal: true,
      prebuildTiles: true
    });

    assert.equal(path.extname(record.originalPath), ".tif");
    for (const level of record.levels) {
      const dir = path.join(dataRoot, "dies", record.id, "tiles", String(level.z));
      assert.equal((await fs.readdir(dir)).length, level.columns * level.rows);
      const edge = await sharp(path.join(dir, `${level.columns - 1}_${level.rows - 1}.jpg`)).metadata();
      assert.equal(edge.width, level.width - (level.columns - 1) * record.tileSize);
      assert.equal(edge.height, level.height - (level.rows - 1) * record.tileSize);
    }
    assert.deepEqual(
      (await fs.readdir(path.join(dataRoot, "dies", record.id))).sort(),
      ["metadata.json", "original", "tiles"]
    );
  } finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
  }
});
