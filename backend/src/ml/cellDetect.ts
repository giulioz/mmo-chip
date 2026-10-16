import type { Cell, CellDetection, CellType } from "shared";

/**
 * Cell detection by via-constellation matching.
 *
 * Given the ML-detected vias of a whole die and one annotated cell type (with
 * its placed member cells), find every other place on the die where the same
 * via pattern occurs. Pure functions — the job manager feeds them data and
 * persists what comes out.
 *
 * Pipeline:
 *   1. `buildTemplate` — pool every member's vias into the type's canonical
 *      frame (undoing each member's flip/rotation), cluster them, and keep
 *      the clusters most members agree on. That averages out single-member
 *      ML misses / false positives.
 *   2. `detectCells` — for each of the 8 dihedral orientations, Hough-vote
 *      the translation `dieVia − orientedTemplateVia` for every pair into a
 *      coarse histogram (same trick as the merge-cells auto-align, but over
 *      the whole die). The vote count in a bin is exactly "how many template
 *      vias line up at that placement", so peaks are candidate placements.
 *      Each peak is then refined (sub-bin centroid from nearest-neighbour
 *      matches) and scored with an F1 between matched template vias and
 *      unexplained die vias inside the footprint. Candidates overlapping an
 *      existing placed cell are dropped, and non-maximum suppression keeps
 *      one proposal per physical location.
 *
 * Orientation convention mirrors the frontend (`applyOrientation` in
 * lib/geometry.ts and the die-viewer cell renderer): a canonical point `p`
 * of an instance at (cell.x, cell.y) lands on the die at
 * `(cell.x, cell.y) + orient(p)`, where `orient` mirrors first (about the
 * box centre) and then rotates by `rotation` (canvas convention: math-CCW,
 * visually CW under y-down).
 */

export interface Point {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

export interface Orient {
  flippedH: boolean;
  flippedV: boolean;
  rotation: Rotation;
}

/** The 8 unique orientations of the dihedral group D4. `flippedV` is
 *  always false here — it equals `flippedH + rotation 180`, so enumerating
 *  it too would double-count solutions. */
export const ORIENTATIONS: readonly Orient[] = [
  { flippedH: false, flippedV: false, rotation: 0 },
  { flippedH: false, flippedV: false, rotation: 90 },
  { flippedH: false, flippedV: false, rotation: 180 },
  { flippedH: false, flippedV: false, rotation: 270 },
  { flippedH: true, flippedV: false, rotation: 0 },
  { flippedH: true, flippedV: false, rotation: 90 },
  { flippedH: true, flippedV: false, rotation: 180 },
  { flippedH: true, flippedV: false, rotation: 270 },
];

/**
 * The orientations to search given the flip options. The four proper
 * rotations are always in; the four reflections split by which cell axis
 * they mirror: `{flippedH, 0}` and `{flippedH, 90}` are a horizontal mirror
 * (± a rotation) → "flipped X"; `{flippedH, 180}` ≡ vertical mirror and
 * `{flippedH, 270}` its rotation → "flipped Y".
 */
export function orientationsFor(opts: {
  allowFlipX?: boolean;
  allowFlipY?: boolean;
}): Orient[] {
  const flipX = opts.allowFlipX !== false;
  const flipY = opts.allowFlipY !== false;
  return ORIENTATIONS.filter((o) => {
    if (!o.flippedH) return true;
    return o.rotation === 0 || o.rotation === 90 ? flipX : flipY;
  });
}

export function orientOf(
  cell: Pick<Cell, "flippedH" | "flippedV" | "rotation">,
): Orient {
  return {
    flippedH: cell.flippedH === true,
    flippedV: cell.flippedV === true,
    rotation: (cell.rotation ?? 0) as Rotation,
  };
}

/** Canonical cell-local → oriented cell-local (relative to the instance's
 *  top-left origin). Flip about the centre, then rotate. */
export function applyOrient(p: Point, o: Orient, W: number, H: number): Point {
  let qx = p.x - W / 2;
  let qy = p.y - H / 2;
  if (o.flippedH) qx = -qx;
  if (o.flippedV) qy = -qy;
  let rx = qx;
  let ry = qy;
  switch (o.rotation) {
    case 90:
      rx = -qy;
      ry = qx;
      break;
    case 180:
      rx = -qx;
      ry = -qy;
      break;
    case 270:
      rx = qy;
      ry = -qx;
      break;
  }
  return { x: rx + W / 2, y: ry + H / 2 };
}

/** Inverse of `applyOrient`: un-rotate, then un-flip. */
export function toCanonical(p: Point, o: Orient, W: number, H: number): Point {
  const rx = p.x - W / 2;
  const ry = p.y - H / 2;
  let qx = rx;
  let qy = ry;
  switch (o.rotation) {
    case 90:
      qx = ry;
      qy = -rx;
      break;
    case 180:
      qx = -rx;
      qy = -ry;
      break;
    case 270:
      qx = -ry;
      qy = rx;
      break;
  }
  if (o.flippedH) qx = -qx;
  if (o.flippedV) qy = -qy;
  return { x: qx + W / 2, y: qy + H / 2 };
}

export interface RectBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Axis-aligned die footprint of a W×H box placed at (x, y) with orientation
 *  `o`. A rotated rectangle is still a rectangle, so the corner bbox is
 *  exact (90°/270° swap the extents about the centre). */
export function footprint(
  x: number,
  y: number,
  o: Orient,
  W: number,
  H: number,
): RectBox {
  const corners = [
    { x: 0, y: 0 },
    { x: W, y: 0 },
    { x: W, y: H },
    { x: 0, y: H },
  ].map((c) => applyOrient(c, o, W, H));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of corners) {
    if (c.x < x0) x0 = c.x;
    if (c.y < y0) y0 = c.y;
    if (c.x > x1) x1 = c.x;
    if (c.y > y1) y1 = c.y;
  }
  return { x0: x + x0, y0: y + y0, x1: x + x1, y1: y + y1 };
}

