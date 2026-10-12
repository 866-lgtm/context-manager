import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest, ToolDefinition } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import { boundFailureLogText } from '../src/strategies/autobiographical.js';
import { createHash } from 'node:crypto';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { StrategyContext, SummaryEntry } from '../src/types/index.js';

// Transient failures never spend the ladder (room-225 L3, brosefo incident).
//
// A provider failure that is not evidence about the request (capacity,
// transport, credentials, anything unclassified) used to be recorded as a
// rung's `provider_error` and the ladder carried on, so an outage could
// exhaust a viable family into quarantine. And between ticks nothing paced
// the lane: a 429 asking for 30 s was retried on every maintenance pass.
// Now: a deterministic rejection is a rung's outcome; a transient failure
// stops the ladder, keeps its durable progress, pauses the lane and
// resumes at the interrupted rung on a later tick.

const BASE = './test-compression-transient-ladder';
let sequence = 0;
const paths: string[] = [];
function freshPath(): string { const p = `${BASE}-${sequence++}`; paths.push(p); return p; }
after(() => { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); });

const text = (t: string): ContentBlock => ({ type: 'text', text: t });
const use = (id: string, name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id, name, input } as ContentBlock);
const result = (id: string, content: string): ContentBlock =>
  ({ type: 'tool_result', toolUseId: id, content } as ContentBlock);
const DIARY = 'I weighed the thread and decided to stay quiet. '.repeat(12);

const REFUSAL = { content: [], stopReason: 'refusal', usage: { inputTokens: 100, outputTokens: 0 }, raw: { response: { stop_details: { category: 'reasoning_extraction' } } } };
const OK = (t: string) => ({ content: [text(t)], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } });
const failure = (type: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`zz ${type} failure`), { type, retryable: type !== 'context_length' && type !== 'invalid_request', ...extra });

type Step = typeof REFUSAL | ReturnType<typeof OK> | { throw: unknown } | { gate: Promise<void>; then: Step };
function scripted(steps: Step[]) {
  const calls: NormalizedRequest[] = [];
  return {
    calls,
    membrane: {
      complete: async (request: NormalizedRequest) => {
        let step = steps[Math.min(calls.length, steps.length - 1)]!;
        calls.push(structuredClone(request));
        while ('gate' in step) { await step.gate; step = step.then; }
        if ('throw' in step) throw step.throw;
        return step;
      },
    } as never,
  };
}

interface RawPause { backoffUntil: number; statedUntil: number | null; statedBy: 'provider' | 'admission' | null; failures: number; model: string | undefined; reason: string }

class ProbeStrategy extends AutobiographicalStrategy {
  seed(entry: SummaryEntry): void { this.pushSummary(entry); }
  run(chunk: Chunk, ctx: StrategyContext): Promise<void> { return this.compressChunkHierarchical(chunk, ctx); }
  summariesView(): SummaryEntry[] { return [...this.summaries]; }
  chunksView(): Chunk[] { return [...this.chunks]; }
  compressionQueueView(): number[] { return [...this.compressionQueue]; }
  setCompressionModel(model: string): void { this.config.compressionModel = model; }
  private lanePause(): RawPause | null {
    return (this as unknown as { compressionPause: RawPause | null }).compressionPause;
  }
  /** The lane's pause as it binds: the later of its backoff and the provider's stated wait. */
  pause(): (RawPause & { until: number; source: 'retry-after' | 'backoff' }) | null {
    const pause = this.lanePause();
    if (!pause) return null;
    const until = Math.max(pause.backoffUntil, pause.statedUntil ?? 0);
    const source = pause.statedUntil !== null && pause.statedUntil > pause.backoffUntil ? 'retry-after' : 'backoff';
    return { ...pause, until, source };
  }
  /** Whether the lane is paused now (a pause whose constraints have all passed binds nothing). */
  paused(): boolean {
    const pause = this.pause();
    return pause !== null && pause.until > Date.now();
  }
  /** Stand for time passing: every finite constraint has elapsed. */
  expirePause(): void {
    const pause = this.lanePause();
    if (!pause) return;
    pause.backoffUntil = 0;
    if (pause.statedUntil !== null && Number.isFinite(pause.statedUntil)) pause.statedUntil = 0;
  }
  /** Note a transient failure as the lane does (white-box: a concurrent operation's error). */
  notePause(error: unknown, ctx: StrategyContext): void {
    const self = this as unknown as {
      captureCompressionBranch(): unknown;
      pauseCompressionLane(source: unknown, ctx: StrategyContext, error: unknown, lane: 'l1' | 'merge', subject: string): void;
    };
    self.pauseCompressionLane(self.captureCompressionBranch(), ctx, error, 'l1', 'the probe');
  }
  /** Stand for other compression landing on `membrane` and `model` (white-box): that domain's evidence advances. */
  land(membrane: unknown, model = 'same-model'): void {
    (this as unknown as { noteCompressionLanded(membrane: unknown, model: string): void }).noteCompressionLanded(membrane, model);
  }
  mergeCandidates(unmerged: SummaryEntry[], threshold: number): SummaryEntry[] | null {
    return this.contiguousMergeCandidates(unmerged, threshold);
  }
  /** White-box clock for the progress sweep's cadence: as if it last ran `ago` ms ago. */
  progressSweptAgo(ago: number): void {
    (this as unknown as { compressionProgressSweptAt: number }).compressionProgressSweptAt = Date.now() - ago;
  }
  /** Per-branch warning state (white-box). */
  warnedSkips(): Set<string> {
    return (this as unknown as { warnedQuarantineSkips: Set<string> }).warnedQuarantineSkips;
  }
  /** Set the pause's constraints relative to now (white-box clock for the release seam). */
  shiftPause(backoffFromNow: number, statedFromNow: number | null): void {
    const pause = this.lanePause()!;
    pause.backoffUntil = Date.now() + backoffFromNow;
    pause.statedUntil = statedFromNow === null ? null : Date.now() + statedFromNow;
  }
}
function managerContext(manager: ContextManager): StrategyContext {
  return (manager as unknown as { createStrategyContext(): StrategyContext }).createStrategyContext();
}
/** The strategy's request identity (sha256 of the request's JSON). */
const sha256 = (request: NormalizedRequest): string => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const tool = (name: string): ToolDefinition => ({ name, description: 'd', inputSchema: { type: 'object', properties: {} } } as never);
/** Wait for the first provider call, failing rather than hanging if it never comes. */
async function firstCall(calls: unknown[], ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (calls.length === 0) {
    if (Date.now() > deadline) assert.fail('the provider was never called');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
const progressSlot = (manager: ContextManager): unknown[] => {
  const value = manager.getStore().getStateJson('default/autobio:compression-family-progress');
  return Array.isArray(value) ? value : [];
};

interface Opts { hoist?: boolean; sourceOnlyFallback?: boolean; path?: string }
function config(opts: Opts) {
  return {
    compressionModel: 'same-model', targetChunkTokens: 100, recentWindowTokens: 0, headWindowTokens: 100_000,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, mergeThreshold: 99, quarantineAlarmIntervalMs: 0,
    compressionRefusalCurveFallbacks: 0,
    compressionSourceOnlyFallback: opts.sourceOnlyFallback,
    ...(opts.hoist ? { compressionToolProseFallback: { intoTool: 'journal', fromTools: ['skip_reply'] } } : {}),
  } as never;
}
/** The tool-prose-hoist fixture's shape: a head, one seeded L1, and a target chunk with a long skip_reply. */
async function build(membrane: unknown, opts: Opts = {}) {
  const path = opts.path ?? freshPath();
  const strategy = new ProbeStrategy(config(opts));
  const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
  manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
  let ids: string[] = manager.queryMessages({}).messages.map((m) => m.id);
  if (ids.length === 0) {
    for (let i = 0; i < 10; i++) ids.push(manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'substantive '.repeat(12))]));
    ids.push(manager.addMessage('User', [text('raw-10 ambient chatter ' + 'substantive '.repeat(12))]));
    ids.push(manager.addMessage('Claude', [use('skip1', 'skip_reply', { reason: DIARY, wake_in_seconds: 1500 })]));
    ids.push(manager.addMessage('User', [result('skip1', '{"skipped":true}')]));
    strategy.seed({ id: 'L1-100', level: 1, content: 'authored L1-100', tokens: 20, sourceLevel: 0, sourceIds: [ids[0]!, ids[1]!], sourceRange: { first: ids[0]!, last: ids[1]! }, created: 100 });
  }
  const target = (): Chunk => {
    const want = new Set(ids.slice(10));
    return { index: 999, startIndex: 10, endIndex: 13, messages: managerContext(manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
  };
  return { manager, strategy, ids, target, path };
}
/** The canonical carries the head (raw-2 onward; raw-0/1 render as their L1's recall pair); source-only-final carries only the chunk. */
const isCanonical = (request: NormalizedRequest): boolean =>
  request.messages.some((m) => m.content.some((b) => b.type === 'text' && (b as { text: string }).text.startsWith('raw-2 ')));
const toolNames = (request: NormalizedRequest): string =>
  [...new Set(request.messages.flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => (b as { name: string }).name)))].join('+');

