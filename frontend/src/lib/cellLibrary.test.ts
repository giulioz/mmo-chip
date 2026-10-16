import assert from "node:assert/strict";
import test from "node:test";
import type { Cell, CellType, DieAnnotations, DieSummary } from "shared";
import type { AnnotationAction } from "../api/actions";
import { scaleCellType } from "shared/cellLibrary";
import { cellFootprint } from "./cellDetection";
import { applyOrientation } from "./geometry";
import { composeOrient, invertOrient, orientVector, type Orient } from "./mergeCells";
import {
  placementCell,
  placementFootprint,
  resizeFromCorner,
  type LibraryPlacement
} from "./libraryPlacement";
import {
  buildTypeMergeAction,
  buildLibraryTypeTransform,
  buildLibraryView,
  libraryDieIds,
  libraryMemberCount,
  placeableTypes,
  remoteInstances,
  routeLibraryAction,
  withLibraryTypes
} from "./cellLibrary";

const die = (id: string, cellLibrary?: string, cellScale?: number): DieSummary => ({
  id,
  name: `die ${id}`,
  originalFilename: `${id}.jpg`,
  width: 1000,
  height: 1000,
  tileSize: 512,
  maxZoomLevel: 1,
  createdAt: "",
  updatedAt: "",
  ...(cellLibrary ? { cellLibrary } : {}),
  ...(cellScale ? { cellScale } : {})
});
const ann = (cellTypes: CellType[], cells: Cell[]): DieAnnotations => ({
  version: 2,
  rev: 1,
  nets: [],
  grids: [],
  cellTypes,
  cells
});
// The owner's NAND: a 40×20 box with a rect and a point.
const nand: CellType = {
  id: "nand",
  name: "NAND",
  matched: true,
  cropRect: { x: 100, y: 200, width: 40, height: 20 },
  layers: {
    metal1: [{ id: "m", kind: "rect", x: 4, y: 2, width: 10, height: 6 }],
    contact: [{ id: "c", kind: "point", x: 20, y: 10, size: 2 }]
  }
};
const placeholder: CellType = { id: "p", name: "p", cropRect: { x: 0, y: 0, width: 5, height: 5 } };
const big: CellType = { id: "big", name: "BIG", matched: true, cropRect: { x: 0, y: 0, width: 90, height: 90 } };

// Die B (this one) is photographed 1.5× larger than die A, which owns the
// types. C is in another library; D names A's type from outside it.
const dies = [die("A", "lib"), die("B", "lib", 1.5), die("C", "other"), die("D")];
const annA = ann([nand, placeholder, big], [
  { id: "a1", cellTypeId: "nand", x: 10, y: 10 },
  { id: "a2", cellTypeId: "nand", x: 60, y: 10, flippedH: true }
]);
const localType: CellType = { id: "loc", name: "LOC", matched: true, cropRect: { x: 0, y: 0, width: 8, height: 8 } };
const annB = ann([localType], [
  { id: "b1", cellTypeId: "nand", cellTypeDieId: "A", x: 300, y: 300 },
  { id: "b2", cellTypeId: "loc", x: 0, y: 0 }
]);
const view = buildLibraryView("B", dies, annB, new Map([["A", annA]]));