function intersectionArea(a: RectBox, b: RectBox): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return w > 0 && h > 0 ? w * h : 0;
}

function area(r: RectBox): number {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

// ── Spatial index over the die's vias ─────────────────────────────────

/** Uniform-grid index over a flat via list. Built once per run; every
 *  neighbourhood query (template refinement, footprint counts) goes through
 *  it so scoring stays O(candidates × template) instead of O(candidates ×
 *  dieVias). */
export class ViaIndex {
  readonly xs: Float64Array;
  readonly ys: Float64Array;
  readonly scores: Float64Array;
  readonly size: number;
  private readonly cellSize: number;
  private readonly grid = new Map<number, number[]>();

  constructor(
    vias: ReadonlyArray<{ x: number; y: number; score: number }>,
    cellSize = 32,
  ) {
    this.size = vias.length;
    this.xs = new Float64Array(vias.length);
    this.ys = new Float64Array(vias.length);
    this.scores = new Float64Array(vias.length);
    this.cellSize = cellSize;
    for (let i = 0; i < vias.length; i++) {
      const v = vias[i];
      this.xs[i] = v.x;
      this.ys[i] = v.y;
      this.scores[i] = v.score;
      const key = this.key(
        Math.floor(v.x / cellSize),
        Math.floor(v.y / cellSize),
      );
      const bucket = this.grid.get(key);
      if (bucket) bucket.push(i);
      else this.grid.set(key, [i]);
    }
  }

  private key(gx: number, gy: number): number {
    // Die coords are non-negative; +1 keeps gx = -1 (edge tolerance) valid.
    return (gx + 1) * 1_048_576 + (gy + 1);
  }

  /** Indices of vias whose centre lies inside the closed box. */
  inBox(box: RectBox): number[] {
    const out: number[] = [];
    const gx0 = Math.floor(box.x0 / this.cellSize);
    const gy0 = Math.floor(box.y0 / this.cellSize);
    const gx1 = Math.floor(box.x1 / this.cellSize);
    const gy1 = Math.floor(box.y1 / this.cellSize);
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const bucket = this.grid.get(this.key(gx, gy));
        if (!bucket) continue;
        for (const i of bucket) {
          const x = this.xs[i];
          const y = this.ys[i];
          if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1)
            out.push(i);
        }
      }
    }
    return out;
  }

  /** Nearest via within `tol` of (x, y), or -1. */
  nearest(x: number, y: number, tol: number): number {
    const gx0 = Math.floor((x - tol) / this.cellSize);
    const gy0 = Math.floor((y - tol) / this.cellSize);
    const gx1 = Math.floor((x + tol) / this.cellSize);
    const gy1 = Math.floor((y + tol) / this.cellSize);
    let best = -1;
    let bestD2 = tol * tol;
    for (let gx = gx0; gx <= gx1; gx++) {
      for (let gy = gy0; gy <= gy1; gy++) {
        const bucket = this.grid.get(this.key(gx, gy));
        if (!bucket) continue;
        for (const i of bucket) {
          const dx = this.xs[i] - x;
          const dy = this.ys[i] - y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = i;
          }
        }
      }
    }
    return best;
  }
}

