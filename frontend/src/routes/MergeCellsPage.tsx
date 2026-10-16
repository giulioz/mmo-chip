import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import type { Cell, CellType } from "shared";
import { AppShell } from "../components/shell/AppShell";
import { StatusBar } from "../components/shell/StatusBar";
import { SubBar, ToolDivider } from "../components/shell/SubBar";
import { Ic } from "../icons";
import { applyDieUpdate, updateDie, useDie } from "../api/dies";
import { cellScaleOf } from "shared/cellLibrary";
import { useAnnotations } from "../api/annotations";
import { useAnnotationsWebSocket } from "../api/annotationsWebSocket";
import { useActionDispatcher } from "../api/actions";
import { useCellLibrary, useForeignTypeImageUrl } from "../api/cellLibrary";
import {
  buildTypeMergeAction,
  routeLibraryAction,
  withLibraryTypes,
  type TypeAlignment,
  type TypeMergePlan
} from "../lib/cellLibrary";
import { useDieVias, type DieViasBbox } from "../api/ml";
import {
  cellDetectionKeys,
  dismissCellDetections,
  useCellDetections
} from "../api/cellDetection";
import {
  cellFootprint,
  memberScoreMap,
  proposalsFor,
  sameFrame,
  type Proposal
} from "../lib/cellDetection";
import { specimenImageUrl, useCellSpecimens } from "../api/cellImaging";
import { useSession } from "../state/session";
import { useMergeStore } from "../state/mergeCells";
import { usePreferences } from "../state/preferences";
import { fitRectViewport } from "../renderer/TiledCanvas";
import { isTypingTarget } from "../lib/keyboard";
import {
  MergeCanvas,
  type CellView,
  type MergeCanvasHandle
} from "../components/mergeCells/MergeCanvas";
import { MergeLeftPanel } from "../components/mergeCells/MergeLeftPanel";
import { Filmstrip } from "../components/mergeCells/Filmstrip";
import { MergeBottomBar, type ScaleControl } from "../components/mergeCells/MergeBottomBar";
import {
  MergeContextMenu,
  type ContextMenuState
} from "../components/mergeCells/MergeContextMenu";
import {
  buildApproveAction,
  buildMergeAction,
  buildOrientAction,
  buildRotateCellTypeAction,
  buildUnmatchAction,
  candidatesFor,
  cellById,
  cellTypeById,
  cellTypeCropUrl,
  membersOf,
  orientOf,
  resolveSpecimenCell,
  rotateView,
  IDENTITY_ORIENT,
  orientOnDie,
  orientVector,
  parseTypeCandidateId,
  typeCandidatesFor,
  type DieOrientOp,
  type TypeCandidateSource
} from "../lib/mergeCells";
import { alignVias, viasToCanonical } from "../lib/viaAlign";

export function MergeCellsPage() {
  const [params] = useSearchParams();
  const sessionDieId = useSession((s) => s.dieId);
  const setSessionDieId = useSession((s) => s.setDieId);
  const dieId = params.get("die") ?? sessionDieId ?? null;

  useEffect(() => {
    if (dieId && dieId !== sessionDieId) setSessionDieId(dieId);
  }, [dieId, sessionDieId, setSessionDieId]);

  if (!dieId) {
    return (
      <AppShell breadcrumb="Merge cells">
        <Centered>Open a die from the Library to merge cells.</Centered>
      </AppShell>
    );
  }
  return <Merge key={dieId} dieId={dieId} />;
}

