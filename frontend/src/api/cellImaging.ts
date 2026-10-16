import { useEffect } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  CellImagingJob,
  CellImagingJobKind,
  CellImagingStartRequest,
  CellSpecimenIndex,
  WireMapInfo
} from "shared";
import { subscribeToDie } from "./annotationsWebSocket";
import { apiDelete, apiGet, apiPost, type ApiError } from "./client";

export const cellImagingKeys = {
  specimens: (dieId: string) => ["cellSpecimens", dieId] as const,
  wireMap: (dieId: string) => ["wireMap", dieId] as const,
  job: (dieId: string) => ["cellImagingJob", dieId] as const
};

/** Index of the clean per-type specimens (null until generated). */
export function useCellSpecimens(
  dieId: string | null
): UseQueryResult<CellSpecimenIndex | null, ApiError> {
  return useQuery<CellSpecimenIndex | null, ApiError>({
    queryKey: cellImagingKeys.specimens(dieId ?? ""),
    queryFn: ({ signal }) => apiGet<CellSpecimenIndex | null>(`/api/dies/${dieId}/cell-specimens`, signal),
    enabled: !!dieId,
    staleTime: 60_000,
    retry: 1
  });
}

/** Wire-likelihood overlay metadata (null until generated). */
export function useWireMapInfo(dieId: string | null): UseQueryResult<WireMapInfo | null, ApiError> {
  return useQuery<WireMapInfo | null, ApiError>({
    queryKey: cellImagingKeys.wireMap(dieId ?? ""),
    queryFn: ({ signal }) => apiGet<WireMapInfo | null>(`/api/dies/${dieId}/wire-map`, signal),
    enabled: !!dieId,
    staleTime: 60_000,
    retry: 1
  });
}

/** Specimen image URL; `version` (the specimen's createdAt) busts the browser
 *  cache when the specimens are regenerated. */
export function specimenImageUrl(dieId: string, cellTypeId: string, version: string): string {
  return `/api/dies/${dieId}/cell-specimens/${cellTypeId}/image?v=${encodeURIComponent(version)}`;
}

export function wireTileUrl(dieId: string, version: string, z: number, x: number, y: number): string {
  return `/api/dies/${dieId}/wire-map/tiles/${z}/${x}/${y}?v=${encodeURIComponent(version)}`;
}

export function startCellImaging(
  dieId: string,
  kind: CellImagingJobKind,
  options: { allDies?: boolean } = {}
): Promise<CellImagingJob> {
  const body: CellImagingStartRequest = { kind, ...(options.allDies ? { allDies: true } : {}) };
  return apiPost<CellImagingJob>(`/api/dies/${dieId}/cell-imaging/job/start`, body);
}

export function stopCellImaging(dieId: string): Promise<CellImagingJob | null> {
  return apiPost<CellImagingJob | null>(`/api/dies/${dieId}/cell-imaging/job/stop`, {});
}

export const clearCellSpecimens = (dieId: string) =>
  apiDelete<{ ok: true }>(`/api/dies/${dieId}/cell-specimens`);
export const clearWireMap = (dieId: string) => apiDelete<{ ok: true }>(`/api/dies/${dieId}/wire-map`);

/** Live imaging-job state: GET seed, WS `imagingJob` updates, slow poll
 *  fallback. A finished job refreshes whatever it produced. */
export function useCellImagingJob(dieId: string | null): UseQueryResult<CellImagingJob | null, ApiError> {
  const qc = useQueryClient();
  const query = useQuery<CellImagingJob | null, ApiError>({
    queryKey: cellImagingKeys.job(dieId ?? ""),
    queryFn: ({ signal }) =>
      dieId ? apiGet<CellImagingJob | null>(`/api/dies/${dieId}/cell-imaging/job`, signal) : Promise.resolve(null),
    enabled: !!dieId,
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
    retry: 1
  });
  useEffect(() => {
    if (!dieId) return;
    return subscribeToDie(dieId, (msg) => {
      if (msg.type !== "imagingJob" || msg.dieId !== dieId) return;
      qc.setQueryData(cellImagingKeys.job(dieId), msg.job);
    });
  }, [dieId, qc]);
  const status = query.data?.status;
  useEffect(() => {
    if (!dieId || status === undefined || status === "running") return;
    void qc.invalidateQueries({ queryKey: cellImagingKeys.specimens(dieId) });
    void qc.invalidateQueries({ queryKey: cellImagingKeys.wireMap(dieId) });
  }, [dieId, status, qc]);
  return query;
}