describe('compression ladder: transient failures never spend it', () => {
  it('canonical rejection → source-only-final once; a 503 there interrupts; a restart resumes at source-only and mints, the canonical paid once', async () => {
    const path = freshPath();
    const first = scripted([{ throw: failure('context_length') }, { throw: failure('server', { httpStatus: 503 }) }]);
    const a = await build(first.membrane, { sourceOnlyFallback: true, path });
    await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    assert.equal(first.calls.length, 2);
    assert.ok(isCanonical(first.calls[0]!), 'the canonical first');
    assert.ok(!isCanonical(first.calls[1]!), 'then source-only-final, skipping variants and the canonical hoist');
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'a 503 does not exhaust the family');
    assert.equal(progressSlot(a.manager).length, 1, 'the canonical rejection is kept durably');
    a.manager.close();

    const second = scripted([OK('memory after the outage')]);
    const b = await build(second.membrane, { sourceOnlyFallback: true, path });
    await b.strategy.run(b.target(), managerContext(b.manager));
    assert.equal(second.calls.length, 1, 'only source-only-final: the canonical is not paid again');
    assert.ok(!isCanonical(second.calls[0]!));
    assert.ok(b.strategy.summariesView().some((s) => s.level === 1 && s.content === 'memory after the outage'));
    assert.equal(progressSlot(b.manager).length, 0, 'the mint drops the progress');
    b.manager.close();
  });

  it('a canonical rejection with no source-only rung exhausts after one call: no variants, no hoist', async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane, { hoist: true });
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 1);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'the family is exhausted');
    assert.equal(progressSlot(fx.manager).length, 0, 'the quarantine ledger holds it now, not progress');
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'and stays exhausted');
    fx.manager.close();
  });

  it('a refusal ladder interrupted at its second rung resumes there, without paying the canonical again', async () => {
    const mock = scripted([REFUSAL, { throw: failure('network') }, OK('hoisted memory')]);
    const fx = await build(mock.membrane, { hoist: true });
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.deepEqual(mock.calls.map(toolNames), ['skip_reply', 'journal+skip_reply']);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.deepEqual(mock.calls.map(toolNames), ['skip_reply', 'journal+skip_reply', 'journal+skip_reply'],
      'the canonical refusal is reused; the hoist runs again');
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'hoisted memory'));
    fx.manager.close();
  });

  it('a failure counts against its request only while other work lands on its route and model; the 8th decides it, and a restart starts the count again', async () => {
    const path = freshPath();
    const always503 = () => scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const streak = (manager: ContextManager) =>
      (progressSlot(manager) as Array<{ failureStreak?: { failures: number; failureClass: string } }>)[0]?.failureStreak;
    const first = always503();
    const a = await build(first.membrane, { path, sourceOnlyFallback: true });
    // An outage: nothing lands between the failures, so none adds to the run.
    for (let i = 0; i < 12; i++) {
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'an outage exhausts nothing');
    assert.deepEqual([streak(a.manager)?.failures, streak(a.manager)?.failureClass], [1, 'server:503'],
      'twelve failures with nothing landing are a run of one');
    // Other work lands in the same domain before each of the next six, so each counts.
    for (let i = 0; i < 6; i++) {
      a.strategy.land(first.membrane);
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(streak(a.manager)?.failures, 7);
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'seven is below the bound');
    a.manager.close();

    // A restart: nothing can say the new process's route is the old one, so
    // the stored run's count isn't carried, and the first failure here starts
    // a run of one.
    const second = always503();
    const b = await build(second.membrane, { path, sourceOnlyFallback: true });
    b.strategy.land(second.membrane);
    await assert.rejects(b.strategy.run(b.target(), managerContext(b.manager)), /zz server failure/);
    assert.equal(streak(b.manager)?.failures, 1, 'the first failure after a restart starts a run of one');
    for (let i = 0; i < 6; i++) {
      b.strategy.land(second.membrane);
      await assert.rejects(b.strategy.run(b.target(), managerContext(b.manager)), /zz server failure/);
    }
    assert.equal(b.strategy.getCompressionQuarantineStatus().count, 0);
    b.strategy.land(second.membrane);
    // The eighth decides the canonical: its outcome is persistent-<class>, a
    // deterministic answer like a rejection, so the ladder takes its one
    // different request, source-only-final, which fails the same way here.
    const callsBefore = second.calls.length;
    await assert.rejects(b.strategy.run(b.target(), managerContext(b.manager)), /zz server failure/);
    assert.equal(second.calls.length, callsBefore + 2, 'the canonical, then source-only-final');
    assert.ok(isCanonical(second.calls[callsBefore]!) && !isCanonical(second.calls[callsBefore + 1]!));
    const outcomes = (progressSlot(b.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string; errorType?: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => [o.curveLabel, o.outcome, o.errorType]), [['canonical', 'provider_error', 'persistent-server:503']],
      'the decision is recorded as the canonical\'s answer');
    assert.equal(b.strategy.getCompressionQuarantineStatus().count, 0, 'source-only-final is still owed');
    b.manager.close();
  });

  it('a failure of another class still counts, and an admission deferral changes nothing', async () => {
    const deferral = Object.assign(new Error('zz held; no call was made'), { type: 'rate_limit', retryable: true, providerAdmission: 'deferred' });
    const mock = scripted([
      { throw: failure('server', { httpStatus: 503 }) },
      { throw: failure('server', { httpStatus: 503 }) },
      { throw: failure('server', { httpStatus: 503 }) },
      { throw: deferral },
      { throw: failure('timeout') },
    ]);
    const fx = await build(mock.membrane);
    const streak = () => (progressSlot(fx.manager) as Array<{ failureStreak?: { failures: number; failureClass: string } }>)[0]!.failureStreak!;
    for (let i = 0; i < 3; i++) {
      fx.strategy.land(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    }
    assert.deepEqual([streak().failures, streak().failureClass], [3, 'server:503']);
    fx.strategy.land(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /no call was made/);
    assert.deepEqual([streak().failures, streak().failureClass], [3, 'server:503'], 'a deferral is no failure');
    // The landing before the deferral wasn't spent: the timeout counts against it.
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz timeout failure/);
    assert.deepEqual([streak().failures, streak().failureClass], [4, 'timeout'], 'another class extends the run (sheet I10)');
    fx.manager.close();
  });

  it('progress is never written from stale-branch work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }]);
    const fx = await build(mock.membrane);
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt('zz-fork', main, fx.manager.getStore().currentSequence()).name;
    const run = fx.strategy.run(fx.target(), managerContext(fx.manager));
    await firstCall(mock.calls);
    await fx.manager.switchBranch(fork);
    release();
    await run;
    assert.equal(fx.strategy.pause(), null, 'a discarded failure installs no pause');
    assert.equal(progressSlot(fx.manager).length, 0);
    await fx.manager.switchBranch(main);
    assert.equal(progressSlot(fx.manager).length, 0);
    fx.manager.close();
  });
});

/** Real persisted raw chunks, queued by the strategy itself, so tick() does the work. */
async function queued(membrane: unknown, opts: { path?: string; store?: ReturnType<ContextManager['getStore']>; config?: Record<string, unknown> } = {}) {
  const strategy = new ProbeStrategy({
    compressionModel: 'same-model', targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, l1HoldbackChunks: 0, minChunkCharsForLLM: 0, mergeThreshold: 99,
    quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0,
    ...opts.config,
  } as never);
  const manager = opts.store
    ? await ContextManager.open({ store: opts.store, strategy, membrane: membrane as never })
    : await ContextManager.open({ path: opts.path ?? freshPath(), strategy, membrane: membrane as never });
  if (manager.queryMessages({}).messages.length === 0) {
    for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'word '.repeat(30))]);
  }
  return { strategy, manager };
}

describe('compression lane pacing', () => {
  it("a 429 pauses the lane for the provider's whole stated wait: no call and no queue item consumed until it ends", async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 120_000 }) }, OK('after the wait')]);
    const fx = await queued(mock.membrane);
    const before = Date.now();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz rate_limit failure/);
    assert.equal(mock.calls.length, 1);
    const pause = fx.strategy.pause()!;
    assert.ok(pause.until >= before + 120_000, 'the stated wait outlasts the 30 s backoff and is honoured whole');
    assert.equal(pause.source, 'retry-after');

    const queue = fx.strategy.compressionQueueView();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'no call while paused');
    assert.deepEqual(fx.strategy.compressionQueueView(), queue, 'no queue item consumed while paused');
    const readiness = fx.strategy.checkReadiness();
    assert.match(readiness.description ?? '', /compression paused until .+ \(the provider's stated wait, failure 1\)/);

    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'the next tick after the wait calls again');
    assert.equal(fx.strategy.pause(), null, 'an answer ends the pause');
    fx.manager.close();
  });

  it('the backoff doubles per failure from 30 s and caps at 10 minutes', async () => {
    const mock = scripted([{ throw: failure('network') }]);
    const fx = await queued(mock.membrane);
    const expected = [30, 60, 120, 240, 480, 600, 600];
    for (let i = 0; i < expected.length; i++) {
      // Each failure consumes the chunk it tried; requeue to keep the lane busy.
      await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
      const start = Date.now();
      await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
      const end = Date.now();
      const pause = fx.strategy.pause()!;
      // The backoff runs from the failure, which lies between start and end:
      // bracketed, so a stalled tick can't shift it out of the window.
      assert.ok(pause.until - end <= expected[i]! * 1_000 && expected[i]! * 1_000 <= pause.until - start,
        `failure ${i + 1}: a ${expected[i]} s backoff (${pause.until - end}..${pause.until - start} ms)`);
      assert.equal(pause.source, 'backoff');
      fx.strategy.expirePause();
    }
    fx.manager.close();
  });

  it('a different compression model ignores and clears an old pause', async () => {
    const mock = scripted([{ throw: failure('network') }, OK('other model memory')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    assert.ok(fx.strategy.pause());
    fx.strategy.setCompressionModel('other-model');
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'the other model is called');
    fx.manager.close();
  });

  it('the chunk failure log is a bounded string, never the error object with its request', async () => {
    const huge = Object.assign(new Error('zz short network failure'), {
      type: 'network', retryable: true, rawRequest: { system: 'x'.repeat(1_000_000) },
    });
    const mock = scripted([{ throw: huge }]);
    const fx = await build(mock.membrane);
    const calls: unknown[][] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { calls.push(args); };
    try {
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)));
    } finally { console.error = orig; }
    const line = calls.find((args) => typeof args[0] === 'string' && (args[0] as string).startsWith('Failed to compress chunk'));
    assert.ok(line, 'the failure is logged');
    for (const arg of line!) assert.equal(typeof arg, 'string', 'no object for the runtime to inspect');
    assert.ok((line![0] as string).length < 2_500);
    assert.match(line![0] as string, /Error \(network, retryable=true\): zz short network failure/);
    fx.manager.close();
  });
});

