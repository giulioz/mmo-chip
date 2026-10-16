import { Router } from "express";
import {
  readAnnotations,
  readDieRecord,
  withDieLock,
  writeAnnotations
} from "../store.js";
import type {
  AnnotationBatchOp,
  AnnotationBatchRequest,
  AnnotationCollection,
  AnnotationNet,
  AnnotationNetEdge,
  AnnotationNetNode,
  Cell,
  CellLayers,
  CellType,
  DieAnnotations,
  GridDefinition,
  Guide,
  HumanAnnotation,
  IgnoreRect,
  IOPin,
  LayerShape,
  LayerType,
  ROIRectangle
} from "shared";

const VALID_LAYERS: LayerType[] = [
  "diffusion",
  "polysilicon",
  "metal1",
  "metal2",
  "contact",
  "via1",
  "wire_hitbox"
];

export interface AnnotationsRouterConfig {
  dataRoot: string;
  /** Called after each successful annotation write with the new revision. */
  onAnnotationsChanged?: (dieId: string, rev: number) => void;
}

export function createAnnotationsRouter(config: AnnotationsRouterConfig) {
  const router = Router();
  const notify = (dieId: string, rev: number) => config.onAnnotationsChanged?.(dieId, rev);

  // ─── Bulk ─────────────────────────────────────────────────────────

  router.get("/api/dies/:dieId/annotations", async (request, response, next) => {
    try {
      await readDieRecord(config.dataRoot, request.params.dieId);
      const annotations = await readAnnotations(config.dataRoot, request.params.dieId);
      response.json(annotations);
    } catch (error) {
      next(error);
    }
  });

  router.put("/api/dies/:dieId/annotations", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      await readDieRecord(config.dataRoot, dieId);
      const annotations = request.body as DieAnnotations;
      const rev = await withDieLock(dieId, () =>
        writeAnnotations(config.dataRoot, dieId, annotations)
      );
      notify(dieId, rev);
      response.json({ ok: true, rev });
    } catch (error) {
      next(error);
    }
  });

  // One multi-entity edit (a batched undo step) as a single write: every op
  // applies in order to the same snapshot under the die lock, then one
  // revision — other clients never see half of it, and a malformed op
  // writes nothing.
  router.post("/api/dies/:dieId/batch", async (request, response, next) => {
    const { dieId } = request.params;
    try {
      const ops = parseBatchOps((request.body as Partial<AnnotationBatchRequest> | undefined)?.ops);
      if (typeof ops === "string") {
        response.status(400).json({ error: ops });
        return;
      }
      const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
        const collections = annotations as unknown as Partial<
          Record<AnnotationCollection, Array<{ id: string }>>
        >;
        for (const op of ops) {
          const collection = collections[op.collection] ?? [];
          collections[op.collection] =
            op.op === "upsert"
              ? upsertById(collection, op.item)
              : removeById(collection, op.id);
        }
        return null;
      });
      sendMutationResult(response, dieId, result, notify);
    } catch (error) {
      next(error);
    }
  });

  // ─── Per-collection (whole entity by id) ──────────────────────────

  registerCollectionRoutes<Cell>(router, config, notify, "cells", "cells");
  registerCollectionRoutes<CellType>(router, config, notify, "cell-types", "cellTypes");
  registerCollectionRoutes<AnnotationNet>(router, config, notify, "nets", "nets");
  registerCollectionRoutes<GridDefinition>(router, config, notify, "grids", "grids");
  registerOptionalCollectionRoutes<IOPin>(router, config, notify, "pins", "pins");
  registerOptionalCollectionRoutes<HumanAnnotation>(router, config, notify, "annotations", "annotations");
  registerOptionalCollectionRoutes<ROIRectangle>(router, config, notify, "rois", "rois");
  registerOptionalCollectionRoutes<IgnoreRect>(router, config, notify, "ignores", "ignores");
  registerOptionalCollectionRoutes<Guide>(router, config, notify, "guides", "guides");

  // ─── Net sub-entities ─────────────────────────────────────────────

  router.put(
    "/api/dies/:dieId/nets/:netId/nodes/:nodeId",
    async (request, response, next) => {
      const { dieId, netId, nodeId } = request.params;
      try {
        const node = request.body as AnnotationNetNode;
        if (node.id !== nodeId) {
          response.status(400).json({ error: "Body id must match URL id" });
          return;
        }
        const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
          const net = annotations.nets.find((n) => n.id === netId);
          if (!net) return { status: 404, error: "Net not found" };
          net.nodes = upsertById(net.nodes, node);
          return null;
        });
        sendMutationResult(response, dieId, result, notify);
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/api/dies/:dieId/nets/:netId/nodes/:nodeId",
    async (request, response, next) => {
      const { dieId, netId, nodeId } = request.params;
      try {
        const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
          const net = annotations.nets.find((n) => n.id === netId);
          if (!net) return { status: 404, error: "Net not found" };
          net.nodes = removeById(net.nodes, nodeId);
          // Cascade: drop any edges that referenced this node
          net.edges = net.edges.filter((e) => e.from !== nodeId && e.to !== nodeId);
          return null;
        });
        sendMutationResult(response, dieId, result, notify);
      } catch (error) {
        next(error);
      }
    }
  );

  router.put(
    "/api/dies/:dieId/nets/:netId/edges/:edgeId",
    async (request, response, next) => {
      const { dieId, netId, edgeId } = request.params;
      try {
        const edge = request.body as AnnotationNetEdge;
        if (edge.id !== edgeId) {
          response.status(400).json({ error: "Body id must match URL id" });
          return;
        }
        const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
          const net = annotations.nets.find((n) => n.id === netId);
          if (!net) return { status: 404, error: "Net not found" };
          // Both endpoints must reference existing nodes
          const nodeIds = new Set(net.nodes.map((n) => n.id));
          if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
            return { status: 400, error: "Edge endpoints must reference existing nodes" };
          }
          net.edges = upsertById(net.edges, edge);
          return null;
        });
        sendMutationResult(response, dieId, result, notify);
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/api/dies/:dieId/nets/:netId/edges/:edgeId",
    async (request, response, next) => {
      const { dieId, netId, edgeId } = request.params;
      try {
        const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
          const net = annotations.nets.find((n) => n.id === netId);
          if (!net) return { status: 404, error: "Net not found" };
          net.edges = removeById(net.edges, edgeId);
          return null;
        });
        sendMutationResult(response, dieId, result, notify);
      } catch (error) {
        next(error);
      }
    }
  );

  // ─── Cell type layer shapes ───────────────────────────────────────

  router.put(
    "/api/dies/:dieId/cell-types/:ctId/layers/:layer/shapes/:shapeId",
    async (request, response, next) => {
      const { dieId, ctId, layer, shapeId } = request.params;
      if (!isValidLayer(layer)) {
        response.status(400).json({ error: "Unknown layer" });
        return;
      }
      try {
        const shape = request.body as LayerShape;
        if (shape.id !== shapeId) {
          response.status(400).json({ error: "Body id must match URL id" });
          return;
        }
        const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
          const cellType = annotations.cellTypes.find((ct) => ct.id === ctId);
          if (!cellType) return { status: 404, error: "Cell type not found" };
          const layers: CellLayers = cellType.layers ?? {};
          const shapes = layers[layer] ?? [];
          layers[layer] = upsertById(shapes, shape);
          cellType.layers = layers;
          return null;
        });
        sendMutationResult(response, dieId, result, notify);
      } catch (error) {
        next(error);
      }
    }
  );

  router.delete(
    "/api/dies/:dieId/cell-types/:ctId/layers/:layer/shapes/:shapeId",
    async (request, response, next) => {
      const { dieId, ctId, layer, shapeId } = request.params;
      if (!isValidLayer(layer)) {
        response.status(400).json({ error: "Unknown layer" });
        return;
      }
      try {
        const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
          const cellType = annotations.cellTypes.find((ct) => ct.id === ctId);
          if (!cellType || !cellType.layers) return null;
          const shapes = cellType.layers[layer];
          if (!shapes) return null;
          cellType.layers[layer] = removeById(shapes, shapeId);
          return null;
        });
        sendMutationResult(response, dieId, result, notify);
      } catch (error) {
        next(error);
      }
    }
  );

  return router;
}

