/**
 * Overlap tolerance + fold→project fixpoint (2026-08-03, opus4 regression).
 *
 * After store surgery a summary "tree" can be NON-NESTED: a group's
 * leafChunkIds may include a leaf whose own l1Id lineage tops out below the
 * group's level or climbs through a different family (e.g. a re-minted L1
 * with different boundaries overlapping an old lineage).
 *
 * Old behavior: foldPass marked such leaves at the group's level anyway; the
 * final validity projection (monotone-lowering) then un-folded the WHOLE
 * group around the one disagreeing leaf — on opus4, 615 leaves cascaded
 * (+24k tokens), the solve returned an over-W frontier, and a produced L4/L5
 * layer sat unused ("deepest fold level=L3" with L4s present).
 *
 * New behavior: disagreeing leaves are skipped by folds and exempted from
 * unanimity (they render raw beside the recall — the renderer's existing
 * ownership-wins semantics), and the solve iterates fold→project until the
 * render fits under W.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { planControlledFrontier, type ControlPlanParams } from '../../src/adaptive/kv-control.js';
import { renderLayout, kvCost, type RenderLayout } from '../../src/adaptive/render-offsets.js';
import { buildChronicleWithChain, type MockChronicle } from './harness.js';
import type { PickerChunk, PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import type { SummaryEntry } from '../../src/types/strategy.js';

function inputsOf(ch: MockChronicle): PickerInputs {
  return {
    chunks: ch.chunks, summaries: ch.summaries, recallPairTokens: ch.recallPairTokens,
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
}

/** 90 chunks × 1000t, base-6 chain, then one ROGUE overlapping L1:
 *  c-0007's own lineage is re-pointed at an unmerged L1-R (sourceIds
 *  c-0007..c-0008, different boundaries) while the original L1/L2 lineage
 *  still lists c-0007 among its leaves — a non-nested tree. */
function corruptedSession(): { inputs: PickerInputs; tree: SummaryTree } {
  const ch = buildChronicleWithChain({
    chunkCount: 90, tokensPerChunk: 1000, mergeThreshold: 6, recallPairTokens: 200,
  });
  const template = ch.summaries.values().next().value as SummaryEntry;
  const rogue: SummaryEntry = {
    ...template,
    id: 'L1-ROGUE',
    level: 1,
    sourceLevel: 0,
    sourceIds: ['c-0007', 'c-0008'],
    sourceRange: { first: 'c-0007', last: 'c-0008' },
  };
  delete (rogue as { mergedInto?: string }).mergedInto;
  delete (rogue as { parentId?: string }).parentId; // harness entries carry parentId; the rogue is unmerged
  ch.summaries.set(rogue.id, rogue);
  ch.recallPairTokens.set(rogue.id, 200);
  const c7 = ch.chunks.find((c) => c.id === 'c-0007')!;
  c7.l1Id = 'L1-ROGUE';
  const inputs = inputsOf(ch);
  return { inputs, tree: new SummaryTree(inputs) };
}

test('a lineage-disagreeing leaf does not un-fold its group (overlap tolerance)', () => {
  const { inputs, tree } = corruptedSession();
  const plan = planControlledFrontier(inputs, tree, {
    previous: new Map(),
    foldAtTokens: 2_000, expandAtTokens: 1_000, targetTokens: 1_000,
    windowTokens: 2_000, rawZone: new Set(), now: 89, mergeThreshold: 6,
  });

  // The physics hold: W is the only wall. (Old code: the projection avalanche
  // lowered the whole L2 group and the returned render busted W.)
  assert.ok(plan.tokens <= 2_000, `render fits under W (${plan.tokens})`);

  // The first L2 group (c-0000..0035) folds to 2 despite the rogue member —
  // the avalanche would have lowered all 36 to L1.
  let atL2 = 0;
  for (let i = 0; i < 36; i++) {
    const id = `c-${String(i).padStart(4, '0')}`;
    if (id === 'c-0007') continue;
    if ((plan.resolutions.get(id) ?? 0) === 2) atL2++;
  }
  assert.ok(atL2 >= 30, `L2 group survives the disagreeing member (${atL2}/35 at L2)`);

  // The rogue leaf itself is never marked at a level its lineage can't render.
  const rogueLevel = plan.resolutions.get('c-0007') ?? 0;
  assert.ok(rogueLevel <= 1, `disagreeing leaf stays at its own lineage depth (L${rogueLevel})`);
});

