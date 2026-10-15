/**
 * describeFoldDiff / formatFoldDiff: pure diff of two frontiers over the same
 * picker inputs — runs grouped in source order by (from → to), positioned by
 * the carried layout, divergence priced like kvCost.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout, kvCost } from '../../src/adaptive/render-offsets.js';
import { describeFoldDiff, formatFoldDiff } from '../../src/adaptive/fold-diff.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

function inputsOf(ch: MockChronicle, head: ChunkId[] = [], tail: ChunkId[] = []): PickerInputs {
  const headSet = new Set(head);
  const tailSet = new Set(tail);
  const tok = (ids: Set<ChunkId>) =>
    ch.chunks.filter((c) => ids.has(c.id)).reduce((a, c) => a + c.rawTokens, 0);
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: tok(headSet), tailTokens: tok(tailSet), headChunkIds: headSet, tailChunkIds: tailSet,
  };
}

const ids = (ch: MockChronicle, from: number, to: number): ChunkId[] =>
  ch.chunks.slice(from, to).map((c) => c.id);

test('fold-diff: identical frontiers → no moves, no divergence', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const f = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), f, f);
  assert.equal(d.moves, 0);
  assert.equal(d.runs.length, 0);
  assert.equal(d.divergenceOffset, null);
  assert.equal(d.suffixTokens, 0);
  assert.match(formatFoldDiff(d), /moves=0 .*layout unchanged/);
});

test('fold-diff: runs are grouped by (from→to) in source order and priced by the carried layout', () => {
  // 36 chunks: L1s over each 6, L2s over each 36 (chain produced by the harness).
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>();
  const next = new Map<ChunkId, number>();
  // Carried: first 12 chunks at L1 (two recall pairs), the rest raw.
  for (const id of ids(ch, 0, 12)) prev.set(id, 1);
  // Next: first 12 deepen to L2 (one pair), chunks 12..18 fold raw→L1, 30..36 raw→L1.
  for (const id of ids(ch, 0, 12)) next.set(id, 2);
  for (const id of ids(ch, 12, 18)) next.set(id, 1);
  for (const id of ids(ch, 30, 36)) next.set(id, 1);

  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 24);
  assert.equal(d.deepened, 24);
  assert.equal(d.raised, 0);
  assert.deepEqual(
    d.runs.map((r) => [r.from, r.to, r.count, r.firstChunkId, r.lastChunkId]),
    [
      [1, 2, 12, ch.chunks[0].id, ch.chunks[11].id],
      [0, 1, 6, ch.chunks[12].id, ch.chunks[17].id],
      [0, 1, 6, ch.chunks[30].id, ch.chunks[35].id],
    ],
  );
  // Positions come from the CARRIED layout: pair(200) + pair(200) + 24 raw.
  assert.equal(d.runs[0].offsetBefore, 0);
  assert.equal(d.runs[1].offsetBefore, 400);
  assert.equal(d.runs[2].offsetBefore, 400 + 18 * 1000);

  // Divergence/suffix agree with kvCost over the same layouts.
  const prevLayout = renderLayout(inputs, tree, prev);
  const nextLayout = renderLayout(inputs, tree, next);
  assert.equal(d.previousTokens, prevLayout.totalTokens);
  assert.equal(d.nextTokens, nextLayout.totalTokens);
  assert.equal(d.divergenceOffset, 0); // the first unit itself changed (L1 pair → L2 pair)
  assert.equal(d.suffixTokens, kvCost(prevLayout, nextLayout));

  const line = formatFoldDiff(d);
  assert.match(line, /^\[fold-diff\] moves=24 \(deepened=24 raised=0\)/);
  assert.match(line, /runs=3: L1→L2×12@0k\[/);
  assert.match(line, /L0→L1×6@18k\[/);
});

test('fold-diff: a change past a stable prefix prices only the suffix; head/tail never count', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const head = ids(ch, 0, 2);
  const tail = ids(ch, 30, 36);
  const inputs = inputsOf(ch, head, tail);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>();
  const next = new Map<ChunkId, number>();
  // A move inside the head/tail must be ignored even if a map claims it.
  next.set(head[0], 1);
  next.set(tail[0], 1);
  // Real change: chunks 24..30 fold raw→L1 while 2..24 stay raw.
  for (const id of ids(ch, 24, 30)) next.set(id, 1);

  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 6);
  assert.equal(d.runs.length, 1);
  // Carried layout: head(2000) + 22 raw middle chunks → run starts at 24k.
  assert.equal(d.runs[0].offsetBefore, 2000 + 22 * 1000);
  assert.equal(d.divergenceOffset, 2000 + 22 * 1000);
  // Suffix = one recall pair + the 6-chunk raw tail.
  assert.equal(d.suffixTokens, 200 + 6 * 1000);
  assert.equal(d.suffixTokens, kvCost(renderLayout(inputs, tree, prev), renderLayout(inputs, tree, next)));
});

test('fold-diff: raised chunks are counted and formatted; run listing is capped', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const next = new Map<ChunkId, number>(prev);
  // Alternate single chunks raw/L1 to create many runs.
  for (let i = 0; i < 36; i += 2) next.set(ch.chunks[i].id, 0);
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.raised, 18);
  assert.equal(d.deepened, 0);
  assert.equal(d.runs.length, 18);
  const line = formatFoldDiff(d, 4);
  assert.match(line, /raised=18/);
  assert.match(line, /\+14 more runs/);
});

test('fold-diff: a folded chunk is positioned by the ancestor the CARRIED frontier chose, not by any recall covering it', () => {
  // 36 chunks: L1 per 6, one L2 over all 36. Carried: chunks 0..29 at L2 (one
  // L2 pair rendered first), chunks 30..35 held at L1 (their own L1 pair
  // rendered after it) — the lock shape. Next: 30..35 go raw.
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>();
  for (const id of ids(ch, 0, 30)) prev.set(id, 2);
  for (const id of ids(ch, 30, 36)) prev.set(id, 1);
  const next = new Map<ChunkId, number>(prev);
  for (const id of ids(ch, 30, 36)) next.set(id, 0);
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0].from, 1);
  // The L1 pair sits AFTER the L2 pair (200 tokens), not at offset 0.
  assert.equal(d.runs[0].offsetBefore, 200);
  assert.equal(d.divergenceOffset, 200);
});

test('fold-diff: a new layout that is a strict prefix of the carried one is reported as changed, with nothing re-read', () => {
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  // Carried: 0..29 at L2 (pair A), 30..35 at L1 (pair B). Next: 30..35 join
  // the already-rendered L2 → the layout is [A] — a strict prefix of [A, B].
  const prev = new Map<ChunkId, number>();
  for (const id of ids(ch, 0, 30)) prev.set(id, 2);
  for (const id of ids(ch, 30, 36)) prev.set(id, 1);
  const next = new Map<ChunkId, number>(ids(ch, 0, 36).map((id) => [id, 2]));
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 6);
  assert.equal(d.nextTokens, 200);
  assert.equal(d.divergenceOffset, 200, 'diverges at the end of the new layout, not null');
  assert.equal(d.suffixTokens, 0);
  assert.match(formatFoldDiff(d), /divergence@0k suffix=0k/);
  assert.doesNotMatch(formatFoldDiff(d), /layout unchanged/);
});

/** The same chronicle's inputs with some chunks pinned and/or locked. */
function withFlags(
  inputs: PickerInputs,
  flags: { pinned?: ChunkId[]; locked?: ChunkId[] },
): PickerInputs {
  const pinned = new Set(flags.pinned ?? []);
  const locked = new Set(flags.locked ?? []);
  return {
    ...inputs,
    chunks: inputs.chunks.map((c) => ({
      ...c,
      pinned: c.pinned || pinned.has(c.id),
      lockedByAgent: c.lockedByAgent || locked.has(c.id),
    })),
  };
}

