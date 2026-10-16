import { backendHosts, trustedBrowserRequest, validToken } from "./security.js";
import type { Server as HttpServer } from "node:http";
import type { CellDetectionJob, CellImagingJob, MLInferenceJob } from "shared";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Realtime change broadcaster.
 *
 * Protocol:
 *   client → server :  { "type": "subscribe",   "dieId": "<id>" }
 *                      { "type": "unsubscribe", "dieId": "<id>" }
 *   server → client :  { "type": "annotations", "dieId": "<id>", "rev": <number> }
 *                      { "type": "mlJob", "dieId": "<id>", "job": <MLInferenceJob> }
 *                      { "type": "cellJob", "dieId": "<id>", "job": <CellDetectionJob> }
 *                      { "type": "die", "dieId": "<id>" }   (to every client)
 *                      { "type": "pong" }    (response to {"type":"ping"})
 *
 * Annotation changes carry no payload — clients invalidate and refetch. ML
 * job updates carry the whole (small) job record so every connected client
 * sees inference progress live, including jobs another user triggered.
 */

type ServerMessage =
  | { type: "annotations"; dieId: string; rev: number }
  | { type: "mlJob"; dieId: string; job: MLInferenceJob }
  | { type: "cellJob"; dieId: string; job: CellDetectionJob }
  | { type: "imagingJob"; dieId: string; job: CellImagingJob }
  | { type: "die"; dieId: string }
  | { type: "pong" };

type ClientMessage =
  | { type: "subscribe"; dieId: string }
  | { type: "unsubscribe"; dieId: string }
  | { type: "ping" };

interface Subscription {
  socket: WebSocket;
  dies: Set<string>;
}

export interface AnnotationBroadcaster {
  /** Notify subscribed clients that a die's annotations advanced to `rev`. */
  emitAnnotationChange(dieId: string, rev: number): void;
  /** Push an ML inference job-state change to subscribed clients. */
  emitMLJob(job: MLInferenceJob): void;
  /** Push a cell-detection job-state change to subscribed clients. */
  emitCellJob(job: CellDetectionJob): void;
  /** Push a cell-imaging (specimens / wire map) job-state change. */
  emitImagingJob(job: CellImagingJob): void;
  /** A die's properties changed (cell library / scale). Sent to every
   *  client, not just the die's subscribers: dies sharing a library draw
   *  each other's cell types, so they all care. */
  emitDieChange(dieId: string): void;
  /** Close the server. */
  close(): Promise<void>;
}

export function attachWebSocketBroadcaster(httpServer: HttpServer): AnnotationBroadcaster {
  const wss = new WebSocketServer({ server: httpServer, path: "/api/ws", maxPayload: 4096,
    verifyClient: ({ req }: { req: import("node:http").IncomingMessage }) => validToken(req.headers["x-chiptool-token"]) &&
      (!(req.headers.origin || req.headers["sec-fetch-site"] || req.headers.referer) || trustedBrowserRequest(req, backendHosts))
  });
  const subscriptions = new Map<WebSocket, Subscription>();

  wss.on("connection", (socket) => {
    if (subscriptions.size >= 64) { socket.close(1013, "Connection limit reached"); return; }
    let messages = 100;
    let updated = Date.now();
    const sub: Subscription = { socket, dies: new Set() };
    subscriptions.set(socket, sub);

    socket.on("message", (raw) => {
      const now = Date.now();
      messages = Math.min(100, messages + (now - updated) * 0.02); updated = now;
      if (messages < 1) { socket.close(1008, "Message limit reached"); return; }
      messages--;
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        return; // ignore malformed
      }
      if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;
      switch (msg.type) {
        case "subscribe":
          if (typeof msg.dieId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(msg.dieId) && sub.dies.size < 256) sub.dies.add(msg.dieId);
          return;
        case "unsubscribe":
          if (typeof msg.dieId === "string") sub.dies.delete(msg.dieId);
          return;
        case "ping":
          send(socket, { type: "pong" });
          return;
      }
    });

    socket.on("close", () => {
      subscriptions.delete(socket);
    });
    socket.on("error", () => {
      subscriptions.delete(socket);
    });
  });

  function send(socket: WebSocket, msg: ServerMessage) {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      // ignore — closed sockets are cleaned up by the close/error handlers
    }
  }

  return {
    emitAnnotationChange(dieId, rev) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(dieId)) continue;
        send(sub.socket, { type: "annotations", dieId, rev });
      }
    },
    emitMLJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "mlJob", dieId: job.dieId, job });
      }
    },
    emitCellJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "cellJob", dieId: job.dieId, job });
      }
    },
    emitImagingJob(job) {
      for (const sub of subscriptions.values()) {
        if (!sub.dies.has(job.dieId)) continue;
        send(sub.socket, { type: "imagingJob", dieId: job.dieId, job });
      }
    },
    emitDieChange(dieId) {
      for (const sub of subscriptions.values()) send(sub.socket, { type: "die", dieId });
    },
    async close() {
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    }
  };
}
