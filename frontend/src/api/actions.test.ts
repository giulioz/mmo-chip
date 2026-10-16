import assert from "node:assert/strict";
import test from "node:test";
import type { Cell, CellType, Guide, IOPin } from "shared";
import { batchOps, type AnnotationAction } from "./actions";

const cell = (id: string): Cell => ({ id, cellTypeId: "t", x: 0, y: 0 });
const type: CellType = { id: "t", name: "T", cropRect: { x: 0, y: 0, width: 4, height: 2 } };
const pin: IOPin = { id: "p", x: 1, y: 2, pin: 1, name: "A" };
const guide: Guide = { id: "g", kind: "line", axis: "x", pos: 3 };

test("batchOps flattens nested batches into whole-entity writes, in order", () => {
  const action: AnnotationAction = {
    kind: "batch",
    actions: [
      { kind: "upsertCellType", cellType: type, prevCellType: null },
      {
        kind: "batch",
        actions: [
          { kind: "upsertCell", cell: cell("a"), prevCell: null },
          { kind: "removeCell", cell: cell("b") }
        ]
      },
      { kind: "addPin", pin },
      { kind: "upsertPin", pin, prevPin: pin },
      { kind: "removeGuide", guide },
      { kind: "removeCellType", cellType: type }
    ]
  };
  assert.deepEqual(batchOps(action), [
    { op: "upsert", collection: "cellTypes", item: type },
    { op: "upsert", collection: "cells", item: cell("a") },
    { op: "remove", collection: "cells", id: "b" },
    { op: "upsert", collection: "pins", item: pin },
    { op: "upsert", collection: "pins", item: pin },
    { op: "remove", collection: "guides", id: "g" },
    { op: "remove", collection: "cellTypes", id: "t" }
  ]);
  assert.deepEqual(batchOps({ kind: "batch", actions: [] }), []);
});

test("splitByDie sends each die its share of a gesture, in order; onDie undoes on its die", async () => {
  const { inverseOf, splitByDie, applyAction } = await import("./actions");
  const remoteType: CellType = { ...type, id: "rt", name: "remote" };
  const action: AnnotationAction = {
    kind: "batch",
    actions: [
      { kind: "onDie", dieId: "A", action: { kind: "upsertCellType", cellType: remoteType, prevCellType: null } },
      { kind: "upsertCell", cell: cell("a"), prevCell: null },
      {
        kind: "onDie",
        dieId: "B",
        action: {
          kind: "batch",
          actions: [
            { kind: "upsertCell", cell: cell("b1"), prevCell: null },
            { kind: "upsertCell", cell: cell("b2"), prevCell: null }
          ]
        }
      },
      { kind: "removeCell", cell: cell("c") }
    ]
  };
  const parts = splitByDie("home", action);
  assert.deepEqual([...parts.keys()], ["A", "home", "B"]);
  assert.deepEqual(parts.get("A"), { kind: "upsertCellType", cellType: remoteType, prevCellType: null });
  assert.deepEqual(parts.get("home"), {
    kind: "batch",
    actions: [
      { kind: "upsertCell", cell: cell("a"), prevCell: null },
      { kind: "removeCell", cell: cell("c") }
    ]
  });
  // The home die's request carries only its own writes.
  assert.deepEqual(batchOps(action), [
    { op: "upsert", collection: "cells", item: cell("a") },
    { op: "remove", collection: "cells", id: "c" }
  ]);
  // Another die's part leaves this die's snapshot alone.
  const empty = { version: 2 as const, rev: 0, nets: [], cellTypes: [], cells: [], grids: [] };
  assert.equal(applyAction(empty, action.actions[0]), empty);
  // Undo mirrors it: still on die A, as the inverse.
  assert.deepEqual(inverseOf(action.actions[0]), {
    kind: "onDie",
    dieId: "A",
    action: { kind: "removeCellType", cellType: remoteType }
  });
  assert.deepEqual([...splitByDie("home", inverseOf(action)).keys()], ["home", "B", "A"]);
});
