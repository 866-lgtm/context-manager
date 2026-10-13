/**
 * #116 review: a raw pin inside a merged summary must open only the branch
 * that contains it. Before the mixed frontier, one pinned message made the
 * canonical L1 prompt replay the whole covering L3 raw (reviewer's repro: 187
 * old messages raw vs 9 in the live view), on every L1 while the pin existed.
 *
 * A pin resolves once, for compression and every selector.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ProtectedRange } from '../src/types/strategy.js';

const dir = mkdtempSync(join(tmpdir(), 'l1-recall-pins-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MARKER = 'You will soon form a new memory';

interface Summary { id: string; level: number; content: string; sourceIds: string[]; mergedInto?: string }
type Internals = {
  summaries: Summary[];
  config: Record<string, unknown>;
  estimateTokens(content: unknown[]): number;
  resetHeadWindow(id: string | null): void;
};

async function forest(
  name: string,
  overrides: Record<string, unknown> = {},
  afterAdd?: (cm: ContextManager, ids: string[]) => void,
  content: (i: number, text: string) => unknown[] = (_i, text) => [{ type: 'text', text }],
) {
  const requests: any[] = [];
  let calls = 0;
  const membrane = { complete: async (req: unknown) => { requests.push(JSON.parse(JSON.stringify(req))); calls++;
    return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}: ordinary events.` }], usage: { inputTokens: 500, outputTokens: 100 } }; } };
  const strategy = new AutobiographicalStrategy({ compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, summaryParticipant: 'Claude', hierarchical: true, mergeThreshold: 6, adaptiveResolution: true,
    ...overrides });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: membrane as never });
  const ids: string[] = [];
  const textOf = new Map<string, string>();
  for (let i = 0; i < 240; i++) {
    const text = `OLD-${i} ${'word '.repeat(30)}`;
    const id = cm.addMessage(i % 2 ? 'Claude' : 'User', content(i, text) as never);
    ids.push(id);
    textOf.set(id, text);
    afterAdd?.(cm, ids);
  }
  for (let r = 0; r < 200; r++) { await cm.compile(); await cm.tick(); if (calls > 150) break; }
  const internals = strategy as unknown as Internals;
  return { cm, strategy, internals, ids, textOf, requests };
}

function textsOf(request: any): string[] {
  return request.messages.flatMap((m: any) => m.content).filter((b: any) => typeof b.text === 'string').map((b: any) => b.text);
}

/** Add a fresh stretch of messages, compile and tick once, and return the
 *  first L1 compression request that tick sent, if any. */
async function nextL1(cm: ContextManager, requests: any[]): Promise<any | undefined> {
  requests.length = 0;
  for (let i = 0; i < 20; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `NEW-${i} ${'word '.repeat(30)}` }]);
  await cm.compile(); await cm.tick();
  return requests.find((request) => textsOf(request).some((text) => text.includes(MARKER)));
}

describe('raw pins open only their own branch of the L1 recall frontier', () => {
  it('one pinned message deep in a merged summary adds at most its chunk raw', async () => {
    const { cm, internals, ids, requests } = await forest('one-pin');
    const levels: Record<number, number> = {};
    for (const s of internals.summaries) if (!s.mergedInto) levels[s.level] = (levels[s.level] ?? 0) + 1;
    assert.ok((levels[2] ?? 0) + (levels[3] ?? 0) > 0, `need an L2+ frontier, got ${JSON.stringify(levels)}`);

    const count = (request: any) => {
      const texts = textsOf(request);
      return { oldRaw: texts.filter((t) => t.startsWith('OLD-')).length, recall: texts.filter((t) => t.startsWith('[CM] Recall memory')).length };
    };
    const baseline = count(await nextL1(cm, requests));
    cm.pinRange(ids[5], ids[5], { name: 'one-message' });
    const pinned = count(await nextL1(cm, requests));

    // The pinned message's L1 chunk (a handful of messages) opens; nothing else.
    assert.ok(pinned.oldRaw - baseline.oldRaw <= 12, `raw grew by ${pinned.oldRaw - baseline.oldRaw} (was 180+ before the fix)`);
    assert.ok(pinned.oldRaw > baseline.oldRaw, 'the pinned chunk itself is shown raw');
    assert.ok(pinned.recall >= baseline.recall, 'sibling branches stay summarized as recall pairs');
    cm.close();
  });
});