test("the view offers the library's matched types, scaled to this die", () => {
  assert.deepEqual(libraryDieIds("B", dies, annB), ["A"]);
  assert.deepEqual(libraryDieIds("D", dies, ann([], [{ id: "d", cellTypeId: "nand", cellTypeDieId: "A", x: 0, y: 0 }])), ["A"]);
  assert.deepEqual(libraryDieIds("C", dies, ann([], [])), []);
  assert.equal(view.name, "lib");
  assert.equal(view.scale, 1.5);
  assert.deepEqual(view.peers.map((d) => d.id), ["A"]);
  const f = view.foreign.get("nand")!;
  assert.equal(f.ownerDieId, "A");
  assert.equal(f.ratio, 1.5);
  assert.deepEqual(f.scaled.cropRect, { x: 150, y: 300, width: 60, height: 30 });
  assert.deepEqual(f.scaled.layers?.metal1, [{ id: "m", kind: "rect", x: 6, y: 3, width: 15, height: 9 }]);
  assert.deepEqual(f.scaled.layers?.contact, [{ id: "c", kind: "point", x: 30, y: 15, size: 3 }]);
  assert.equal(f.offered, true);
  assert.equal(view.foreign.get("p")?.offered, false, "unmatched placeholders stay home");
  // Rebuilt from the same snapshot, the scaled twin is the same object.
  assert.equal(buildLibraryView("B", dies, annB, new Map([["A", annA]])).foreign.get("nand")!.scaled, f.scaled);
  assert.deepEqual(placeableTypes(view).map((t) => t.type.id), ["big", "nand"]);

  const merged = withLibraryTypes(annB, view);
  assert.deepEqual(merged.cellTypes.map((t) => t.id), ["loc", "nand", "big"]);
  assert.equal(merged.cells, annB.cells);
  assert.deepEqual(
    withLibraryTypes(annB, view, { usedOnly: true }).cellTypes.map((t) => t.id),
    ["loc", "nand"]
  );
  // Nothing to add ⇒ the same object.
  const alone = ann([localType], []);
  assert.equal(withLibraryTypes(alone, buildLibraryView("C", dies, alone, new Map())), alone);
});

test("editing another die's type sends it there, in its pixels, touching only what changed", () => {
  const f = view.foreign.get("nand")!;
  const rename: AnnotationAction = {
    kind: "upsertCellType",
    cellType: { ...f.scaled, name: "NAND2" },
    prevCellType: f.scaled
  };
  const routed = routeLibraryAction(rename, view);
  assert.ok(routed?.kind === "onDie" && routed.action.kind === "upsertCellType");
  assert.equal(routed.dieId, "A");
  assert.equal(routed.action.cellType.name, "NAND2");
  assert.equal(routed.action.cellType.cropRect, nand.cropRect, "box kept as stored");
  assert.equal(routed.action.cellType.layers, nand.layers, "layers kept as stored");
  assert.equal(routed.action.prevCellType, nand);

  // Move the contact 3 px right (in B's pixels): only it comes back scaled.
  const moved = { ...f.scaled.layers!.contact![0], x: 33 };
  const edit = routeLibraryAction(
    {
      kind: "upsertCellType",
      cellType: { ...f.scaled, layers: { ...f.scaled.layers, contact: [moved] } },
      prevCellType: f.scaled
    },
    view
  );
  assert.ok(edit?.kind === "onDie" && edit.action.kind === "upsertCellType");
  const layers = edit.action.cellType.layers!;
  assert.equal(layers.metal1, nand.layers!.metal1);
  assert.deepEqual(layers.contact, [{ id: "c", kind: "point", x: 22, y: 10, size: 2 }]);

  // Deleting it from here isn't this die's call: dropped.
  assert.equal(routeLibraryAction({ kind: "removeCellType", cellType: f.scaled }, view), null);

  // Nor is deleting one of our own types that another die still places (A's
  // view: B places NAND): the delete of its last local cell keeps the type.
  const fromA = buildLibraryView("A", dies, annA, new Map([["B", annB]]));
  const lastCell: AnnotationAction = {
    kind: "batch",
    actions: [
      { kind: "removeCell", cell: annA.cells[0] },
      { kind: "removeCell", cell: annA.cells[1] },
      { kind: "removeCellType", cellType: nand }
    ]
  };
  const kept = routeLibraryAction(lastCell, fromA);
  assert.ok(kept?.kind === "batch");
  assert.deepEqual(kept.actions.map((x) => x.kind), ["removeCell", "removeCell"]);
  // An unused one goes as asked.
  assert.equal(routeLibraryAction({ kind: "removeCellType", cellType: big }, fromA)?.kind, "removeCellType");
});