// ─── Helpers ─────────────────────────────────────────────────────────

interface MutationError {
  status: number;
  error: string;
}

type MutationResult = MutationError | { rev: number };

async function mutateAnnotations(
  dataRoot: string,
  dieId: string,
  mutate: (annotations: DieAnnotations) => MutationError | null
): Promise<MutationResult> {
  await readDieRecord(dataRoot, dieId);
  return withDieLock(dieId, async (): Promise<MutationResult> => {
    const annotations = await readAnnotations(dataRoot, dieId);
    const result = mutate(annotations);
    if (result) return result;
    const rev = await writeAnnotations(dataRoot, dieId, annotations);
    return { rev };
  });
}

function isError(result: MutationResult): result is MutationError {
  return "error" in result;
}

function sendMutationResult(
  response: import("express").Response,
  dieId: string,
  result: MutationResult,
  notify: (dieId: string, rev: number) => void
): void {
  if (isError(result)) {
    response.status(result.status).json({ error: result.error });
    return;
  }
  notify(dieId, result.rev);
  response.json({ ok: true, rev: result.rev });
}

function upsertById<T extends { id: string }>(collection: T[], item: T): T[] {
  const index = collection.findIndex((existing) => existing.id === item.id);
  if (index === -1) return [...collection, item];
  return collection.map((existing, i) => (i === index ? item : existing));
}