describe('a pin resolves once, for compression and every selector', () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}` }));
  const pins: Array<Omit<ProtectedRange, 'firstMessageId' | 'lastMessageId' | 'kind' | 'created' | 'id'> & { at: number }> = [
    { at: 1 },                          // classic raw pin
    { at: 2, level: 0 },
    { at: 3, maxLevel: 0 },
    { at: 4, level: 2 },
    { at: 5, maxLevel: 2 },
    { at: 6, level: 2 }, { at: 6, maxLevel: 0 },   // a fixed level wins over a cap
    { at: 7 }, { at: 7, maxLevel: 3 },              // a bound takes a classic pin's place
    { at: 8, level: 0 }, { at: 8, maxLevel: 3 },
  ];
  const resolve = (config: Record<string, unknown>) => {
    const strategy = new AutobiographicalStrategy({ autoTickOnNewMessage: false, ...config });
    (strategy as unknown as { pins: ProtectedRange[] }).pins = pins.map(({ at, ...bound }, n) => ({
      id: `pin-${n}`, firstMessageId: `m${at}`, lastMessageId: `m${at}`, kind: 'pin', created: 0, ...bound,
    }));
    const internals = strategy as unknown as {
      resolvedPinBounds(m: typeof messages): Map<number, unknown>;
      forceRawPinPositions(m: typeof messages): Set<number>;
    };
    return { bounds: internals.resolvedPinBounds(messages), raw: internals.forceRawPinPositions(messages) };
  };

  for (const foldingStrategy of ['kv-stable', 'kv-unified'] as const) {
    it(`${foldingStrategy} reads bounds, as kv-stable always has`, () => {
      const { bounds, raw } = resolve({
        adaptiveResolution: true, foldingStrategy,
        ...(foldingStrategy === 'kv-unified' ? { kvUnified: { treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false } as never } : {}),
      });
      assert.deepEqual([...bounds.entries()].sort(([a], [b]) => a - b), [
        [1, 'raw'], [2, { level: 0 }], [3, { maxLevel: 0 }], [4, { level: 2 }], [5, { maxLevel: 2 }],
        [6, { level: 2 }], [7, { maxLevel: 3 }], [8, { level: 0 }],
      ]);
      assert.deepEqual([...raw].sort(), [1, 2, 3, 8]);
    });
  }

  for (const [name, config] of [
    ['flat-profile', { adaptiveResolution: true }],
    ['oldest-first', { adaptiveResolution: true, foldingStrategy: 'oldest-first' }],
    ['hierarchical selection', { adaptiveResolution: false, foldingStrategy: 'kv-stable' }],
  ] as const) {
    it(`${name} keeps every pinned message raw`, () => {
      const { bounds, raw } = resolve(config);
      assert.deepEqual([...bounds.values()], Array(8).fill('raw'));
      assert.deepEqual([...raw].sort(), [1, 2, 3, 4, 5, 6, 7, 8]);
    });
  }

  type ChunkPins = { pinned: boolean; pinLevel?: number; pinMaxLevel?: number };
  const pickerCases: Array<[string, Record<string, unknown>, ChunkPins[]]> = [
    ['kv-stable', { foldingStrategy: 'kv-stable' }, [
      { pinned: true }, { pinned: true }, { pinned: true }, { pinned: false, pinLevel: 2 }, { pinned: false, pinMaxLevel: 2 },
      { pinned: false, pinLevel: 2 }, { pinned: false, pinMaxLevel: 3 }, { pinned: true },
    ]],
    ['flat-profile', {}, Array(8).fill({ pinned: true })],
  ];
  for (const [name, config, expected] of pickerCases) {
    it(`${name}'s picker chunks carry the resolution: a raw one as pinned, at most one bound`, async () => {
      let captured: Array<ChunkPins & { id: string }> | undefined;
      class Probe extends AutobiographicalStrategy {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        protected buildPicker(...args: [any, ...any[]]): any {
          captured = args[0].chunks;
          return (AutobiographicalStrategy.prototype as any).buildPicker.apply(this, args);
        }
      }
      const strategy = new Probe({ adaptiveResolution: true, headWindowTokens: 0, recentWindowTokens: 0, autoTickOnNewMessage: false, ...config });
      const cm = await ContextManager.open({ path: join(dir, `picker-${name}`), strategy });
      const ids = Array.from({ length: 40 }, (_, i) => cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: `M-${i}` }]));
      for (const { at, ...bound } of pins) cm.pinRange(ids[at], ids[at], bound);
      await cm.compile();
      assert.ok(captured, 'setup: the picker was built');
      for (let at = 1; at <= 8; at++) {
        const chunk: ChunkPins | undefined = captured!.find((c) => c.id === ids[at]);
        assert.ok(chunk, `setup: message ${at} is a picker chunk`);
        const got: ChunkPins = {
          pinned: chunk!.pinned,
          ...(chunk!.pinLevel !== undefined ? { pinLevel: chunk!.pinLevel } : {}),
          ...(chunk!.pinMaxLevel !== undefined ? { pinMaxLevel: chunk!.pinMaxLevel } : {}),
        };
        assert.deepEqual(got, expected[at - 1], `message ${at}`);
      }
      cm.close();
    });
  }

  it('under kv-stable, a message pinned at a level above 0 is still compressed; one kept raw is not', async () => {
    const { cm, internals, ids } = await forest('kv-stable-chunking', { foldingStrategy: 'kv-stable' }, (manager, messageIds) => {
      if (messageIds.length === 4) manager.pinAtLevel(messageIds[3], messageIds[3], 2, { name: 'at-level' });
      if (messageIds.length === 8) manager.pinRange(messageIds[7], messageIds[7], { name: 'raw' });
    });
    const covered = (id: string) => internals.summaries.some((s) => s.level === 1 && s.sourceIds.includes(id));
    assert.ok(covered(ids[3]), 'the level-2 pin\'s message has an L1, so it can render at its level');
    assert.ok(!covered(ids[7]), 'the raw pin\'s message was never chunked');
    cm.close();
  });

  it('the flat-profile live view keeps a message pinned at a level raw, as compression does', async () => {
    const { cm, ids } = await forest('flat-live');
    // Pinned while raw (the forest's compiles fit their default budget), then
    // compiled under a budget that folds its unpinned neighbour.
    cm.pinAtLevel(ids[100], ids[100], 2, { name: 'at-level' });
    const live = JSON.stringify(await cm.compile({ maxTokens: 4000, reserveForResponse: 0 }));
    assert.ok(!live.includes('OLD-101 '), 'setup: an unpinned neighbour folds under this budget');
    assert.ok(live.includes('OLD-100 '), 'pinned at a level, it stays raw where levels are not read');
    cm.close();
  });
});