test("cells point at their type's owner", () => {
  const moveB1: AnnotationAction = {
    kind: "upsertCell",
    cell: { id: "b3", cellTypeId: "nand", x: 1, y: 1 },
    prevCell: null
  };
  const r1 = routeLibraryAction(moveB1, view);
  assert.ok(r1?.kind === "upsertCell");
  assert.equal(r1.cell.cellTypeDieId, "A");

  // Unmatching a borrowed instance into a fresh local placeholder clears it.
  const fresh: CellType = { id: "new", name: "cell b1", cropRect: { x: 0, y: 0, width: 60, height: 30 } };
  const unmatch: AnnotationAction = {
    kind: "batch",
    actions: [
      { kind: "upsertCellType", cellType: fresh, prevCellType: null },
      { kind: "upsertCell", cell: { ...annB.cells[0], cellTypeId: "new" }, prevCell: annB.cells[0] }
    ]
  };
  const r2 = routeLibraryAction(unmatch, view);
  assert.ok(r2?.kind === "batch" && r2.actions[1].kind === "upsertCell");
  assert.equal("cellTypeDieId" in r2.actions[1].cell, false);
  assert.equal(r2.actions[0], unmatch.actions[0], "a local type isn't touched");

  // A type we can't see (its die still loading) keeps the pointer as is.
  const loading = buildLibraryView("B", dies, annB, new Map(), true);
  const r3 = routeLibraryAction({ kind: "upsertCell", cell: annB.cells[0], prevCell: annB.cells[0] }, loading);
  assert.ok(r3?.kind === "upsertCell");
  assert.equal(r3.cell.cellTypeDieId, "A");
});

test("turning a shared type turns it on its owner and every instance, each in its die's pixels", () => {
  assert.equal(libraryMemberCount(view, annB, "nand"), 3);
  const action = buildLibraryTypeTransform(view, annB, "nand", { kind: "rotate", deg: 90 });
  assert.ok(action?.kind === "batch");
  const [typeEdit, ...rest] = action.actions;
  // The definition turns on A, in A's pixels: 40×20 → 20×40.
  assert.ok(typeEdit.kind === "onDie" && typeEdit.dieId === "A" && typeEdit.action.kind === "upsertCellType");
  assert.deepEqual(typeEdit.action.cellType.cropRect, { x: 100, y: 200, width: 20, height: 40 });
  // B's instance: its 60×30 box re-centred → origin shifts by ±15.
  const home = rest.find((a) => a.kind === "upsertCell");
  assert.ok(home?.kind === "upsertCell");
  assert.deepEqual([home.cell.x, home.cell.y, home.cell.rotation], [315, 285, 270]);
  // A's two instances, on A: the 40×20 box → ±10; a mirrored one turns the other way.
  const onA = rest.find((a) => a.kind === "onDie" && a.dieId === "A");
  assert.ok(onA?.kind === "onDie" && onA.action.kind === "batch");
  const cells = onA.action.actions.map((a) => (a.kind === "upsertCell" ? a.cell : null));
  assert.deepEqual(cells.map((c) => [c?.id, c?.x, c?.y, c?.rotation]), [
    ["a1", 20, 0, 270],
    ["a2", 70, 0, 90]
  ]);
  // The local type is nobody else's business.
  assert.equal(
    buildLibraryTypeTransform(view, annB, "loc", { kind: "flip", axis: "h" })?.kind,
    "batch"
  );
  assert.equal(buildLibraryTypeTransform(view, annB, "missing", { kind: "flip", axis: "h" }), null);
});