// ---------------------------------------------------------------------------
// The next compile keeps the exemption. A leaf that a summary lists, but whose
// own lineage at the summary's level is another summary or none, renders
// through its own lineage beside the summary. The validity projection leaves
// such a leaf out of the summary's unanimity for the carried frontier and for
// each suffix candidate, as for the ideal cut. When only the ideal cut's
// projection left it out, the next compile un-folded the summary around it.

function summary(id: string, level: number, sourceIds: string[], tokens: number, parentId?: string): SummaryEntry {
  return {
    id, level, sourceLevel: level - 1, sourceIds, tokens, content: `summary ${id}`, created: 0,
    sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
    ...(parentId ? { parentId } : {}),
  };
}

function message(id: string, sequence: number, rawTokens: number, l1Id?: string): PickerChunk {
  return { id, sequence, rawTokens, currentResolution: 0, lockedByAgent: false, pinned: false, ...(l1Id ? { l1Id } : {}) };
}

function store(chunks: PickerChunk[], summaries: SummaryEntry[]): { inputs: PickerInputs; tree: SummaryTree } {
  const inputs: PickerInputs = {
    chunks, summaries: new Map(summaries.map((s) => [s.id, s])),
    headTokens: 0, tailTokens: 0, headChunkIds: new Set(), tailChunkIds: new Set(),
  };
  return { inputs, tree: new SummaryTree(inputs) };
}

const unitsOf = (layout: RenderLayout): string[] => layout.units.map((u) => `${u.kind}:${u.key}`);

/** Each test plans on purpose over a tree that makes the planner warn. */
function quietOverlap<T>(fn: () => T): { result: T; overlapWarnings: number } {
  const original = console.error;
  let overlapWarnings = 0;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('[kv-overlap]')) overlapWarnings++;
    else original(...args);
  };
  try {
    return { result: fn(), overlapWarnings };
  } finally {
    console.error = original;
  }
}

/** m1's L1 A has no parent, but L2 G's sources are A, B and C, so G lists m1
 *  while m1's own lineage stops at A. Fully folded, the window is A beside G
 *  (70 tokens); with G un-folded around m1, it is A, B and C (90). */
function disagreeingTrio(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('A', 1, ['m1'], 30),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
}

/** As the trio, but A's parent is L2 H, which doesn't list A: m1's own
 *  lineage reaches level 2 through H, not G. H covers m0 alone. Fully folded,
 *  the window is H, A beside G (110 tokens). */
function crossParentedTrio(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m0', 0, 100, 'D'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('D', 1, ['m0'], 30, 'H'),
      summary('H', 2, ['D'], 40),
      summary('A', 1, ['m1'], 30, 'H'),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
}

/** Two L2s list A: its own parent P, with C, and Q, with B. A pin caps C at
 *  L1, so P can't fold, and A stays at L1 beside Q. */
function twoParentsOneCapped(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('A', 1, ['m1'], 30, 'P'),
      summary('B', 1, ['m2'], 30, 'Q'),
      summary('C', 1, ['m3'], 30, 'P'),
      summary('P', 2, ['A', 'C'], 40),
      summary('Q', 2, ['A', 'B'], 40),
    ],
  );
}

/** A lists m0 and m1, and its parent is L2 P, which doesn't list A: P's one
 *  source is C, which lists m2 and also m1. So m1 folds to L2 through P,
 *  above A, while P doesn't cover m0. L2 Q lists A and D. Fully folded, the
 *  window is A, P and Q beside raw m4 (170 tokens); with A un-folded because
 *  m1 sits above it, m0 renders raw (240). */