test('fold-diff: a pinned chunk carried at L1 that the solver puts at 0 is not a move (review repro)', () => {
  // The review's line: `moves=1 (deepened=0 raised=1) … layout unchanged
  // runs=1: L1→L0×1@0k[c-0008]`. The pinned chunk renders raw on both sides,
  // so from/to are both its effective level 0.
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const pinnedId = ch.chunks[8].id;
  const inputs = withFlags(inputsOf(ch), { pinned: [pinnedId] });
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>([[pinnedId, 1]]);
  const next = new Map<ChunkId, number>();
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 0);
  assert.equal(d.raised, 0);
  assert.deepEqual(d.runs, []);
  assert.equal(d.divergenceOffset, null);
  const line = formatFoldDiff(d);
  assert.match(line, /moves=0 .*layout unchanged/);
  assert.doesNotMatch(line, /c-0008/);
});

test('fold-diff: a level whose summary is missing renders raw and is not a move', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const orphan = ch.chunks[6].id;
  assert.equal(tree.ancestorAt(orphan, 5), null, 'fixture: no L5 exists');
  const d = describeFoldDiff(inputs, tree, new Map(), new Map([[orphan, 5]]));
  assert.equal(d.moves, 0);
  assert.equal(d.divergenceOffset, null);
});

test('fold-diff: locked chunks are skipped in counts and runs, as the commit loop skips them', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const lockedId = ch.chunks[2].id;
  const inputs = withFlags(inputsOf(ch), { locked: [lockedId] });
  const tree = new SummaryTree(inputs);
  // Everything raw → everything at L1. The locked chunk "moves" too in the
  // solver's map, but its carried level is never committed.
  const prev = new Map<ChunkId, number>();
  const next = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.moves, 11);
  assert.deepEqual(
    d.runs.map((r) => [r.firstChunkId, r.lastChunkId, r.count]),
    [
      [ch.chunks[0].id, ch.chunks[1].id, 2],
      [ch.chunks[3].id, ch.chunks[11].id, 9],
    ],
    'the locked chunk splits the run and is not counted',
  );
  // The layouts still diverge where they do: the solver's level renders.
  assert.equal(d.divergenceOffset, 0);
});

