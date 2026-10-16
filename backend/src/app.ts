import cors from "cors";
import express from "express";
import { createImportJobManager } from "./dieImport/jobs.js";
import { createAnnotationsRouter } from "./api/annotations.js";
import { createCellDetectionRouter } from "./api/cellDetection.js";
import { createCellImagingRouter } from "./api/cellImaging.js";
import { createDiesRouter } from "./api/dies.js";
import { createHealthRouter } from "./api/health.js";
import { createJobsRouter } from "./api/jobs.js";
import { createMLRouter } from "./api/ml.js";
import { createMLExportRouter } from "./api/mlExport.js";
import { createTilesRouter } from "./api/tiles.js";
import { createMLPredictor } from "./ml/predict.js";
import { listDieRecords } from "./store.js";
import { createTileScheduler } from "./tileScheduler.js";
import type { AnnotationBroadcaster } from "./ws.js";

export function createApp(config: {
  dataRoot: string;
  tileSize: number;
  limitInputPixels: number | false;
  tileConcurrency: number;
  mlSidecarUrl: string;
  mlPredictPad: number;
  broadcaster?: AnnotationBroadcaster;
}) {
  const app = express();
  const tileScheduler = createTileScheduler({
    dataRoot: config.dataRoot,
    concurrency: config.tileConcurrency
  });
  const importJobManager = createImportJobManager({
    ...config,
    tileScheduler
  });

  void listDieRecords(config.dataRoot)
    .then((records) => {
      for (const record of records) {
        tileScheduler.enqueueBackground(record);
      }
    })
    .catch((error) => {
      console.error("Failed to resume background tile generation", error);
    });

  app.use(cors() as unknown as express.RequestHandler);
  app.use(express.json({ limit: "50mb" }));

  app.use(createHealthRouter());
  app.use(createJobsRouter({ dataRoot: config.dataRoot }));
  app.use(
    createDiesRouter({
      dataRoot: config.dataRoot,
      tileScheduler,
      importJobManager,
      broadcaster: config.broadcaster
    })
  );
  app.use(createTilesRouter({ dataRoot: config.dataRoot, tileScheduler }));
  app.use(
    createAnnotationsRouter({
      dataRoot: config.dataRoot,
      onAnnotationsChanged: (dieId, rev) =>
        config.broadcaster?.emitAnnotationChange(dieId, rev)
    })
  );
  app.use(createMLExportRouter({ dataRoot: config.dataRoot }));
  const predictor = createMLPredictor({
    mlSidecarUrl: config.mlSidecarUrl,
    dataRoot: config.dataRoot,
    mlPredictPad: config.mlPredictPad
  });
  app.use(createMLRouter({
    mlSidecarUrl: config.mlSidecarUrl,
    dataRoot: config.dataRoot,
    mlPredictPad: config.mlPredictPad,
    broadcaster: config.broadcaster,
    predictor
  }));
  app.use(
    createCellDetectionRouter({
      dataRoot: config.dataRoot,
      predictor,
      broadcaster: config.broadcaster
    })
  );
  app.use(
    createCellImagingRouter({
      dataRoot: config.dataRoot,
      tileScheduler,
      broadcaster: config.broadcaster
    })
  );

  app.use(
    (
      error: unknown,
      _request: express.Request,
      response: express.Response,
      _next: express.NextFunction
    ) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        response.status(404).json({ error: "Not found" });
        return;
      }

      response.status(500).json({
        error: error instanceof Error ? error.message : "Unknown server error"
      });
    }
  );

  return app;
}