test("a placement draft scales uniformly from a corner and commits as a cell of the owner's type", () => {
  const p: LibraryPlacement = { typeId: "nand", cx: 100, cy: 50, k: 1, rotation: 0, flippedH: false, flippedV: false };
  assert.deepEqual(placementFootprint(p, nand), { x: 80, y: 40, width: 40, height: 20 });
  // Bottom-right corner (120, 60) dragged to (140, 70): ×1.5 about the pinned top-left.
  const grown = resizeFromCorner(p, nand, 2, { x: 140, y: 70 });
  assert.equal(grown.k, 1.5);
  assert.deepEqual(placementFootprint(grown, nand), { x: 80, y: 40, width: 60, height: 30 });
  // Off the diagonal, the pointer is projected onto it: the aspect holds.
  assert.equal(resizeFromCorner(p, nand, 2, { x: 140, y: 60 }).k, 1.4);
  // Never below 4 px on the short side.
  assert.equal(placementFootprint(resizeFromCorner(p, nand, 2, { x: 0, y: 0 }), nand).height, 4);
  // A quarter turn swaps the footprint about the same centre.
  const turned: LibraryPlacement = { ...grown, rotation: 90 };
  assert.deepEqual(placementFootprint(turned, nand), { x: 95, y: 25, width: 30, height: 60 });
  const cell = placementCell(turned, nand, "A", "new");
  assert.deepEqual(cell, {
    id: "new",
    cellTypeId: "nand",
    cellTypeDieId: "A",
    x: 80,
    y: 40,
    merged: true,
    rotation: 90
  });
  // Once the die takes the fitted scale, the cell covers what the draft did.
  assert.deepEqual(cellFootprint(cell, scaleCellType(nand, turned.k)), placementFootprint(turned, nand));
});

test("orientation algebra: compose / invert match applying one after the other", () => {
  const all: Orient[] = [];
  for (const rotation of [0, 90, 180, 270] as const) {
    for (const flippedH of [false, true]) for (const flippedV of [false, true]) all.push({ rotation, flippedH, flippedV });
  }
  const v = { x: 3, y: -7 };
  for (const a of all) {
    for (const b of all) {
      const ab = composeOrient(a, b);
      assert.deepEqual(orientVector(ab, v), orientVector(a, orientVector(b, v)));
    }
    assert.deepEqual(orientVector(composeOrient(a, invertOrient(a)), v), v);
  }
});