// ── Template ──────────────────────────────────────────────────────────

export interface TemplateVia {
  /** Canonical-frame position. */
  x: number;
  y: number;
  /** Fraction of members that had a via here (0..1]. */
  weight: number;
}

export interface TemplateOptions {
  /** Cluster radius (px) when pooling member vias. */
  tolerance?: number;
  /** Keep clusters seen in at least this fraction of members. */
  minSupport?: number;
}

/**
 * Pool the die vias inside every member's footprint into the type's canonical
 * frame and keep the consensus positions. A single member yields its vias
 * verbatim (weight 1).
 */
export function buildTemplate(
  members: ReadonlyArray<Cell>,
  cellType: Pick<CellType, "cropRect">,
  index: ViaIndex,
  options: TemplateOptions = {},
): TemplateVia[] {
  return buildPooledTemplate([{ members, cellType, index, scale: 1 }], options);
}

/** Members on one die for `buildPooledTemplate`: the type as it sits there,
 *  that die's vias, and `scale` = target pixels per that die's pixel. */
export interface TemplateSource {
  members: ReadonlyArray<Cell>;
  cellType: Pick<CellType, "cropRect">;
  index: ViaIndex;
  scale: number;
}

/**
 * `buildTemplate` over instances on several dies (a type shared through the
 * cell library): each member's vias are taken to the canonical frame in its
 * own die's pixels, scaled to the target die's, and clustered together —
 * support counts every member, whichever die it's on. Via positions don't
 * depend on a photo's exposure, so pooling them is safe.
 */
