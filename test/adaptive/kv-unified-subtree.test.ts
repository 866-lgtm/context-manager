import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { PickerInputs } from '../../src/adaptive/picker.js';
import { CanonicalSummaryForest } from '../../src/adaptive/kv-unified.js';
import { ParetoKvUnifiedPolicySolver, type ParetoSolveOptions } from '../../src/adaptive/kv-unified-pareto.js';
import type { KvUnifiedReuse } from '../../src/adaptive/kv-unified-reuse.js';
import { ExactKvUnifiedPolicySolver, type ExactPolicyCandidate } from '../../src/adaptive/kv-unified-policy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { renderLayout } from '../../src/adaptive/render-offsets.js';
import { buildChronicleWithChain, MockChronicle } from './harness.js';

const metrics = (candidates: readonly ExactPolicyCandidate[]) => candidates
  .map((c) => [c.renderedTokens, c.fidelityLoss, c.continuityLoss, c.cacheChurn, c.score].map((v) => Math.round(v * 1e6) / 1e6).join('/'))
  .sort();

function inputsOf(chronicle: MockChronicle, extra: Partial<PickerInputs> = {}): PickerInputs {
  return {
    chunks: chronicle.chunks, summaries: chronicle.summaries, recallPairTokens: chronicle.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(), ...extra,
  };
}

/** A chained forest (L1 pairs, L2 quads, L3 octets) with a few ownerless
 * leaves appended, randomized sizes, salience and recall costs; every third
 * run is the packed test's interleaved ownership (gap-bearing summaries),
 * and every fourth pins a leaf inside a summary (an internal hole). */
function randomForest(random: () => number, run: number): { chronicle: MockChronicle; inputs: PickerInputs } {
  const chronicle = run % 3 === 0 ? new MockChronicle({ recallPairTokens: 30 }) :
    buildChronicleWithChain({ chunkCount: 8, tokensPerChunk: 70, mergeThreshold: 2, recallPairTokens: 30 });
  if (run % 3 === 0) {
    for (let i = 0; i < 9; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70 });
    const a = chronicle.produceL1(['c0', 'c3', 'c6']);
    const b = chronicle.produceL1(['c1', 'c4', 'c7']);
    chronicle.produceL1(['c2', 'c5', 'c8']);
    chronicle.produceUpper(2, [a.id, b.id]);
  }
  for (let i = 0; i < run % 3; i++) chronicle.addChunk({ id: `tail-${i}`, rawTokens: 70, pinned: run % 5 === 0 && i === 0 });
  for (const chunk of chronicle.chunks) {
    chunk.rawTokens = 10 + Math.floor(random() * 200) + (run % 4 === 0 ? random() : 0);
    chunk.salience = random();
  }
  if (run % 4 === 0) chronicle.chunks[2].pinned = true;
  for (const [id] of chronicle.recallPairTokens) chronicle.recallPairTokens.set(id, 10 + random() * 50);
  const inputs = inputsOf(chronicle, { headTokens: run % 7, tailTokens: run % 13 });
  return { chronicle, inputs };
}

const FOREST_OPTIONS = { preserveGapBearingSummaries: true };