test("merging two whole types keeps every instance on the same die pixels, on every die", () => {
  // Die B's own type COPY is NAND turned a quarter (30×60 here = 20×40 on A,
  // in B's 1.5× pixels), placed twice on B; NAND (A's) is placed on A and B.
  const copy: CellType = { id: "copy", name: "COPY", matched: true, cropRect: { x: 0, y: 0, width: 30, height: 60 } };
  const b = ann([localType, copy], [
    ...annB.cells,
    { id: "k1", cellTypeId: "copy", x: 100, y: 100, rotation: 90 },
    { id: "k2", cellTypeId: "copy", x: 300, y: 50, flippedH: true }
  ]);
  const v = buildLibraryView("B", dies, b, new Map([["A", annA]]));
  // COPY's frame onto NAND's: a quarter turn back, and 3 px right, 2 up.
  const align = { orient: { rotation: 270, flippedH: false, flippedV: false } as Orient, dx: 3, dy: -2 };
  const box = (t: CellType, r: number) => ({ w: t.cropRect.width * r, h: t.cropRect.height * r });
  const dieOf = (c: Cell, w: number, h: number, p: { x: number; y: number }) => {
    const q = applyOrientation(p, c, w, h);
    return { x: c.x + q.x, y: c.y + q.y };
  };
  const close = (a: { x: number; y: number }, e: { x: number; y: number }) =>
    assert.ok(Math.hypot(a.x - e.x, a.y - e.y) < 1e-9, `${JSON.stringify(a)} vs ${JSON.stringify(e)}`);
  const samples = [{ x: 0, y: 0 }, { x: 7, y: 2 }, { x: 13, y: 29 }];
  const upserts = (a: AnnotationAction | null | undefined, dieId: string): Cell[] => {
    const out: Cell[] = [];
    const visit = (x: AnnotationAction, die: string) => {
      if (x.kind === "batch") x.actions.forEach((y) => visit(y, die));
      else if (x.kind === "onDie") visit(x.action, x.dieId);
      else if (x.kind === "upsertCell" && die === dieId) out.push(x.cell);
    };
    if (a) visit(a, "B");
    return out;
  };

  // NAND has two shapes, COPY none: NAND survives, COPY's instances move over.
  const plan = buildTypeMergeAction(v, b, "nand", "copy", align)!;
  assert.equal(plan.survivorId, "nand");
  assert.equal(plan.moved, 2);
  const L = align.orient;
  const cBox = box(copy, 1);
  const nBox = box(nand, 1.5);
  for (const next of upserts(plan.action, "B")) {
    const before = b.cells.find((c) => c.id === next.id)!;
    assert.equal(next.cellTypeId, "nand");
    assert.equal(next.cellTypeDieId, "A");
    for (const p of samples) {
      // The same canonical point, through the alignment…
      const lp = orientVector(L, { x: p.x - cBox.w / 2, y: p.y - cBox.h / 2 });
      const ps = { x: lp.x + nBox.w / 2 + align.dx, y: lp.y + nBox.h / 2 + align.dy };
      // …lands where it did.
      close(dieOf(next, nBox.w, nBox.h, ps), dieOf(before, cBox.w, cBox.h, p));
    }
  }
  const tail = plan.action.kind === "batch" ? plan.action.actions.at(-1) : null;
  assert.deepEqual(tail, { kind: "onDie", dieId: "B", action: { kind: "removeCellType", cellType: copy } });

  // Give COPY more annotations: now it survives, and NAND's instances — on B
  // and on A (in A's pixels, where COPY sits at 20×40) — move over.
  const rich: CellType = {
    ...copy,
    layers: { metal1: [1, 2, 3].map((i) => ({ id: `r${i}`, kind: "point" as const, x: i, y: i, size: 1 })) }
  };
  const b2 = { ...b, cellTypes: [localType, rich] };
  const v2 = buildLibraryView("B", dies, b2, new Map([["A", annA]]));
  const plan2 = buildTypeMergeAction(v2, b2, "nand", "copy", align)!;
  assert.equal(plan2.survivorId, "copy");
  assert.equal(plan2.moved, 3);
  const Li = invertOrient(L);
  for (const [dieId, k, cells] of [["B", 1, b2.cells], ["A", 1 / 1.5, annA.cells]] as const) {
    const moved = upserts(plan2.action, dieId);
    assert.equal(moved.length, dieId === "B" ? 1 : 2);
    const nb = box(nand, 1.5 * k);
    const cb = box(copy, k);
    for (const next of moved) {
      const before = cells.find((c) => c.id === next.id)!;
      assert.equal(next.cellTypeId, "copy");
      assert.equal(next.cellTypeDieId, dieId === "B" ? undefined : "B");
      for (const p of samples) {
        // A NAND point, back through the alignment (scaled to this die).
        const q = orientVector(Li, { x: p.x - nb.w / 2 - align.dx * k, y: p.y - nb.h / 2 - align.dy * k });
        close(dieOf(next, cb.w, cb.h, { x: q.x + cb.w / 2, y: q.y + cb.h / 2 }), dieOf(before, nb.w, nb.h, p));
      }
    }
  }
  const tail2 = plan2.action.kind === "batch" ? plan2.action.actions.at(-1) : null;
  assert.deepEqual(tail2, { kind: "onDie", dieId: "A", action: { kind: "removeCellType", cellType: nand } });
});

test("a type's instances on the library's other dies, with their pixel ratio", () => {
  // From B: NAND's two instances on its owner A (B's pixels are 1.5× A's).
  const fromB = remoteInstances(view, annB, "nand");
  assert.deepEqual(fromB.map((r) => [r.cell.id, r.dieId, r.dieName, r.ratio]), [
    ["a1", "A", "die A", 1.5],
    ["a2", "A", "die A", 1.5]
  ]);
  assert.deepEqual(remoteInstances(view, annB, "loc"), [], "nobody else places B's own type");
  // From A: B's instance of A's type.
  const fromA = buildLibraryView("A", dies, annA, new Map([["B", annB]]));
  assert.deepEqual(remoteInstances(fromA, annA, "nand").map((r) => [r.cell.id, r.dieId, r.ratio]), [["b1", "B", 1 / 1.5]]);
});
