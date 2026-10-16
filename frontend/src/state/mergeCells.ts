import { create } from "zustand";
import type { ProposalOverride } from "../lib/cellDetection";

/**
 * Transient per-session UI state for the Merge cells page. Selections only —
 * the actual cell/cell-type mutations go through the shared action dispatcher
 * (so undo/redo is unified with the rest of the app). Not persisted: the ids
 * are die-specific and the workflow is ephemeral.
 */
interface MergeState {
  /** The cell type the candidate is being matched into ("specimen"). */
  specimenTypeId: string | null;
  /** Which member cell of the specimen type is shown as the reference. Null
   *  ⇒ use the type's first member (or its crop template). */
  specimenCellId: string | null;
  /** The candidate cell currently loaded in the canvas. */
  candidateCellId: string | null;
  /** Matched cell types expanded to reveal their member cells. */
  expandedTypes: string[];
  /** The "Unmatched" folder open in the left panel. */
  unmatchedOpen: boolean;
  /** The "ML" folder (cell-detection proposals grouped by type) open. */
  mlOpen: boolean;
  /** Unsaved flip / rotate / drag-align tweaks per proposal (keyed by
   *  detection id). Proposals aren't persisted cells, so orientation edits
   *  stay here until the proposal is approved into a real cell. */
  proposalOverrides: Record<string, ProposalOverride>;
}

interface MergeActions {
  setSpecimen: (typeId: string | null, cellId?: string | null) => void;
  setSpecimenCell: (cellId: string | null) => void;
  setCandidate: (cellId: string | null) => void;
  toggleType: (id: string) => void;
  setUnmatchedOpen: (open: boolean) => void;
  setMlOpen: (open: boolean) => void;
  patchProposalOverride: (detectionId: string, patch: ProposalOverride) => void;
  clearProposalOverride: (detectionId: string) => void;
  reset: () => void;
}

const INITIAL: MergeState = {
  specimenTypeId: null,
  specimenCellId: null,
  candidateCellId: null,
  expandedTypes: [],
  unmatchedOpen: true,
  mlOpen: false,
  proposalOverrides: {}
};

export const useMergeStore = create<MergeState & MergeActions>()((set, get) => ({
  ...INITIAL,

  setSpecimen: (typeId, cellId = null) =>
    set({ specimenTypeId: typeId, specimenCellId: cellId }),
  setSpecimenCell: (cellId) => set({ specimenCellId: cellId }),
  setCandidate: (cellId) => set({ candidateCellId: cellId }),
  toggleType: (id) =>
    set((s) => ({
      expandedTypes: s.expandedTypes.includes(id)
        ? s.expandedTypes.filter((t) => t !== id)
        : [...s.expandedTypes, id]
    })),
  setUnmatchedOpen: (open) => set({ unmatchedOpen: open }),
  setMlOpen: (open) => set({ mlOpen: open }),
  patchProposalOverride: (detectionId, patch) =>
    set((s) => ({
      proposalOverrides: {
        ...s.proposalOverrides,
        [detectionId]: { ...s.proposalOverrides[detectionId], ...patch }
      }
    })),
  clearProposalOverride: (detectionId) =>
    set((s) => {
      if (!(detectionId in s.proposalOverrides)) return s;
      const { [detectionId]: _, ...rest } = s.proposalOverrides;
      return { proposalOverrides: rest };
    }),
  reset: () => {
    // Keep folder open-state; only clear selections.
    const { unmatchedOpen, mlOpen, expandedTypes } = get();
    set({ ...INITIAL, unmatchedOpen, mlOpen, expandedTypes });
  }
}));
