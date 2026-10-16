import { useMemo, useRef } from "react";
import { useQueries } from "@tanstack/react-query";
import type { DieAnnotations } from "shared";
import { buildLibraryView, libraryDieIds, type CellLibraryView } from "../lib/cellLibrary";
import { sameFrame } from "../lib/cellDetection";
import { cellTypeCropUrl } from "../lib/mergeCells";
import { annotationKeys, getAnnotations } from "./annotations";
import { useAnnotationsWebSocketMany } from "./annotationsWebSocket";
import { specimenImageUrl, useCellSpecimens } from "./cellImaging";
import { useDies } from "./dies";

/**
 * The cell library as `dieId` sees it: the other dies of its library (and
 * any die its cells borrow a type from), their annotations — the same live
 * queries their own pages use, kept fresh over WS — and the types they
 * offer, scaled to this die. See lib/cellLibrary. `scale`, when given, stands
 * in for the die's saved one (a scale being tried out before it's set).
 */
export function useCellLibrary(
  dieId: string,
  own: DieAnnotations | undefined,
  { scale = null }: { scale?: number | null } = {}
): CellLibraryView {
  const listed = useDies().data;
  const dies = useMemo(
    () =>
      scale == null || !listed
        ? listed
        : listed.map((d) => (d.id === dieId ? { ...d, cellScale: scale } : d)),
    [listed, dieId, scale]
  );
  const ids = libraryDieIds(dieId, dies ?? [], own);
  const idsKey = ids.join(",");
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: annotationKeys.forDie(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => getAnnotations(id, signal)
    }))
  });
  useAnnotationsWebSocketMany(ids);

  // One Map per set of loaded snapshots, so the view (and everything memoised
  // on it) only changes when another die's annotations actually do.
  const datas = results.map((r) => r.data);
  const loading = results.some((r) => r.isLoading);
  const loadedRef = useRef<{
    key: string;
    datas: Array<DieAnnotations | undefined>;
    map: Map<string, DieAnnotations>;
  } | null>(null);
  const prev = loadedRef.current;
  let loaded: Map<string, DieAnnotations>;
  if (
    prev &&
    prev.key === idsKey &&
    prev.datas.length === datas.length &&
    prev.datas.every((d, i) => d === datas[i])
  ) {
    loaded = prev.map;
  } else {
    loaded = new Map();
    ids.forEach((id, i) => {
      const d = datas[i];
      if (d) loaded.set(id, d);
    });
    loadedRef.current = { key: idsKey, datas, map: loaded };
  }

  return useMemo(
    () => buildLibraryView(dieId, dies ?? [], own, loaded, loading),
    [dieId, dies, own, loaded, loading]
  );
}

/**
 * An image of another die's type, for a page that has no instance of it to
 * draw: its clean specimen on its own die when there's one (built in the
 * type's current frame), else that die's template crop (unless
 * `cropFallback` is off). Null for this die's own types.
 */
export function useForeignTypeImageUrl(
  library: CellLibraryView,
  typeId: string | null,
  useCleanSpecimens: boolean,
  { cropFallback = true }: { cropFallback?: boolean } = {}
): string | null {
  const f = typeId ? library.foreign.get(typeId) : undefined;
  const index = useCellSpecimens(f && useCleanSpecimens ? f.ownerDieId : null).data ?? null;
  if (!f) return null;
  const members =
    library.annotations
      .get(f.ownerDieId)
      ?.cells.filter((c) => c.cellTypeId === f.type.id && !c.cellTypeDieId) ?? [];
  const clean = useCleanSpecimens
    ? index?.specimens.find(
        (s) =>
          s.cellTypeId === f.type.id &&
          s.width === Math.round(f.type.cropRect.width) &&
          s.height === Math.round(f.type.cropRect.height) &&
          sameFrame(s.memberSignature, members)
      )
    : undefined;
  if (clean) return specimenImageUrl(f.ownerDieId, f.type.id, clean.createdAt);
  return cropFallback ? cellTypeCropUrl(f.ownerDieId, f.type.id) : null;
}