// ---------------------------------------------------------------------------
// Corrective round (Wren-1021's review of 3398926, room-225 #46214, #46271,
// #46345, #46385; Ruth-1049's surrogate-cut gap).
// ---------------------------------------------------------------------------

describe('progress is a shared record, not an instance snapshot (#46214 #1)', () => {
  /** A second strategy and manager on the same JsStore and namespace. */
  async function sibling(store: ReturnType<ContextManager['getStore']>, membrane: unknown, opts: Opts = {}) {
    const strategy = new ProbeStrategy(config(opts));
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
    return { strategy, manager };
  }

  it("a sibling strategy resumes at the rung another one was interrupted at, without paying the canonical again", async () => {
    const first = scripted([{ throw: failure('context_length') }, { throw: failure('server', { httpStatus: 503 }) }]);
    const a = await build(first.membrane, { sourceOnlyFallback: true });
    // B is initialized BEFORE A records anything: an instance snapshot taken
    // at initialize would be stale by the time B runs.
    const second = scripted([OK('memory from the sibling')]);
    const b = await sibling(a.manager.getStore(), second.membrane, { sourceOnlyFallback: true });
    await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    assert.equal(first.calls.length, 2);

    const bChunk = { ...a.target(), messages: a.target().messages.map((m) => managerContext(b.manager).messageStore.get(m.id)!) };
    await b.strategy.run(bChunk, managerContext(b.manager));
    assert.equal(second.calls.length, 1, 'the sibling read the durable canonical rejection');
    assert.ok(!isCanonical(second.calls[0]!), 'and went straight to source-only-final');
    a.manager.close();
  });

  it("each strategy's write keeps the other's families, and one's cleanup leaves the other's", async () => {
    const first = scripted([{ throw: failure('network') }]);
    const a = await build(first.membrane);
    // Both siblings are initialized before either records anything.
    const second = scripted([REFUSAL, { throw: failure('network') }]);
    const b = await sibling(a.manager.getStore(), second.membrane, { hoist: true });
    const third = scripted([OK('A minted')]);
    const a2 = await sibling(a.manager.getStore(), third.membrane);
    await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz network failure/);
    assert.equal(progressSlot(a.manager).length, 1);

    const want = new Set(a.ids.slice(6, 9));
    const other: Chunk = { index: 998, startIndex: 6, endIndex: 9, messages: managerContext(b.manager).messageStore.getAll().filter((m) => want.has(m.id)), tokens: 100, compressed: false };
    await assert.rejects(b.strategy.run(other, managerContext(b.manager)), /zz network failure/);
    assert.equal(progressSlot(a.manager).length, 2, "B's write kept A's family");

    // A's family mints (through a third sibling): its cleanup removes only its own entry.
    const aChunk = { ...a.target(), messages: a.target().messages.map((m) => managerContext(a2.manager).messageStore.get(m.id)!) };
    await a2.strategy.run(aChunk, managerContext(a2.manager));
    const left = progressSlot(a.manager) as Array<{ chunkSourceHash: string; outcomes: Array<{ curveLabel: string }> }>;
    assert.equal(left.length, 1, "A's cleanup left B's family");
    assert.deepEqual(left[0]!.outcomes.map((o) => o.curveLabel), ['canonical'], "B's canonical refusal is still known");
    a.manager.close();
  });
});

describe('the pause holds an unusable deadline explicitly (#46214 #2)', () => {
  it('a finite retry-after past the last Date instant is an indefinite hold: the provider error is what throws, and readiness says so', async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 1e20 }) }, OK('after the release')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz rate_limit failure/);
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, Number.POSITIVE_INFINITY);
    assert.equal(pause.source, 'retry-after');
    assert.match(fx.strategy.checkReadiness().description ?? '', /cannot be held as an instant/);
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'time passing does not end it');
    assert.equal(fx.strategy.releaseCompressionPause(), true, 'an explicit release does');
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });
});

describe('the pause belongs to the call that failed (#46271 #3)', () => {
  it('a failure dispatched to model A, landing after the model changed to B, pauses A, not B', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }, OK('B memory')]);
    const fx = await queued(mock.membrane);
    const tick = fx.strategy.tick(managerContext(fx.manager));
    await firstCall(mock.calls);
    assert.equal(mock.calls[0]!.config.model, 'same-model');
    fx.strategy.setCompressionModel('zz-model-b');
    release();
    await assert.rejects(tick, /zz network failure/);
    assert.equal(fx.strategy.pause()?.model, 'same-model', 'the pause names the dispatched model');
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'model B is not held by A\'s failure');
    assert.equal(mock.calls[1]!.config.model, 'zz-model-b');
    fx.manager.close();
  });
});

describe("releasing the provider's wait keeps the lane's own backoff (#46385)", () => {
  async function pausedByStatedWait() {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 120_000 }) }, OK('after')]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz rate_limit failure/);
    return { mock, fx };
  }
  const requeue = (fx: Awaited<ReturnType<typeof queued>>) =>
    fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));

  it('wait 120 s, backoff 30 s, release at 10 s: the remaining 20 s of backoff still pace the lane', async () => {
    const { mock, fx } = await pausedByStatedWait();
    fx.strategy.shiftPause(20_000, 110_000); // 10 s have passed
    assert.equal(fx.strategy.releaseCompressionPause('zz-other-model'), false, 'a release for another model leaves it');
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, null, 'only the provider-derived constraint is gone');
    assert.ok(pause.until > Date.now() + 19_000 && pause.until <= Date.now() + 20_000);
    await requeue(fx);
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'still paced by the backoff');
    assert.equal(fx.strategy.releaseCompressionPause(), false, 'nothing provider-derived left to release');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'and calls once the backoff has passed');
    fx.manager.close();
  });

  it('release after the backoff has elapsed: the lane resumes at once', async () => {
    const { mock, fx } = await pausedByStatedWait();
    fx.strategy.shiftPause(-1, 60_000); // the backoff passed; the stated wait still binds
    await requeue(fx);
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'held by the stated wait');
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    assert.equal(fx.strategy.paused(), false, 'nothing left to pace it');
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });
});

describe('the plain-prose retry is a rung of the durable ladder (#46345 #6)', () => {
  const THINKING = { content: [text('<thinking>all of it went here</thinking>')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
  const isProse = (request: NormalizedRequest): boolean => JSON.stringify(request).includes('plain prose');

  it('a transient failure of the retry interrupts there; the next run pays only for the retry', async () => {
    const mock = scripted([THINKING as never, { throw: failure('network') }, OK('prose memory')]);
    const fx = await build(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 2);
    const recorded = progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string }> }>;
    assert.deepEqual(recorded[0]!.outcomes.map((o) => [o.curveLabel, o.outcome]), [['canonical', 'unusable_empty']],
      "the canonical's empty answer is kept");
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'only the retry is called again');
    assert.ok(isProse(mock.calls[2]!), 'and it is the plain-prose request');
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && s.content === 'prose memory'));
    fx.manager.close();
  });

  it('a typed rejection of the retry is its outcome: the family exhausts and is never paid again', async () => {
    const mock = scripted([THINKING as never, { throw: failure('context_length') }]);
    const fx = await build(mock.membrane);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 2, 'no call after exhaustion');
    fx.manager.close();
  });
});

describe('the log bound never splits a surrogate pair at either cut', () => {
  it('a pair straddling the head cut or the tail cut, at every nearby position', () => {
    const n = 100_002;
    const max = 2_000;
    const marker = ` …[${n} of ${n} characters omitted]… `.length;
    const budget = max - marker;
    const tail = Math.floor(budget / 4);
    const headEnd = budget - tail;
    const tailStart = n - tail;
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const at of [-3, -2, -1, 0, 1].flatMap((d) => [headEnd + d, tailStart + d])) {
      const input = `${'x'.repeat(at)}😀${'x'.repeat(n - 2 - at)}`;
      const out = boundFailureLogText(input, max);
      assert.ok(out.length <= max, `length at ${at}`);
      assert.equal(lone.test(out), false, `no lone surrogate with the pair at ${at}`);
      const omitted = Number(/…\[(\d+) of \d+ characters omitted\]…/.exec(out)![1]);
      assert.equal(out.length - ` …[${omitted} of ${n} characters omitted]… `.length + omitted, n, `the omission count is exact at ${at}`);
    }
  });
});

