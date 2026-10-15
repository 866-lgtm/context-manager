/**
 * Credit exhaustion never spends a bounded retry budget (2026-10-15).
 *
 * The compression provider answered `402 insufficient_credits` whenever the
 * account's credit balance dipped below a request's cost. Membrane surfaced
 * that as `unknown, retryable: false`; the merge path reads retryable:false as
 * "this request fails identically forever" and routes it through the bounded
 * attempt policy — so an L3 merge spent all five attempts inside one second
 * and went to the durable merge quarantine, while the next compression call
 * two minutes later succeeded. The same shape reached the L1 fallback rungs,
 * where an unanswered rung counted as a rung outcome toward chunk quarantine.
 *
 * Invariant: a rate limit or credit exhaustion — in either the legacy
 * (`unknown`, retryable:false) or the classified (`rate_limit`, 402) shape —
 * is rethrown with no attempt accounting and no quarantine; the next tick
 * retries the identical work. Deterministic failures keep the bounded policy.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { isTransientAccountError } from '../src/strategies/autobiographical.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

const BASE = './test-credit-exhaustion';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
function cleanup(): void { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); }

const t = (s: string): ContentBlock => ({ type: 'text', text: s });

/** The VoidAI response body of 2026-10-15, as the adapter wraps it. */
const VOIDAI_402 =
  'API error: 402 {"error":{"message":"Insufficient credits. You have 241833 credits remaining.",' +
  '"type":"api_error","code":"insufficient_credits"}}';
/** How a membrane without the 402 classification surfaced it (the live incident). */
const legacy402 = (): Error => Object.assign(new Error(VOIDAI_402), { type: 'unknown', retryable: false });
/** How the classified membrane surfaces it. */
const classified402 = (): Error =>
  Object.assign(new Error(VOIDAI_402), { type: 'rate_limit', retryable: true, httpStatus: 402 });

type Step = { stop: 'end_turn' | 'refusal'; text?: string } | { error: () => Error };

/** Answers call N with steps[N] (the last step repeats); `steps` may be swapped mid-test. */
function scripted(initial: Step[]) {
  const calls: NormalizedRequest[] = [];
  const state = { steps: initial, offset: 0 };
  return {
    calls,
    /** Replace the script from the next call on (e.g. "credits refilled"). */
    then(steps: Step[]): void { state.steps = steps; state.offset = calls.length; },
    membrane: {
      complete: async (request: NormalizedRequest) => {
        const i = calls.length - state.offset;
        const step = state.steps[i] ?? state.steps[state.steps.length - 1]!;
        calls.push(structuredClone(request));
        if ('error' in step) throw step.error();
        return {
          stopReason: step.stop,
          content: step.text ? [t(step.text)] : [],
          usage: { inputTokens: 100, outputTokens: step.text ? 20 : 0 },
          ...(step.stop === 'refusal' ? { raw: { response: { stop_details: { category: 'cyber' } } } } : {}),
        };
      },
    } as never,
  };
}

class Probe extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  qMerge(level: number, sourceIds: string[]): void { this.enqueueMerge({ level, sourceIds }); }
  mergeQueueView(): Array<{ level: number; sourceIds: string[]; attempts?: number }> {
    return this.mergeQueue.map((item) => ({ ...item, sourceIds: [...item.sourceIds] }));
  }
  summariesView(): SummaryEntry[] { return [...this.summaries]; }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
}

function ctx(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}

function storedMergeQuarantine(manager: ContextManager): unknown[] {
  const value = manager.getStore().getStateJson('default/autobio:merge-quarantine');
  return Array.isArray(value) ? value : [];
}

/** Two seeded L1s over real messages with a level-2 merge queued; tick() drives the real executeMerge. */
async function mergeFixture(membrane: unknown, options: Record<string, unknown> = {}) {
  const strategy = new Probe({
    compressionModel: 'same-model',
    hierarchical: true,
    targetChunkTokens: 100_000, // chunks never close — merge path only
    recentWindowTokens: 0,
    headWindowTokens: 0,
    autoTickOnNewMessage: false,
    mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0,
    ...options,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 8; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`raw-${i} ` + 'substance '.repeat(10))]));
  const l1 = (id: string, a: number, b: number): SummaryEntry => ({
    id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
    sourceIds: [ids[a]!, ids[b]!], sourceRange: { first: ids[a]!, last: ids[b]! }, created: 1,
  });
  strategy.seed(l1('L1-100', 0, 1));
  strategy.seed(l1('L1-101', 2, 3));
  strategy.qMerge(2, ['L1-100', 'L1-101']);
  return { manager, strategy };
}