function ownLeafFoldedAbove(): { inputs: PickerInputs; tree: SummaryTree } {
  return store(
    [message('m0', 0, 100, 'A'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'C'), message('m3', 3, 100, 'D'), message('m4', 4, 100)],
    [
      summary('A', 1, ['m0', 'm1'], 30, 'P'),
      summary('C', 1, ['m2', 'm1'], 30, 'P'),
      summary('D', 1, ['m3'], 30, 'Q'),
      summary('P', 2, ['C'], 20),
      summary('Q', 2, ['A', 'D'], 20),
    ],
  );
}

const trio = { targetTokens: 50, windowTokens: 1_000, reachTokens: 1_000, rawZone: new Set<ChunkId>(), now: 1_000 };

for (const [kind, build, foldAtTokens, folded, pinCaps] of [
  ['whose own lineage stops below the summary', disagreeingTrio, 100, ['recall:A', 'recall:G'], undefined],
  ['whose own lineage runs through another summary at its level', crossParentedTrio, 150, ['recall:H', 'recall:A', 'recall:G'], undefined],
  ['whose own parent is held back by a pin', twoParentsOneCapped, 150, ['recall:A', 'recall:Q', 'recall:C'], new Map([['m3', 1]])],
  ['of its own that is folded above it', ownLeafFoldedAbove, 250, ['recall:A', 'recall:P', 'recall:Q', 'raw:m4'], undefined],
] as const) {
  test(`a held plan keeps the summary beside a leaf ${kind}`, () => {
    const { inputs, tree } = build();
    const params = { ...trio, foldAtTokens, ...(pinCaps ? { pinCaps } : {}) };
    const { result: [first, second] } = quietOverlap(() => {
      const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
      return [first, planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions })];
    });
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, first.resolutions)), folded);
    // The fullest fold is inside the [50, foldAt] band, so the second compile holds.
    assert.deepEqual(unitsOf(renderLayout(inputs, tree, second.resolutions)), folded);
    assert.equal(second.perturbation, 0);
    assert.ok(!second.folded && !second.expanded);
  });
}

test('a compile above foldAt that adopts the frontier it carried reports no fold and no perturbation', () => {
  const { inputs, tree } = disagreeingTrio();
  // The fullest fold is 70 tokens, above foldAt, so nothing holds: each
  // compile adopts the ideal cut, which is the frontier it carried.
  const params = { ...trio, foldAtTokens: 60 };
  const { result: [first, second] } = quietOverlap(() => {
    const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
    return [first, planControlledFrontier(inputs, tree, { ...params, previous: first.resolutions })];
  });
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, second.resolutions)), unitsOf(renderLayout(inputs, tree, first.resolutions)));
  assert.equal(second.perturbation, 0);
  assert.ok(!second.folded && !second.expanded);
});