describe('every rung keeps its own identity across a resume (#47653)', () => {
  const THINKING = { content: [text('<thinking>all of it went here</thinking>')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
  const TOOL_USE = { content: [use('t9', 'skip_reply', { reason: 'later' })], stopReason: 'tool_use', usage: { inputTokens: 80, outputTokens: 5 } };
  it('an empty no-tools answer is recorded as no-tools: a resume pays only for the prose retry', async () => {
    const mock = scripted([TOOL_USE as never, THINKING as never, { throw: failure('network') }, OK('prose memory')]);
    const fx = await build(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 3);
    const outcomes = (progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => [o.curveLabel, o.outcome]), [['canonical', 'incomplete'], ['canonical-no-tools', 'unusable_empty']]);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 4, 'neither the canonical nor the no-tools request is paid again');
    assert.ok(JSON.stringify(mock.calls[3]).includes('plain prose'));
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'prose memory'));
    fx.manager.close();
  });

  it('the same for an empty tools-less answer', async () => {
    const mock = scripted([TOOL_USE as never, TOOL_USE as never, THINKING as never, { throw: failure('network') }, OK('prose memory')]);
    const fx = await build(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 4);
    const outcomes = (progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string; outcome: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => o.curveLabel), ['canonical', 'canonical-no-tools', 'canonical-toolless']);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 5, 'only the prose retry');
    assert.ok(JSON.stringify(mock.calls[4]).includes('plain prose'));
    fx.manager.close();
  });

  /** The fixture, with L1-100 carrying signed reasoning, so its recall pair carries it. */
  async function withCarriers(membrane: unknown) {
    const fx = await build(membrane);
    const internals = fx.strategy as unknown as { summaries: SummaryEntry[] };
    const l1 = internals.summaries.find((s) => s.id === 'L1-100')!;
    l1.responseContent = [
      { type: 'thinking', thinking: 'zz carried reasoning', signature: 'zz-signature' } as never,
      text('authored L1-100'),
    ];
    return fx;
  }
  const carriesThinking = (request: NormalizedRequest): boolean =>
    request.messages.some((m) => m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));

  it('a genuine carrier rejection is recorded under its own identity: a resume goes straight to the stripped request', async () => {
    const rejected = Object.assign(new Error('zz 400: thinking blocks cannot be modified'), { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const mock = scripted([{ throw: rejected }, { throw: failure('network') }, OK('stripped memory')]);
    const fx = await withCarriers(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(mock.calls.length, 2);
    assert.ok(carriesThinking(mock.calls[0]!), 'the canonical carried reasoning');
    assert.ok(!carriesThinking(mock.calls[1]!), 'the degraded retry did not');
    const outcomes = (progressSlot(fx.manager) as Array<{ outcomes: Array<{ curveLabel: string }> }>)[0]!.outcomes;
    assert.deepEqual(outcomes.map((o) => o.curveLabel), ['canonical:carrier-rejected']);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'the known-rejected carrier request is not sent again');
    assert.ok(!carriesThinking(mock.calls[2]!));
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'stripped memory'));
    fx.manager.close();
  });

  it("the stripped request's failures are its own: with work landing between them, the eighth ends it, the carrier request paid once (#48315)", async () => {
    const rejected = Object.assign(new Error('zz 400: thinking blocks cannot be modified'), { type: 'invalid_request', retryable: false, httpStatus: 400 });
    const first = scripted([{ throw: rejected }, { throw: failure('server', { httpStatus: 503 }) }]);
    const a = await build(first.membrane);
    const internals = a.strategy as unknown as { summaries: SummaryEntry[] };
    internals.summaries.find((s) => s.id === 'L1-100')!.responseContent = [
      { type: 'thinking', thinking: 'zz carried reasoning', signature: 'zz-signature' } as never,
      text('authored L1-100'),
    ];
    for (let i = 0; i < 7; i++) {
      a.strategy.land(first.membrane);
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(first.calls.filter(carriesThinking).length, 1, 'the carrier request was sent once');
    assert.equal(first.calls.length, 8);
    const stripped = sha256(first.calls[1]!);
    const progress = progressSlot(a.manager) as Array<{ failureStreak?: { key: string; failures: number; failureClass: string } }>;
    assert.deepEqual(
      [progress[0]!.failureStreak?.key, progress[0]!.failureStreak?.failures, progress[0]!.failureStreak?.failureClass],
      [runKey(a.target().messages.map((m) => m.id), 'canonical', true), 7, 'server:503'],
      'counted against the stripped request, its own run',
    );
    a.strategy.land(first.membrane);
    await a.strategy.run(a.target(), managerContext(a.manager));
    assert.equal(first.calls.length, 9, 'only the stripped request again');
    assert.ok(!carriesThinking(first.calls[8]!));
    assert.equal(sha256(first.calls[8]!), stripped, 'the same stripped request');
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 1, 'the eighth ends the family');
    a.manager.close();
  });

  it('a transient failure that merely mentions thinking interrupts the ladder; no degraded retry', async () => {
    const network = Object.assign(new Error('zz upstream: invalid_request while reading thinking blocks'), { type: 'network', retryable: true });
    const mock = scripted([{ throw: network }]);
    const fx = await withCarriers(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz upstream/);
    assert.equal(mock.calls.length, 1, 'no stripped retry');
    assert.equal(progressSlot(fx.manager).length, 1);
    assert.deepEqual((progressSlot(fx.manager) as Array<{ outcomes: unknown[] }>)[0]!.outcomes, [], 'nothing recorded for it');
    fx.manager.close();
  });
});

describe("a caller's admission deferral is an external wait, not a failed call (#47927)", () => {
  /** agent-framework's refusal of a held model: no provider call was made. */
  const deferred = (retryAfterMs?: number) => Object.assign(
    new Error('Provider wait: same-model is held for resident (recorded earlier: zz 429); no call was made'),
    { type: 'rate_limit', retryable: true, providerAdmission: 'deferred', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );
  const requeue = (fx: Awaited<ReturnType<typeof queued>>) =>
    fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));

  it('on a fresh lane: no failure is counted, no backoff is invented, the admission is asked again within 30 s; a release resumes at once', async () => {
    const mock = scripted([{ throw: deferred(120_000) }, OK('after the release')]);
    const fx = await queued(mock.membrane);
    const start = Date.now();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /no call was made/);
    const end = Date.now();
    const pause = fx.strategy.pause()!;
    assert.equal(pause.failures, 0, 'nothing failed here');
    assert.ok(pause.backoffUntil <= Date.now(), 'no local backoff');
    assert.ok(pause.statedUntil! - end <= 30_000 && 30_000 <= pause.statedUntil! - start,
      'the cached answer lasts 30 s from the deferral, not the admission\'s 120 s deadline');
    assert.match(fx.strategy.checkReadiness().description ?? '', /then the caller's provider admission is asked again, failure 0/);
    assert.equal(progressSlot(fx.manager).length, 1);
    assert.deepEqual((progressSlot(fx.manager) as Array<{ outcomes: unknown[]; failureStreak?: unknown }>)[0]!.outcomes, [], 'no rung spent');

    // The operator releases the wait through agent-framework 10 s later: no
    // invented 20 s of failure pacing remain.
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    assert.equal(fx.strategy.paused(), false);
    await requeue(fx);
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });

  it('after a genuine failure: the deferral leaves its count and backoff as they were, and the next failure doubles from it', async () => {
    const mock = scripted([{ throw: failure('network') }, { throw: deferred(120_000) }, { throw: failure('network') }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz network failure/);
    assert.equal(fx.strategy.pause()!.failures, 1);
    fx.strategy.expirePause();
    const backoffBefore = fx.strategy.pause()!.backoffUntil;
    await requeue(fx);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /no call was made/);
    const held = fx.strategy.pause()!;
    assert.equal(held.failures, 1, 'not incremented');
    assert.equal(held.backoffUntil, backoffBefore, 'the backoff deadline is untouched');
    assert.equal(fx.strategy.releaseCompressionPause(), true);
    await requeue(fx);
    const start = Date.now();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz network failure/);
    const end = Date.now();
    assert.equal(fx.strategy.pause()!.failures, 2);
    const backoffUntil = fx.strategy.pause()!.backoffUntil;
    assert.ok(backoffUntil - end <= 60_000 && 60_000 <= backoffUntil - start, 'doubling continues from the genuine count: 60 s');
    fx.manager.close();
  });

  it('a deferral with no deadline is rechecked, not cached: refusals count nothing, and recovery runs the pending chunk with no release (#49105)', async () => {
    // An unreadable wait journal: the admission defers with no deadline, and
    // keeps deferring after the first recheck. Then the journal reads again
    // and reveals a later real wait (10 min), then that wait passes.
    const mock = scripted([{ throw: deferred() }, { throw: deferred() }, { throw: deferred(600_000) }, OK('recovered memory')]);
    const fx = await queued(mock.membrane);
    const ctx = managerContext(fx.manager);
    await assert.rejects(fx.strategy.tick(ctx), /no call was made/);
    let pause = fx.strategy.pause()!;
    assert.ok(Number.isFinite(pause.statedUntil!) && pause.statedUntil! <= Date.now() + 30_000, 'a recheck time, not an indefinite hold');
    assert.equal(pause.statedBy, 'admission');
    await fx.strategy.tick(ctx);
    assert.equal(mock.calls.length, 1, 'no check before the recheck time');

    for (const step of [2, 3]) {
      fx.strategy.expirePause(); // 30 s pass
      await assert.rejects(fx.strategy.tick(ctx), /no call was made/);
      assert.equal(mock.calls.length, step, 'each recheck asks the admission once');
      pause = fx.strategy.pause()!;
      assert.equal(pause.failures, 0, 'a refusal is not a failure');
      assert.ok(pause.backoffUntil <= Date.now(), 'and adds no backoff');
      assert.ok(pause.statedUntil! <= Date.now() + 30_000, 'still at most 30 s, even against a 10 min deadline');
    }
    assert.match(fx.strategy.checkReadiness().description ?? '', /then the caller's provider admission is asked again, failure 0/);

    // The admission clears: the already-pending chunk runs on the next check,
    // with no release, new message, rebuild or restart.
    fx.strategy.expirePause();
    await fx.strategy.tick(ctx);
    assert.equal(mock.calls.length, 4);
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && s.content === 'recovered memory'));
    fx.manager.close();
  });

  it("a deferral never shortens a wait the provider stated after a real call", async () => {
    const mock = scripted([{ throw: failure('rate_limit', { retryAfterMs: 600_000 }) }]);
    const fx = await queued(mock.membrane);
    const ctx = managerContext(fx.manager);
    await assert.rejects(fx.strategy.tick(ctx), /zz rate_limit failure/);
    const before = fx.strategy.pause()!;
    assert.equal(before.statedBy, 'provider');
    // A deferral arriving from a concurrent operation while that wait stands.
    fx.strategy.notePause(deferred(), ctx);
    const after = fx.strategy.pause()!;
    assert.equal(after.statedBy, 'provider');
    assert.equal(after.statedUntil, before.statedUntil, 'the 10 min provider wait stands');
    fx.manager.close();
  });
});

