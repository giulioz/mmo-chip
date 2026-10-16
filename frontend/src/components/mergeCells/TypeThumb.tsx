import { useDie } from "../../api/dies";
import type { TypeCandidateSource } from "../../lib/mergeCells";
import { CellThumb } from "./CellThumb";

/** Thumbnail for a whole-type candidate: one of its instances, drawn from the
 *  tiles of whichever die it's on (this one, or the type's own die). */
export function TypeThumb({ source }: { source: TypeCandidateSource | null }) {
  const die = useDie(source?.dieId).data ?? null;
  if (!source || !die) return null;
  return <CellThumb die={die} cell={source.cell} cellType={source.cellType} />;
}