/** A real store with a seeded L1 recall pair and a two-message target chunk (L1 ladder path). */
async function chunkFixture(membrane: unknown, options: Record<string, unknown> = {}) {
  const strategy = new Probe({
    compressionModel: 'same-model',
    targetChunkTokens: 100,
    recentWindowTokens: 0,
    headWindowTokens: 100_000,
    autoTickOnNewMessage: false,
    minChunkCharsForLLM: 0,
    mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0,
    compressionSourceOnlyFallback: true,
    compressionRefusalCurveFallbacks: 0,
    ...options,
  } as never);
  const manager = await ContextManager.open({ path: freshPath(), strategy, membrane: membrane as never });
  const ids: string[] = [];
  for (let i = 0; i < 12; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`raw-${i} ` + 'substantive '.repeat(12))]));
  strategy.seed({
    id: 'L1-100', level: 1, content: 'authored L1-100', tokens: 20, sourceLevel: 0,
    sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! }, created: 100,
  });
  const targetMessages = ctx(manager).messageStore.getAll().filter((m) => [ids[10]!, ids[11]!].includes(m.id));
  const target: Chunk = { index: 999, startIndex: 10, endIndex: 12, messages: targetMessages, tokens: 100, compressed: false };
  return { manager, strategy, ids, target };
}

describe('isTransientAccountError', () => {
  it('recognizes credit exhaustion and rate limits in every shape membrane has used', () => {
    assert.equal(isTransientAccountError(legacy402()), true, 'legacy unknown/retryable:false 402');
    assert.equal(isTransientAccountError(classified402()), true, 'classified rate_limit/402');
    assert.equal(isTransientAccountError(Object.assign(new Error('slow down'), { type: 'rate_limit', retryable: true })), true);
    assert.equal(isTransientAccountError({ httpStatus: 402, message: 'payment' }), true);
    assert.equal(isTransientAccountError(new Error('You exceeded your current quota [insufficient_quota]')), true);
    assert.equal(isTransientAccountError(new Error('OpenRouter error: 402 {"error":{"message":"requires more credits"}}')), true);
  });

  it('leaves deterministic failures and bare numbers alone', () => {
    assert.equal(isTransientAccountError(Object.assign(new Error('API error: 400 context too long'), {
      type: 'context_length', retryable: false,
    })), false);
    assert.equal(isTransientAccountError(Object.assign(new Error('API error: 500 boom'), { type: 'server', retryable: true })), false);
    assert.equal(isTransientAccountError(new Error('summary came out 402 tokens over target')), false);
    assert.equal(isTransientAccountError(new Error('API error: 400 messages[402] malformed')), false);
    assert.equal(isTransientAccountError(null), false);
    assert.equal(isTransientAccountError('API error: 402'), false, 'non-objects are not provider errors');
  });
});

describe('merge path under credit exhaustion', () => {
  after(cleanup);

  for (const [label, make] of [['legacy (unknown, retryable:false)', legacy402], ['classified (rate_limit, 402)', classified402]] as const) {
    it(`a ${label} 402 is rethrown with no attempt burn, past the attempt limit, then the merge lands`, async () => {
      const mock = scripted([{ error: make }]);
      const fx = await mergeFixture(mock.membrane, { mergeAttemptLimit: 2 });

      // Twice the attempt limit: under the old policy the merge would have
      // been quarantined after the second tick.
      for (let i = 0; i < 4; i++) {
        await assert.rejects(fx.strategy.tick(ctx(fx.manager)), /402/, `tick ${i + 1} rethrows`);
        assert.equal(fx.strategy.mergeQueueView().length, 1, 'entry stays queued');
        assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, undefined, 'no attempt accounting');
      }
      assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0, 'never quarantined');
      assert.equal(storedMergeQuarantine(fx.manager).length, 0);

      // Credits refill: the identical queued merge now succeeds.
      mock.then([{ stop: 'end_turn', text: 'Consolidated after the refill.' }]);
      await fx.strategy.tick(ctx(fx.manager));
      const parent = fx.strategy.summariesView().find((s) => s.level === 2);
      assert.equal(parent?.content, 'Consolidated after the refill.');
      assert.equal(fx.strategy.mergeQueueView().length, 0);
      await fx.manager.close();
    });
  }

  it('control: a deterministic non-retryable error still spends the attempt budget into quarantine', async () => {
    const invalid = () => Object.assign(new Error('API error: 400 invalid_request: bad field'), {
      type: 'invalid_request', retryable: false,
    });
    const fx = await mergeFixture(scripted([{ error: invalid }]).membrane, { mergeAttemptLimit: 2 });
    await fx.strategy.tick(ctx(fx.manager));
    await fx.strategy.tick(ctx(fx.manager));
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 1, 'bounded policy unchanged for real rejections');
    await fx.manager.close();
  });

  it('a 402 during refusal escalation surfaces as the 402, not as the original refusal', async () => {
    // The escalation retry never got an answer; reporting the original
    // (non-retryable) content-filter error instead would charge the merge
    // an attempt for a credit dip.
    const blocked = () => Object.assign(new Error('content_filter: output blocked'), { type: 'safety', retryable: false });
    const mock = scripted([{ error: blocked }, { error: legacy402 }]);
    const fx = await mergeFixture(mock.membrane, {
      mergeAttemptLimit: 1,
      compressionRefusalSystemPrompt: 'heavy escalation prompt',
    });
    await assert.rejects(fx.strategy.tick(ctx(fx.manager)), /402/);
    assert.equal(mock.calls.length, 2, 'canonical + one escalation');
    assert.equal(fx.strategy.mergeQueueView()[0]?.attempts, undefined, 'no attempt charged');
    assert.equal(fx.strategy.getMergeQuarantineStatus().count, 0);
    await fx.manager.close();
  });
});