describe('pending work stays discoverable after a transient failure or a deferral (#48424, #48444)', () => {
  const deferred = (retryAfterMs?: number) => Object.assign(
    new Error('Provider wait: same-model is held for resident; no call was made'),
    { type: 'rate_limit', retryable: true, providerAdmission: 'deferred', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );

  it('with no new message, no restart and no manual rebuild, maintenance finds the chunk again once the wait ends', async () => {
    const mock = scripted([{ throw: failure('network') }, { throw: deferred(120_000) }, OK('resumed memory')]);
    const fx = await queued(mock.membrane);
    const queuedAtStart = fx.strategy.compressionQueueView();
    assert.ok(queuedAtStart.length >= 1);

    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz network failure/);
    // After a failure the chunk goes to the back, so the chunks behind it run first.
    const afterFailure = [...queuedAtStart.slice(1), queuedAtStart[0]!];
    assert.deepEqual(fx.strategy.compressionQueueView(), afterFailure, 'the failed chunk is back, at the end of the queue');
    assert.equal(fx.strategy.checkReadiness().ready, false, 'pending work is visible to maintenance');

    fx.strategy.expirePause();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /no call was made/);
    assert.deepEqual(fx.strategy.compressionQueueView(), afterFailure, 'and a deferral keeps the queue as it was');

    // The operator releases the wait; the backoff has passed. The next
    // maintenance tick, with nothing else happening, compresses the chunk.
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 3, 'retried without any rebuild');
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 1 && s.content === 'resumed memory'));
    fx.manager.close();
  });

  it('a chunk a newer queue decision withdrew while its call was in flight stays withdrawn (#48739)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }, OK('should not be called')]);
    const fx = await queued(mock.membrane);
    const tick = fx.strategy.tick(managerContext(fx.manager));
    await firstCall(mock.calls);
    // While the call is in flight, a rebuild under a larger holdback withdraws
    // every still-raw chunk from the queue (they still exist, uncompressed).
    (fx.strategy as unknown as { config: { l1HoldbackChunks: number } }).config.l1HoldbackChunks = 100;
    await fx.strategy.onNewMessage(fx.manager.queryMessages({}).messages.at(-1)!, managerContext(fx.manager));
    assert.deepEqual(fx.strategy.compressionQueueView(), [], 'the newer decision withdrew them');
    release();
    await assert.rejects(tick, /zz network failure/);
    assert.deepEqual(fx.strategy.compressionQueueView(), [], 'the failed attempt does not resurrect withdrawn work');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 1, 'no second call to the withdrawn chunk');
    fx.manager.close();
  });

  for (const fate of ['compressed', 'gone'] as const) {
    it(`a chunk ${fate} meanwhile is not resurrected (sheet I40)`, async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const mock = scripted([{ gate, then: { throw: failure('network') } }]);
      const fx = await queued(mock.membrane);
      const head = fx.strategy.compressionQueueView()[0]!;
      const key = fx.strategy.chunksView()[head]!.messages.map((m) => m.id).join('|');
      const tick = fx.strategy.tick(managerContext(fx.manager));
      await firstCall(mock.calls);
      const internals = fx.strategy as unknown as { chunks: Array<{ compressed: boolean }> };
      // While the call is in flight, another producer compresses the chunk, or it leaves the chunk list.
      if (fate === 'compressed') internals.chunks[head]!.compressed = true;
      else internals.chunks.splice(head, 1);
      release();
      await assert.rejects(tick, /zz network failure/);
      // (The white-box removal leaves the queue's later indexes dangling; a rebuild would renumber them.)
      const queuedKeys = fx.strategy.compressionQueueView().flatMap((index) => {
        const chunk = fx.strategy.chunksView()[index];
        return chunk ? [chunk.messages.map((m) => m.id).join('|')] : [];
      });
      assert.equal(queuedKeys.includes(key), false, `a ${fate} chunk isn't put back`);
      fx.manager.close();
    });
  }
});

// ---------------------------------------------------------------------------
// Evidence, not streaks (room-203 #70846, #70922, #70929; room-383 #74877):
// a failure counts against its request only while other compression lands on
// its route and model; a failed request goes behind the work that hasn't
// failed; the stall clock is durable; a stall alerts.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60_000;
const STALL_SLOT = 'default/autobio:compression-stall';
interface StallClock { failingSince: number | null; activeAt: number | null; last: { subject: string; failureClass: string } | null; stall: { since: number; subject: string } | null }
const stallClock = (manager: ContextManager): StallClock | null => manager.getStore().getStateJson(STALL_SLOT) as StallClock | null;
/** Collect console.warn while `body` runs. */
async function warningsOf(body: (warnings: string[]) => Promise<void>): Promise<void> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  try { await body(warnings); } finally { console.warn = warn; }
}

