/**
 * Fold diff — what a compile actually changed in the frontier, and where.
 *
 * `[plan-vs-actual]` reports how many chunks moved; it does not say which
 * levels they moved between or where in the rendered prefix the first change
 * landed. Both questions decide the provider bill for the turn (everything
 * after the earliest layout divergence is re-read at full price) and the
 * operator has had no way to answer them short of replaying the store.
 * Observed on Fable (2026-10-06): 24 of 51 large requests in a week read
 * exactly the system+tools prefix and re-wrote ~450k tokens, with nothing in
 * the logs saying which band had rotated.
 *
 * `describeFoldDiff` is pure: it compares a carried frontier against the one
 * the solver just produced, groups the changed chunks into contiguous runs in
 * source order by (from → to) level, prices each run's position by the
 * previous layout's cumulative offset, and reports the earliest divergence in
 * the same unit model `kvCost` uses. `formatFoldDiff` renders one log line.
 *
 * Levels are EFFECTIVE levels — the level `renderLayout` renders a chunk at:
 * a pinned chunk is raw whatever level it carries, and a level whose ancestor
 * summary is missing renders raw. Locked chunks are skipped, as the
 * strategy's commit loop skips them (their carried level never changes).
 * Counting stored levels instead let a line report a move together with
 * "layout unchanged" (a pinned chunk carried at L1 that the solver puts at 0
 * renders raw on both sides; PR #157 review).
 */

import type { ChunkId } from './folding-strategy.js';
import type { PickerInputs, PickerChunk } from './picker.js';
import type { SummaryTree } from './summary-tree.js';
import {
  renderLayout,
  earliestDivergenceIndex,
  type Frontier,
  type RenderLayout,
} from './render-offsets.js';

/** One contiguous (in source order) run of chunks that moved between the same two levels. */
export interface FoldDiffRun {
  /** Level before the compile (0 = raw). */
  from: number;
  /** Level after the compile (0 = raw). */
  to: number;
  /** Chunks in the run. */
  count: number;
  firstChunkId: ChunkId;
  lastChunkId: ChunkId;
  /**
   * Offset (tokens before) in the PREVIOUS layout of the carried unit the
   * run's first chunk rendered in: its own raw unit, or the recall pair of
   * the ancestor its carried level selected — for a chunk inside a pair that
   * is the pair's start, not the point where the layouts diverge (raising
   * one chunk out of a pair whose siblings stay folded diverges after the
   * pair). `null` only when that unit is absent from the previous layout,
   * which can happen only when diffing against a kept `previousLayout` (the
   * chunk was not in the previous request, or rendered through a different
   * unit than its carried level now selects). Re-rendering the carried
   * frontier always finds it.
   */
  offsetBefore: number | null;
}

/**
 * What one compile changed. The NEW side is always rendered from this
 * compile's inputs and frontier. The PREVIOUS side is the layout the last
 * committed compile actually sent when the caller kept it (`previousLayout`),
 * so pin changes and appended messages since that request show in the
 * divergence; without one (first compile after a restart) the carried
 * frontier is re-rendered with THIS compile's inputs — its pins, head and
 * tail — and such changes are invisible. Either way, `moves`/`runs` compare
 * the carried frontier with the new one under this compile's pins and
 * summaries.
 */
export interface FoldDiff {
  /** Chunks whose effective level changed (head/tail and locked chunks
   *  excluded, as in the picker and the commit loop). */
  moves: number;
  /** Chunks that folded deeper. */
  deepened: number;
  /** Chunks that un-folded toward raw. */
  raised: number;
  runs: FoldDiffRun[];
  /** Rendered tokens of the previous layout and of the new one. */
  previousTokens: number;
  nextTokens: number;
  /**
   * Offset in the NEW layout of the first rendered unit that differs from the
   * previous layout (`kvCost` semantics): a prompt-cache prefix can survive
   * up to here. Equals `nextTokens` when the new layout is a strict prefix of
   * the previous one (units dropped at the end, nothing re-read). `null` only
   * when the layouts are identical.
   */
  divergenceOffset: number | null;
  /** Tokens of the new layout from the divergence to the end — what the
   *  provider re-reads at full price. 0 when nothing diverged. */
  suffixTokens: number;
}

/** Layouts the caller already has; each is rendered here when absent. */
export interface FoldDiffLayouts {
  /** The layout the last committed compile sent. Absent → re-render
   *  `previous` over this compile's inputs. */
  previousLayout?: RenderLayout;
  /** `renderLayout(inputs, tree, next)`, when the caller already built it. */
  nextLayout?: RenderLayout;
}

/**
 * The level `renderLayout` renders `c` at under `frontier`: raw when pinned,
 * raw when the selected ancestor summary is missing. Kept in step with
 * `renderLayout`'s rules.
 */
function effectiveLevel(c: PickerChunk, tree: SummaryTree, frontier: Frontier): number {
  if (c.pinned) return 0;
  const level = frontier.get(c.id) ?? 0;
  return level > 0 && tree.ancestorAt(c.id, level) ? level : 0;
}