export function buildPooledTemplate(
  sources: ReadonlyArray<TemplateSource>,
  options: TemplateOptions = {},
): TemplateVia[] {
  const tol = options.tolerance ?? 4;
  const minSupport = options.minSupport ?? 0.5;
  const total = sources.reduce((n, s) => n + s.members.length, 0);
  if (total === 0) return [];

  interface Cluster {
    sumX: number;
    sumY: number;
    n: number;
    members: Set<number>;
  }
  const clusters: Cluster[] = [];
  let mi = 0;
  for (const src of sources) {
    const W = src.cellType.cropRect.width;
    const H = src.cellType.cropRect.height;
    if (W <= 0 || H <= 0) {
      mi += src.members.length;
      continue;
    }
    for (const m of src.members) {
      const o = orientOf(m);
      const box = footprint(m.x, m.y, o, W, H);
      for (const i of src.index.inBox(box)) {
        const local = { x: src.index.xs[i] - m.x, y: src.index.ys[i] - m.y };
        const q = toCanonical(local, o, W, H);
        if (q.x < 0 || q.x > W || q.y < 0 || q.y > H) continue;
        const c = { x: q.x * src.scale, y: q.y * src.scale };
        let best: Cluster | null = null;
        let bestD2 = tol * tol;
        for (const cl of clusters) {
          const dx = cl.sumX / cl.n - c.x;
          const dy = cl.sumY / cl.n - c.y;
          const d2 = dx * dx + dy * dy;
          if (d2 <= bestD2) {
            bestD2 = d2;
            best = cl;
          }
        }
        if (best) {
          best.sumX += c.x;
          best.sumY += c.y;
          best.n += 1;
          best.members.add(mi);
        } else {
          clusters.push({ sumX: c.x, sumY: c.y, n: 1, members: new Set([mi]) });
        }
      }
      mi += 1;
    }
  }

  const need = Math.max(1, Math.ceil(minSupport * total));
  const out: TemplateVia[] = [];
  for (const cl of clusters) {
    if (cl.members.size < need) continue;
    out.push({
      x: cl.sumX / cl.n,
      y: cl.sumY / cl.n,
      weight: cl.members.size / total,
    });
  }
  return out;
}

// ── Detection ─────────────────────────────────────────────────────────

export interface DetectOptions {
  /** Hough histogram bin size (px). Grown automatically when the die is so
   *  large that the dense vote grid would exceed `MAX_VOTE_BINS`. */
  binSize?: number;
  /** Die extent (px). Sizes the vote grid; derived from the vias if absent. */
  dieWidth?: number;
  dieHeight?: number;
  /** Nearest-neighbour tolerance (px) when matching template vias. */
  tolerance?: number;
  /** Minimum weighted vote count for a bin to become a candidate. Defaults
   *  to max(2, 40% of the template). */
  minVotes?: number;
  /** Drop candidates scoring below this (0..1). */
  minScore?: number;
  /** Footprints overlapping an existing cell by more than this fraction of
   *  their own area are dropped. */
  maxExistingOverlap?: number;
  /** NMS: a candidate overlapping an accepted (higher-scoring) one by more
   *  than this fraction of the smaller footprint is dropped. */
  nmsIou?: number;
  /** Die vias processed per event-loop yield during voting. */
  chunk?: number;
  /** Mirrored placements to search (see `orientationsFor`). Default both. */
  allowFlipX?: boolean;
  allowFlipY?: boolean;
}

export interface DetectHooks {
  /** Fired at phase boundaries and periodically inside voting. */
  onProgress?: (phase: string, fraction: number) => void;
  /** Return true to abort; `detectCells` then resolves with what it has. */
  shouldCancel?: () => boolean;
}

/** Footprint rectangles of already-placed cells (any type). */
/** Overlap fraction (of the candidate's own area) above which a placed cell
 *  blocks a candidate — when avoiding existing cells of any type, and the
 *  stricter "near-duplicate" bar used against the type's own members when
 *  overlaps are otherwise allowed. */
export const EXISTING_OVERLAP_ANY = 0.3;
export const EXISTING_OVERLAP_SAME_TYPE = 0.6;

export function existingFootprints(
  cells: ReadonlyArray<Cell>,
  cellTypes: ReadonlyArray<CellType>,
): RectBox[] {
  const byId = new Map(cellTypes.map((ct) => [ct.id, ct]));
  const out: RectBox[] = [];
  for (const c of cells) {
    const ct = byId.get(c.cellTypeId);
    if (!ct) continue;
    out.push(
      footprint(c.x, c.y, orientOf(c), ct.cropRect.width, ct.cropRect.height),
    );
  }
  return out;
}

export type DetectionCandidate = Omit<CellDetection, "id" | "cellTypeId">;

export interface PlacementScore {
  score: number;
  matched: number;
  extra: number;
}

/**
 * F1 between the oriented template and the die vias under a placement: each
 * template via claims its nearest unclaimed die via within `tol` (weighted by
 * template support), and every other die via inside the footprint counts
 * against precision (weighted by its ML confidence).
 */