test('a pin tightened since the last compile is in the carried frontier, so perturbation leaves it out', () => {
  // A, B and C under G, nested. The first compile folds to G; the second caps
  // m1 at L1, which no plan can render through G. The provider re-reads from
  // G on, but that change is every plan's, so the carried frontier applies it
  // first and the plan, which holds, reports a perturbation of 0.
  const { inputs, tree } = store(
    [message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('A', 1, ['m1'], 30, 'G'),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
  const params = { ...trio, foldAtTokens: 150 };
  const first = planControlledFrontier(inputs, tree, { ...params, previous: new Map() });
  const second = planControlledFrontier(inputs, tree, { ...params, pinCaps: new Map([['m1', 1]]), previous: first.resolutions });
  const before = renderLayout(inputs, tree, first.resolutions);
  const after = renderLayout(inputs, tree, second.resolutions);
  assert.deepEqual(unitsOf(before), ['recall:G']);
  assert.deepEqual(unitsOf(after), ['recall:A', 'recall:B', 'recall:C']);
  assert.ok(kvCost(before, after) > 0, 'the provider re-reads from G on');
  assert.equal(second.perturbation, 0);
});

test('suffix adoption takes a summary beside a lineage-disagreeing leaf', () => {
  // The trio after m0, whose own L1 Z has no parent. From an all-raw carried
  // frontier the ideal cut (Z, A and G) rewrites all 100 tokens it renders;
  // P = 75 allows a rewrite from m1 on, which is A and G, 70 tokens.
  const { inputs, tree } = store(
    [message('m0', 0, 100, 'Z'), message('m1', 1, 100, 'A'), message('m2', 2, 100, 'B'), message('m3', 3, 100, 'C')],
    [
      summary('Z', 1, ['m0'], 30),
      summary('A', 1, ['m1'], 30),
      summary('B', 1, ['m2'], 30, 'G'),
      summary('C', 1, ['m3'], 30, 'G'),
      summary('G', 2, ['A', 'B', 'C'], 40),
    ],
  );
  const { result: plan } = quietOverlap(() => planControlledFrontier(inputs, tree, {
    ...trio, foldAtTokens: 300, reachTokens: 75,
    previous: new Map(inputs.chunks.map((c) => [c.id, 0])),
  }));
  assert.equal(plan.override, undefined);
  assert.deepEqual(unitsOf(renderLayout(inputs, tree, plan.resolutions)), ['raw:m0', 'recall:A', 'recall:G']);
  assert.equal(plan.perturbation, 70);
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A nested tree over 3 to 12 messages, with one or two corruptions of the
 *  kinds store surgery leaves: an L1 detached from the L2 that still lists
 *  it, an L1 re-pointed at an L2 that doesn't list it, or a message
 *  re-pointed at an unmerged L1 over it and its neighbour. On some trees the
 *  caller's protections too: a raw zone, pin-max-level caps, pin-at-level
 *  over one summary's leaves, and a locked leaf. */
function randomNonNested(rng: () => number): {
  inputs: PickerInputs; tree: SummaryTree; params: Omit<ControlPlanParams, 'previous'>; corruptions: string[];
} {
  const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  const n = 3 + Math.floor(rng() * 10);
  const chunks = Array.from({ length: n }, (_, i) => message(`m${i}`, i, 40 + Math.floor(rng() * 120)));
  const summaries: SummaryEntry[] = [];
  const levels: SummaryEntry[][] = [[]];
  for (let i = 0; i < n;) {
    const run = chunks.slice(i, i + 1 + Math.floor(rng() * 3));
    i += run.length;
    if (rng() < 0.1) continue; // left uncovered
    const s = summary(`L1-${levels[0].length}`, 1, run.map((c) => c.id), 10 + Math.floor(rng() * 40));
    for (const c of run) c.l1Id = s.id;
    summaries.push(s);
    levels[0].push(s);
  }
  for (let level = 2; level <= 3 && levels[level - 2].length >= 2; level++) {
    const below = levels[level - 2];
    const here: SummaryEntry[] = [];
    for (let j = 0; j < below.length;) {
      const kids = below.slice(j, j + 2 + Math.floor(rng() * 2));
      j += kids.length;
      if (kids.length < 2 || rng() < 0.2) continue;
      const s = summary(`L${level}-${here.length}`, level, kids.map((k) => k.id), 10 + Math.floor(rng() * 40));
      for (const k of kids) k.parentId = s.id;
      summaries.push(s);
      here.push(s);
    }
    levels.push(here);
  }
  const corruptions: string[] = [];
  for (let c = 1 + Math.floor(rng() * 2); c > 0; c--) {
    const kind = Math.floor(rng() * 3);
    const merged = levels[0].filter((s) => s.parentId);
    if (kind === 0 && merged.length > 0) {
      const s = pick(merged);
      delete s.parentId;
      corruptions.push(`${s.id} detached`);
    } else if (kind === 1 && merged.length > 0 && (levels[1]?.length ?? 0) >= 2) {
      const s = pick(merged);
      const other = pick(levels[1].filter((p) => p.id !== s.parentId));
      s.parentId = other.id;
      corruptions.push(`${s.id} re-pointed at ${other.id}`);
    } else if (kind === 2) {
      const at = Math.floor(rng() * (n - 1));
      const s = summary(`R-${c}`, 1, [chunks[at].id, chunks[at + 1].id], 10 + Math.floor(rng() * 40));
      chunks[at].l1Id = s.id;
      summaries.push(s);
      corruptions.push(`${chunks[at].id} re-pointed at ${s.id}`);
    }
  }
  const rawZone = new Set<ChunkId>(rng() < 0.3 ? [chunks[n - 1].id] : []);
  const pinCaps = new Map<ChunkId, number>();
  if (rng() < 0.4) for (let p = 1 + Math.floor(rng() * 2); p > 0; p--) pinCaps.set(pick(chunks).id, Math.floor(rng() * 3));
  const fixedLevels = new Map<ChunkId, number>();
  if (rng() < 0.2 && summaries.length > 0) {
    const s = pick(summaries);
    const byId = new Map(summaries.map((x) => [x.id, x] as const));
    const leavesOf = (x: SummaryEntry): string[] =>
      x.level === 1 ? x.sourceIds : x.sourceIds.flatMap((id) => { const y = byId.get(id); return y ? leavesOf(y) : []; });
    for (const id of leavesOf(s)) if (!rawZone.has(id)) fixedLevels.set(id, s.level);
  }
  const frozen = new Set<ChunkId>();
  if (rng() < 0.2) {
    const c = pick(chunks);
    if (!rawZone.has(c.id) && !fixedLevels.has(c.id)) frozen.add(c.id);
  }
  const rawTotal = chunks.reduce((total, c) => total + c.rawTokens, 0);
  const targetTokens = Math.max(1, Math.floor(rawTotal * (0.05 + rng() * 0.6)));
  const { inputs, tree } = store(chunks, summaries);
  return {
    inputs, tree, corruptions,
    params: {
      targetTokens, foldAtTokens: Math.floor(targetTokens * (1 + rng())), windowTokens: rawTotal * 2,
      rawZone, pinCaps, fixedLevels, frozen, now: n,
    },
  };
}

test('on unchanged inputs, each plan reports its change from the last plan, and an adopted ideal cut stays put', () => {
  const sameLevels = (a: ReadonlyMap<ChunkId, number>, b: ReadonlyMap<ChunkId, number>): boolean =>
    a.size === b.size && [...a].every(([id, level]) => (b.get(id) ?? 0) === level);
  const rng = mulberry32(1);
  let warned = 0;
  for (let t = 0; t < 300; t++) {
    const { inputs, tree, params, corruptions } = randomNonNested(rng);
    // From nothing, the first plan adopts the ideal cut. From an all-raw
    // frontier with a small trust region, suffix adoption moves toward it.
    const starts = [
      { reachTokens: params.windowTokens, previous: new Map<ChunkId, number>() },
      { reachTokens: Math.max(1, Math.floor(params.targetTokens / 2)), previous: new Map(inputs.chunks.map((c) => [c.id, 0])) },
    ];
    let ideal: ReadonlyMap<ChunkId, number> | null = null;
    const { overlapWarnings } = quietOverlap(() => {
      for (const start of starts) {
        let previous: ReadonlyMap<ChunkId, number> = start.previous;
        let before = renderLayout(inputs, tree, previous);
        for (let turn = 1; turn <= 4; turn++) {
          const plan = planControlledFrontier(inputs, tree, { ...params, reachTokens: start.reachTokens, previous });
          const after = renderLayout(inputs, tree, plan.resolutions);
          ideal ??= plan.resolutions;
          const where = `tree ${t} (${corruptions.join('; ')}), turn ${turn}: ${unitsOf(before).join(' ')} → ${unitsOf(after).join(' ')}`;
          // A first turn with leaves pinned at a level starts from a frontier
          // the base changes, and perturbation counts from the carried
          // frontier, which applies the base first.
          if (turn > 1 || params.fixedLevels!.size === 0) {
            assert.equal(plan.perturbation, kvCost(before, after), `perturbation is the change from the last plan's render, ${where}`);
          }
          if (turn > 1 && sameLevels(previous, ideal)) {
            assert.ok(sameLevels(plan.resolutions, ideal), `the adopted ideal cut stays put, ${where}`);
          }
          if (turn > 1 && sameLevels(previous, plan.resolutions)) {
            assert.ok(!plan.folded && !plan.expanded, `an unchanged plan reports no fold or un-fold, ${where}`);
          }
          previous = plan.resolutions;
          before = after;
        }
      }
    });
    if (overlapWarnings > 0) warned++;
  }
  // The trees exercise the exemption: over a third of them make some plan warn.
  assert.ok(warned >= 100, `${warned} of 300 trees exempted a leaf`);
});