function Merge({ dieId }: { dieId: string }) {
  const navigate = useNavigate();
  const [params, setSearchParams] = useSearchParams();
  const die = useDie(dieId).data;
  const annotationsQ = useAnnotations(dieId);
  useAnnotationsWebSocket(dieId);
  const ownAnnotations = annotationsQ.data;
  // Other dies' types shared through the cell library, merged in at this
  // die's scale; edits to them are routed to their die.
  // A die scale being tried out (the scale control, or a corner drag on a
  // type from another die): everything from other dies is drawn at it until
  // it's set — or reset.
  const [scalePreview, setScalePreview] = useState<number | null>(null);
  const library = useCellLibrary(dieId, ownAnnotations, { scale: scalePreview });
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const annotations = useMemo(
    () => (ownAnnotations ? withLibraryTypes(ownAnnotations, library) : undefined),
    [ownAnnotations, library]
  );
  const dispatcher = useActionDispatcher(dieId, {
    route: (action) => routeLibraryAction(action, libraryRef.current)
  });
  const qc = useQueryClient();

  // ML cell proposals (cell-detection results): offered as candidates for
  // their type and approved into real cells from here. Orientation tweaks on
  // a proposal stay in the merge store until approval.
  const cellDetectionsQ = useCellDetections(dieId);
  const cellDetectionThreshold = usePreferences((s) => s.cellDetectionThreshold);
  const proposals = useMemo<Proposal[]>(
    () =>
      annotations && cellDetectionsQ.data
        ? proposalsFor(cellDetectionsQ.data, annotations, {
            threshold: cellDetectionThreshold
          })
        : [],
    [annotations, cellDetectionsQ.data, cellDetectionThreshold]
  );
  // Members' template-match scores from the latest run per type: ranks a
  // type's members worst-first so misclassified ones are easy to spot.
  const memberScores = useMemo(
    () => memberScoreMap(cellDetectionsQ.data ?? []),
    [cellDetectionsQ.data]
  );
  const proposalOverrides = useMergeStore((s) => s.proposalOverrides);
  const patchProposalOverride = useMergeStore((s) => s.patchProposalOverride);
  const clearProposalOverride = useMergeStore((s) => s.clearProposalOverride);

  const mode = usePreferences((s) => s.mergeMode);
  const setMode = usePreferences((s) => s.setMergeMode);
  const opacity = usePreferences((s) => s.mergeOpacity);
  const setOpacity = usePreferences((s) => s.setMergeOpacity);
  const showAnno = usePreferences((s) => s.mergeShowAnno);
  const setShowAnno = usePreferences((s) => s.setMergeShowAnno);
  const showMlVias = usePreferences((s) => s.mergeShowMlVias);
  const setShowMlVias = usePreferences((s) => s.setMergeShowMlVias);

  const specimenTypeId = useMergeStore((s) => s.specimenTypeId);
  const specimenCellId = useMergeStore((s) => s.specimenCellId);
  const candidateCellId = useMergeStore((s) => s.candidateCellId);
  const setSpecimen = useMergeStore((s) => s.setSpecimen);
  const setCandidate = useMergeStore((s) => s.setCandidate);

  // ── URL ↔ store sync ──────────────────────────────────────────────
  // One-shot hydration so a refresh / deep link lands on the same target
  // type + reference instance + candidate. useLayoutEffect so the auto-pick
  // effect below (which fires on the first specimenTypeId transition) sees
  // the hydrated candidate and skips the override.
  const hydratedFromUrlRef = useRef(false);
  useLayoutEffect(() => {
    if (hydratedFromUrlRef.current) return;
    hydratedFromUrlRef.current = true;
    const type = params.get("type");
    const ref = params.get("ref");
    const cand = params.get("cand");
    if (type) setSpecimen(type, ref);
    if (cand) setCandidate(cand);
  }, [params, setSpecimen, setCandidate]);

  // Write the active selection back into the URL. `replace: true` so per-
  // candidate flips don't pollute the back-button history. Diff-first so the
  // store→URL→params→effect loop self-terminates.
  useEffect(() => {
    if (!hydratedFromUrlRef.current) return;
    const next = new URLSearchParams(params);
    let changed = false;
    if (specimenTypeId) {
      if (next.get("type") !== specimenTypeId) {
        next.set("type", specimenTypeId);
        changed = true;
      }
    } else if (next.has("type")) {
      next.delete("type");
      changed = true;
    }
    if (specimenCellId) {
      if (next.get("ref") !== specimenCellId) {
        next.set("ref", specimenCellId);
        changed = true;
      }
    } else if (next.has("ref")) {
      next.delete("ref");
      changed = true;
    }
    if (candidateCellId) {
      if (next.get("cand") !== candidateCellId) {
        next.set("cand", candidateCellId);
        changed = true;
      }
    } else if (next.has("cand")) {
      next.delete("cand");
      changed = true;
    }
    if (changed) setSearchParams(next, { replace: true });
  }, [specimenTypeId, specimenCellId, candidateCellId, params, setSearchParams]);

  // Stale-link guard: if the URL pointed at a cell type that's since been
  // removed, drop the selection so the panel renders cleanly.
  useEffect(() => {
    // (A library type only resolves once its die's annotations are in.)
    if (!annotations || !specimenTypeId || library.loading) return;
    if (!annotations.cellTypes.some((ct) => ct.id === specimenTypeId)) {
      setSpecimen(null, null);
    }
  }, [annotations, specimenTypeId, setSpecimen]);

  const canvasRef = useRef<MergeCanvasHandle | null>(null);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  // A type merge that would drop the losing type's annotations, awaiting OK.
  const [confirmTypeMerge, setConfirmTypeMerge] = useState<TypeMergePlan | null>(null);

  // ── Derived views ──────────────────────────────────────────────────
  const specimenType = annotations
    ? cellTypeById(annotations, specimenTypeId)
    : null;
  const specimenCell = annotations
    ? resolveSpecimenCell(annotations, specimenTypeId, specimenCellId)
    : null;
  // Pixels for a whole-type candidate: an instance here, else one on the die
  // that owns the type.
  const typeSourceFor = useCallback(
    (ct: CellType): TypeCandidateSource | null => {
      const local = annotations?.cells.find((c) => c.cellTypeId === ct.id);
      if (local) return { dieId, cell: local, cellType: ct };
      const f = library.foreign.get(ct.id);
      const there = f
        ? library.annotations
            .get(f.ownerDieId)
            ?.cells.find((c) => c.cellTypeId === ct.id && !c.cellTypeDieId)
        : undefined;
      return f && there ? { dieId: f.ownerDieId, cell: there, cellType: f.type } : null;
    },
    [annotations, library, dieId]
  );
  // Cells to merge into the specimen type — then, past a divider, whole cell
  // types (this die's and the library's) to merge with it.
  const candidates = useMemo(
    () =>
      annotations
        ? [
            ...candidatesFor(annotations, specimenType, proposals, proposalOverrides, memberScores),
            ...typeCandidatesFor(annotations, specimenType, typeSourceFor)
          ]
        : [],
    [annotations, specimenType, proposals, proposalOverrides, memberScores, typeSourceFor]
  );
  // The candidate is a placed cell or a proposal's virtual cell — resolved
  // through the candidate list so a proposal's unsaved tweaks apply — or a
  // whole cell type (then none of the per-cell paths below apply).
  const candidateEntry =
    candidates.find((c) => c.cell.id === candidateCellId) ?? null;
  const typeCandidate = candidateEntry?.mergeType ? candidateEntry : null;
  const candidateCell = typeCandidate
    ? null
    : (candidateEntry?.cell ?? (annotations ? cellById(annotations, candidateCellId) : null));
  const candidateType = typeCandidate
    ? null
    : (candidateEntry?.cellType ??
      (candidateCell ? cellTypeById(annotations!, candidateCell.cellTypeId) : null));
  const candidateProposal = candidateEntry?.proposal ?? null;

  // How the candidate type lines up with the specimen's: turned / mirrored /
  // shifted with the same controls as a cell. Starts centred, unturned.
  const [typeAlignState, setTypeAlignState] = useState<(TypeAlignment & { typeId: string }) | null>(null);
  const typeAlign: TypeAlignment | null = typeCandidate
    ? typeAlignState?.typeId === typeCandidate.cellType.id
      ? typeAlignState
      : { orient: IDENTITY_ORIENT, dx: 0, dy: 0 }
    : null;
  /** Flip / turn the candidate type as seen in the canvas, about the
   *  specimen's centre. */
  const orientTypeCandidate = useCallback(
    (op: DieOrientOp) => {
      if (!typeCandidate || !typeAlign) return;
      const d = orientVector(orientOnDie(IDENTITY_ORIENT, op), { x: typeAlign.dx, y: typeAlign.dy });
      setTypeAlignState({
        typeId: typeCandidate.cellType.id,
        orient: orientOnDie(typeAlign.orient, op),
        dx: d.x,
        dy: d.y
      });
    },
    [typeCandidate, typeAlign]
  );
  const onAlignCanonical = useCallback(
    (dx: number, dy: number) => {
      if (!typeCandidate || !typeAlign) return;
      setTypeAlignState({
        typeId: typeCandidate.cellType.id,
        orient: typeAlign.orient,
        dx: Math.round(typeAlign.dx + dx),
        dy: Math.round(typeAlign.dy + dy)
      });
    },
    [typeCandidate, typeAlign]
  );

  // ── ML via overlay (fetched per cell die-bbox; cached client-side) ──
  // Only fetched when the toggle is on so we don't burn ML inference time
  // for users who don't want the help. React Query keys on the bbox tuple,
  // so flipping between candidates instantly serves cached results.
  const specimenBbox: DieViasBbox | null =
    specimenCell && specimenType ? footprintBbox(specimenCell, specimenType) : null;
  const candidateBbox: DieViasBbox | null =
    candidateCell && candidateType ? footprintBbox(candidateCell, candidateType) : null;
  const specimenViasQ = useDieVias(dieId, specimenBbox, { enabled: showMlVias });
  const candidateViasQ = useDieVias(dieId, candidateBbox, { enabled: showMlVias });

  // Clean specimen (per-pixel median of the type's instances) instead of one
  // raw member crop, when generated and enabled: no wires / debris on the
  // reference side of the comparison.
  const useCleanSpecimens = usePreferences((s) => s.useCleanSpecimens);
  const specimenIndex = useCellSpecimens(dieId).data ?? null;
  const cleanSpecimen =
    useCleanSpecimens && specimenType
      ? (specimenIndex?.specimens.find(
          (s) =>
            s.cellTypeId === specimenType.id &&
            s.width === Math.round(specimenType.cropRect.width) &&
            s.height === Math.round(specimenType.cropRect.height) &&
            // Built before the type was flipped / turned: it would show
            // mirrored or rotated against its members.
            sameFrame(s.memberSignature, membersOf(annotations!, specimenType.id))
        ) ?? null)
      : null;
  // Another die's type not placed here yet: its image comes from that die.
  const foreignSpecimenUrl = useForeignTypeImageUrl(
    library,
    specimenType && !specimenCell ? specimenType.id : null,
    useCleanSpecimens
  );
  // Instances are drawn from the die's tile pyramid; a URL only for the
  // clean specimen, or the type's template when it has no instance yet.
  const specimenView: CellView | null = specimenType
    ? {
        cellType: specimenType,
        cell: specimenCell,
        imageUrl: cleanSpecimen
          ? specimenImageUrl(dieId, specimenType.id, cleanSpecimen.createdAt)
          : specimenCell
            ? null
            : (foreignSpecimenUrl ?? cellTypeCropUrl(dieId, specimenType.id)),
        mlVias: specimenViasQ.data ?? null
      }
    : null;
  // A whole-type candidate: its clean specimen when there's one (built here,
  // else on its own die), else an instance's pixels — lined up in the
  // specimen's box as aligned.
  const typeCandidateId = typeCandidate?.cellType.id ?? null;
  const localTypeSpecimen =
    useCleanSpecimens && typeCandidate
      ? (specimenIndex?.specimens.find(
          (s) =>
            s.cellTypeId === typeCandidate.cellType.id &&
            s.width === Math.round(typeCandidate.cellType.cropRect.width) &&
            s.height === Math.round(typeCandidate.cellType.cropRect.height) &&
            sameFrame(s.memberSignature, membersOf(annotations!, typeCandidate.cellType.id))
        ) ?? null)
      : null;
  const ownerTypeSpecimenUrl = useForeignTypeImageUrl(
    library,
    localTypeSpecimen ? null : typeCandidateId,
    useCleanSpecimens,
    { cropFallback: false }
  );
  const typeSource = typeCandidate?.mergeType?.source ?? null;
  const typeSourceDie = useDie(typeSource?.dieId).data;

  // Which die each side's pixels come from. Scaling means something when one
  // side is this die's and the other another die's: the control then sets
  // this die's scale against that one.
  const specimenPixelsDie = !specimenType
    ? null
    : !specimenCell && !cleanSpecimen && library.foreign.has(specimenType.id)
      ? library.foreign.get(specimenType.id)!.ownerDieId
      : dieId;
  const candidatePixelsDie = typeCandidate
    ? localTypeSpecimen
      ? dieId
      : ownerTypeSpecimenUrl
        ? (library.foreign.get(typeCandidate.cellType.id)?.ownerDieId ?? dieId)
        : (typeSource?.dieId ?? null)
    : candidateCell
      ? dieId
      : null;
  const scaleOtherDieId =
    specimenPixelsDie &&
    candidatePixelsDie &&
    specimenPixelsDie !== candidatePixelsDie &&
    (specimenPixelsDie === dieId || candidatePixelsDie === dieId)
      ? specimenPixelsDie === dieId
        ? candidatePixelsDie
        : specimenPixelsDie
      : null;

  const typeCandidateView: CellView | null =
    typeCandidate && typeAlign && specimenType
      ? {
          cellType: specimenType,
          cell: null,
          imageUrl: localTypeSpecimen
            ? specimenImageUrl(dieId, typeCandidate.cellType.id, localTypeSpecimen.createdAt)
            : ownerTypeSpecimenUrl,
          align: {
            cellType: typeCandidate.cellType,
            ...typeAlign,
            member:
              typeSource && typeSourceDie
                ? {
                    cell: typeSource.cell,
                    die: typeSourceDie,
                    scale:
                      typeSource.dieId === dieId
                        ? 1
                        : (library.foreign.get(typeCandidate.cellType.id)?.ratio ?? 1)
                  }
                : null,
            // Drawn from another die's pixels: its corners scale it.
            scalable: candidatePixelsDie !== dieId && candidatePixelsDie === scaleOtherDieId
          },
          mlVias: null
        }
      : null;
  const candidateView: CellView | null =
    typeCandidateView ??
    (candidateCell && candidateType
      ? {
          cellType: candidateType,
          cell: candidateCell,
          imageUrl: null,
          mlVias: candidateViasQ.data ?? null
        }
      : null);

  // When the specimen *type* changes, jump the selection to the most likely
  // candidate (the closest-size not-yet-matched one — candidates are sorted
  // done-first then by ascending size distance). Only fires on a real type
  // switch, not on every annotations refresh (e.g. after a merge).
  //
  // The very first run after URL hydration is a special case: if `?cand=` was
  // present, hydration set the candidate before this effect ran, and we want
  // to keep it instead of overriding with the auto-pick.
  const prevSpecimenType = useRef<string | null>(null);
  useEffect(() => {
    if (!annotations) return;
    if (specimenTypeId === prevSpecimenType.current) return;
    const wasFirstRun = prevSpecimenType.current === null;
    prevSpecimenType.current = specimenTypeId;
    if (wasFirstRun && candidateCellId) return;
    const list = candidatesFor(
      annotations,
      cellTypeById(annotations, specimenTypeId),
      proposals,
      proposalOverrides,
      memberScores
    );
    // A candidate picked together with the type (e.g. clicking a proposal
    // group in the ML folder) wins over the auto-pick.
    if (
      candidateCellId &&
      list.some((c) => c.cell.id === candidateCellId && !c.done)
    ) {
      return;
    }
    const first = list.find((c) => !c.done) ?? list[0] ?? null;
    setCandidate(first ? first.cell.id : null);
  }, [
    specimenTypeId,
    annotations,
    candidateCellId,
    setCandidate,
    proposals,
    proposalOverrides,
    memberScores
  ]);

  // ── Actions ────────────────────────────────────────────────────────
  const advance = useCallback(() => {
    const idx = candidates.findIndex((c) => c.cell.id === candidateCellId);
    const next =
      candidates.slice(idx + 1).find((c) => !c.done) ??
      candidates.find((c) => !c.done && c.cell.id !== candidateCellId);
    setCandidate(next ? next.cell.id : null);
  }, [candidates, candidateCellId, setCandidate]);

  const orient = useCallback(
    (patch: Partial<Pick<Cell, "flippedH" | "flippedV" | "rotation" | "x" | "y">>) => {
      if (!candidateCell) return;
      if (candidateProposal) {
        // Proposals aren't persisted — keep the tweak local until approval.
        patchProposalOverride(candidateProposal.detection.id, patch);
        return;
      }
      void dispatcher.dispatch(buildOrientAction(candidateCell, patch));
    },
    [candidateCell, candidateProposal, patchProposalOverride, dispatcher]
  );

  const onFlipH = useCallback(
    () =>
      typeCandidate
        ? orientTypeCandidate("flipH")
        : orient({ flippedH: !(candidateCell?.flippedH === true) }),
    [orient, candidateCell, typeCandidate, orientTypeCandidate]
  );
  const onFlipV = useCallback(
    () =>
      typeCandidate
        ? orientTypeCandidate("flipV")
        : orient({ flippedV: !(candidateCell?.flippedV === true) }),
    [orient, candidateCell, typeCandidate, orientTypeCandidate]
  );
  const onRotateCw = useCallback(() => {
    if (typeCandidate) {
      orientTypeCandidate("rotateCw");
      return;
    }
    if (!candidateCell || !annotations) return;
    // An unmatched candidate alone in its placeholder type turns the whole
    // placeholder: the footprint stays on the same die pixels while its box
    // swaps W×H, so it can line up with a target of the other aspect (e.g.
    // a type turned in Cell RE). Members, proposals and shared placeholders
    // turn just this placement about its centre.
    if (
      !candidateProposal &&
      candidateType &&
      candidateType.matched !== true &&
      membersOf(annotations, candidateType.id).length === 1
    ) {
      const action = buildRotateCellTypeAction(annotations, candidateType, 90);
      if (action) void dispatcher.dispatch(action);
      return;
    }
    orient({ rotation: rotateView(orientOf(candidateCell), 90).rotation });
  }, [
    annotations,
    candidateCell,
    candidateProposal,
    candidateType,
    dispatcher,
    orient,
    typeCandidate,
    orientTypeCandidate
  ]);
  const onAlign = useCallback(
    (dxSrc: number, dySrc: number) => {
      if (!candidateCell) return;
      orient({
        x: Math.round(candidateCell.x + dxSrc),
        y: Math.round(candidateCell.y + dySrc)
      });
    },
    [orient, candidateCell]
  );

  // ── Auto-align (via Hough voting over the dihedral group D4) ────────
  // Enabled iff both cells have ML vias loaded with at least 2 points each.
  // The button stays present but disabled otherwise (with a tooltip hint).
  const specimenVias = specimenViasQ.data?.pointVias ?? null;
  const candidateVias = candidateViasQ.data?.pointVias ?? null;
  const canAutoAlign =
    !!candidateCell &&
    !!specimenCell &&
    !!specimenType &&
    !!candidateType &&
    !!specimenVias &&
    !!candidateVias &&
    specimenVias.length >= 2 &&
    candidateVias.length >= 2;

  const doAutoAlign = useCallback(() => {
    if (
      !candidateCell ||
      !specimenCell ||
      !specimenType ||
      !candidateType ||
      !specimenVias ||
      !candidateVias
    ) {
      return;
    }
    // Specimen vias projected into the specimen's canonical frame (once).
    // Candidate vias stay in raw cell-local coords — alignVias re-projects
    // them under every candidate orientation it tries.
    const W = candidateType.cropRect.width;
    const H = candidateType.cropRect.height;
    const specCanon = viasToCanonical(
      specimenVias.map((v) => ({
        x: v.x - specimenCell.x,
        y: v.y - specimenCell.y
      })),
      orientOf(specimenCell),
      specimenType.cropRect.width,
      specimenType.cropRect.height
    );
    const candRaw = candidateVias.map((v) => ({
      x: v.x - candidateCell.x,
      y: v.y - candidateCell.y
    }));
    const result = alignVias(specCanon, candRaw, W, H);
    if (!result) {
      // Not enough signal — leave the user in charge. A toast / status line
      // would be friendlier; for now the bottom-bar tooltip explains it.
      console.warn("[merge] auto-align: no orientation produced a strong enough cluster");
      return;
    }
    orient({
      flippedH: result.flippedH,
      flippedV: result.flippedV,
      rotation: result.rotation,
      x: Math.round(candidateCell.x + result.dx),
      y: Math.round(candidateCell.y + result.dy)
    });
  }, [
    candidateCell,
    candidateType,
    specimenCell,
    specimenType,
    specimenVias,
    candidateVias,
    orient
  ]);

  // ── Die scale, fitted against another die's pixels ───────────────
  const savedScale = cellScaleOf(die);
  const scalePending = scalePreview !== null && Math.abs(scalePreview - savedScale) > 1e-9;
  const [scaleBusy, setScaleBusy] = useState(false);
  // The die compared against — remembered, so a pending scale can still be
  // set or reset after moving to a comparison it doesn't apply to.
  const lastScaleOtherRef = useRef<string | null>(null);
  if (scaleOtherDieId) lastScaleOtherRef.current = scaleOtherDieId;
  const scaleOther = scaleOtherDieId ?? (scalePending ? lastScaleOtherRef.current : null);
  const otherScale = cellScaleOf(scaleOther ? library.dies.get(scaleOther) : null);
  const stepScale = useCallback(
    (up: boolean, coarse: boolean) => {
      const f = coarse ? 1.01 : 1.001;
      setScalePreview((s) => (s ?? savedScale) * (up ? f : 1 / f));
    },
    [savedScale]
  );
  const onScaleCandidate = useCallback(
    (factor: number) => setScalePreview((s) => (s ?? savedScale) * factor),
    [savedScale]
  );
  /** Save the scale being tried out as the die's. */
  const saveScale = useCallback(async (): Promise<boolean> => {
    if (scalePreview === null) return true;
    setScaleBusy(true);
    try {
      applyDieUpdate(qc, await updateDie(dieId, { cellScale: scalePreview }));
      setScalePreview(null);
      return true;
    } catch (e) {
      console.warn("[merge] saving the die scale failed", e);
      return false;
    } finally {
      setScaleBusy(false);
    }
  }, [scalePreview, qc, dieId]);
  /** Run `fn` once a pending scale is saved — merging what was matched at a
   *  tried-out scale sets that scale, as placing a library cell does. */
  const withScaleSaved = useCallback(
    (fn: () => void) => {
      if (!scalePending) fn();
      else void saveScale().then((ok) => ok && fn());
    },
    [scalePending, saveScale]
  );
  const scaleControl: ScaleControl | null = scaleOther
    ? {
        ratio: (scalePreview ?? savedScale) / otherScale,
        otherName: library.dies.get(scaleOther)?.name ?? "the other die",
        pending: scalePending,
        busy: scaleBusy,
        onStep: stepScale,
        onSetRatio: (r) => setScalePreview(r * otherScale),
        onSave: () => void saveScale(),
        onReset: () => setScalePreview(null)
      }
    : null;

  /** Merge the candidate type with the specimen's (see buildTypeMergeAction):
   *  one undo step. When the candidate is the one kept, it becomes the
   *  specimen — the old one is gone. */
  const runTypeMerge = useCallback(
    (plan: TypeMergePlan) => {
      setConfirmTypeMerge(null);
      withScaleSaved(() => {
        setTypeAlignState(null);
        void dispatcher.dispatch(plan.action);
        if (plan.survivorId !== specimenTypeId) setSpecimen(plan.survivorId, null);
        else advance();
      });
    },
    [dispatcher, specimenTypeId, setSpecimen, advance, withScaleSaved]
  );

  const doMerge = useCallback(() => {
    if (typeCandidate) {
      if (!ownAnnotations || !specimenType || !typeAlign) return;
      const plan = buildTypeMergeAction(
        library,
        ownAnnotations,
        specimenType.id,
        typeCandidate.cellType.id,
        typeAlign
      );
      if (!plan) return;
      if (plan.loserShapes > 0) setConfirmTypeMerge(plan);
      else runTypeMerge(plan);
      return;
    }
    if (!annotations || !candidateCell || !specimenType) return;
    if (candidateProposal) {
      // Approve: materialise the proposal as a merged member at the
      // (possibly tweaked) placement. It then hides itself because it
      // overlaps the new cell — undo brings it back.
      const action = buildApproveAction(specimenType, {
        ...orientOf(candidateCell),
        x: candidateCell.x,
        y: candidateCell.y
      });
      const detectionId = candidateProposal.detection.id;
      withScaleSaved(() => {
        void dispatcher.dispatch(action);
        clearProposalOverride(detectionId);
        advance();
      });
      return;
    }
    const plan = buildMergeAction(annotations, candidateCell, specimenType, {
      ...orientOf(candidateCell),
      x: candidateCell.x,
      y: candidateCell.y
    });
    if (plan.losesAnnotations && !confirmMerge) {
      setConfirmMerge(true);
      return;
    }
    setConfirmMerge(false);
    withScaleSaved(() => {
      void dispatcher.dispatch(plan.action);
      advance();
    });
  }, [
    annotations,
    candidateCell,
    candidateProposal,
    clearProposalOverride,
    specimenType,
    confirmMerge,
    dispatcher,
    advance,
    typeCandidate,
    typeAlign,
    ownAnnotations,
    library,
    runTypeMerge,
    withScaleSaved
  ]);

  const onSkip = useCallback(() => advance(), [advance]);

  /** Reject a proposal for good (persisted on the result file). */
  const doDismiss = useCallback(
    (p: Proposal) => {
      void dismissCellDetections(dieId, p.result.cellTypeId, [p.detection.id])
        .then(() =>
          qc.invalidateQueries({ queryKey: cellDetectionKeys.results(dieId) })
        )
        .catch((e: unknown) => console.warn("[merge] dismiss failed", e));
      clearProposalOverride(p.detection.id);
      if (candidateProposal?.detection.id === p.detection.id) advance();
    },
    [dieId, qc, clearProposalOverride, candidateProposal, advance]
  );

  /** Right-click on a candidate row / thumbnail. */
  const openCandidateMenu = useCallback(
    (cell: Cell, x: number, y: number) => {
      if (parseTypeCandidateId(cell.id)) return; // a whole type: nothing to do per cell
      const entry = candidates.find((c) => c.cell.id === cell.id) ?? null;
      const proposal = entry?.proposal ?? null;
      // Unmatch is meaningless for a proposal, or for a sole-member type
      // (it's already standalone — would just rename it to a fresh singleton).
      const canUnmatch =
        !proposal &&
        !!annotations &&
        membersOf(annotations, cell.cellTypeId).length > 1;
      setMenu({ x, y, cellId: cell.id, canUnmatch, proposal });
    },
    [candidates, annotations]
  );

  const doUnmatch = useCallback(
    (cell: Cell) => {
      if (!annotations) return;
      void dispatcher.dispatch(buildUnmatchAction(annotations, cell));
    },
    [annotations, dispatcher]
  );

  const jumpToDie = useCallback(
    (cell: Cell) => {
      const ct = annotations ? cellTypeById(annotations, cell.cellTypeId) : null;
      if (ct) {
        const fp = cellFootprint(cell, ct);
        const rect = { ...fp, width: fp.width || 64, height: fp.height || 64 };
        const v = fitRectViewport(
          rect,
          Math.max(320, window.innerWidth - 568),
          Math.max(240, window.innerHeight - 140),
          80,
          4
        );
        usePreferences.getState().saveViewport(dieId, v);
      }
      navigate(`/die/${dieId}`);
    },
    [annotations, dieId, navigate]
  );

  // ── Keyboard: ⌘Z / ⌘⇧Z undo-redo ───────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) void dispatcher.redo();
        else void dispatcher.undo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dispatcher]);

  // ── Keyboard: merge workflow shortcuts ──────────────────────────────
  //   ←/↑ prev · →/↓ next candidate
  //   1 overlay · 2 side-by-side · 3 difference
  //   f flip H · g flip V · h rotate · j auto-align (stub)
  //   y accept & merge
  useEffect(() => {
    const stepCandidate = (delta: number) => {
      if (candidates.length === 0) return;
      const idx = candidates.findIndex((c) => c.cell.id === candidateCellId);
      const base = idx === -1 ? (delta > 0 ? -1 : candidates.length) : idx;
      const next = Math.min(candidates.length - 1, Math.max(0, base + delta));
      const c = candidates[next];
      if (c) setCandidate(c.cell.id);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTypingTarget(e.target)) return;
      switch (e.key) {
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          stepCandidate(-1);
          break;
        case "ArrowRight":
        case "ArrowDown":
          e.preventDefault();
          stepCandidate(1);
          break;
        case "1":
          setMode("overlay");
          break;
        case "2":
          setMode("sxs");
          break;
        case "3":
          setMode("diff");
          break;
        case "4":
          setMode("specimen");
          break;
        case "5":
          setMode("candidate");
          break;
        case "f":
        case "F":
          onFlipH();
          break;
        case "g":
        case "G":
          onFlipV();
          break;
        case "h":
        case "H":
          onRotateCw();
          break;
        case "j":
        case "J":
          if (canAutoAlign) doAutoAlign();
          break;
        case "y":
        case "Y":
          doMerge();
          break;
        case "n":
        case "N":
          if (candidateProposal) doDismiss(candidateProposal);
          break;
        // Die scale against the other die's pixels (Shift: coarser).
        case "[":
        case "{":
          if (scaleOther) stepScale(false, e.shiftKey);
          break;
        case "]":
        case "}":
          if (scaleOther) stepScale(true, e.shiftKey);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    candidates,
    candidateCellId,
    candidateProposal,
    setCandidate,
    setMode,
    onFlipH,
    onFlipV,
    onRotateCw,
    doMerge,
    doDismiss,
    canAutoAlign,
    doAutoAlign,
    scaleOther,
    stepScale
  ]);

  const typeName = (id: string) => {
    const ct = annotations ? cellTypeById(annotations, id) : null;
    return `${ct?.name ?? "the type"}${library.foreign.has(id) ? " (other die)" : ""}`;
  };
  // Which way a type merge goes: into the type with more annotations.
  const typeMergeLabel = (() => {
    if (!typeCandidate || !specimenType) return null;
    const shapes = (t: CellType) =>
      Object.values(t.layers ?? {}).reduce((n, list) => n + (list?.length ?? 0), 0);
    const keepCandidate = shapes(typeCandidate.cellType) > shapes(specimenType);
    const [into, from] = keepCandidate
      ? [typeCandidate.cellType, specimenType]
      : [specimenType, typeCandidate.cellType];
    return `Merge ${typeName(from.id)} into ${typeName(into.id)}`;
  })();

  const baseImageName = die?.originalFilename ?? die?.name ?? "base image";

  return (
    <AppShell
      breadcrumb={die?.name ?? "Merge cells"}
      meta={specimenType ? `merge → ${specimenType.name}` : "merge cells"}
      onUndo={() => void dispatcher.undo()}
      onRedo={() => void dispatcher.redo()}
      canUndo={dispatcher.canUndo}
      canRedo={dispatcher.canRedo}
    >
      <SubBar
        right={
          <button
            className="btn"
            disabled
            title="Base image (one per die for now)"
            style={{ maxWidth: 220 }}
          >
            {Ic.image}
            <span
              className="m"
              style={{
                fontSize: 10.5,
                marginLeft: 4,
                overflow: "hidden",
                textOverflow: "ellipsis"
              }}
            >
              {baseImageName}
            </span>
            {Ic.caret}
          </button>
        }
      >
        <span
          className={"chip" + (mode === "overlay" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("overlay")}
          title="Overlay (1)"
        >
          <Kb>1</Kb> overlay
        </span>
        <span
          className={"chip" + (mode === "sxs" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("sxs")}
          title="Side-by-side (2)"
        >
          <Kb>2</Kb> side-by-side
        </span>
        <span
          className={"chip" + (mode === "diff" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("diff")}
          title="Pixel difference — black where aligned, bright where they disagree (3)"
        >
          <Kb>3</Kb> difference
        </span>
        <span
          className={"chip" + (mode === "specimen" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("specimen")}
          title="Specimen only (4)"
        >
          <Kb>4</Kb> specimen
        </span>
        <span
          className={"chip" + (mode === "candidate" ? " on" : "")}
          style={{ cursor: "pointer" }}
          onClick={() => setMode("candidate")}
          title="Candidate only (5)"
        >
          <Kb>5</Kb> candidate
        </span>
        {mode === "overlay" && (
          <>
            <span
              className="m"
              style={{ fontSize: 10.5, color: "var(--ink3)", marginLeft: 8 }}
            >
              opacity
            </span>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(opacity * 100)}
              onChange={(e) => setOpacity(Number(e.target.value) / 100)}
              style={{ width: 120 }}
            />
            <span className="m" style={{ fontSize: 10.5, color: "var(--ink2)", width: 30 }}>
              {Math.round(opacity * 100)}%
            </span>
          </>
        )}
        <ToolDivider />
        <label className="check">
          <input
            type="checkbox"
            checked={showAnno}
            onChange={(e) => setShowAnno(e.target.checked)}
          />
          Cell annotations
        </label>
        <label
          className="check"
          title="Overlay ML-detected vias on each cell — helps eyeball the alignment"
        >
          <input
            type="checkbox"
            checked={showMlVias}
            onChange={(e) => setShowMlVias(e.target.checked)}
          />
          ML vias
          {showMlVias &&
            (specimenViasQ.isFetching || candidateViasQ.isFetching) && (
              <span style={{ marginLeft: 4, fontSize: 10, color: "var(--ink3)" }}>
                …
              </span>
            )}
          {showMlVias &&
            (specimenViasQ.isError || candidateViasQ.isError) && (
              <span
                style={{ marginLeft: 4, fontSize: 10, color: "var(--err)" }}
                title={
                  (specimenViasQ.error ?? candidateViasQ.error)?.message ??
                  "ML service unavailable"
                }
              >
                ⚠
              </span>
            )}
        </label>
      </SubBar>

      <main
        style={{
          flex: "1 1 auto",
          minHeight: 0,
          display: "flex"
        }}
      >
        {annotations ? (
          <MergeLeftPanel
            die={die ?? null}
            annotations={annotations}
            proposals={proposals}
            memberScores={memberScores}
            foreignTypes={library.foreign}
            candidates={candidates}
            onCandidateContextMenu={openCandidateMenu}
          />
        ) : (
          <div style={{ width: 248, flex: "0 0 auto", background: "var(--card)" }} />
        )}

        <div className="col" style={{ flex: "1 1 auto", minWidth: 0, minHeight: 0 }}>
          <MergeCanvas
            ref={canvasRef}
            mode={mode}
            opacity={opacity}
            showAnno={showAnno}
            showMlVias={showMlVias}
            specimen={specimenView}
            candidate={candidateView}
            die={die ?? null}
            onAlign={onAlign}
            onAlignCanonical={onAlignCanonical}
            onScaleCandidate={onScaleCandidate}
          />
          <Filmstrip
            die={die ?? null}
            candidates={candidates}
            selectedId={candidateCellId}
            onPick={(c) => setCandidate(c.id)}
            onContextMenu={openCandidateMenu}
            foreignTypes={library.foreign}
          />
          <MergeBottomBar
            hasCandidate={!!candidateView}
            specimenName={specimenType?.name ?? null}
            onFlipH={onFlipH}
            onFlipV={onFlipV}
            onRotateCw={onRotateCw}
            onAutoAlign={canAutoAlign ? doAutoAlign : null}
            onSkip={onSkip}
            onMerge={doMerge}
            candidateIsProposal={!!candidateProposal}
            onDismiss={candidateProposal ? () => doDismiss(candidateProposal) : null}
            typeMergeLabel={typeMergeLabel}
            scale={scaleControl}
          />
        </div>
      </main>

      <StatusBar
        items={[
          die?.name ?? dieId,
          mode === "overlay"
            ? `overlay · ${Math.round(opacity * 100)}%`
            : mode === "diff"
              ? "difference"
              : mode === "specimen"
                ? "specimen only"
                : mode === "candidate"
                  ? "candidate only"
                  : "side-by-side",
          specimenType ? `specimen ${specimenType.name}` : "no specimen",
          typeCandidate
            ? `type ${typeCandidate.cellType.name}${library.foreign.has(typeCandidate.cellType.id) ? " (other die)" : ""}`
            : candidateProposal
            ? `ML proposal · ${candidateProposal.detection.score.toFixed(2)}`
            : candidateCell
              ? `candidate ${candidateCell.id.slice(0, 6)}`
              : "no candidate",
          scalePending && scaleControl
            ? `scale ×${scaleControl.ratio.toFixed(4)} vs ${scaleControl.otherName} · not set yet`
            : null
        ].filter(Boolean)}
      />

      {menu && (
        <MergeContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onUnmatch={() => {
            const c = annotations ? cellById(annotations, menu.cellId) : null;
            if (c) doUnmatch(c);
          }}
          onDismiss={() => {
            if (menu.proposal) doDismiss(menu.proposal);
          }}
          onJumpToDie={() => {
            const c =
              candidates.find((x) => x.cell.id === menu.cellId)?.cell ??
              (annotations ? cellById(annotations, menu.cellId) : null);
            if (c) jumpToDie(c);
          }}
        />
      )}

      {confirmTypeMerge && (
        <ConfirmDialog
          title="Merging drops annotations"
          body={`Both types carry layer annotations. The merged type keeps ${typeName(
            confirmTypeMerge.survivorId
          )}'s ${confirmTypeMerge.survivorShapes} shape(s); ${typeName(confirmTypeMerge.loserId)}'s ${
            confirmTypeMerge.loserShapes
          } go. ${confirmTypeMerge.moved} instance(s) change type. Continue?`}
          confirmLabel="Merge anyway"
          onCancel={() => setConfirmTypeMerge(null)}
          onConfirm={() => runTypeMerge(confirmTypeMerge)}
        />
      )}

      {confirmMerge && (
        <ConfirmDialog
          title="Merge will drop annotations"
          body={`The candidate's current type carries layer annotations that ${
            specimenType?.name ?? "the target"
          } doesn't. Merging detaches them. Continue?`}
          confirmLabel="Merge anyway"
          onCancel={() => setConfirmMerge(false)}
          onConfirm={doMerge}
        />
      )}
    </AppShell>
  );
}

/** A placement's die footprint as the `[x0, y0, x1, y1]` box the via query
 *  takes (a 90° turn swaps its extent). */
function footprintBbox(cell: Cell, cellType: CellType): DieViasBbox {
  const fp = cellFootprint(cell, cellType);
  return [fp.x, fp.y, fp.x + fp.width, fp.y + fp.height];
}

/** Tiny inline keyboard-shortcut hint shown inside a chip/button. */
function Kb({ children }: { children: React.ReactNode }) {
  return (
    <kbd
      style={{
        display: "inline-block",
        minWidth: 12,
        padding: "0 3px",
        marginRight: 2,
        borderRadius: 3,
        border: "1px solid var(--l2)",
        background: "var(--panel)",
        font: "inherit",
        fontSize: 9,
        lineHeight: "13px",
        textAlign: "center",
        color: "var(--ink3)"
      }}
    >
      {children}
    </kbd>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="m"
      style={{
        flex: "1 1 auto",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--ink3)",
        fontSize: 12
      }}
    >
      {children}
    </div>
  );
}

function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onCancel,
  onConfirm
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1100,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}
      onClick={onCancel}
    >
      <div
        className="popover"
        style={{ width: 360, padding: 16 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", marginBottom: 8 }}>
          {title}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--ink2)", lineHeight: 1.5, marginBottom: 14 }}>
          {body}
        </div>
        <div className="row" style={{ justifyContent: "flex-end", gap: 8 }}>
          <button className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button className="btn accent" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
