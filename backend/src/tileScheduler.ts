import { dataPath, HttpError, safeId } from "./security.js";
import { promises as fs } from "node:fs";
import { ensureTileForRecord } from "./dieImport/importer.js";
import type { DieRecord } from "./types.js";

// When false, the pyramid is never preemptively built — tiles are generated
// only when a browser actually requests them via the API.
const BACKGROUND_TILE_GENERATION_ENABLED = false;

type TilePriority = "high" | "low";

interface TileTask {
  key: string;
  record: DieRecord;
  z: number;
  x: number;
  y: number;
  priority: TilePriority;
  started: boolean;
  requesterCount: number;
  promise: Promise<string>;
  resolve: (tilePath: string) => void;
  reject: (error: unknown) => void;
  completion: Promise<void>;
}

interface DieProgressState {
  totalTiles: number;
  completedTiles: number;
  lastLoggedStep: number;
  backgroundQueued: boolean;
}

export function createTileScheduler(config: {
  dataRoot: string;
  concurrency: number;
}) {
  const activeTasks = new Map<string, TileTask>();
  const highPriorityQueue: string[] = [];
  const lowPriorityQueue: string[] = [];
  const progressByDie = new Map<string, DieProgressState>();
  const deletedDies = new Set<string>();
  let activeWorkers = 0;

  function ensureProgressState(record: DieRecord) {
    let progress = progressByDie.get(record.id);
    if (!progress) {
      progress = {
        totalTiles: record.levels.reduce((sum, level) => sum + level.columns * level.rows, 0),
        completedTiles: 0,
        lastLoggedStep: -1,
        backgroundQueued: false
      };
      progressByDie.set(record.id, progress);
    }
    return progress;
  }

  async function requestTile(record: DieRecord, z: number, x: number, y: number) {
    safeId(record.id);
    const level = record.levels[z];
    if (![z, x, y].every(n => Number.isSafeInteger(n) && n >= 0) || !level || x >= level.columns || y >= level.rows) throw new Error("Tile coordinates out of range");
    if (deletedDies.has(record.id)) {
      throw new Error("Die has been deleted.");
    }

    const tilePath = buildTilePath(config.dataRoot, record.id, z, x, y);
    try {
      await fs.access(tilePath);
      return tilePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }

    const task = getOrCreateTask(record, z, x, y, "high");
    task.requesterCount += 1;
    if (!task.started && task.priority !== "high") {
      task.priority = "high";
      highPriorityQueue.push(task.key);
    }
    pumpQueue();
    return task.promise;
  }

  function enqueueBackground(record: DieRecord) {
    if (!BACKGROUND_TILE_GENERATION_ENABLED) {
      return;
    }
    if (deletedDies.has(record.id)) {
      return;
    }

    const progress = ensureProgressState(record);
    if (progress.backgroundQueued) {
      return;
    }

    progress.backgroundQueued = true;
    console.log(`[tiles:${record.id}] queued background generation for ${progress.totalTiles} tiles`);

    for (const level of record.levels) {
      for (let y = 0; y < level.rows; y += 1) {
        for (let x = 0; x < level.columns; x += 1) {
          getOrCreateTask(record, level.z, x, y, "low");
        }
      }
    }

    pumpQueue();
  }

  function getOrCreateTask(
    record: DieRecord,
    z: number,
    x: number,
    y: number,
    priority: TilePriority
  ) {
    const key = `${record.id}/${z}/${x}/${y}`;
    const existing = activeTasks.get(key);
    if (existing) {
      if (!existing.started && priority === "high" && existing.priority !== "high") {
        existing.priority = "high";
        highPriorityQueue.push(existing.key);
      }
      return existing;
    }

    if (activeTasks.size >= 256) throw new HttpError(429, "Tile queue is full; retry later");
    let resolve!: (tilePath: string) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<string>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const completion = promise.then(
      () => undefined,
      () => undefined
    );

    const task: TileTask = {
      key,
      record,
      z,
      x,
      y,
      priority,
      started: false,
      requesterCount: 0,
      promise,
      resolve,
      reject,
      completion
    };

    activeTasks.set(key, task);
    if (priority === "high") {
      highPriorityQueue.push(key);
    } else {
      lowPriorityQueue.push(key);
    }

    return task;
  }

  function pumpQueue() {
    while (activeWorkers < Math.max(1, config.concurrency)) {
      const task = takeNextTask();
      if (!task) {
        return;
      }

      task.started = true;
      activeWorkers += 1;

      void runTask(task).finally(() => {
        activeWorkers -= 1;
        pumpQueue();
      });
    }
  }

  function takeNextTask() {
    while (highPriorityQueue.length > 0) {
      const key = highPriorityQueue.shift()!;
      const task = activeTasks.get(key);
      if (!task || task.started || task.priority !== "high") {
        continue;
      }
      return task;
    }

    while (lowPriorityQueue.length > 0) {
      const key = lowPriorityQueue.shift()!;
      const task = activeTasks.get(key);
      if (!task || task.started || task.priority !== "low") {
        continue;
      }
      return task;
    }

    return null;
  }

  async function runTask(task: TileTask) {
    try {
      const tilePath = await ensureTileForRecord({
        dataRoot: config.dataRoot,
        record: task.record,
        z: task.z,
        x: task.x,
        y: task.y
      });

      if (deletedDies.has(task.record.id)) {
        activeTasks.delete(task.key);
        task.reject(new Error("Die has been deleted."));
        return;
      }

      const progress = ensureProgressState(task.record);
      progress.completedTiles += 1;
      logLazyCompletion(task, progress);
      logBackgroundProgress(task.record.id, progress);

      activeTasks.delete(task.key);
      task.resolve(tilePath);
    } catch (error) {
      activeTasks.delete(task.key);
      task.reject(error);
    }
  }

  function logLazyCompletion(task: TileTask, progress: DieProgressState) {
    if (task.requesterCount === 0) {
      return;
    }

    console.log(
      `[tiles:${task.record.id}] lazy tile ${task.z}/${task.x}/${task.y} ready (${progress.completedTiles}/${progress.totalTiles})`
    );
  }

  function logBackgroundProgress(dieId: string, progress: DieProgressState) {
    const nextStep =
      progress.totalTiles === 0
        ? 10
        : Math.floor((progress.completedTiles / progress.totalTiles) * 10);
    if (
      nextStep <= progress.lastLoggedStep &&
      progress.completedTiles !== progress.totalTiles
    ) {
      return;
    }

    progress.lastLoggedStep = nextStep;
    const percentage =
      progress.totalTiles === 0
        ? 100
        : (progress.completedTiles / progress.totalTiles) * 100;
    console.log(
      `[tiles:${dieId}] background ${percentage.toFixed(1)}% (${progress.completedTiles}/${progress.totalTiles})`
    );
  }

  async function removeDie(dieId: string) {
    deletedDies.add(dieId);
    progressByDie.delete(dieId);

    const pendingCompletions: Promise<void>[] = [];
    for (const task of activeTasks.values()) {
      if (task.record.id !== dieId) {
        continue;
      }

      if (task.started) {
        pendingCompletions.push(task.completion);
        continue;
      }

      activeTasks.delete(task.key);
      task.reject(new Error("Die has been deleted."));
    }

    await Promise.allSettled(pendingCompletions);
  }

  function getProgress(dieId: string) {
    const state = progressByDie.get(dieId);
    if (!state) return null;
    const percentage =
      state.totalTiles === 0 ? 100 : (state.completedTiles / state.totalTiles) * 100;
    return {
      totalTiles: state.totalTiles,
      completedTiles: state.completedTiles,
      percentage
    };
  }

  return {
    enqueueBackground,
    requestTile,
    removeDie,
    getProgress
  };
}

function buildTilePath(dataRoot: string, dieId: string, z: number, x: number, y: number) {
  return dataPath(dataRoot, "dies", safeId(dieId), "tiles", String(z), `${x}_${y}.jpg`);
}