describe('compression lane: failures are evidence only by the company they keep', () => {
  it('a failed chunk goes to the back of the queue, so the chunk behind it runs next', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }, OK('the second chunk')]);
    const fx = await queued(mock.membrane);
    const queue = fx.strategy.compressionQueueView();
    assert.ok(queue.length >= 2, 'two chunks queued');
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.deepEqual(fx.strategy.compressionQueueView(), [...queue.slice(1), queue[0]], 'the failed chunk is now last');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    const second = fx.strategy.chunksView()[queue[1]!]!;
    const minted = fx.strategy.summariesView().find((s) => s.content === 'the second chunk');
    assert.ok(minted, 'the next chunk compressed');
    assert.equal(minted!.sourceIds[0], second.messages[0]!.id, 'the one that had been behind the failed chunk');
    fx.manager.close();
  });

  it('a failed chunk stays behind the others through the rebuilds an inbound message makes, during its call or after it (sheet I1, I24)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('server', { httpStatus: 503 }) } }, OK('the second chunk')]);
    const fx = await queued(mock.membrane);
    const queue = fx.strategy.compressionQueueView();
    assert.ok(queue.length >= 2, 'two chunks queued');
    const tick = fx.strategy.tick(managerContext(fx.manager));
    await firstCall(mock.calls);
    // An inbound message during the call rebuilds the queue in index order.
    fx.manager.addMessage('User', [text('inbound during the call')]);
    release();
    await assert.rejects(tick, /zz server failure/);
    const behind = [...queue.slice(1), queue[0]!];
    assert.deepEqual(fx.strategy.compressionQueueView(), behind, 'the failed chunk is behind the other, though a rebuild ran during its call');
    fx.manager.addMessage('Claude', [text('inbound after the call')]);
    assert.deepEqual(fx.strategy.compressionQueueView(), behind, 'and a rebuild after it keeps that order');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'the second chunk'), 'the chunk behind it ran');
    assert.equal(mock.calls.length, 2);
    fx.manager.close();
  });

  it('a failed chunk gives its turn to a queued merge that has not failed since, so the merge runs and lands (review miss on I1)', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }, OK('the merged memory')]);
    const fx = await queued(mock.membrane, { config: { hierarchical: true } });
    const ids = fx.manager.queryMessages({}).messages.map((m) => m.id);
    const l1 = (id: string, first: number, last: number): SummaryEntry => ({
      id, level: 1, content: id, tokens: 10, sourceLevel: 0,
      sourceIds: ids.slice(first, last + 1), sourceRange: { first: ids[first]!, last: ids[last]! }, created: 1,
    });
    // The first chunk's span is covered by two L1s (it is dropped as covered,
    // with no call); the second chunk is the one that fails.
    fx.strategy.seed(l1('L1-a', 0, 1));
    fx.strategy.seed(l1('L1-b', 2, 3));
    (fx.strategy as unknown as { enqueueMerge(merge: { level: number; sourceIds: string[] }): void })
      .enqueueMerge({ level: 2, sourceIds: ['L1-a', 'L1-b'] });
    await fx.strategy.tick(managerContext(fx.manager)); // the covered chunk: no call
    assert.equal(mock.calls.length, 0);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.equal(mock.calls.length, 1, 'the second chunk failed');
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(mock.calls.length, 2);
    assert.ok(fx.strategy.summariesView().some((s) => s.level === 2 && s.content === 'the merged memory'),
      'the merge ran ahead of the failed chunk');
    assert.equal(fx.strategy.compressionQueueView().length, 1, 'the failed chunk is still queued');
    fx.manager.close();
  });

  it('an aborted or deferred attempt keeps its chunk at the head', async () => {
    const aborted = Object.assign(new Error('zz aborted'), { name: 'AbortError' });
    const deferral = Object.assign(new Error('zz held; no call was made'), { type: 'rate_limit', retryable: true, providerAdmission: 'deferred' });
    for (const error of [aborted, deferral]) {
      const mock = scripted([{ throw: error }]);
      const fx = await queued(mock.membrane);
      const queue = fx.strategy.compressionQueueView();
      await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz (aborted|held)/);
      assert.deepEqual(fx.strategy.compressionQueueView(), queue, `${error.message}: the chunk keeps its place`);
      fx.manager.close();
    }
  });

  it('a landed L1 is evidence in its own domain: the next failure of another request there counts', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }, OK('the second chunk'), { throw: failure('server', { httpStatus: 503 }) }]);
    const fx = await queued(mock.membrane);
    // The chunk's request family changes when another L1 lands (its frontier
    // grows), and its run goes on in the newest family.
    const runOf = () => (progressSlot(fx.manager) as Array<{ updated: number; failureStreak?: { failures: number } }>)
      .filter((entry) => entry.failureStreak).map((entry) => entry.failureStreak!.failures);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.deepEqual(runOf(), [1]);
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager)); // the second chunk lands
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.deepEqual(runOf(), [2], 'the landing in between made it count, in one run for the chunk');
    fx.manager.close();
  });

  it('a landing ends the stall clock on the branch that compressed, though a branch switch crosses the payoff after it (sheet I3)', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }, OK('the second chunk')]);
    const fx = await queued(mock.membrane);
    const store = fx.manager.getStore();
    const main = fx.manager.currentBranch().name;
    const fork = store.createBranchAt('zz-fork', main, store.currentSequence()).name;
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.equal(typeof stallClock(fx.manager)?.failingSince, 'number', 'the failure started the clock on main');
    // The success path's payoff await is crossed by a switch to the fork.
    const self = fx.strategy as unknown as { clearQuarantineForCompressedChunk(chunk: Chunk): Promise<void> };
    const clear = self.clearQuarantineForCompressedChunk.bind(fx.strategy);
    self.clearQuarantineForCompressedChunk = async (chunk: Chunk) => {
      self.clearQuarantineForCompressedChunk = clear;
      await fx.manager.switchBranch(fork);
      return clear(chunk);
    };
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(stallClock(fx.manager), null, 'the fork kept its own (empty) clock');
    await fx.manager.switchBranch(main);
    assert.ok(fx.strategy.summariesView().some((s) => s.content === 'the second chunk'), 'main holds the L1');
    assert.equal(stallClock(fx.manager)?.failingSince ?? null, null, 'and main, which compressed, had its clock ended');
    fx.manager.close();
  });

  /** The stall slot's value at each store sync: what a crash right after it would keep. */
  function watchSyncedStall(manager: ContextManager): unknown[] {
    const store = manager.getStore();
    const sync = store.sync.bind(store);
    const synced: unknown[] = [];
    store.sync = () => {
      synced.push(store.getStateJson(STALL_SLOT));
      sync();
    };
    return synced;
  }

  it('failures for an hour with nothing landing alert once, through checkReadiness, until something lands', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const fx = await queued(mock.membrane);
    const synced = watchSyncedStall(fx.manager);
    await warningsOf(async (warnings) => {
      await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
      assert.equal(fx.strategy.checkReadiness().compressionStall, undefined, 'a failure is no stall');
      // Stand for an hour of failures: the clock is the durable start of the failures since the last landing.
      const store = fx.manager.getStore();
      const clock = stallClock(fx.manager)!;
      assert.equal(typeof clock.failingSince, 'number', 'the failures\' start is kept');
      assert.deepEqual(synced.at(-1), clock, 'durably: synced, so a crash loop does not restart the clock');
      store.setStateJson(STALL_SLOT, { ...clock, failingSince: Date.now() - 61 * 60_000 });
      for (let i = 0; i < 2; i++) {
        fx.strategy.expirePause();
        await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
      }
      const stall = fx.strategy.checkReadiness().compressionStall;
      assert.ok(stall, 'the readiness report carries the stall');
      assert.equal(stall!.failureClass, 'server:503');
      assert.match(stall!.subject, /^the chunk of \d+ message\(s\) from /);
      assert.match(fx.strategy.checkReadiness().description ?? '', /compression stalled since /);
      assert.equal(warnings.filter((w) => w.includes('compression stalled')).length, 1, 'one alert per stall');
      fx.strategy.land(mock.membrane);
      assert.equal(fx.strategy.checkReadiness().compressionStall, undefined, 'a landed success ends it');
    });
    fx.manager.close();
  });

  it('an idle hour starts the stall clock again: the first failure after it is no stall (sheet I2)', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    // Failures began three hours ago, and the lane hasn't been seen failing or waiting for two.
    fx.manager.getStore().setStateJson(STALL_SLOT, { ...stallClock(fx.manager)!, failingSince: Date.now() - 3 * HOUR, activeAt: Date.now() - 2 * HOUR });
    fx.strategy.expirePause();
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    assert.equal(fx.strategy.checkReadiness().compressionStall, undefined, 'no stall');
    assert.ok(Date.now() - stallClock(fx.manager)!.failingSince! < 60_000, 'the clock starts again at this failure');
    fx.manager.close();
  });

  it('a stated wait longer than the hour alerts during the wait, from a tick that finds the lane paused with work pending (sheet I11)', async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: 3 * HOUR }) }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    assert.ok(fx.strategy.paused());
    fx.manager.getStore().setStateJson(STALL_SLOT, { ...stallClock(fx.manager)!, failingSince: Date.now() - 61 * 60_000 });
    await warningsOf(async (warnings) => {
      await fx.strategy.tick(managerContext(fx.manager));
      assert.equal(mock.calls.length, 1, 'no call while paused');
      const stall = fx.strategy.checkReadiness().compressionStall;
      assert.ok(stall, 'the stall shows while the lane waits');
      assert.equal(stall!.failureClass, 'rate_limit:429');
      assert.equal(warnings.filter((w) => w.includes('compression stalled')).length, 1);
      await fx.strategy.tick(managerContext(fx.manager));
      assert.equal(warnings.filter((w) => w.includes('compression stalled')).length, 1, 'once');
    });
    fx.manager.close();
  });

  it("the stall is the branch's and the store's: another branch shows its own clock, a restart keeps the one alert, and a sibling's landing ends it (sheet I6, I20, I25)", async () => {
    const path = freshPath();
    const first = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const a = await queued(first.membrane, { path });
    const store = a.manager.getStore();
    const main = a.manager.currentBranch().name;
    const fork = store.createBranchAt('zz-fork', main, store.currentSequence()).name;
    await warningsOf(async (warnings) => {
      await assert.rejects(a.strategy.tick(managerContext(a.manager)));
      store.setStateJson(STALL_SLOT, { ...stallClock(a.manager)!, failingSince: Date.now() - 61 * 60_000 });
      a.strategy.expirePause();
      await assert.rejects(a.strategy.tick(managerContext(a.manager)));
      assert.ok(a.strategy.checkReadiness().compressionStall, 'stalled on main');
      await a.manager.switchBranch(fork);
      assert.equal(a.strategy.checkReadiness().compressionStall, undefined, 'the fork has no stall');
      await a.manager.switchBranch(main);
      assert.ok(a.strategy.checkReadiness().compressionStall, 'main still has it');
      a.manager.close();

      const second = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
      const b = await queued(second.membrane, { path });
      assert.ok(b.strategy.checkReadiness().compressionStall, 'a restart keeps the stall');
      await assert.rejects(b.strategy.tick(managerContext(b.manager)));
      assert.equal(warnings.filter((w) => w.includes('compression stalled')).length, 1, 'and alerts no second time');

      const sibling = await queued(scripted([OK('unused')]).membrane, { store: b.manager.getStore() });
      sibling.strategy.land(managerContext(sibling.manager).membrane);
      assert.equal(b.strategy.checkReadiness().compressionStall, undefined, "a sibling's landing ends it for every instance");
      b.manager.close();
    });
  });

  it('a NaN retryAfterMs states no wait: the pause ends with the lane\'s own backoff (sheet I17)', async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: Number.NaN }) }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, null, 'no stated wait');
    assert.equal(pause.source, 'backoff');
    assert.ok(pause.until - Date.now() <= 30_000, 'the 30 s backoff, not a hold');
    fx.manager.close();
  });

  it('readiness reports a pause only while it binds the configured model (sheet I29)', async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    assert.match(fx.strategy.checkReadiness().description ?? '', /compression paused/);
    fx.strategy.setCompressionModel('other-model');
    assert.doesNotMatch(fx.strategy.checkReadiness().description ?? '', /compression paused/);
    fx.manager.close();
  });

  it('a hole that a pending retry will fill keeps the run before it waiting; an entry that names no live chunk holds nothing (sheet I18, I44)', async () => {
    const fx = await queued(scripted([OK('unused')]).membrane);
    for (let i = 8; i < 10; i++) fx.manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'word '.repeat(30))]);
    const ids = fx.manager.queryMessages({}).messages.map((m) => m.id);
    const hole = fx.strategy.chunksView().find((chunk) => !chunk.compressed && chunk.messages[0]!.id === ids[4]);
    assert.ok(hole && hole.messages.at(-1)!.id === ids[7], 'a pending chunk over messages 4-7');
    const summary = (id: string, level: number, first: number, last: number): SummaryEntry => ({
      id, level, content: id, tokens: 10, sourceLevel: level - 1,
      sourceIds: ids.slice(first, last + 1), sourceRange: { first: ids[first]!, last: ids[last]! }, created: 1,
    });
    // Two summaries, a hole over messages 4-7, then two more: the first run is interior.
    const unmerged = [summary('L1-a', 1, 0, 1), summary('L1-b', 1, 2, 3), summary('L1-c', 1, 8, 8), summary('L1-d', 1, 9, 9)];
    for (const entry of unmerged) fx.strategy.seed(entry);
    assert.deepEqual(fx.strategy.mergeCandidates(unmerged, 4)?.map((s) => s.id), ['L1-a', 'L1-b'],
      'a stranded interior run consolidates at two');
    const store = fx.manager.getStore();
    const run = { key: 'zz-request', failureClass: 'server:503', failures: 1, atLanded: 0, firstFailedAt: Date.now() };
    // A run left by a chunk a rebuild re-cut: its hash names no live chunk, and no retry will fill its span.
    store.setStateJson(PROGRESS_SLOT, [{ familyKey: 'zz-stale', chunkSourceHash: 'zz-hash', sourceIds: ids.slice(4, 8), outcomes: [], failureStreak: run, updated: Date.now() }]);
    assert.deepEqual(fx.strategy.mergeCandidates(unmerged, 4)?.map((s) => s.id), ['L1-a', 'L1-b'], 'a stale entry holds nothing');
    // The chunk over the hole failed and will be retried.
    store.setStateJson(PROGRESS_SLOT, [{ familyKey: 'zz-family', chunkSourceHash: idsHash(hole!.messages.map((m) => m.id)), sourceIds: ids.slice(4, 8), outcomes: [], failureStreak: run, updated: Date.now() }]);
    assert.equal(fx.strategy.mergeCandidates(unmerged, 4), null, 'the run waits for the retry, as the newest run does');
    store.setStateJson(PROGRESS_SLOT, []);
    // One level up: a queued merge with a run will fill the hole with its parent.
    const level2 = [summary('L2-a', 2, 0, 1), summary('L2-b', 2, 2, 3), summary('L2-c', 2, 8, 8), summary('L2-d', 2, 9, 9)];
    for (const entry of level2) fx.strategy.seed(entry);
    fx.strategy.seed(summary('L1-x', 1, 4, 5));
    fx.strategy.seed(summary('L1-y', 1, 6, 7));
    assert.deepEqual(fx.strategy.mergeCandidates(level2, 4)?.map((s) => s.id), ['L2-a', 'L2-b']);
    (fx.strategy as unknown as { mergeQueue: unknown[] }).mergeQueue.push({ level: 2, sourceIds: ['L1-x', 'L1-y'], failureStreak: run });
    assert.equal(fx.strategy.mergeCandidates(level2, 4), null, 'a failing merge holds the hole its parent will fill');
    fx.manager.close();
  });

  it('a progress write keeps another writer\'s longer run for the same request in the same domain, and drops a run whose request answered', async () => {
    const fx = await build(scripted([OK('unused')]).membrane);
    const self = fx.strategy as unknown as {
      captureCompressionBranch(): unknown;
      recordCompressionFamilyProgress(
        source: unknown, record: { familyKey: string; chunkSourceHash: string }, outcomes: unknown[],
        tokens: number | undefined, streak: unknown, answered: ReadonlySet<string>, sourceIds: readonly string[],
      ): void;
    };
    const record = { familyKey: 'zz-family', chunkSourceHash: 'zz-hash' };
    const run = (failures: number, domain = 'zz-domain', key = 'zz-request') =>
      ({ key, failureClass: 'server:503', domain, failures, atLanded: failures, firstFailedAt: 1 });
    const stored = () => (progressSlot(fx.manager) as Array<{ failureStreak?: { failures: number; domain: string } }>)[0]!.failureStreak;
    // Another writer counted further on the same request, in the same domain.
    self.recordCompressionFamilyProgress(self.captureCompressionBranch(), record, [], undefined, run(5), new Set(), ['m1']);
    self.recordCompressionFamilyProgress(self.captureCompressionBranch(), record, [], undefined, run(3), new Set(), ['m1']);
    assert.equal(stored()?.failures, 5, 'the longer run is kept');
    // A run in another domain doesn't take that one's count.
    self.recordCompressionFamilyProgress(self.captureCompressionBranch(), record, [], undefined, run(1, 'zz-other'), new Set(), ['m1']);
    assert.deepEqual([stored()?.failures, stored()?.domain], [1, 'zz-other'], "this writer's run stands");
    // The request answered for this writer: the run ends durably.
    self.recordCompressionFamilyProgress(self.captureCompressionBranch(), record, [], undefined, undefined, new Set(['zz-request']), ['m1']);
    assert.equal(stored(), undefined, 'no stored run comes back for a request that answered');
    fx.manager.close();
  });
});