function scoreOriented(
  oriented: ReadonlyArray<{ x: number; y: number; weight: number }>,
  templateWeight: number,
  index: ViaIndex,
  X: number,
  Y: number,
  box: RectBox,
  tol: number
): PlacementScore {
  const matchedIdx = new Set<number>();
  let matchedW = 0;
  let matchedN = 0;
  for (const t of oriented) {
    const j = index.nearest(X + t.x, Y + t.y, tol);
    if (j < 0 || matchedIdx.has(j)) continue;
    matchedIdx.add(j);
    matchedW += t.weight;
    matchedN += 1;
  }
  let extraW = 0;
  let extraN = 0;
  for (const j of index.inBox(box)) {
    if (matchedIdx.has(j)) continue;
    extraW += index.scores[j];
    extraN += 1;
  }
  const precision = matchedW > 0 ? matchedW / (matchedW + extraW) : 0;
  const recall = templateWeight > 0 ? matchedW / templateWeight : 0;
  const score =
    precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { score: Math.round(score * 1000) / 1000, matched: matchedN, extra: extraN };
}

/** Score an existing placement (e.g. one of the type's own members) against
 *  the template, at exactly its stored position and orientation. */
export function scorePlacement(
  template: ReadonlyArray<TemplateVia>,
  cellType: Pick<CellType, "cropRect">,
  index: ViaIndex,
  cell: Pick<Cell, "x" | "y" | "flippedH" | "flippedV" | "rotation">,
  tolerance = 4
): PlacementScore {
  const W = cellType.cropRect.width;
  const H = cellType.cropRect.height;
  const o = orientOf(cell);
  const oriented = template.map((t) => ({ ...applyOrient(t, o, W, H), weight: t.weight }));
  const templateWeight = template.reduce((s, t) => s + t.weight, 0);
  return scoreOriented(
    oriented,
    templateWeight,
    index,
    cell.x,
    cell.y,
    footprint(cell.x, cell.y, o, W, H),
    tolerance
  );
}

const yieldToLoop = () => new Promise<void>((r) => setImmediate(r));

/** Upper bound on the dense vote grid (bins). 16M × Uint32 = 64 MB; the
 *  bin size grows past `binSize` on dies that would need more. */
const MAX_VOTE_BINS = 16 * 1024 * 1024;
/** Template vias used for the Hough vote. Voting cost is |die vias| × this
 *  × 8, so a big cell with hundreds of vias is located with a spread-out
 *  subset and then *scored* against the full template. */
const MAX_VOTE_VIAS = 64;
/** Vote weights (0..1] are accumulated as integers at this resolution. */
const WEIGHT_Q = 64;

/** Pick up to `n` template vias spread across the cell (stride over the
 *  vias sorted by position) so the vote subset still pins the placement. */
function voteSubset(
  template: ReadonlyArray<TemplateVia>,
  n: number,
): TemplateVia[] {
  if (template.length <= n) return [...template];
  const sorted = [...template].sort((a, b) => a.x - b.x || a.y - b.y);
  const out: TemplateVia[] = [];
  for (let i = 0; i < n; i++)
    out.push(sorted[Math.floor((i * sorted.length) / n)]);
  return out;
}

/**
 * Find placements of `template` across `index`. Resolves to scored, NMS'd
 * candidates sorted by descending score. Async only so the voting loop can
 * yield to the event loop between chunks (the job runs in-process next to
 * the HTTP server).
 */