describe('L1 fallback rungs under credit exhaustion', () => {
  after(cleanup);

  it('a 402 on the source-only final rung aborts the family without quarantining the chunk', async () => {
    const mock = scripted([{ stop: 'refusal' }, { error: legacy402 }]);
    const fx = await chunkFixture(mock.membrane);

    await assert.rejects(fx.strategy.run(fx.target, ctx(fx.manager)), /402/);
    assert.equal(mock.calls.length, 2, 'canonical refused, then the source-only rung hit the 402');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, 'no chunk quarantine for an unanswered rung');
    assert.equal(fx.target.compressed, false, 'chunk stays queued for a later tick');

    // Credits refill: the same ladder completes on the next attempt.
    mock.then([{ stop: 'refusal' }, { stop: 'end_turn', text: 'memory formed after the refill' }]);
    await fx.strategy.run(fx.target, ctx(fx.manager));
    assert.equal(fx.target.compressed, true);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    await fx.manager.close();
  });

  it('a 402 on a recall-variant rung stops the ladder before any further paid rung', async () => {
    const mock = scripted([{ stop: 'refusal' }, { error: classified402 }]);
    const fx = await chunkFixture(mock.membrane, { compressionRefusalCurveFallbacks: 1 });
    // An L2 parent over two L1 children gives the curve a frontier to expand.
    const childA: SummaryEntry = {
      id: 'L1-300', level: 1, content: 'authored L1-300', tokens: 20, sourceLevel: 0,
      sourceIds: [fx.ids[4]!, fx.ids[5]!], sourceRange: { first: fx.ids[4]!, last: fx.ids[5]! }, created: 300,
      mergedInto: 'L2-302',
    };
    const childB: SummaryEntry = {
      id: 'L1-301', level: 1, content: 'authored L1-301', tokens: 20, sourceLevel: 0,
      sourceIds: [fx.ids[6]!, fx.ids[7]!], sourceRange: { first: fx.ids[6]!, last: fx.ids[7]! }, created: 301,
      mergedInto: 'L2-302',
    };
    fx.strategy.seed(childA);
    fx.strategy.seed(childB);
    fx.strategy.seed({
      id: 'L2-302', level: 2, content: 'authored parent', tokens: 20, sourceLevel: 1,
      sourceIds: ['L1-300', 'L1-301'], sourceRange: { first: fx.ids[4]!, last: fx.ids[7]! }, created: 302,
    });

    await assert.rejects(fx.strategy.run(fx.target, ctx(fx.manager)), /402/);
    assert.equal(mock.calls.length, 2, 'canonical + the variant that hit the 402; source-only never dispatched');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    await fx.manager.close();
  });

  it('control: a refusal on the final rung still quarantines the chunk', async () => {
    const fx = await chunkFixture(scripted([{ stop: 'refusal' }]).membrane);
    await fx.strategy.run(fx.target, ctx(fx.manager));
    assert.ok(fx.strategy.getCompressionQuarantineStatus().count >= 1);
    await fx.manager.close();
  });
});
