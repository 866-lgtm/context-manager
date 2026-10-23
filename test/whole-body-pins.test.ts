/**
 * A pin renders whole messages: a pin or document mark whose first or last
 * id names a part of a message stored in parts covers that message from its
 * first part to its last in the selects, while the summarizer's prompt and
 * compression read it by its ids, so the message's other parts are chunked
 * and summarized like any history (`pinSpan`). A compile refused
 * over budget narrows pins back to their own ids, the one that frees the
 * most first, one at a time, until a select goes ahead, and keeps them so
 * while the strategy instance holds them; otherwise it puts them back
 * (`selectNarrowingPins`).
 *
 * The store: six history messages, then long messages that ingress stores
 * in parts (adaptive resolution with 1,500-token chunks), then 360 messages
 * of traffic. A head window of 500 tokens and a recent window of 8,000 leave
 * the long messages in the middle. With one 6,000-word message marked, its
 * first part alone fits at 22,000 tokens and the whole message needs about
 * 38,000; the tests use 30,000 for "can't be whole" and 42,000 for "fits".
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';
import type { AutobiographicalConfig } from '../src/index.js';

const words = (label: string, n: number): ContentBlock[] =>
  [{ type: 'text', text: `${label} ${Array.from({ length: n }, (_, i) => `word${i}`).join(' ')}` }];

const KV_UNIFIED = {
  policy: {
    alpha: 0.7, budgetLowRatio: 0.5, budgetHighRatio: 0.9, budgetUnderLambda: 10, budgetOverLambda: 10,
    cacheLambda: 1, cacheScale: 1000, cacheReadPrice: 0.1, cacheWritePrice: 1.25, continuityLambda: 1,
    continuityScale: 1000, continuityRecencyHalfLifeTokens: 1000, continuityRecencyFloor: 0.2,
    continuityStableHalfLife: 10, continuityStableFloor: 0.25,
  },
  tokenBucketSize: 100, continuityBucketSize: 100, fidelityBucketSize: 100, labelCeiling: 10_000, adoptEpsilon: 0,
  treeifyNonContiguousSummaries: false, preserveGapBearingSummaries: false,
};

/** Reaches the strategy's pins and windows. */
class PinStore extends AutobiographicalStrategy {
  private pinById(pinId: string) {
    return this.pins.find((p) => p.id === pinId)!;
  }
  /** Narrow a pin to its ids, or put it back, as a compile does: the request an earlier version sent. */
  setNarrowed(pinId: string, narrowed: boolean): void {
    if (narrowed) this.narrowedPins.add(this.narrowKey(this.pinById(pinId)));
    else this.narrowedPins.delete(this.narrowKey(this.pinById(pinId)));
  }
  /** Whether a compile narrowed this pin. */
  isNarrowed(pinId: string): boolean {
    return this.narrowedPins.has(this.narrowKey(this.pinById(pinId)));
  }
  /** Read the store's state again, as this instance does when another instance on the store has written it. */
  reload(): void {
    this.loadPersistedState({ keepKvUnifiedPresentation: true });
  }
  /** The fold bound each pinned position resolves to, as every selector reads it. */
  boundsAt(messages: unknown[]): Map<number, unknown> {
    return this.resolvedPinBounds(messages as never, 'whole');
  }
  /** The ids of the messages in compressed chunks. */
  summarizedIds(): Set<string> {
    const out = new Set<string>();
    for (const chunk of this.chunks) if (chunk.compressed) for (const m of chunk.messages) out.add(m.id);
    return out;
  }
  /** The ids of the messages in any chunk. */
  chunkedIds(): Set<string> {
    const out = new Set<string>();
    for (const chunk of this.chunks) for (const m of chunk.messages) out.add(m.id);
    return out;
  }
  /** Where the head window starts, and where the recent window starts. */
  windows(store: never): { headStart: number; recentStart: number } {
    return { headStart: this.getHeadWindowStartIndex(store), recentStart: this.getRecentWindowStart(store) };
  }
  /** Where the head window ends. */
  headEnd(store: never): number {
    return this.getHeadWindowEnd(store);
  }
  /** How many adaptive selects ran, and the refusals they threw. */
  selects = 0;
  refusals: OverBudgetError[] = [];
  /** Fail a select that a narrowed pin let through, after it planned. */
  failNarrowedAfterPlanning = false;
  protected selectAdaptive(store: never, budget: never, opts?: never): never {
    this.selects++;
    let entries: never;
    try {
      entries = super.selectAdaptive(store, budget, opts) as never;
    } catch (err) {
      if (err instanceof OverBudgetError) this.refusals.push(err);
      throw err;
    }
    if (this.failNarrowedAfterPlanning && this.pins.some((p) => this.narrowedPins.has(this.narrowKey(p)))) throw new Error('select failed');
    return entries;
  }
  /**
   * Leave the L1s covering these messages as the only record of their
   * coverage, as an adopted summary can: their chunks lose the pointer to it
   * and read as not compressed.
   */
  dropChunkPointers(ids: readonly string[]): void {
    const of = new Set(ids);
    for (const record of this.chunkRecords) {
      if (!record.sourceIds.some((id) => of.has(id))) continue;
      record.summaryId = undefined;
      record.compressed = false;
    }
  }
  /** The id a pin's range starts at. */
  firstIdOf(pinId: string): string {
    return this.pinById(pinId).firstMessageId;
  }
  /** Persist a provisional calibration multiplier, as a restart no sample has confirmed leaves one. */
  saveProvisionalCalibration(multiplier: number): void {
    const epoch = (AutobiographicalStrategy as unknown as { CALIBRATION_PRICING_EPOCH: number }).CALIBRATION_PRICING_EPOCH;
    this.store!.setStateJson(this.calibrationStateId, { multiplier, at: 1, pricing: epoch, provisional: true });
  }
  /** Fail a select with an error that isn't a refusal while a pin is narrowed. */
  failWhileNarrowed = false;
  protected resolvedPinBounds(messages: never, reading: 'ids' | 'whole'): never {
    if (this.failWhileNarrowed && this.pins.some((p) => this.narrowedPins.has(this.narrowKey(p)))) throw new Error('select failed');
    return super.resolvedPinBounds(messages, reading) as never;
  }
}