export async function detectCells(
  template: ReadonlyArray<TemplateVia>,
  cellType: Pick<CellType, "cropRect">,
  index: ViaIndex,
  existing: ReadonlyArray<RectBox>,
  options: DetectOptions = {},
  hooks: DetectHooks = {},
): Promise<DetectionCandidate[]> {
  const W = cellType.cropRect.width;
  const H = cellType.cropRect.height;
  const tol = options.tolerance ?? 4;
  const minScore = options.minScore ?? 0.2;
  const maxExistingOverlap = options.maxExistingOverlap ?? EXISTING_OVERLAP_ANY;
  const nmsIou = options.nmsIou ?? 0.5;
  const chunk = options.chunk ?? 20_000;
  const templateWeight = template.reduce((s, t) => s + t.weight, 0);
  const progress = hooks.onProgress ?? (() => {});
  const cancelled = () => hooks.shouldCancel?.() === true;

  if (template.length < 2 || index.size === 0 || W <= 0 || H <= 0) return [];

  // ── Vote grid geometry ─────────────────────────────────────────────
  // Translations run from −(oriented extent) to the die edge on each axis.
  let dieW = options.dieWidth ?? 0;
  let dieH = options.dieHeight ?? 0;
  if (!dieW || !dieH) {
    for (let i = 0; i < index.size; i++) {
      if (index.xs[i] > dieW) dieW = index.xs[i];
      if (index.ys[i] > dieH) dieH = index.ys[i];
    }
  }
  const ext = Math.max(W, H);
  const spanX = dieW + ext + 1;
  const spanY = dieH + ext + 1;
  const binSize = Math.max(
    options.binSize ?? 4,
    Math.ceil(Math.sqrt((spanX * spanY) / MAX_VOTE_BINS)),
  );
  const offX = Math.ceil(ext / binSize) + 1;
  const offY = offX;
  const cols = Math.ceil(spanX / binSize) + offX + 2;
  const rows = Math.ceil(spanY / binSize) + offY + 2;
  const votes = new Uint32Array(cols * rows);

  const voteTemplate = voteSubset(template, MAX_VOTE_VIAS);
  const minVotes =
    options.minVotes ?? Math.max(2, Math.ceil(0.4 * voteTemplate.length));
  const minVotesQ = Math.round(minVotes * WEIGHT_Q);
  /** Matched template vias a candidate needs to survive scoring. */
  const minMatched = Math.max(2, Math.ceil(0.4 * template.length));

  interface Raw {
    x: number;
    y: number;
    oi: number;
    score: number;
    matched: number;
    extra: number;
    box: RectBox;
  }
  const raw: Raw[] = [];
  const orientations = orientationsFor(options);
  const nOrient = orientations.length;

  for (let oi = 0; oi < nOrient; oi++) {
    const o = orientations[oi];
    const oriented = template.map((t) => ({
      ...applyOrient(t, o, W, H),
      weight: t.weight,
    }));
    const orientedVote = voteTemplate.map((t) => ({
      ...applyOrient(t, o, W, H),
      wq: Math.max(1, Math.round(t.weight * WEIGHT_Q)),
    }));

    // ── Vote ──────────────────────────────────────────────────────
    votes.fill(0);
    for (let start = 0; start < index.size; start += chunk) {
      if (cancelled()) return [];
      const end = Math.min(index.size, start + chunk);
      for (let i = start; i < end; i++) {
        const vx = index.xs[i];
        const vy = index.ys[i];
        for (const t of orientedVote) {
          // Splat each vote into the 2×2 bins around its translation, so
          // bin k effectively covers [(k−1)·bin, (k+1)·bin): windows twice
          // the bin wide, overlapping by half. Via positions jitter by a
          // couple of px, and with plain rounding a placement whose true
          // offset sits near a bin corner had its votes split four ways —
          // each bin under the vote floor, so the placement was never
          // proposed. With overlapping windows some bin always holds them
          // all (jitter ≪ bin), and it's the one centred nearest the truth.
          const bx = Math.floor((vx - t.x) / binSize) + offX;
          const by = Math.floor((vy - t.y) / binSize) + offY;
          if (bx < 0 || by < 0 || bx + 1 >= cols || by + 1 >= rows) continue;
          const at = by * cols + bx;
          votes[at] += t.wq;
          votes[at + 1] += t.wq;
          votes[at + cols] += t.wq;
          votes[at + cols + 1] += t.wq;
        }
      }
      progress("matching", (oi + end / index.size) / nOrient);
      await yieldToLoop();
    }

    // ── Peaks: bins at/above the vote floor that dominate their 3×3 ──
    for (let by = 1; by < rows - 1; by++) {
      if ((by & 255) === 0) {
        if (cancelled()) return [];
        await yieldToLoop();
      }
      for (let bx = 1; bx < cols - 1; bx++) {
        const count = votes[by * cols + bx];
        if (count < minVotesQ) continue;
        let isPeak = true;
        for (let ny = by - 1; ny <= by + 1 && isPeak; ny++) {
          for (let nx = bx - 1; nx <= bx + 1; nx++) {
            if (nx === bx && ny === by) continue;
            const other = votes[ny * cols + nx];
            // Strict on earlier neighbours so an exact tie yields one peak.
            if (
              other > count ||
              (other === count && (ny < by || (ny === by && nx < bx)))
            ) {
              isPeak = false;
              break;
            }
          }
        }
        if (!isPeak) continue;

        // ── Refine: nearest-neighbour centroid, then rescore ─────────
        let X = (bx - offX) * binSize;
        let Y = (by - offY) * binSize;
        for (let pass = 0; pass < 2; pass++) {
          let sx = 0;
          let sy = 0;
          let n = 0;
          const searchTol = pass === 0 ? binSize * 1.5 : tol;
          for (const t of oriented) {
            const j = index.nearest(X + t.x, Y + t.y, searchTol);
            if (j < 0) continue;
            sx += index.xs[j] - (X + t.x);
            sy += index.ys[j] - (Y + t.y);
            n += 1;
          }
          if (n === 0) break;
          X += sx / n;
          Y += sy / n;
        }

        // ── Score ────────────────────────────────────────────────────
        const box = footprint(X, Y, o, W, H);
        const {
          score,
          matched: matchedN,
          extra: extraN
        } = scoreOriented(oriented, templateWeight, index, X, Y, box, tol);
        if (matchedN < minMatched) continue;
        if (score < minScore) continue;

        // ── Existing cells ───────────────────────────────────────────
        const own = area(box);
        let clash = false;
        for (const e of existing) {
          if (intersectionArea(box, e) > maxExistingOverlap * own) {
            clash = true;
            break;
          }
        }
        if (clash) continue;

        raw.push({
          x: Math.round(X),
          y: Math.round(Y),
          oi,
          score,
          matched: matchedN,
          extra: extraN,
          box,
        });
      }
    }
    progress("scoring", (oi + 1) / nOrient);
    await yieldToLoop();
  }

  // ── Non-maximum suppression ──────────────────────────────────────
  raw.sort((a, b) => b.score - a.score || a.oi - b.oi);
  const accepted: Raw[] = [];
  for (const r of raw) {
    const own = area(r.box);
    let dup = false;
    for (const a of accepted) {
      const inter = intersectionArea(r.box, a.box);
      if (inter === 0) continue;
      // Overlap relative to the *smaller* footprint, not IoU: two proposals
      // of one type can't both be real if one covers more than half of the
      // other. IoU under-counts that when the weaker candidate is a 90°
      // rotation (different box shape) or a via-pitch-shifted alignment of
      // the same physical cell.
      const overlap = inter / Math.min(own, area(a.box));
      if (overlap > nmsIou) {
        dup = true;
        break;
      }
    }
    if (!dup) accepted.push(r);
  }

  return accepted.map((r) => {
    const o = orientations[r.oi];
    const out: DetectionCandidate = {
      x: r.x,
      y: r.y,
      score: r.score,
      matched: r.matched,
      extra: r.extra,
    };
    if (o.flippedH) out.flippedH = true;
    if (o.flippedV) out.flippedV = true;
    if (o.rotation !== 0) out.rotation = o.rotation;
    return out;
  });
}
