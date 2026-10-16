import { useEffect } from "react";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult
} from "@tanstack/react-query";
import type {
  CellDetectionDismissRequest,
  CellDetectionJob,
  CellDetectionResult,
  CellDetectionStartRequest
} from "shared";
import { subscribeToDie } from "./annotationsWebSocket";
import { apiDelete, apiGet, apiPost, type ApiError } from "./client";

// ── Keys ─────────────────────────────────────────────────────────────

export const cellDetectionKeys = {
  results: (dieId: string) => ["cellDetections", dieId] as const,
  job: (dieId: string) => ["cellDetectionJob", dieId] as const
};

// ── Results ──────────────────────────────────────────────────────────

/** Every persisted detection result for a die (one per cell type). */
export function useCellDetections(
  dieId: string | null
): UseQueryResult<CellDetectionResult[], ApiError> {
  return useQuery<CellDetectionResult[], ApiError>({
    queryKey: cellDetectionKeys.results(dieId ?? ""),
    queryFn: ({ signal }) =>
      apiGet<CellDetectionResult[]>(`/api/dies/${dieId}/cell-detections`, signal),
    enabled: !!dieId,
    staleTime: 60_000,
    retry: 1
  });
}

/** Drop results — for one cell type, or every type when `cellTypeId` is
 *  omitted. Only the results files are touched, never the annotations. */
export function clearCellDetections(
  dieId: string,
  cellTypeId?: string
): Promise<{ ok: true }> {
  return apiDelete<{ ok: true }>(
    cellTypeId
      ? `/api/dies/${dieId}/cell-detections/${cellTypeId}`
      : `/api/dies/${dieId}/cell-detections`
  );
}

/** Mark (or unmark) detections as rejected by the user. */
export function dismissCellDetections(
  dieId: string,
  cellTypeId: string,
  ids: string[],
  dismissed = true
): Promise<CellDetectionResult> {
  const body: CellDetectionDismissRequest = { ids, dismissed };
  return apiPost<CellDetectionResult>(
    `/api/dies/${dieId}/cell-detections/${cellTypeId}/dismiss`,
    body
  );
}

// ── Job ──────────────────────────────────────────────────────────────

export function getCellDetectionJob(
  dieId: string,
  signal?: AbortSignal
): Promise<CellDetectionJob | null> {
  return apiGet<CellDetectionJob | null>(
    `/api/dies/${dieId}/cell-detections/job`,
    signal
  );
}

export function startCellDetection(
  dieId: string,
  cellTypeId: string,
  options: { allowFlipX: boolean; allowFlipY: boolean; avoidExistingCells: boolean; allDies?: boolean }
): Promise<CellDetectionJob> {
  const body: CellDetectionStartRequest = { cellTypeId, ...options };
  return apiPost<CellDetectionJob>(
    `/api/dies/${dieId}/cell-detections/job/start`,
    body
  );
}

export function stopCellDetection(dieId: string): Promise<CellDetectionJob | null> {
  return apiPost<CellDetectionJob | null>(
    `/api/dies/${dieId}/cell-detections/job/stop`,
    {}
  );
}

/**
 * Live cell-detection job state for a die: seeded by GET, then driven by WS
 * `cellJob` broadcasts (with a slow poll fallback while running). When a run
 * finishes the results query is invalidated so the overlay refreshes.
 */
export function useCellDetectionJob(
  dieId: string | null
): UseQueryResult<CellDetectionJob | null, ApiError> {
  const qc = useQueryClient();
  const query = useQuery<CellDetectionJob | null, ApiError>({
    queryKey: cellDetectionKeys.job(dieId ?? ""),
    queryFn: ({ signal }) =>
      dieId ? getCellDetectionJob(dieId, signal) : Promise.resolve(null),
    enabled: !!dieId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
    retry: 1
  });

  useEffect(() => {
    if (!dieId) return;
    return subscribeToDie(dieId, (msg) => {
      if (msg.type !== "cellJob" || msg.dieId !== dieId) return;
      const prev = qc.getQueryData<CellDetectionJob | null>(
        cellDetectionKeys.job(dieId)
      );
      qc.setQueryData(cellDetectionKeys.job(dieId), msg.job);
      if (msg.job.status !== "running" && prev?.status !== msg.job.status) {
        void qc.invalidateQueries({ queryKey: cellDetectionKeys.results(dieId) });
      }
    });
  }, [dieId, qc]);

  // Poll fallback: a completed job seen via refetch (WS down) also refreshes.
  const status = query.data?.status;
  useEffect(() => {
    if (!dieId || status === "running" || status === undefined) return;
    void qc.invalidateQueries({ queryKey: cellDetectionKeys.results(dieId) });
  }, [dieId, status, qc]);

  return query;
}