// ── The comparison domain: the route and the model (room-383 #74635, #74790,
// #74877; Ethan-2263's probes cm138-model-evidence, -route-evidence,
// -portability) ──────────────────────────────────────────────────────────────

describe('a failure is evidence only against landings on its own route and model', () => {
  const sourceOnly = (strategy: ProbeStrategy): void => {
    (strategy as unknown as { config: { compressionSourceOnly: boolean } }).config.compressionSourceOnly = true;
  };
  /** Two fresh messages, compressed as their own chunk through `ctx`. */
  async function landOther(fx: Awaited<ReturnType<typeof build>>, i: number, ctx: StrategyContext): Promise<void> {
    const before = managerContext(fx.manager).messageStore.getAll().length;
    fx.manager.addMessage('User', [text(`other source ${i} ` + 'substantive '.repeat(15))]);
    fx.manager.addMessage('Claude', [text(`other reply ${i} ` + 'substantive '.repeat(15))]);
    const messages = managerContext(fx.manager).messageStore.getAll().slice(before);
    await fx.strategy.run({ index: 1000 + i, startIndex: before, endIndex: before + 2, messages, tokens: 100, compressed: false }, ctx);
  }
  const swallowNetwork = (e: unknown) => { if (!String(e).includes('zz network failure')) throw e; };

  async function crossModel(control: boolean) {
    const calls: NormalizedRequest[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        if ((request.config as { model?: string }).model === 'model-a') throw failure('network');
        return OK('model-b made a memory');
      },
    };
    const fx = await build(membrane);
    sourceOnly(fx.strategy);
    try {
      for (let i = 0; i < 8; i++) {
        fx.strategy.setCompressionModel('model-a');
        fx.strategy.expirePause();
        await fx.strategy.run(fx.target(), managerContext(fx.manager)).catch(swallowNetwork);
        if (i === 7) break;
        if (control) {
          fx.strategy.land(membrane, 'model-a');
        } else {
          fx.strategy.setCompressionModel('model-b');
          await landOther(fx, i, managerContext(fx.manager));
        }
      }
      return { calls, quarantine: fx.strategy.getCompressionQuarantineStatus().count };
    } finally {
      fx.manager.close();
    }
  }

  it("another model's landings say nothing about this one: model A's outage stays undecided while model B lands", async () => {
    const { calls, quarantine } = await crossModel(false);
    const a = calls.filter((request) => (request.config as { model?: string }).model === 'model-a');
    assert.equal(a.length, 8);
    assert.equal(new Set(a.map(sha256)).size, 1, 'one identical model-A request');
    assert.equal(calls.length - a.length, 7, 'seven model-B landings between its failures');
    assert.equal(quarantine, 0, 'undecided');
  });

  it('control: other work landing on the same route and model decides it at the eighth', async () => {
    assert.equal((await crossModel(true)).quarantine, 1);
  });

  async function crossRoute(control: boolean) {
    const calls: Array<{ route: string; request: NormalizedRequest }> = [];
    const down = { complete: async (request: NormalizedRequest) => { calls.push({ route: 'down', request: structuredClone(request) }); throw failure('network'); } };
    const healthy = { complete: async (request: NormalizedRequest) => { calls.push({ route: 'healthy', request: structuredClone(request) }); return OK('healthy route made a memory'); } };
    const fx = await build(down);
    sourceOnly(fx.strategy);
    const through = (route: object): StrategyContext => ({ ...managerContext(fx.manager), membrane: route as never });
    try {
      for (let i = 0; i < 8; i++) {
        fx.strategy.expirePause();
        await fx.strategy.run(fx.target(), through(down)).catch(swallowNetwork);
        if (i === 7) break;
        if (control) fx.strategy.land(down);
        else await landOther(fx, i, through(healthy));
      }
      const quarantine = fx.strategy.getCompressionQuarantineStatus().count;
      const pending = fx.target();
      await fx.strategy.run(pending, through(healthy));
      return { calls, quarantine, compressed: pending.compressed };
    } finally {
      fx.manager.close();
    }
  }

  it("another route's landings say nothing about this one, though the model is the same: the healthy route then takes the pending request", async () => {
    const { calls, quarantine, compressed } = await crossRoute(false);
    const down = calls.filter((call) => call.route === 'down');
    assert.equal(down.length, 8);
    assert.equal(new Set(down.map((call) => sha256(call.request))).size, 1);
    assert.equal(new Set(calls.map((call) => (call.request.config as { model?: string }).model)).size, 1, 'one model');
    assert.equal(quarantine, 0, 'undecided');
    assert.equal(calls.filter((call) => call.route === 'healthy').length, 8, 'the healthy route got the pending request');
    assert.equal(compressed, true);
  });

  it('control: landings on the same route decide it at the eighth', async () => {
    assert.equal((await crossRoute(true)).quarantine, 1);
  });

  it("a recorded answer is reused on any route until an operator's clear: after a route change it can exhaust a family the new route would answer, and the clear recovers it (room-383 #75066)", async () => {
    const old = scripted([{ throw: failure('invalid_request') }, { throw: failure('network') }]);
    const nextCalls: NormalizedRequest[] = [];
    const next = { complete: async (request: NormalizedRequest) => { nextCalls.push(structuredClone(request)); return isCanonical(request) ? OK('full-context memory') : REFUSAL; } };
    const fx = await build(old.membrane, { sourceOnlyFallback: true });
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    const resumed = fx.target();
    await fx.strategy.run(resumed, { ...managerContext(fx.manager), membrane: next as never });
    assert.equal(old.calls.length, 2);
    assert.equal(nextCalls.length, 1);
    assert.equal(nextCalls.filter(isCanonical).length, 0, 'the recorded canonical answer is reused on the new route');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'source-only-final refused there, so the family exhausts');
    assert.equal(resumed.compressed, false);
    await fx.strategy.clearCompressionRefusalQuarantine();
    const cleared = fx.target();
    await fx.strategy.run(cleared, { ...managerContext(fx.manager), membrane: next as never });
    assert.equal(nextCalls.filter(isCanonical).length, 1, 'after the clear, the canonical is asked again');
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    assert.equal(cleared.compressed, true);
    fx.manager.close();
  });
});

// ── The review's further cases (sw-cm138) ──────────────────────────────────

/** The strategy's hash of a chunk's message ids (chunkSourceHash). */
const idsHash = (ids: string[]): string => createHash('sha256').update(JSON.stringify(ids), 'utf8').digest('hex');
/** An L1 run's subject: the chunk's rung (chunkRunKey). */
const runKey = (ids: string[], curveLabel: string, stripped: boolean): string =>
  createHash('sha256').update(JSON.stringify({ chunkSourceHash: idsHash(ids), curveLabel, stripped }), 'utf8').digest('hex');
const families = (manager: ContextManager): string[] =>
  (progressSlot(manager) as Array<{ familyKey: string }>).map((entry) => entry.familyKey).sort();
const PROGRESS_SLOT = 'default/autobio:compression-family-progress';
const DAY = 24 * 60 * 60_000;

describe('an abort is neither evidence nor a reason to pause (sw-cm138 I8)', () => {
  for (const [label, error] of [
    ['an AbortError', Object.assign(new Error('zz aborted'), { name: 'AbortError' })],
    ["a membrane error of type 'abort'", failure('abort')],
  ] as const) {
    it(`${label}: no pause, no rung spent, the family not exhausted, and the next run calls the canonical again`, async () => {
      const mock = scripted([{ throw: error }, OK('after the abort')]);
      const fx = await build(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz abort/);
      assert.equal(fx.strategy.pause(), null, 'a cancellation pauses nothing');
      assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
      for (const entry of progressSlot(fx.manager) as Array<{ outcomes: unknown[] }>) {
        assert.deepEqual(entry.outcomes, [], 'and is no rung\'s outcome');
      }
      await fx.strategy.run(fx.target(), managerContext(fx.manager));
      assert.equal(mock.calls.length, 2);
      assert.ok(isCanonical(mock.calls[1]!), 'the canonical, asked again');
      fx.manager.close();
    });
  }
});