type Kind = 'adaptive' | 'kv-unified';
const config = (kind: Kind, recentWindowTokens: number): AutobiographicalConfig => ({
  headWindowTokens: 500, recentWindowTokens, imageStripDepthTokens: 0, compressionModel: 'test-model',
  hierarchical: false, adaptiveResolution: true, targetChunkTokens: 1500,
  ...(kind === 'kv-unified' ? { foldingStrategy: 'kv-unified', kvUnified: { ...KV_UNIFIED, policy: { ...KV_UNIFIED.policy } } } : {}),
} as AutobiographicalConfig);

function summarizer(words = 30): { membrane: never; calls: () => number; requests: string[] } {
  let n = 0;
  const requests: string[] = [];
  const membrane = {
    complete: async (request: unknown) => (requests.push(JSON.stringify(request)), {
      stopReason: 'end_turn', content: [{ type: 'text', text: `[S${++n}] ` + 'recalled '.repeat(words) }],
      usage: { input_tokens: 100, output_tokens: 40 },
    }),
  } as never;
  return { membrane, calls: () => n, requests };
}

async function open(dir: string, kind: Kind = 'adaptive', recentWindowTokens = 8000, extra: Partial<AutobiographicalConfig> = {}) {
  const strategy = new PinStore({ ...config(kind, recentWindowTokens), ...extra } as AutobiographicalConfig);
  const sum = summarizer();
  const cm = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: sum.membrane });
  return { cm, strategy, calls: sum.calls, requests: sum.requests };
}

const budget = (maxTokens: number) => ({ maxTokens, reserveForResponse: 0 });
type Sent = { participant: string; content: ContentBlock[] };
const sent = (r: { messages: unknown[] }): Sent[] => r.messages as Sent[];
const textOf = (m: Sent): string => m.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
/** The raw words of a marked message the request carries, by their numbers. */
function rawWords(messages: Sent[], label: string): number[] {
  return messages.map(textOf)
    .filter((t) => t.startsWith(label) || /^\s*word\d+/.test(t))
    .flatMap((t) => [...t.matchAll(/\bword(\d+)\b/g)].map((m) => Number(m[1])))
    .sort((a, b) => a - b);
}
const allOf = (n: number): number[] => Array.from({ length: n }, (_, i) => i);
const ready = async (cm: ContextManager) => { for (let i = 0; i < 800 && !cm.isReady(); i++) await cm.tick(); };

async function history(cm: ContextManager): Promise<void> {
  for (let i = 0; i < 6; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', words(`hist${i}`, 200));
  await cm.compile(budget(42_000));
}
async function traffic(cm: ContextManager, n: number, label = 'event'): Promise<void> {
  for (let i = 0; i < n; i++) cm.addMessage(i % 2 ? 'assistant' : 'user', words(`${label}${i}`, 200));
}

/**
 * A store as an earlier version left it: the marks on long messages covered
 * their first part only, so the rest of each was chunked and summarized, as
 * it still is. Returns the request it sent then, and the marks read whole
 * again, as the upgraded store reads them.
 */
async function upgradedStore(dir: string, opts: { kind?: Kind; bodies: Array<[string, number, string?]>; budget: number }) {
  const s = await open(dir, opts.kind);
  await history(s.cm);
  const marks: string[] = [];
  for (const [label, n, name] of opts.bodies) {
    const mark = s.cm.markDocument(s.cm.addMessage('user', words(label, n)), name === undefined ? undefined : { name });
    s.strategy.setNarrowed(mark, true);
    marks.push(mark);
  }
  await traffic(s.cm, 360);
  await ready(s.cm);
  const before = sent(await s.cm.compile(budget(opts.budget)));
  for (const mark of marks) s.strategy.setNarrowed(mark, false);
  return { ...s, marks, before };
}

function warnings(t: { mock: { method: (o: object, m: string, f: (...a: unknown[]) => void) => unknown } }): string[] {
  const out: string[] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => { out.push(String(args[0])); });
  return out;
}
const narrowingWarnings = (out: string[]) => out.filter((w) => w.includes(' now covers only '));