function removeById<T extends { id: string }>(collection: T[], id: string): T[] {
  return collection.filter((existing) => existing.id !== id);
}

function isValidLayer(layer: string): layer is LayerType {
  return (VALID_LAYERS as string[]).includes(layer);
}

const BATCH_COLLECTIONS: ReadonlySet<string> = new Set<AnnotationCollection>([
  "cells",
  "cellTypes",
  "nets",
  "grids",
  "pins",
  "annotations",
  "rois",
  "ignores",
  "guides"
]);

/** Validate a batch body's `ops` up front (so a bad op writes nothing);
 *  returns the error message instead when malformed. */
function parseBatchOps(raw: unknown): AnnotationBatchOp[] | string {
  if (!Array.isArray(raw) || raw.length === 0) return "ops must be a non-empty array";
  for (const [i, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") return `ops[${i}]: not an object`;
    const { op, collection, item, id } = entry as Record<string, unknown>;
    if (typeof collection !== "string" || !BATCH_COLLECTIONS.has(collection)) {
      return `ops[${i}]: unknown collection`;
    }
    if (op === "upsert") {
      if (!item || typeof item !== "object" || typeof (item as { id?: unknown }).id !== "string") {
        return `ops[${i}]: upsert needs an item with a string id`;
      }
    } else if (op === "remove") {
      if (typeof id !== "string") return `ops[${i}]: remove needs a string id`;
    } else {
      return `ops[${i}]: op must be "upsert" or "remove"`;
    }
  }
  return raw as AnnotationBatchOp[];
}

function registerCollectionRoutes<T extends { id: string }>(
  router: Router,
  config: { dataRoot: string },
  notify: (dieId: string, rev: number) => void,
  pathName: string,
  field: "cells" | "cellTypes" | "nets" | "grids"
) {
  router.put(`/api/dies/:dieId/${pathName}/:id`, async (request, response, next) => {
    const { dieId, id } = request.params;
    try {
      const item = request.body as T;
      if (item.id !== id) {
        response.status(400).json({ error: "Body id must match URL id" });
        return;
      }
      const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
        const collection = annotations[field] as unknown as T[];
        (annotations as unknown as Record<string, T[]>)[field] = upsertById(collection, item);
        return null;
      });
      sendMutationResult(response, dieId, result, notify);
    } catch (error) {
      next(error);
    }
  });

  router.delete(`/api/dies/:dieId/${pathName}/:id`, async (request, response, next) => {
    const { dieId, id } = request.params;
    try {
      const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
        const collection = annotations[field] as unknown as T[];
        (annotations as unknown as Record<string, T[]>)[field] = removeById(collection, id);
        return null;
      });
      sendMutationResult(response, dieId, result, notify);
    } catch (error) {
      next(error);
    }
  });
}

function registerOptionalCollectionRoutes<T extends { id: string }>(
  router: Router,
  config: { dataRoot: string },
  notify: (dieId: string, rev: number) => void,
  pathName: string,
  field: "pins" | "annotations" | "rois" | "ignores" | "guides"
) {
  router.put(`/api/dies/:dieId/${pathName}/:id`, async (request, response, next) => {
    const { dieId, id } = request.params;
    try {
      const item = request.body as T;
      if (item.id !== id) {
        response.status(400).json({ error: "Body id must match URL id" });
        return;
      }
      const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
        const collection = (annotations[field] ?? []) as unknown as T[];
        (annotations as unknown as Record<string, T[]>)[field] = upsertById(collection, item);
        return null;
      });
      sendMutationResult(response, dieId, result, notify);
    } catch (error) {
      next(error);
    }
  });

  router.delete(`/api/dies/:dieId/${pathName}/:id`, async (request, response, next) => {
    const { dieId, id } = request.params;
    try {
      const result = await mutateAnnotations(config.dataRoot, dieId, (annotations) => {
        const collection = (annotations[field] ?? []) as unknown as T[];
        (annotations as unknown as Record<string, T[]>)[field] = removeById(collection, id);
        return null;
      });
      sendMutationResult(response, dieId, result, notify);
    } catch (error) {
      next(error);
    }
  });
}