function presentationFor(inputs: PickerInputs, random: () => number, coveredFraction: number, lastChangedSeq: number) {
  const forest = new CanonicalSummaryForest(inputs, FOREST_OPTIONS);
  const cuts = forest.enumerateExactCuts().candidates;
  const cut = cuts[Math.floor(random() * cuts.length)];
  const layout = renderLayout(inputs, new SummaryTree(inputs), cut.frontier);
  const covered = Math.floor(inputs.chunks.length * coveredFraction);
  const leaves = new Map(inputs.chunks.slice(0, covered).map((chunk) => {
    const level = cut.frontier.get(chunk.id) ?? 0;
    const id = forest.leaf(chunk.id)!.summaryIds.find((sid) => forest.summary(sid)!.level === level);
    return [chunk.id, { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${id}`, lastChangedSeq }];
  }));
  return { layout, leaves };
}

test('the subtree engine matches the object engine exactly without a grid, warm and cold', () => {
  let state = 4242;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let compared = 0;
  for (let run = 0; run < 90; run++) {
    const { inputs } = randomForest(random, run);
    const { layout, leaves } = presentationFor(inputs, random, run % 2 ? 1 : 0.5, run % 3);
    const forest = new CanonicalSummaryForest(inputs, FOREST_OPTIONS);
    const floor = forest.minimumTokens();
    assert.ok(floor.feasible);
    const options: ParetoSolveOptions = {
      maxTokens: floor.floorTokens + 1 + random() * 500, adoptEpsilon: run % 2 ? 20 : 0,
      ...(run % 5 ? { presentation: { currentSeq: 7, leaves } } : {}),
      cache: { immutablePrefixHash: 'same', layout, markers: [
        { unitIndex: Math.max(1, Math.floor(layout.units.length / 2)), offset: 100 },
        { unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: run % 6 ? 'same' : 'changed',
      labelCeiling: 1_000_000,
      policy: { continuityLambda: 50 + run, cacheLambda: 100 + run, continuityScale: 100, cacheScale: 100, ageBandSteps: run % 2 ? 0 : 4 },
    };
    const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
    const reference = solver.solve({ ...options, storage: 'objects' });
    const subtree = solver.solve({ ...options, engine: 'subtree' });
    assert.ok(reference.feasible && subtree.feasible);
    assert.ok(solver.lastSubtreeStats, 'the subtree engine ran');
    assert.deepEqual(subtree.selected.frontier, reference.selected.frontier, `selected run ${run}`);
    assert.equal(subtree.selected.score, reference.selected.score);
    assert.equal(subtree.cacheFloor, reference.cacheFloor);
    assert.equal(subtree.continuityFloor, reference.continuityFloor);
    assert.deepEqual(metrics(subtree.candidates), metrics(reference.candidates), `candidates run ${run}`);
    assert.equal(subtree.propagation?.approximationScoreErrorBound, reference.propagation?.approximationScoreErrorBound);
    compared++;
  }
  assert.equal(compared, 90);
});

test('the subtree engine stays within the reported bound of the oracle on a grid', () => {
  let state = 9001;
  const random = () => ((state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let run = 0; run < 60; run++) {
    const { inputs } = randomForest(random, run);
    const { layout, leaves } = presentationFor(inputs, random, 1, 1);
    const forest = new CanonicalSummaryForest(inputs, FOREST_OPTIONS);
    const floor = forest.minimumTokens();
    assert.ok(floor.feasible);
    const options: ParetoSolveOptions = {
      maxTokens: floor.floorTokens + 1 + random() * 500,
      presentation: { currentSeq: 3, leaves },
      cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
      currentImmutablePrefixHash: run % 2 ? 'p' : 'q',
      tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100, labelCeiling: 1_000_000,
      policy: { continuityLambda: 50 + run, cacheLambda: 100 + run, continuityScale: 100, cacheScale: 100, ageBandSteps: 4 },
    };
    const oracle = new ExactKvUnifiedPolicySolver(inputs, forest).solve(options);
    const subtree = new ParetoKvUnifiedPolicySolver(inputs, forest).solve({ ...options, engine: 'subtree' });
    assert.ok(oracle.feasible && subtree.feasible);
    const bound = subtree.propagation!.approximationScoreErrorBound;
    assert.ok(subtree.selected.score <= oracle.selected.score + bound + 1e-6,
      `run ${run}: subtree ${subtree.selected.score} vs oracle ${oracle.selected.score} + bound ${bound}`);
  }
});

test('the subtree engine reuses the deltas of unchanged summaries across compiles and matches a cold solve', () => {
  // 32 leaves of 100 tokens in a chain to L3 octets, one band per doubling:
  // after one append, every leaf older than 16 keeps its fidelity band and
  // every token midpoint older than 1024 keeps its recency band, so the
  // oldest octets are reused while the youngest subtrees are solved again.
  const chronicle = buildChronicleWithChain({ chunkCount: 32, tokensPerChunk: 100, mergeThreshold: 2, recallPairTokens: 40 });
  const first = inputsOf(chronicle);
  const policy = { continuityLambda: 10, cacheLambda: 10, continuityScale: 1000, cacheScale: 1000, ageBandSteps: 1 };
  // The accepted presentation is a cut this engine selected with no receipt.
  const blank = new ParetoKvUnifiedPolicySolver(first, new CanonicalSummaryForest(first)).solve({
    maxTokens: 1600, tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100, labelCeiling: 1_000_000, policy, engine: 'subtree',
  });
  assert.ok(blank.feasible);
  const layout = renderLayout(first, new SummaryTree(first), blank.selected.frontier);
  const accepted = new CanonicalSummaryForest(first);
  const leaves = new Map(first.chunks.map((chunk) => {
    const level = blank.selected.frontier.get(chunk.id) ?? 0;
    const id = accepted.leaf(chunk.id)!.summaryIds.find((sid) => accepted.summary(sid)!.level === level);
    return [chunk.id, { level, repHash: level === 0 ? `raw:${chunk.id}` : `summary:${id}`, lastChangedSeq: 0 }];
  }));
  const base: ParetoSolveOptions = {
    maxTokens: 1600, presentation: { currentSeq: 40, leaves },
    cache: { immutablePrefixHash: 'p', layout, markers: [{ unitIndex: layout.units.length, offset: layout.totalTokens }] },
    currentImmutablePrefixHash: 'p',
    tokenBucketSize: 50, continuityBucketSize: 30, fidelityBucketSize: 100, labelCeiling: 1_000_000, policy,
    engine: 'subtree',
  };
  const reuse: KvUnifiedReuse = {};
  const forestA = new CanonicalSummaryForest(first);
  const solverA = new ParetoKvUnifiedPolicySolver(first, forestA);
  const a = solverA.solve({ ...base, reuse });
  assert.ok(a.feasible);
  assert.ok(solverA.lastSubtreeStats!.summariesSolved > 0);
  assert.equal(solverA.lastSubtreeStats!.summariesReused, 0, 'a cold solve reuses nothing');
  assert.ok(reuse.subtree && reuse.subtree.size > 0, 'the holder keeps the sets');
  // The same inputs again: everything is reused.
  const solverA2 = new ParetoKvUnifiedPolicySolver(first, forestA);
  const a2 = solverA2.solve({ ...base, reuse });
  assert.ok(a2.feasible);
  assert.equal(solverA2.lastSubtreeStats!.summariesSolved, 0, 'nothing changed: nothing is solved');
  assert.deepEqual(a2.selected.frontier, a.selected.frontier);

  chronicle.addChunk({ id: 'appended', rawTokens: 100 });
  const second = inputsOf(chronicle);
  const forestB = CanonicalSummaryForest.derive(forestA, second)!;
  assert.ok(forestB, 'an append derives');
  const options = { ...base, presentation: { currentSeq: 41, leaves } };
  const solverB = new ParetoKvUnifiedPolicySolver(second, forestB);
  const warm = solverB.solve({ ...options, reuse });
  assert.ok(warm.feasible);
  const stats = solverB.lastSubtreeStats!;
  assert.ok(stats.summariesReused > 0, `old subtrees are reused (${JSON.stringify(stats)})`);
  assert.ok(stats.summariesSolved > 0, 'the subtrees the append moved across a band are solved again');
  // A fresh holder has nothing memoized: a cold solve of the same inputs.
  const solverC = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second));
  const cold = solverC.solve({ ...options, reuse: {} });
  assert.ok(cold.feasible);
  assert.equal(solverC.lastSubtreeStats!.summariesReused, 0);
  assert.deepEqual(warm.selected.frontier, cold.selected.frontier, 'the warm solve is the cold solve');
  assert.equal(warm.selected.score, cold.selected.score);
  assert.deepEqual(metrics(warm.candidates), metrics(cold.candidates));
  // A full rebuild (new summary objects, the same ids and structure) still
  // reads the holder's sets: the entries rebind to the new objects.
  const solverD = new ParetoKvUnifiedPolicySolver(second, new CanonicalSummaryForest(second));
  const rebuilt = solverD.solve({ ...options, reuse });
  assert.ok(rebuilt.feasible);
  assert.equal(solverD.lastSubtreeStats!.summariesSolved, 0, 'a rebuild changes no set');
  assert.ok(solverD.lastSubtreeStats!.summariesReused > 0);
  assert.deepEqual(rebuilt.selected.frontier, warm.selected.frontier);
  // A summary that changed (a new parent over two fresh L1s) is solved
  // again with its chain; the rest is read from the holder.
  for (let i = 0; i < 4; i++) chronicle.addChunk({ id: `fresh-${i}`, rawTokens: 100 });
  const l1a = chronicle.produceL1(['fresh-0', 'fresh-1']);
  const l1b = chronicle.produceL1(['fresh-2', 'fresh-3']);
  new ParetoKvUnifiedPolicySolver(inputsOf(chronicle), new CanonicalSummaryForest(inputsOf(chronicle))).solve({ ...options, reuse });
  chronicle.produceUpper(2, [l1a.id, l1b.id]);
  const third = inputsOf(chronicle);
  const solverE = new ParetoKvUnifiedPolicySolver(third, new CanonicalSummaryForest(third));
  const merged = solverE.solve({ ...options, reuse });
  assert.ok(merged.feasible);
  const after = solverE.lastSubtreeStats!;
  assert.ok(after.summariesSolved > 0 && after.summariesReused > 0, `the merge re-solves its chain only (${JSON.stringify(after)})`);
  const solverF = new ParetoKvUnifiedPolicySolver(third, new CanonicalSummaryForest(third));
  const mergedCold = solverF.solve({ ...options, reuse: {} });
  assert.ok(mergedCold.feasible);
  assert.deepEqual(merged.selected.frontier, mergedCold.selected.frontier);
  assert.deepEqual(metrics(merged.candidates), metrics(mergedCold.candidates));
});

test('the subtree engine walks internal holes and gap-bearing ownership like the object engine, and `dag` still asks for the packed engine', () => {
  const chronicle = new MockChronicle({ recallPairTokens: 30 });
  for (let i = 0; i < 6; i++) chronicle.addChunk({ id: `c${i}`, rawTokens: 70, pinned: i === 1 });
  chronicle.produceL1(['c0', 'c1', 'c2']);
  chronicle.produceL1(['c3', 'c4', 'c5']);
  const inputs = inputsOf(chronicle);
  const forest = new CanonicalSummaryForest(inputs);
  assert.ok(forest.hasInternalProtectedHoles());
  const solver = new ParetoKvUnifiedPolicySolver(inputs, forest);
  const reference = solver.solve({ maxTokens: 400, storage: 'objects', labelCeiling: 100_000 });
  const subtree = solver.solve({ maxTokens: 400, labelCeiling: 100_000 });
  assert.ok(reference.feasible && subtree.feasible);
  assert.ok(solver.lastSubtreeStats, 'auto runs the subtree engine on a buffered forest');
  assert.deepEqual(subtree.selected.frontier, reference.selected.frontier);
  assert.deepEqual(metrics(subtree.candidates), metrics(reference.candidates));
  const packed = solver.solve({ maxTokens: 400, engine: 'dag', labelCeiling: 100_000 });
  assert.ok(packed.feasible);
  assert.equal(solver.lastSubtreeStats, null);
  assert.equal(packed.propagation?.storageMode, 'packed');
});