type View = { getAll(): Array<{ id: string; bodyGroupId?: string }> };
const viewOf = (cm: ContextManager): View => (cm as unknown as { strategyMessageView(): View }).strategyMessageView();
/** The ids of the parts of the message `id` is in, in store order. */
const partsOf = (cm: ContextManager, id: string): string[] => {
  const all = viewOf(cm).getAll();
  const group = all.find((m) => m.id === id)!.bodyGroupId;
  return all.filter((m) => m.bodyGroupId !== undefined && m.bodyGroupId === group).map((m) => m.id);
};
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-whole-pins-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('pins render whole messages', () => {
  for (const kind of ['adaptive', 'kv-unified'] as const) {
    it(`${kind}: a document mark on a long message's first part sends the whole message raw, while compression summarizes its other parts`, async () => {
      await withDir(async (dir) => {
        // A recent window of 20,000 holds the whole message as it arrives, so the mark is there before
        // compression chunks any part of it.
        const { cm, strategy } = await open(dir, kind, 20_000);
        await history(cm);
        const b = cm.addMessage('user', words('Bdoc', 6000));
        assert.deepStrictEqual(partsOf(cm, b).filter((id) => strategy.chunkedIds().has(id)), [], 'no part is chunked yet');
        cm.markDocument(b);
        await traffic(cm, 360);
        await ready(cm);
        assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), allOf(6000));
        const parts = partsOf(cm, b);
        assert.ok(parts.length > 2, 'the message is stored in parts');
        const summarized = strategy.summarizedIds();
        assert.deepStrictEqual(parts.map((id) => summarized.has(id)), parts.map((_, i) => i > 0), 'every part but the marked one is summarized');
        await cm.close();
      });
    });
  }

  it('a mark made after its message\'s early parts were chunked as it arrived sends the whole message raw', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir);
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      const parts = partsOf(cm, b);
      assert.ok(strategy.chunkedIds().has(parts[1]!), 'the second part was chunked before the mark');
      cm.markDocument(b);
      await traffic(cm, 360);
      await ready(cm);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('a range pin whose ends fall inside long messages covers both of them whole', async () => {
    await withDir(async (dir) => {
      const { cm } = await open(dir);
      await history(cm);
      const bParts = partsOf(cm, cm.addMessage('user', words('Bdoc', 2500)));
      const cParts = partsOf(cm, cm.addMessage('user', words('Cdoc', 2500)));
      assert.ok(bParts.length > 2 && cParts.length > 2, 'both messages are stored in parts');
      // From B's second part to C's second part.
      cm.pinRange(bParts[1]!, cParts[1]!);
      await traffic(cm, 360);
      await ready(cm);
      const request = sent(await cm.compile(budget(42_000)));
      assert.deepStrictEqual(rawWords(request, 'Bdoc'), allOf(2500));
      assert.deepStrictEqual(rawWords(request, 'Cdoc'), allOf(2500));
      await cm.close();
    });
  });

  it('a mark\'s level bound holds every part of its message', async () => {
    await withDir(async (dir) => {
      const { cm, strategy } = await open(dir, 'kv-unified');
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      cm.markDocument(b, { maxLevel: 1 });
      const all = viewOf(cm).getAll();
      const parts = new Set(partsOf(cm, b));
      const at = all.flatMap((m, i) => (parts.has(m.id) ? [i] : []));
      assert.ok(at.length > 2, 'the message is stored in parts');
      const bounds = strategy.boundsAt(all);
      assert.deepStrictEqual(at.map((i) => bounds.get(i)), at.map(() => ({ maxLevel: 1 })));
      await cm.close();
    });
  });

  it('kv-unified: a mark\'s own part that another pin\'s whole reading holds at a level is summarized, so the compile is feasible', async () => {
    await withDir(async (dir) => {
      // A recent window of 20,000 holds the message as it arrives, so both pins are there before any part is chunked.
      const { cm, strategy } = await open(dir, 'kv-unified', 20_000);
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      const parts = partsOf(cm, b);
      // A raw mark on the first part; a range at level 1 from the second part to the third, which read whole covers
      // the first part too, where a bound takes a raw pin's place.
      cm.markDocument(b);
      cm.pinRange(parts[1]!, parts[2]!, { level: 1 });
      await traffic(cm, 360);
      await ready(cm);
      assert.ok(strategy.summarizedIds().has(parts[0]!), 'the first part is summarized');
      await cm.compile(budget(60_000));
      await cm.close();
    });
  });

  it('a compression request after the mark carries the marked part raw and the other parts as summaries, as main gives it', async () => {
    await withDir(async (dir) => {
      const { cm, requests } = await open(dir);
      await history(cm);
      cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)));
      await traffic(cm, 360);
      await ready(cm);
      // A request whose chunk holds traffic message 300, long after the marked message.
      const later = requests.filter((r) => r.includes('"event300 word0'));
      assert.ok(later.length > 0, 'the chunk was summarized');
      for (const r of later) {
        assert.ok(r.includes('Bdoc word0 word1'), 'the marked part is in the prompt raw');
        assert.ok(!r.includes('word5999'), 'the message\'s last part is not');
      }
      await cm.close();
    });
  });

  it('the summarizer\'s over-budget warning doesn\'t count a mark\'s later parts, which its prompt sends as summaries', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      // A head window of 3,000 holds the message's first part (about 2,070 tokens), where the mark's own
      // id is. Read whole, its later parts would be raw history ahead of the traffic's chunks, more than
      // the summarizer's recall budget of 2,000.
      const { cm, strategy, calls } = await open(dir, 'adaptive', 8000, { headWindowTokens: 3000, compressionRecallBudgetTokens: 2000 });
      cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)));
      await traffic(cm, 120);
      await ready(cm);
      assert.strictEqual(strategy.headEnd(viewOf(cm) as never), 1, 'the head holds the first part alone');
      assert.ok(calls() > 0, 'the summarizer was called');
      assert.deepStrictEqual(out.filter((w) => w.includes('recalls the summaries its pins override')), []);
      await cm.close();
    });
  });

  for (const kind of ['adaptive', 'kv-unified'] as const) {
    it(`${kind}: the summarizer's over-budget warning names the pins that keep its raw history raw, read by their ids as its prompt reads them`, async (t) => {
      await withDir(async (dir) => {
        const out = warnings(t);
        // The summarizer shows a pinned message raw where a summary would cover it. Under kv-unified, Q's whole
        // reading holds P's part at a level, so it's summarized; a recent window of 20,000 holds the message as it
        // arrives, so both pins are there before any part is chunked. Elsewhere, a recent window of 8,000 lets the
        // message's early parts be chunked as they arrive, before the pins.
        const { cm } = await open(dir, kind, kind === 'kv-unified' ? 20_000 : 8000, { compressionRecallBudgetTokens: 1000 });
        await history(cm);
        const b = cm.addMessage('user', words('Bdoc', 6000));
        const parts = partsOf(cm, b);
        // P keeps the first part raw, about 2,070 tokens, over the recall budget of 1,000. Q names the sixth part:
        // raw where no bounds are read, and at level 1 under kv-unified, where read whole it would hold the first
        // part at that level in P's place.
        cm.markDocument(b, { name: 'P' });
        cm.pinRange(parts[5]!, parts[5]!, kind === 'kv-unified' ? { name: 'Q', level: 1 } : { name: 'Q' });
        await traffic(cm, 360);
        await ready(cm);
        const over = out.filter((w) => w.includes('recalls the summaries its pins override'));
        assert.ok(over.length > 0, 'the warning was given');
        // Only P's part is the prompt's pinned raw history: Q's whole reading would reach it, its ids don't.
        for (const w of over) assert.ok(w.includes('pins: P)'), w);
        await cm.close();
      });
    });
  }

  it('a store opened without adaptive resolution reads a mark by its ids, as before', async () => {
    await withDir(async (dir) => {
      const first = await open(dir);
      await history(first.cm);
      const b = first.cm.addMessage('user', words('Bdoc', 6000));
      first.cm.markDocument(b);
      await traffic(first.cm, 360);
      await ready(first.cm);
      const summarized = first.strategy.summarizedIds();
      assert.ok(partsOf(first.cm, b).slice(1).every((id) => summarized.has(id)), 'the later parts are summarized');
      await first.cm.close();
      const { cm } = await open(dir, 'adaptive', 8000, { adaptiveResolution: false });
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(60_000))), 'Bdoc'), allOf(763));
      await cm.close();
    });
  });
});