describe('ladder progress goes when its debt is paid, and is swept on its own cadence (sw-cm138)', () => {
  /** Two persisted chunk records (messages 1-4 compressed, 5-8 raw), an L1 over 5-6, and seven families. */
  async function sweepFixture() {
    const mock = scripted([{ throw: failure('network') }]);
    const fx = await queued(mock.membrane);
    const store = fx.manager.getStore();
    store.setStateJson('default/autobio:chunks', [
      { id: 'c-0', sourceIds: ['1', '2', '3', '4'], compressed: true, summaryId: 'L1-900' },
      { id: 'c-1', sourceIds: ['5', '6', '7', '8'], compressed: false },
    ]);
    fx.strategy.seed({ id: 'L1-901', level: 1, content: 'covers 5 and 6', tokens: 10, sourceLevel: 0, sourceIds: ['5', '6'], sourceRange: { first: '5', last: '6' }, created: 1 });
    const now = Date.now();
    const entry = (familyKey: string, chunkSourceHash: string, extra: Record<string, unknown> = {}) =>
      ({ familyKey, chunkSourceHash, outcomes: [], updated: now, ...extra });
    store.setStateJson(PROGRESS_SLOT, [
      entry('fam-compressed', idsHash(['1', '2', '3', '4'])),
      entry('fam-raw', idsHash(['5', '6', '7', '8'])),
      entry('fam-abandoned', idsHash(['5', '6', '7', '8']), { updated: now - 31 * DAY }),
      entry('fam-covered', idsHash(['5', '6']), { sourceIds: ['5', '6'] }),
      entry('fam-gone', idsHash(['7', 'zz-gone']), { sourceIds: ['7', 'zz-gone'] }),
      entry('fam-live', idsHash(['7', '8']), { sourceIds: ['7', '8'] }),
      entry('fam-old-shape', idsHash(['7', '8', 'x'])),
    ]);
    return { ...fx, mock, store };
  }

  it('from tick, with the quarantine alarm off and the lane paused: covered, gone and abandoned spans go; live ones stay, a missing record included (I5, I20, I34, I36)', async () => {
    const fx = await sweepFixture();
    const ctx = managerContext(fx.manager);
    fx.strategy.notePause(failure('network'), ctx); // tick returns at the pause, after the sweep
    await fx.strategy.tick(ctx);
    assert.equal(fx.mock.calls.length, 0, 'paused: no call');
    assert.deepEqual(families(fx.manager), ['fam-live', 'fam-raw'],
      'kept: a raw record\'s, and a missing record\'s whose messages are all there and uncovered');
    fx.manager.close();
  });

  it('at most every 10 minutes', async () => {
    const fx = await sweepFixture();
    const ctx = managerContext(fx.manager);
    fx.strategy.notePause(failure('network'), ctx);
    await fx.strategy.tick(ctx);
    assert.deepEqual(families(fx.manager), ['fam-live', 'fam-raw']);
    // A family paid off after that sweep waits for the next one.
    fx.store.setStateJson(PROGRESS_SLOT, [
      ...progressSlot(fx.manager),
      { familyKey: 'fam-late', chunkSourceHash: idsHash(['1', '2', '3', '4']), outcomes: [], updated: Date.now() },
    ]);
    fx.strategy.progressSweptAgo(9 * 60_000);
    await fx.strategy.tick(ctx);
    assert.deepEqual(families(fx.manager), ['fam-late', 'fam-live', 'fam-raw'], 'nine minutes on: not swept again');
    fx.strategy.progressSweptAgo(10 * 60_000);
    await fx.strategy.tick(ctx);
    assert.deepEqual(families(fx.manager), ['fam-live', 'fam-raw'], 'ten: swept');
    fx.manager.close();
  });

  it('with no chunk records to judge spans by, only age decides', async () => {
    const fx = await sweepFixture();
    fx.store.setStateJson('default/autobio:chunks', []);
    const ctx = managerContext(fx.manager);
    fx.strategy.notePause(failure('network'), ctx);
    await fx.strategy.tick(ctx);
    assert.deepEqual(families(fx.manager),
      ['fam-compressed', 'fam-covered', 'fam-gone', 'fam-live', 'fam-old-shape', 'fam-raw'], 'never blind: only the abandoned family goes');
    fx.manager.close();
  });

  it("a ladder never writes back a family dropped while it ran (I4)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([REFUSAL, { throw: failure('network') }, { gate, then: { throw: failure('network') } }]);
    const fx = await build(mock.membrane, { hoist: true });
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz network failure/);
    assert.equal(progressSlot(fx.manager).length, 1, 'the canonical refusal is kept');
    // The resumed ladder starts from that progress; while its hoist rung is
    // in flight, the family is dropped (another strategy minted it, say).
    const run = fx.strategy.run(fx.target(), managerContext(fx.manager));
    const deadline = Date.now() + 10_000;
    while (mock.calls.length < 3) {
      if (Date.now() > deadline) assert.fail('the resumed rung was never called');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    fx.manager.getStore().setStateJson(PROGRESS_SLOT, []);
    release();
    await assert.rejects(run, /zz network failure/);
    assert.equal(progressSlot(fx.manager).length, 0, 'the ladder\'s snapshot does not bring the family back');
    fx.manager.close();
  });

  it('nor does a fresh ladder, once it has written the family and the family is dropped (I4)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([REFUSAL, { gate, then: { throw: failure('network') } }]);
    const fx = await build(mock.membrane, { hoist: true });
    assert.equal(progressSlot(fx.manager).length, 0, 'no progress when the ladder begins');
    const run = fx.strategy.run(fx.target(), managerContext(fx.manager));
    const deadline = Date.now() + 10_000;
    while (mock.calls.length < 2) {
      if (Date.now() > deadline) assert.fail('the second rung was never called');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(progressSlot(fx.manager).length, 1, 'the ladder wrote its canonical refusal');
    fx.manager.getStore().setStateJson(PROGRESS_SLOT, []);
    release();
    await assert.rejects(run, /zz network failure/);
    assert.equal(progressSlot(fx.manager).length, 0, 'what it wrote, once dropped, is not written back');
    fx.manager.close();
  });

  it('the dedup guard pays off the span\'s progress (I25)', async () => {
    const mock = scripted([OK('never called')]);
    const fx = await build(mock.membrane);
    const target = fx.target();
    const ids = target.messages.map((message) => message.id);
    // Every message is covered, by L1s cut at other boundaries.
    fx.strategy.seed({ id: 'L1-200', level: 1, content: 'covers the first two', tokens: 10, sourceLevel: 0, sourceIds: ids.slice(0, 2), sourceRange: { first: ids[0]!, last: ids[1]! }, created: 1 });
    fx.strategy.seed({ id: 'L1-201', level: 1, content: 'covers the last', tokens: 10, sourceLevel: 0, sourceIds: ids.slice(2), sourceRange: { first: ids[2]!, last: ids.at(-1)! }, created: 1 });
    fx.manager.getStore().setStateJson(PROGRESS_SLOT, [
      { familyKey: 'fam-target', chunkSourceHash: idsHash(ids), outcomes: [], updated: Date.now() },
      { familyKey: 'fam-other', chunkSourceHash: idsHash(['zz']), outcomes: [], updated: Date.now() },
    ]);
    await fx.strategy.run(target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 0, 'dropped, not compressed');
    assert.equal(target.compressed, true);
    assert.deepEqual(families(fx.manager), ['fam-other'], "the covered span's progress is gone; another's stays");
    fx.manager.close();
  });

  it("an operator's clear takes the family's progress with it (I27)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([REFUSAL, { gate, then: REFUSAL }]);
    const fx = await build(mock.membrane, { hoist: true });
    const run = fx.strategy.run(fx.target(), managerContext(fx.manager));
    const deadline = Date.now() + 10_000;
    while (mock.calls.length < 2) {
      if (Date.now() > deadline) assert.fail('the second rung was never called');
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const progress = progressSlot(fx.manager);
    assert.equal(progress.length, 1, 'the canonical refusal is recorded before the next rung');
    release();
    await run;
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'exhausted');
    // A crash between exhaustion's ledger write and its progress drop leaves this.
    fx.manager.getStore().setStateJson(PROGRESS_SLOT, progress);
    await fx.strategy.clearCompressionRefusalQuarantine();
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    assert.equal(progressSlot(fx.manager).length, 0, 'nothing recorded before the clear outlives it');
    fx.manager.close();
  });
});

describe("an admission hold warns once (sw-cm138 I24)", () => {
  const deferred = (retryAfterMs?: number) => Object.assign(
    new Error('Provider wait: same-model is held for resident; no call was made'),
    { type: 'rate_limit', retryable: true, providerAdmission: 'deferred', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) },
  );

  it('however often the lane rechecks it, and again when its deadline changes or a release leaves it standing', async () => {
    const fx = await queued(scripted([OK('unused')]).membrane);
    const ctx = managerContext(fx.manager);
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].includes("held by the caller's provider admission")) warnings.push(args[0]);
    };
    try {
      fx.strategy.notePause(deferred(120_000), ctx);
      // Rechecks: the same deadline, restated as the time left.
      fx.strategy.notePause(deferred(119_990), ctx);
      fx.strategy.notePause(deferred(119_980), ctx);
      assert.equal(warnings.length, 1, 'one hold, one warning');
      fx.strategy.notePause(deferred(600_000), ctx);
      assert.equal(warnings.length, 2, 'a new deadline is news');
      fx.strategy.notePause(deferred(), ctx);
      fx.strategy.notePause(deferred(), ctx);
      assert.equal(warnings.length, 3, 'so is none, once');
      assert.equal(fx.strategy.releaseCompressionPause(), true);
      fx.strategy.notePause(deferred(), ctx);
      assert.equal(warnings.length, 4, 'a hold that outlasts a release warns again');
    } finally {
      console.warn = orig;
    }
    fx.manager.close();
  });
});

describe('the quarantine-skip warning is per branch (sw-cm138 I28)', () => {
  it('a branch switch clears what was warned on the old branch', async () => {
    const fx = await queued(scripted([OK('unused')]).membrane);
    fx.strategy.warnedSkips().add('zz-chunk-hash');
    const main = fx.manager.currentBranch().name;
    const fork = fx.manager.getStore().createBranchAt('zz-fork', main, fx.manager.getStore().currentSequence()).name;
    await fx.manager.switchBranch(fork);
    assert.equal(fx.strategy.warnedSkips().size, 0);
    fx.manager.close();
  });
});