test('fold-diff: a pinned AND locked chunk never reports a phantom move', () => {
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const id = ch.chunks[8].id;
  const inputs = withFlags(inputsOf(ch), { pinned: [id], locked: [id] });
  const tree = new SummaryTree(inputs);
  const d = describeFoldDiff(inputs, tree, new Map([[id, 1]]), new Map());
  assert.equal(d.moves, 0);
  assert.equal(d.divergenceOffset, null);
});

test('fold-diff: offsetBefore of a chunk inside a pair is the pair start, not the divergence', () => {
  // All 36 at L1 (six pairs). Raise chunk 9 out of the second pair; its
  // siblings stay folded, so the pair still renders and the layouts diverge
  // after it.
  const ch = buildChronicleWithChain({ chunkCount: 36, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const inputs = inputsOf(ch);
  const tree = new SummaryTree(inputs);
  const prev = new Map<ChunkId, number>(ch.chunks.map((c) => [c.id, 1]));
  const next = new Map<ChunkId, number>(prev);
  next.set(ch.chunks[9].id, 0);
  const d = describeFoldDiff(inputs, tree, prev, next);
  assert.equal(d.runs.length, 1);
  assert.equal(d.runs[0].offsetBefore, 200);
  assert.equal(d.divergenceOffset, 400);
});

test('fold-diff: a kept previous layout shows a pin added since the last request', () => {
  // Last request: chunk 8 unpinned at L1, rendered through its L1 pair.
  // This compile: chunk 8 pinned (raw), solver puts it at 0. Re-rendering the
  // carried frontier with THIS compile's pins sees raw on both sides; the
  // kept layout shows where the cache prefix actually breaks.
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const pinnedId = ch.chunks[8].id;
  const before = inputsOf(ch);
  const now = withFlags(before, { pinned: [pinnedId] });
  const tree = new SummaryTree(now);
  const carried = new Map<ChunkId, number>([[pinnedId, 1]]);
  const sent = renderLayout(before, new SummaryTree(before), carried);

  const reRendered = describeFoldDiff(now, tree, carried, new Map());
  assert.equal(reRendered.divergenceOffset, null, 'fallback cannot see the pin change');

  const d = describeFoldDiff(now, tree, carried, new Map(), { previousLayout: sent });
  assert.equal(d.moves, 0, 'from/to are effective levels under this compile’s pins');
  assert.equal(d.previousTokens, sent.totalTokens);
  // Chunks 0..7 raw, then the L1 pair replaced chunk 8's raw unit.
  assert.equal(d.divergenceOffset, 8 * 1000);
  assert.equal(d.suffixTokens, 4 * 1000);
});

test('fold-diff: against a kept previous layout, appended messages diverge at the old end', () => {
  // The last request held chunks 0..9, all raw. This compile has 0..11 and
  // folds new chunk 11 straight to L1.
  const ch = buildChronicleWithChain({ chunkCount: 12, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200 });
  const older = { ...inputsOf(ch), chunks: ch.chunks.slice(0, 10) };
  const sent = renderLayout(older, new SummaryTree(older), new Map());
  const inputs = inputsOf(ch);
  const next = new Map<ChunkId, number>([[ch.chunks[11].id, 1]]);
  const d = describeFoldDiff(inputs, new SummaryTree(inputs), new Map(), next, { previousLayout: sent });
  assert.equal(d.moves, 1);
  assert.equal(d.previousTokens, 10 * 1000);
  assert.equal(d.divergenceOffset, 10 * 1000, 'the old request is a cached prefix');
  assert.equal(d.suffixTokens, 1000 + 200);
  // The new chunk has no unit in the previous request.
  assert.equal(d.runs[0].offsetBefore, null);
  assert.match(formatFoldDiff(d), /runs=1: L0→L1×1\[c-0011\]$/, "no position for a run the previous request lacked");
});