describe('a compile that can\'t hold the whole messages narrows pins', () => {
  for (const kind of ['adaptive', 'kv-unified'] as const) {
    it(`${kind}: an upgraded store whose mark can't be whole narrows it in memory and sends the request it sent before`, async (t) => {
      await withDir(async (dir) => {
        const out = warnings(t);
        const { cm, strategy, marks, before } = await upgradedStore(dir, { kind, bodies: [['Bdoc', 6000]], budget: 30_000 });
        assert.deepStrictEqual(rawWords(before, 'Bdoc'), allOf(763), 'before, the mark kept its first part raw');
        assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), before);
        assert.ok(strategy.isNarrowed(marks[0]!));
        const said = narrowingWarnings(out);
        assert.strictEqual(said.length, 1);
        assert.match(said[0]!, new RegExp(`^autobio: document mark ${marks[0]} now covers only message `));
        assert.match(said[0]!, /With it covering the whole message, the compile came to ~\d+ tokens against a hard budget of 30600 \(maxTokens 30000\)\./);
        assert.match(said[0]!, /Until this context is loaded again, the parts it no longer covers fold like any history\./);
        assert.match(said[0]!, new RegExp(`raise the budget, then restart or unpin ${marks[0]} and mark the message again\\.`));
        // Narrowed, it fits: the next compile sends the same and warns no more.
        assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), before);
        assert.strictEqual(narrowingWarnings(out).length, 1);
        await cm.close();
      });
    });
  }

  it('an upgraded store whose mark fits sends the whole message and narrows nothing', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 42_000 });
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      assert.ok(!strategy.isNarrowed(marks[0]!));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      await cm.close();
    });
  });

  it('a store opened again reads the mark whole: with room it sends the whole message, without it narrows again', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const first = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      await first.cm.compile(budget(30_000));
      assert.ok(first.strategy.isNarrowed(first.marks[0]!));
      await first.cm.close();
      const roomy = await open(dir);
      assert.deepStrictEqual(rawWords(sent(await roomy.cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      assert.ok(!roomy.strategy.isNarrowed(first.marks[0]!));
      await roomy.cm.close();
      const tight = await open(dir);
      assert.notDeepStrictEqual(rawWords(sent(await tight.cm.compile(budget(30_000))), 'Bdoc'), allOf(6000));
      assert.ok(tight.strategy.isNarrowed(first.marks[0]!));
      assert.strictEqual(narrowingWarnings(out).length, 2, 'each instance that narrows warns once');
      await tight.cm.close();
    });
  });

  it('a narrowing holds when this instance reads the store\'s state again', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks, before } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      await cm.compile(budget(30_000));
      strategy.reload();
      assert.ok(strategy.isNarrowed(marks[0]!));
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), rawWords(before, 'Bdoc'));
      assert.strictEqual(narrowingWarnings(out).length, 1);
      await cm.close();
    });
  });

  it('a narrowing ends when the strategy loads the store again: a fork narrows again, and the same strategy reopened with room sends the whole message', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      await cm.compile(budget(30_000));
      assert.ok(strategy.isNarrowed(marks[0]!));
      await cm.fork();
      assert.ok(!strategy.isNarrowed(marks[0]!), 'the fork loaded the store again');
      await cm.compile(budget(30_000));
      assert.ok(strategy.isNarrowed(marks[0]!), 'and narrowed again');
      assert.strictEqual(narrowingWarnings(out).length, 2);
      await cm.close();
      const again = await ContextManager.open({ path: join(dir, 'store'), strategy, membrane: summarizer().membrane });
      assert.deepStrictEqual(rawWords(sent(await again.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      assert.ok(!strategy.isNarrowed(marks[0]!));
      await again.close();
    });
  });

  it('a later narrowing that fails, or that a dry compile makes, leaves an earlier one as it was', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000], ['Cdoc', 1500]], budget: 30_000 });
      strategy.setNarrowed(marks[0]!, true);
      // With the first narrowed, the second fits at 25,000 only narrowed, and at 15,000 not even so.
      let selects = strategy.selects;
      await assert.rejects(cm.compile(budget(15_000)), OverBudgetError);
      assert.strictEqual(strategy.selects - selects, 2, 'the refused select and one narrowing the second mark');
      assert.ok(strategy.isNarrowed(marks[0]!), 'the first stays narrowed');
      assert.ok(!strategy.isNarrowed(marks[1]!));
      selects = strategy.selects;
      assert.strictEqual(cm.previewContext(budget(25_000))!.fits, true);
      assert.strictEqual(strategy.selects - selects, 2, 'the dry select narrowed the second mark');
      assert.ok(strategy.isNarrowed(marks[0]!), 'the first stays narrowed');
      assert.ok(!strategy.isNarrowed(marks[1]!));
      await cm.close();
    });
  });

  it('a mark whose parts\' L1s only the summaries record, with no chunk pointing to them, is narrowed as the select folds them', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      const { cm, strategy, marks, before } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      strategy.dropChunkPointers(partsOf(cm, strategy.firstIdOf(marks[0]!)));
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(30_000))), 'Bdoc'), rawWords(before, 'Bdoc'));
      assert.ok(strategy.isNarrowed(marks[0]!));
      await cm.close();
    });
  });

  it('a mark over parts locked at a fold is narrowed: narrowed, they return to their locked level', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      const { cm, strategy, marks, before } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      // The earlier version's compile folded the message's later parts; lock them there.
      const parts = partsOf(cm, strategy.firstIdOf(marks[0]!));
      for (const id of parts.slice(1)) strategy.lockChunk(id);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(30_000))), 'Bdoc'), rawWords(before, 'Bdoc'));
      assert.ok(strategy.isNarrowed(marks[0]!));
      await cm.close();
    });
  });

  it('an error from a narrowed select leaves the refused select\'s frontier and preview', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      strategy.refusals = [];
      // The narrowed select plans, setting its own frontier, and then fails.
      strategy.failNarrowedAfterPlanning = true;
      await assert.rejects(cm.compile(budget(30_000)), /select failed/);
      strategy.failNarrowedAfterPlanning = false;
      assert.ok(!strategy.isNarrowed(marks[0]!));
      assert.strictEqual(strategy.getHotContextSettings().currentFrontierTokens, strategy.refusals[0]!.actual);
      await cm.close();
    });
  });

  it('the warning names a named mark and its part, and gives the whole reading\'s refusal', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000, 'spec']], budget: 30_000 });
      strategy.refusals = [];
      await cm.compile(budget(30_000));
      const refusal = strategy.refusals[0]!;
      const said = narrowingWarnings(out);
      assert.strictEqual(said.length, 1);
      assert.ok(said[0]!.startsWith(`autobio: document mark "spec" (${marks[0]}) now covers only message ${strategy.firstIdOf(marks[0]!)}, one part of a message stored in parts, not the whole message. `), said[0]);
      assert.ok(said[0]!.includes(`the compile came to ~${refusal.actual} tokens against a hard budget of ${refusal.budget} (maxTokens 30000).`), said[0]);
      await cm.close();
    });
  });

  it('a provisional calibration multiplier the whole reading is over is dropped before any narrowing, as for any refusal', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const first = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 42_000 });
      first.strategy.saveProvisionalCalibration(1.3);
      await first.cm.close();
      // At 1.3 the whole message is over 42,000 and the narrowed one isn't; at 1 the whole one fits.
      const { cm, strategy } = await open(dir);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      assert.ok(!strategy.isNarrowed(first.marks[0]!));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      const calibration = cm.getRenderStats()!.calibration!;
      assert.deepStrictEqual([calibration.multiplier, calibration.reset?.discardedMultiplier], [1, 1.3]);
      await cm.close();
    });
  });

  it('a mark whose other parts aren\'t summarized yet frees nothing, so another mark\'s narrowing doesn\'t take it along', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      const { cm, strategy } = await open(dir);
      await history(cm);
      // C's parts are summarized; B's, which arrive after, aren't, with no tick since.
      const c = cm.markDocument(cm.addMessage('user', words('Cdoc', 3000)));
      await traffic(cm, 120);
      await ready(cm);
      const b = cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)));
      await traffic(cm, 60, 'later');
      for (let max = 80_000; !strategy.isNarrowed(c) && max > 10_000; max -= 1_000) {
        try {
          await cm.compile(budget(max));
        } catch (err) {
          if (!(err instanceof OverBudgetError)) throw err;
        }
      }
      assert.ok(strategy.isNarrowed(c), 'C was narrowed');
      assert.ok(!strategy.isNarrowed(b), 'B was not');
      await cm.close();
    });
  });

  it('unpinning a narrowed mark and marking the message again covers it whole', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      const { cm, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      await cm.compile(budget(30_000));
      const b = cm.listPins()[0]!.firstMessageId;
      assert.ok(cm.unpin(marks[0]!));
      cm.markDocument(b);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('a new mark on a long message narrows as it stops fitting, with no compile refused', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir);
      const turn = async (content: ContentBlock[], role: 'user' | 'assistant') => {
        cm.addMessage(role, content);
        const request = sent(await cm.compile(budget(30_000)));
        await ready(cm);
        return request;
      };
      for (let i = 0; i < 6; i++) await turn(words(`hist${i}`, 200), i % 2 ? 'assistant' : 'user');
      const mark = cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)));
      let last: Sent[] = [];
      for (let i = 0; i < 120; i++) last = await turn(words(`event${i}`, 200), i % 2 ? 'assistant' : 'user');
      assert.ok(strategy.isNarrowed(mark));
      assert.strictEqual(narrowingWarnings(out).length, 1);
      assert.match(narrowingWarnings(out)[0]!, new RegExp(`document mark ${mark} now covers only message `));
      assert.deepStrictEqual(rawWords(last, 'Bdoc'), allOf(763));
      await cm.close();
    });
  });

  it('narrows the mark whose whole message adds the most first, and no more than the compile needs', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      // Both whole need about 40,800; B narrowed alone, about 25,200; C narrowed alone, about 38,700.
      // C is marked first, so taking the first mark that frees anything would narrow C.
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Cdoc', 1500], ['Bdoc', 6000]], budget: 30_000 });
      const request = sent(await cm.compile(budget(30_000)));
      assert.deepStrictEqual(marks.map((m) => strategy.isNarrowed(m)), [false, true]);
      assert.deepStrictEqual(rawWords(request, 'Cdoc'), allOf(1500));
      assert.strictEqual(narrowingWarnings(out).length, 1);
      assert.match(narrowingWarnings(out)[0]!, new RegExp(`document mark ${marks[1]} `));
      await cm.close();
    });
  });

  it('narrows a second mark, after the first, when the first alone doesn\'t let the compile through', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      // Both narrowed need about 23,000; B narrowed alone, about 25,200.
      const { cm, strategy, marks, before } = await upgradedStore(dir, { bodies: [['Bdoc', 6000], ['Cdoc', 1500]], budget: 24_000 });
      assert.deepStrictEqual(sent(await cm.compile(budget(24_000))), before);
      assert.deepStrictEqual(marks.map((m) => strategy.isNarrowed(m)), [true, true]);
      const said = narrowingWarnings(out);
      assert.strictEqual(said.length, 2);
      assert.match(said[0]!, new RegExp(`document mark ${marks[0]} `));
      assert.match(said[1]!, new RegExp(`document mark ${marks[1]} `));
      // The refusal's total had both whole, and each warning says so.
      for (const w of said) assert.ok(w.includes('With the 2 pins narrowed here covering their whole messages, the compile came to ~'), w);
      await cm.close();
    });
  });

  it('two marks on one message: narrowing one frees nothing while the other covers the message, so both are narrowed', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir);
      await history(cm);
      const parts = partsOf(cm, cm.addMessage('user', words('Bdoc', 6000)));
      const first = cm.markDocument(parts[0]!);
      const second = cm.markDocument(parts[2]!);
      strategy.setNarrowed(first, true);
      strategy.setNarrowed(second, true);
      await traffic(cm, 360);
      await ready(cm);
      const before = sent(await cm.compile(budget(30_000)));
      strategy.setNarrowed(first, false);
      strategy.setNarrowed(second, false);
      assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), before);
      assert.deepStrictEqual([strategy.isNarrowed(first), strategy.isNarrowed(second)], [true, true]);
      assert.strictEqual(narrowingWarnings(out).length, 2);
      await cm.close();
    });
  });

  it('doesn\'t narrow a mark whose message lies in the recent window, which is sent raw either way', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      // A recent window of 20,000. B, marked before the upgrade, is in the middle; C, 6,000 words marked
      // now, is in the recent window. Both whole need about 39,100; B narrowed, about 33,900, with C whole
      // or not. C's whole message adds more than B's, so without the window check C would go first.
      const { cm, strategy } = await open(dir, 'adaptive', 20_000);
      await history(cm);
      const b = cm.markDocument(cm.addMessage('user', words('Bdoc', 2500)));
      strategy.setNarrowed(b, true);
      await traffic(cm, 360);
      const c = cm.markDocument(cm.addMessage('user', words('Cdoc', 6000)));
      await ready(cm);
      strategy.setNarrowed(b, false);
      const request = sent(await cm.compile(budget(36_000)));
      assert.deepStrictEqual([strategy.isNarrowed(b), strategy.isNarrowed(c)], [true, false]);
      assert.deepStrictEqual(rawWords(request, 'Cdoc'), allOf(6000));
      assert.strictEqual(narrowingWarnings(out).length, 1);
      await cm.close();
    });
  });

  it('a mark whose message is in the head window frees nothing, so a refusal runs no select again', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      // A head window of 25,000 holds the history and the whole 6,000-word message.
      const { cm, strategy } = await open(dir, 'adaptive', 8000, { headWindowTokens: 25_000 });
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 6000));
      const mark = cm.markDocument(b);
      await traffic(cm, 360);
      await ready(cm);
      const all = viewOf(cm).getAll();
      const last = all.findIndex((m) => m.id === partsOf(cm, b).at(-1));
      assert.ok(strategy.headEnd(viewOf(cm) as never) > last, 'the head holds the whole message');
      // Lower the budget until a compile is refused for its middle, where narrowing would free nothing.
      let refused: OverBudgetError | undefined;
      let ran = 0;
      for (let max = 44_000; !refused && max > 20_000; max -= 1_000) {
        const selects = strategy.selects;
        try {
          await cm.compile(budget(max));
        } catch (err) {
          assert.ok(err instanceof OverBudgetError);
          refused = err;
          ran = strategy.selects - selects;
        }
      }
      assert.ok(refused && refused.diagnostics.middleTokens > 0, 'refused for its middle');
      assert.strictEqual(ran, 1, 'nothing to narrow, so no select again');
      assert.ok(!strategy.isNarrowed(mark));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      await cm.close();
    });
  });

  it('after a head-window reset, a mark in the history before the head frees its message once it leaves the recent window', async (t) => {
    await withDir(async (dir) => {
      warnings(t);
      // A recent window of 20,000. The marked message is history before the head, which the selects fold.
      const { cm, strategy } = await open(dir, 'adaptive', 20_000);
      await history(cm);
      const b = cm.addMessage('user', words('Bdoc', 2500));
      const mark = cm.markDocument(b);
      await cm.resetHeadWindow('A new topic.');
      const narrows = async (): Promise<boolean> => {
        for (let max = 60_000; !strategy.isNarrowed(mark) && max > 8_000; max -= 1_000) {
          try {
            await cm.compile(budget(max));
          } catch (err) {
            if (!(err instanceof OverBudgetError)) throw err;
          }
        }
        return strategy.isNarrowed(mark);
      };
      const positions = () => {
        const at = viewOf(cm).getAll().findIndex((m) => m.id === b);
        return { at, ...strategy.windows(viewOf(cm) as never) };
      };
      // Within the recent window its parts can't be summarized, so narrowing it would free nothing.
      cm.addMessage('user', words('after', 20));
      await ready(cm);
      const inRecent = positions();
      assert.ok(inRecent.at > inRecent.recentStart && inRecent.at < inRecent.headStart, JSON.stringify(inRecent));
      assert.strictEqual(await narrows(), false);
      // Out of it, they're summarized, and narrowing it frees them.
      await traffic(cm, 120);
      await ready(cm);
      const outOfRecent = positions();
      assert.ok(outOfRecent.at < outOfRecent.recentStart && outOfRecent.at < outOfRecent.headStart, JSON.stringify(outOfRecent));
      assert.strictEqual(await narrows(), true);
      await cm.close();
    });
  });

  it('narrows a range pin to its own ids, warning in a range\'s words, and sends the request it sent before', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir);
      await history(cm);
      const bParts = partsOf(cm, cm.addMessage('user', words('Bdoc', 6000)));
      const cParts = partsOf(cm, cm.addMessage('user', words('Cdoc', 1500)));
      // From B's last part to C's first: whole, both messages; by its ids, B's last part and C's first.
      const range = cm.pinRange(bParts.at(-1)!, cParts[0]!);
      strategy.setNarrowed(range, true);
      await traffic(cm, 360);
      await ready(cm);
      const before = sent(await cm.compile(budget(30_000)));
      strategy.setNarrowed(range, false);
      assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), before);
      assert.ok(strategy.isNarrowed(range));
      const said = narrowingWarnings(out);
      assert.strictEqual(said.length, 1);
      assert.match(said[0]!, new RegExp(`^autobio: pin ${range} now covers only messages ${bParts.at(-1)} to ${cParts[0]}, `));
      assert.match(said[0]!, new RegExp(`unpin ${range} and pin the range again\\.`));
      await cm.close();
    });
  });

  it('a refusal narrowing doesn\'t answer puts the mark back and stands as it was, preview included', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      // At 15,000 the narrowed request is over too.
      const preview = cm.previewContext(budget(15_000))!;
      assert.ok(!strategy.isNarrowed(marks[0]!), 'the dry compile kept nothing');
      const selects = strategy.selects;
      let thrown: OverBudgetError | undefined;
      await assert.rejects(cm.compile(budget(15_000)), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError);
        thrown = err;
        return true;
      });
      assert.strictEqual(strategy.selects - selects, 2, 'the refused select and one narrowed');
      assert.ok(!strategy.isNarrowed(marks[0]!));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      // A preview reports the plan the refusal describes, not a narrowed retry's, and so does the frontier.
      assert.strictEqual(preview.fits, false);
      assert.strictEqual(preview.finalTokens, thrown!.actual);
      assert.strictEqual(strategy.getHotContextSettings().currentFrontierTokens, thrown!.actual);
      // The refusal thrown is the whole reading's: the narrowed reading's is smaller.
      strategy.setNarrowed(marks[0]!, true);
      await assert.rejects(cm.compile(budget(15_000)), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError);
        assert.ok(thrown!.actual > err.actual, `whole ${thrown!.actual}, narrowed ${err.actual}`);
        return true;
      });
      strategy.setNarrowed(marks[0]!, false);
      // Put back whole: the next compile with room sends it whole.
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('a refusal while nothing the mark covers is summarized narrows nothing, and the whole message goes out once compression catches up', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir);
      await history(cm);
      const mark = cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)));
      // No tick while 360 messages arrive: nothing after the message is summarized.
      await traffic(cm, 360);
      const selects = strategy.selects;
      await assert.rejects(cm.compile(budget(42_000)), OverBudgetError);
      assert.strictEqual(strategy.selects - selects, 1, 'no narrowed select ran');
      assert.ok(!strategy.isNarrowed(mark));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      await ready(cm);
      assert.deepStrictEqual(rawWords(sent(await cm.compile(budget(42_000))), 'Bdoc'), allOf(6000));
      await cm.close();
    });
  });

  it('under a solver that reads no bounds, a mark with a level cap renders raw and is narrowed like any', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir);
      await history(cm);
      const mark = cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)), { maxLevel: 1 });
      strategy.setNarrowed(mark, true);
      await traffic(cm, 360);
      await ready(cm);
      const before = sent(await cm.compile(budget(30_000)));
      strategy.setNarrowed(mark, false);
      assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), before);
      assert.ok(strategy.isNarrowed(mark));
      assert.strictEqual(narrowingWarnings(out).length, 1);
      await cm.close();
    });
  });

  it('kv-unified: a mark with a level cap isn\'t narrowed, so a refusal runs no select again', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir, 'kv-unified');
      await history(cm);
      const mark = cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)), { maxLevel: 1 });
      await traffic(cm, 360);
      await ready(cm);
      const selects = strategy.selects;
      await assert.rejects(cm.compile(budget(12_000)), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError);
        assert.ok(err.diagnostics.middleTokens > 0, 'refused for its middle');
        return true;
      });
      assert.strictEqual(strategy.selects - selects, 1);
      assert.ok(!strategy.isNarrowed(mark));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      await cm.close();
    });
  });

  it('a refusal the head and recent windows alone cause narrows nothing and runs no select again', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy } = await open(dir);
      await history(cm);
      const mark = cm.markDocument(cm.addMessage('user', words('Bdoc', 6000)));
      await traffic(cm, 360);
      await ready(cm);
      // A recent window of 8,000 doesn't fit 6,000.
      const selects = strategy.selects;
      await assert.rejects(cm.compile(budget(6_000)), (err: unknown) => {
        assert.ok(err instanceof OverBudgetError);
        assert.strictEqual(err.diagnostics.middleTokens, 0);
        return true;
      });
      assert.strictEqual(strategy.selects - selects, 1);
      assert.ok(!strategy.isNarrowed(mark));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      await cm.close();
    });
  });

  it('a dry compile narrows for itself only: it sends what the live compile will, and keeps and warns nothing', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks, before } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      const dry = sent(await cm.compile(budget(30_000), undefined, { dryRun: true }));
      assert.deepStrictEqual(dry, before);
      assert.ok(!strategy.isNarrowed(marks[0]!));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), dry);
      assert.ok(strategy.isNarrowed(marks[0]!));
      assert.strictEqual(narrowingWarnings(out).length, 1);
      await cm.close();
    });
  });

  it('a select that fails while narrowing puts the marks back and fails the compile with its error', async (t) => {
    await withDir(async (dir) => {
      const out = warnings(t);
      const { cm, strategy, marks, before } = await upgradedStore(dir, { bodies: [['Bdoc', 6000]], budget: 30_000 });
      strategy.failWhileNarrowed = true;
      await assert.rejects(cm.compile(budget(30_000)), /select failed/);
      strategy.failWhileNarrowed = false;
      assert.ok(!strategy.isNarrowed(marks[0]!));
      assert.deepStrictEqual(narrowingWarnings(out), []);
      assert.deepStrictEqual(sent(await cm.compile(budget(30_000))), before);
      await cm.close();
    });
  });
});