/**
 * Describe the change from `previous` to `next` over `inputs.chunks`.
 * Chunks absent from a map are at level 0. Head, tail and locked chunks never
 * count (head and tail are forced raw by the picker; a locked chunk's carried
 * level is never committed). See `FoldDiff` for which side is re-rendered.
 */
export function describeFoldDiff(
  inputs: PickerInputs,
  tree: SummaryTree,
  previous: Frontier,
  next: Frontier,
  layouts: FoldDiffLayouts = {},
): FoldDiff {
  const prevLayout = layouts.previousLayout ?? renderLayout(inputs, tree, previous);
  const nextLayout = layouts.nextLayout ?? renderLayout(inputs, tree, next);

  // Offset of each chunk's own unit in the previous layout: a raw chunk's
  // unit is keyed by its id; a folded chunk renders through the ancestor the
  // CARRIED frontier selected for it (keyed by summary id). Attribute by that
  // ancestor, not by every recall unit covering the leaf — with locks a
  // chunk can sit at L1 while its siblings' L2 also covers it, and the L2's
  // earlier offset would otherwise be reported for the L1's leaves (PR #157
  // review). Only raw/recall units: a tail chunk's raw unit is keyed by its
  // id too, so a chunk that slid out of the previous request's tail is found.
  const unitOffset = new Map<string, number>();
  for (const unit of prevLayout.units) {
    if (unit.kind === 'raw' || unit.kind === 'recall') unitOffset.set(unit.key, unit.offset);
  }
  const offsetBefore = (c: PickerChunk, from: number): number | null => {
    const key = from === 0 ? c.id : tree.ancestorAt(c.id, from)?.id ?? c.id;
    return unitOffset.get(key) ?? null;
  };

  const ordered = [...inputs.chunks].sort((a, b) => a.sequence - b.sequence);
  const runs: FoldDiffRun[] = [];
  let moves = 0;
  let deepened = 0;
  let raised = 0;
  let current: FoldDiffRun | null = null;
  for (const c of ordered) {
    if (inputs.headChunkIds.has(c.id) || inputs.tailChunkIds.has(c.id) || c.lockedByAgent) {
      current = null;
      continue;
    }
    const from = effectiveLevel(c, tree, previous);
    const to = effectiveLevel(c, tree, next);
    if (from === to) {
      current = null;
      continue;
    }
    moves++;
    if (to > from) deepened++;
    else raised++;
    if (current && current.from === from && current.to === to) {
      current.count++;
      current.lastChunkId = c.id;
      continue;
    }
    current = {
      from,
      to,
      count: 1,
      firstChunkId: c.id,
      lastChunkId: c.id,
      offsetBefore: offsetBefore(c, from),
    };
    runs.push(current);
  }

  // `null` means byte-identical. A new layout that is a strict PREFIX of the
  // previous one (units removed at the end, nothing after them) diverges at
  // its own end: the provider re-reads nothing (`suffixTokens` 0) but the
  // layout did change, and hosts must be able to tell that from unchanged.
  const d = earliestDivergenceIndex(prevLayout.units, nextLayout.units);
  const divergenceOffset =
    d === -1
      ? null
      : d >= nextLayout.units.length
        ? nextLayout.totalTokens
        : nextLayout.units[d].offset;
  const suffixTokens = divergenceOffset === null ? 0 : nextLayout.totalTokens - divergenceOffset;

  return {
    moves,
    deepened,
    raised,
    runs,
    previousTokens: prevLayout.totalTokens,
    nextTokens: nextLayout.totalTokens,
    divergenceOffset,
    suffixTokens,
  };
}

const k = (n: number): string => `${Math.round(n / 1000)}k`;

/**
 * One line for the operator log. Runs are listed in source order (oldest
 * first) so the leftmost entry has the smallest offset — the earliest point
 * in the layout that a run touches. `maxRuns`
 * caps the listing; the remainder is summarized.
 */
export function formatFoldDiff(diff: FoldDiff, maxRuns = 8): string {
  const runText = diff.runs.slice(0, maxRuns).map((r) => {
    const where = r.offsetBefore === null ? '' : `@${k(r.offsetBefore)}`;
    const span = r.count === 1 ? r.firstChunkId : `${r.firstChunkId}..${r.lastChunkId}`;
    return `L${r.from}→L${r.to}×${r.count}${where}[${span}]`;
  });
  if (diff.runs.length > maxRuns) runText.push(`+${diff.runs.length - maxRuns} more runs`);
  const divergence =
    diff.divergenceOffset === null
      ? 'layout unchanged'
      : `divergence@${k(diff.divergenceOffset)} suffix=${k(diff.suffixTokens)}`;
  return (
    `[fold-diff] moves=${diff.moves} (deepened=${diff.deepened} raised=${diff.raised}) ` +
    `rendered ${k(diff.previousTokens)}→${k(diff.nextTokens)} ${divergence}` +
    (runText.length > 0 ? ` runs=${diff.runs.length}: ${runText.join(' ')}` : '')
  );
}
