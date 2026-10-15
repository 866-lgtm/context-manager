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
  /** Make a chunk the strategy's own, as its chunking would. */
  adopt(chunk: Chunk): void { this.chunks.push(chunk); }
  klaxon(): Promise<void> { return (this as unknown as { soundQuarantineAlarmIfNeeded(): Promise<void> }).soundQuarantineAlarmIfNeeded(); }
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
  /** Stand for time passing: the pause's finite constraints ended at `at`. */
  endPauseAt(at: number): void {
    const pause = this.lanePause();
    if (!pause) return;
    pause.backoffUntil = at;
    if (pause.statedUntil !== null && Number.isFinite(pause.statedUntil)) pause.statedUntil = at;
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
/** Wait until more than `count` provider calls have been made. */
async function firstCallAfter(calls: unknown[], count: number, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (calls.length <= count) {
    if (Date.now() > deadline) assert.fail(`the provider was never called after call ${count}`);
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
    const streak = (strategy: unknown) => l1RunsOf(strategy)[0];
    const first = always503();
    const a = await build(first.membrane, { path, sourceOnlyFallback: true });
    // An outage: nothing lands between the failures, so none adds to the run.
    for (let i = 0; i < 12; i++) {
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'an outage exhausts nothing');
    assert.equal(streak(a.strategy)?.failures, 1,
      'twelve failures with nothing landing are a run of one');
    // Other work lands in the same domain before each of the next six, so each counts.
    for (let i = 0; i < 6; i++) {
      a.strategy.land(first.membrane);
      await assert.rejects(a.strategy.run(a.target(), managerContext(a.manager)), /zz server failure/);
    }
    assert.equal(streak(a.strategy)?.failures, 7);
    assert.equal(a.strategy.getCompressionQuarantineStatus().count, 0, 'seven is below the bound');
    a.manager.close();

    // A restart: runs live in the process, as their evidence does, so the
    // first failure here starts a run of one.
    const second = always503();
    const b = await build(second.membrane, { path, sourceOnlyFallback: true });
    b.strategy.land(second.membrane);
    await assert.rejects(b.strategy.run(b.target(), managerContext(b.manager)), /zz server failure/);
    assert.equal(streak(b.strategy)?.failures, 1, 'the first failure after a restart starts a run of one');
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
    const streak = () => l1RunsOf(fx.strategy)[0]!;
    for (let i = 0; i < 3; i++) {
      fx.strategy.land(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    }
    assert.equal(streak().failures, 3);
    fx.strategy.land(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /no call was made/);
    assert.equal(streak().failures, 3, 'a deferral is no failure');
    // The landing before the deferral wasn't spent: the timeout counts against it.
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz timeout failure/);
    assert.equal(streak().failures, 4, 'another class extends the run (sheet I10)');
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
    assert.deepEqual(l1RunsOf(fx.strategy), [], 'and starts no run');
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
    assert.match(readiness.description ?? '', /compression paused until .+ \(the provider's stated wait, failure 1; latest: the chunk of 4 message\(s\) from \S+ failed \(rate_limit:429\)\)/);

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
    const shiftedAt = Date.now();
    fx.strategy.shiftPause(20_000, 110_000); // 10 s have passed
    assert.equal(fx.strategy.releaseCompressionPause('zz-other-model'), false, 'a release for another model leaves it');
    assert.equal(fx.strategy.releaseCompressionPause('same-model'), true);
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, null, 'only the provider-derived constraint is gone');
    assert.ok(pause.until >= shiftedAt + 20_000 && pause.until <= Date.now() + 20_000, 'the backoff, from when it was shifted');
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
    const run = l1RunsOf(a.strategy)[0];
    assert.deepEqual(
      [run?.key, run?.failures],
      [runKey(a.target().messages, 'canonical', true), 7],
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
    assert.deepEqual((progressSlot(fx.manager) as Array<{ outcomes: unknown[] }>)[0]!.outcomes, [], 'no rung spent');

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
// failed.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60_000;

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

  it('a failing chunk and a failing merge take turns, least recently failed first', async () => {
    const calls: string[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push(JSON.stringify(request).includes('single L2 memory') ? 'merge' : 'chunk');
        throw failure('server', { httpStatus: 503 });
      },
    };
    const fx = await queued(membrane, { config: { hierarchical: true } });
    const ids = fx.manager.queryMessages({}).messages.map((m) => m.id);
    const l1 = (id: string, first: number, last: number): SummaryEntry => ({
      id, level: 1, content: id, tokens: 10, sourceLevel: 0,
      sourceIds: ids.slice(first, last + 1), sourceRange: { first: ids[first]!, last: ids[last]! }, created: 1,
    });
    fx.strategy.seed(l1('L1-a', 0, 1));
    fx.strategy.seed(l1('L1-b', 2, 3));
    (fx.strategy as unknown as { enqueueMerge(merge: { level: number; sourceIds: string[] }): void })
      .enqueueMerge({ level: 2, sourceIds: ['L1-a', 'L1-b'] });
    await fx.strategy.tick(managerContext(fx.manager)); // the covered chunk: no call
    for (let i = 0; i < 4; i++) {
      fx.strategy.expirePause();
      await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    }
    assert.deepEqual(calls, ['chunk', 'merge', 'chunk', 'merge']);
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
    // grows), and its run goes on.
    const runOf = () => l1RunsOf(fx.strategy).map((run) => run.failures);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.deepEqual(runOf(), [1]);
    fx.strategy.expirePause();
    await fx.strategy.tick(managerContext(fx.manager)); // the second chunk lands
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)), /zz server failure/);
    assert.deepEqual(runOf(), [2], 'the landing in between made it count, in one run for the chunk');
    fx.manager.close();
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

  it('a negative retryAfterMs states no wait either', async () => {
    const mock = scripted([{ throw: failure('rate_limit', { httpStatus: 429, retryAfterMs: -60_000 }) }]);
    const fx = await queued(mock.membrane);
    await assert.rejects(fx.strategy.tick(managerContext(fx.manager)));
    const pause = fx.strategy.pause()!;
    assert.equal(pause.statedUntil, null, 'no stated wait');
    assert.equal(pause.source, 'backoff');
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
    const run = { key: 'zz-request', domain: 'zz', failures: 1, atLanded: 0 };
    const l1Runs = (fx.strategy as unknown as { compressionFailureRuns: Map<string, { run: typeof run; chunkKey: string }> }).compressionFailureRuns;
    // A run left by a chunk a rebuild re-cut: its key names no live chunk, and no retry will fill its span.
    l1Runs.set('zz-stale', { run, chunkKey: ids.slice(4, 7).join(':') });
    assert.deepEqual(fx.strategy.mergeCandidates(unmerged, 4)?.map((s) => s.id), ['L1-a', 'L1-b'], 'a stale run holds nothing');
    // The chunk over the hole failed and will be retried.
    l1Runs.set('zz-subject', { run, chunkKey: hole!.messages.map((m) => m.id).join(':') });
    assert.equal(fx.strategy.mergeCandidates(unmerged, 4), null, 'the run waits for the retry, as the newest run does');
    l1Runs.clear();
    // One level up: a queued merge with a run will fill the hole with its parent.
    const level2 = [summary('L2-a', 2, 0, 1), summary('L2-b', 2, 2, 3), summary('L2-c', 2, 8, 8), summary('L2-d', 2, 9, 9)];
    for (const entry of level2) fx.strategy.seed(entry);
    fx.strategy.seed(summary('L1-x', 1, 4, 5));
    fx.strategy.seed(summary('L1-y', 1, 6, 7));
    assert.deepEqual(fx.strategy.mergeCandidates(level2, 4)?.map((s) => s.id), ['L2-a', 'L2-b']);
    (fx.strategy as unknown as { mergeQueue: unknown[] }).mergeQueue.push({ level: 2, sourceIds: ['L1-x', 'L1-y'] });
    (fx.strategy as unknown as { mergeFailureRuns: Map<string, typeof run> }).mergeFailureRuns.set(`2\u0000L1-x\u0000L1-y`, run);
    assert.equal(fx.strategy.mergeCandidates(level2, 4), null, 'a failing merge holds the hole its parent will fill');
    fx.manager.close();
  });
});

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
const sha256Of = (value: unknown): string => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
/** An L1 run's subject: the chunk's rung, by its sources' ids and content (chunkRunKey, chunkRunSubject). */
const runKey = (messages: ReadonlyArray<{ id: string; content: unknown }>, curveLabel: string, stripped: boolean): string =>
  sha256Of({
    runSubject: sha256Of({ chunkSourceHash: idsHash(messages.map((m) => m.id)), content: messages.map((m) => m.content) }),
    curveLabel,
    stripped,
  });
const families = (manager: ContextManager): string[] =>
  (progressSlot(manager) as Array<{ familyKey: string }>).map((entry) => entry.familyKey).sort();
const PROGRESS_SLOT = 'default/autobio:compression-family-progress';
/** The lane's L1 runs of failures, which it keeps in memory. */
const l1RunsOf = (strategy: unknown): Array<{ key: string; failures: number }> =>
  [...(strategy as { compressionFailureRuns: Map<string, { run: { key: string; failures: number } }> })
    .compressionFailureRuns.values()].map((entry) => entry.run);
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

  it('an exact-match adoption pays off the span\'s progress (sheet I15)', async () => {
    const mock = scripted([OK('never called')]);
    const fx = await build(mock.membrane);
    const target = fx.target();
    const ids = target.messages.map((message) => message.id);
    fx.strategy.seed({ id: 'L1-210', level: 1, content: 'the same span, already summarized', tokens: 10, sourceLevel: 0, sourceIds: ids, sourceRange: { first: ids[0]!, last: ids.at(-1)! }, created: 1 });
    fx.manager.getStore().setStateJson(PROGRESS_SLOT, [
      { familyKey: 'fam-target', chunkSourceHash: idsHash(ids), outcomes: [], updated: Date.now() },
      { familyKey: 'fam-other', chunkSourceHash: idsHash(['zz']), outcomes: [], updated: Date.now() },
    ]);
    await fx.strategy.run(target, managerContext(fx.manager));
    assert.equal(mock.calls.length, 0, 'adopted, not compressed');
    assert.equal(target.compressed, true);
    assert.deepEqual(families(fx.manager), ['fam-other'], "the adopted span's progress is gone; another's stays");
    fx.manager.close();
  });

  it('the thin-chunk stub pays off the span\'s progress, and is no landing (sheet I12, I32)', async () => {
    const mock = scripted([OK('never called')]);
    const fx = await build(mock.membrane);
    (fx.strategy as unknown as { config: { minChunkCharsForLLM: number } }).config.minChunkCharsForLLM = 200;
    const before = managerContext(fx.manager).messageStore.getAll().length;
    fx.manager.addMessage('User', [text('ok')]);
    fx.manager.addMessage('Claude', [text('ok')]);
    const messages = managerContext(fx.manager).messageStore.getAll().slice(before);
    const thin: Chunk = { index: 500, startIndex: before, endIndex: before + 2, messages, tokens: 4, compressed: false };
    fx.manager.getStore().setStateJson(PROGRESS_SLOT, [
      { familyKey: 'fam-thin', chunkSourceHash: idsHash(messages.map((m) => m.id)), outcomes: [], updated: Date.now() },
    ]);
    let landings = 0;
    const lane = fx.strategy as unknown as { noteCompressionLanded(membrane: object, model: string | undefined): void };
    const landed = lane.noteCompressionLanded.bind(fx.strategy);
    lane.noteCompressionLanded = (membrane, model) => { landings++; landed(membrane, model); };
    await fx.strategy.run(thin, managerContext(fx.manager));
    assert.equal(mock.calls.length, 0, 'stubbed, with no call');
    assert.equal(thin.compressed, true);
    assert.deepEqual(families(fx.manager), [], "the stubbed span's progress is gone");
    assert.equal(landings, 0, 'a stub made no call, so it is no landing');
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
    // The progress goes before the clear event (sheet I28): a crash between
    // them leaves the quarantine standing, never a cleared family with its
    // old answers.
    const self = fx.strategy as unknown as { appendCompressionQuarantineEvent(event: { kind: string }): unknown };
    const append = self.appendCompressionQuarantineEvent.bind(fx.strategy);
    const progressAtClear: number[] = [];
    self.appendCompressionQuarantineEvent = (event: { kind: string }) => {
      if (event.kind === 'clear') progressAtClear.push(progressSlot(fx.manager).length);
      return append(event);
    };
    await fx.strategy.clearCompressionRefusalQuarantine();
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    assert.equal(progressSlot(fx.manager).length, 0, 'nothing recorded before the clear outlives it');
    assert.deepEqual(progressAtClear, [0], 'the progress was gone before the clear event was written');
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

// ── Round 4 (cm138-r3's sheet; Andrew-2310's review, room-203 #78444) ─────────

describe("a run's evidence belongs to the chunk's sources", () => {
  const runsOf = (strategy: unknown): number[] => l1RunsOf(strategy).map((run) => run.failures);
  const l1 = (ids: string[], id: string, first: number, last: number): SummaryEntry => ({
    id, level: 1, content: `authored ${id}`, tokens: 20, sourceLevel: 0,
    sourceIds: ids.slice(first, last + 1), sourceRange: { first: ids[first]!, last: ids[last]! }, created: 1,
  });

  it("a source edited in place starts a new run: the seven failures before the edit don't decide it (Andrew-2310's boundary 1)", async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const fx = await build(mock.membrane);
    for (let i = 0; i < 7; i++) {
      fx.strategy.land(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    }
    assert.deepEqual(runsOf(fx.strategy), [7]);
    fx.manager.editMessage(fx.ids[10]!, [text('raw-10 edited in place ' + 'substantive '.repeat(12))]);
    fx.strategy.land(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0, "the old content's failures don't decide the new");
    assert.deepEqual(runsOf(fx.strategy).sort((a, b) => a - b), [1, 7],
      "the edited sources start a run of one; the old content's run stays with its family, which nothing of the new content takes");
    fx.manager.close();
  });

  it("a late failure of a source's old content leaves the run of its new content: each content is its own subject (Andrew-2310's late-old-source case)", async () => {
    let hold: Promise<void> | null = null;
    let release: () => void = () => {};
    const calls: NormalizedRequest[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push(structuredClone(request));
        const held = hold;
        hold = null;
        if (held) await held;
        throw failure('server', { httpStatus: 503 });
      },
    };
    const fx = await build(membrane);
    for (let i = 0; i < 3; i++) {
      fx.strategy.land(membrane);
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    }
    assert.deepEqual(runsOf(fx.strategy), [3], "the old content's run");
    // The old content's next call is held.
    fx.strategy.land(membrane);
    hold = new Promise<void>((resolve) => { release = resolve; });
    const before = calls.length;
    const late = fx.strategy.run(fx.target(), managerContext(fx.manager));
    await firstCallAfter(calls, before);
    // Meanwhile the source is edited, and a sibling counts two failures of the new content.
    fx.manager.editMessage(fx.ids[10]!, [text('raw-10 edited in place ' + 'substantive '.repeat(12))]);
    const strategy = new ProbeStrategy(config({}));
    const manager = await ContextManager.open({ store: fx.manager.getStore(), strategy, membrane: membrane as never });
    manager.setToolDefinitions(['skip_reply', 'journal'].map(tool));
    for (let i = 0; i < 2; i++) {
      strategy.land(membrane);
      await assert.rejects(strategy.run(fx.target(), managerContext(manager)), /zz server failure/);
    }
    // Each strategy keeps its own runs, in memory.
    assert.deepEqual(runsOf(strategy), [2], "the new content's run is two");
    release();
    await assert.rejects(late, /zz server failure/);
    assert.deepEqual(runsOf(fx.strategy), [4], "the old content's late failure counts on its own run");
    assert.deepEqual(runsOf(strategy), [2], "and leaves the new content's");
    // A new L1 grows the frontier: the new content's next family takes its own content's run.
    strategy.seed(l1(fx.ids, 'L1-101', 2, 3));
    strategy.land(membrane);
    await assert.rejects(strategy.run(fx.target(), managerContext(manager)), /zz server failure/);
    assert.deepEqual(runsOf(strategy), [3], "the new content's next failure counts on");
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 0);
    manager.close();
    fx.manager.close();
  });

  it("a decision ends the chunk's run: a later family starts again (Andrew-2310's boundary 2, sheet I13)", async () => {
    const mock = scripted([{ throw: failure('server', { httpStatus: 503 }) }]);
    const fx = await build(mock.membrane);
    for (let i = 0; i < 7; i++) {
      fx.strategy.land(mock.membrane);
      await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    }
    // A new L1 grows the frontier: a new family carries the run, and its failure is the eighth.
    fx.strategy.seed(l1(fx.ids, 'L1-101', 2, 3));
    fx.strategy.land(mock.membrane);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'the eighth decides it');
    assert.deepEqual(runsOf(fx.strategy), [], 'and the decided run is gone');
    // Another L1 grows the frontier again: the next family's first failure is a run of one.
    fx.strategy.seed(l1(fx.ids, 'L1-102', 4, 5));
    fx.strategy.land(mock.membrane);
    await assert.rejects(fx.strategy.run(fx.target(), managerContext(fx.manager)), /zz server failure/);
    assert.equal(fx.strategy.getCompressionQuarantineStatus().count, 1, 'no second decision from the old run');
    assert.deepEqual(runsOf(fx.strategy), [1]);
    fx.manager.close();
  });

});

describe("an answer resumes only its own route's pause (Andrew-2310's boundary 4)", () => {
  it("another membrane's answer leaves the pause; the same route's answer ends it", async () => {
    const stated = failure('rate_limit', { httpStatus: 429, retryAfterMs: 3 * HOUR });
    const routeA = scripted([OK('answered on A')]);
    const routeB = scripted([OK('answered on B')]);
    const a = await build(routeA.membrane);
    a.strategy.notePause(stated, managerContext(a.manager));
    assert.ok(a.strategy.paused(), "route A's stated wait");
    await a.strategy.run(a.target(), { ...managerContext(a.manager), membrane: routeB.membrane });
    assert.equal(routeB.calls.length, 1, 'answered through B');
    assert.ok(a.strategy.paused(), "B's answer says nothing about A: A's pause stands");
    a.manager.close();

    const otherModel = await build(routeA.membrane);
    otherModel.strategy.notePause(stated, managerContext(otherModel.manager));
    otherModel.strategy.setCompressionModel('zz-other-model');
    await otherModel.strategy.run(otherModel.target(), managerContext(otherModel.manager));
    assert.ok(otherModel.strategy.paused(), 'an answer naming another model leaves the pause (cm138-r4 I15)');
    otherModel.manager.close();

    const control = await build(routeA.membrane);
    control.strategy.notePause(stated, managerContext(control.manager));
    await control.strategy.run(control.target(), managerContext(control.manager));
    assert.ok(!control.strategy.paused(), "A's answer ends A's pause");
    control.manager.close();
  });
});

describe("a chunk no longer pending leaves its run", () => {
  it('the next ordering drops it, with the failure orders', async () => {
    const fx = await queued(scripted([OK('unused')]).membrane);
    const runs = (fx.strategy as unknown as { compressionFailureRuns: Map<string, { run: unknown; chunkKey: string }> }).compressionFailureRuns;
    const run = { key: 'zz', domain: 'zz', failures: 1, atLanded: 0 };
    const pending = fx.strategy.chunksView().find((chunk) => !chunk.compressed)!;
    runs.set('zz-gone', { run, chunkKey: 'zz-a chunk no longer cut' });
    runs.set('zz-pending', { run, chunkKey: pending.messages.map((m) => m.id).join(':') });
    (fx.strategy as unknown as { orderCompressionQueue(): void }).orderCompressionQueue();
    assert.deepEqual([...runs.keys()], ['zz-pending']);
    fx.manager.close();
  });
});

describe("a preview keeps the lane's failure orders, runs and window waits (cm138-r4 I3)", () => {
  it('the dry rebuild prunes them against its own cut, and the select puts them back', async () => {
    const fx = await queued(scripted([OK('unused')]).membrane);
    const lane = fx.strategy as unknown as {
      compressionFailureOrder: Map<string, number>; compressionNotBefore: Map<string, number>; mergeFailureOrder: Map<string, number>;
      compressionFailureRuns: Map<string, { run: unknown; chunkKey: string }>; mergeFailureRuns: Map<string, unknown>;
    };
    const run = { key: 'zz', domain: 'zz', failures: 1, atLanded: 0 };
    lane.compressionFailureOrder.set('zz-a chunk the preview cuts otherwise', 1);
    lane.compressionNotBefore.set('zz-a chunk the preview cuts otherwise', Date.now() + 60_000);
    lane.compressionFailureRuns.set('zz-subject', { run, chunkKey: 'zz-a chunk the preview cuts otherwise' });
    lane.mergeFailureOrder.set('zz-a queued merge', 2);
    lane.mergeFailureRuns.set('zz-a queued merge', run);
    await fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    assert.equal(lane.compressionFailureOrder.get('zz-a chunk the preview cuts otherwise'), 1);
    assert.ok(lane.compressionNotBefore.has('zz-a chunk the preview cuts otherwise'));
    assert.ok(lane.compressionFailureRuns.has('zz-subject'));
    assert.equal(lane.mergeFailureOrder.get('zz-a queued merge'), 2);
    assert.ok(lane.mergeFailureRuns.has('zz-a queued merge'));
    fx.manager.close();
  });
});

describe("a dry select during a call leaves the call's chunk to be put back (sheet I3)", () => {
  it('a transient failure after a preview puts the chunk back in the queue', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const mock = scripted([{ gate, then: { throw: failure('network') } }]);
    const fx = await queued(mock.membrane);
    const queuedAtStart = fx.strategy.compressionQueueView();
    assert.ok(queuedAtStart.length >= 1);
    const attempt = fx.strategy.tick(managerContext(fx.manager));
    await firstCallAfter(mock.calls, 0);
    await fx.manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }, undefined, { dryRun: true });
    release();
    await assert.rejects(attempt, /zz network failure/);
    assert.ok(fx.strategy.compressionQueueView().includes(queuedAtStart[0]!), 'the failed chunk is queued again');
    fx.manager.close();
  });
});

describe("a split-window wait skips its chunk for the wait and lets the tick go on (sheet I4, I21)", () => {
  it('the chunk behind it runs in the same tick, and the waiting one is skipped until its wait ends', async () => {
    const mock = scripted([OK('the next chunk')]);
    const fx = await queued(mock.membrane);
    assert.ok(fx.strategy.compressionQueueView().length >= 2, 'two chunks pending');
    const lane = fx.strategy as unknown as {
      compressChunkHierarchical(chunk: Chunk, ctx: StrategyContext, onSkip?: () => void): Promise<void>;
      splitCallTimes: number[];
      splitWindowWait(needed: number, limit: number, windowMs: number): Error & { waitMs: number };
      compressionNotBefore: Map<string, number>;
    };
    const original = lane.compressChunkHierarchical.bind(fx.strategy);
    const attempted: number[] = [];
    let waitMs = 0;
    let calledAt = 0;
    let waitBounds: [number, number] = [0, 0];
    lane.compressChunkHierarchical = async (chunk, ctx, onSkip) => {
      attempted.push(chunk.index);
      if (attempted.length === 1) {
        // Its split rung meets a window whose one call was made a second ago.
        calledAt = Date.now() - 1_000;
        lane.splitCallTimes = [calledAt];
        const t0 = Date.now();
        const wait = lane.splitWindowWait(1, 1, 60_000);
        waitBounds = [calledAt + 60_000 - Date.now(), calledAt + 60_000 - t0];
        waitMs = wait.waitMs;
        throw wait;
      }
      return original(chunk, ctx, onSkip);
    };
    const before = Date.now();
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(attempted.length, 2, 'the chunk behind the waiting one ran in the same tick');
    assert.ok(waitMs >= waitBounds[0] && waitMs <= waitBounds[1], `the wait runs until the window's call ages out (${waitMs} ms)`);
    const [notBefore] = [...lane.compressionNotBefore.values()];
    assert.ok(notBefore! >= before + waitMs && notBefore! <= Date.now() + waitMs, 'the chunk is skipped for that wait');
    await fx.strategy.tick(managerContext(fx.manager));
    assert.ok(!attempted.slice(2).includes(attempted[0]!), 'and skipped again before it ends');
    fx.manager.close();
  });
});

describe('a window wait after a branch switch ends the scan (cm138-r4 I14)', () => {
  it('no chunk behind it runs under the old branch', async () => {
    const fx = await queued(scripted([OK('the next chunk')]).membrane);
    assert.ok(fx.strategy.compressionQueueView().length >= 2, 'two chunks pending');
    const store = fx.manager.getStore();
    const fork = store.createBranchAt('zz-fork', fx.manager.currentBranch().name, store.currentSequence()).name;
    const lane = fx.strategy as unknown as {
      compressChunkHierarchical(chunk: Chunk, ctx: StrategyContext, onSkip?: () => void): Promise<void>;
      splitCallTimes: number[];
      splitWindowWait(needed: number, limit: number, windowMs: number): Error;
    };
    const original = lane.compressChunkHierarchical.bind(fx.strategy);
    let attempts = 0;
    lane.compressChunkHierarchical = async (chunk, ctx, onSkip) => {
      attempts++;
      if (attempts === 1) {
        await fx.manager.switchBranch(fork);
        lane.splitCallTimes = [Date.now() - 1_000];
        throw lane.splitWindowWait(1, 1, 60_000);
      }
      return original(chunk, ctx, onSkip);
    };
    await fx.strategy.tick(managerContext(fx.manager));
    assert.equal(attempts, 1, 'the scan ended at the switch');
    fx.manager.close();
  });
});

describe('the quarantine names each stuck span once, with its messages and age', () => {
  it('two exhausted shapes of one chunk are one span: two records, its first and last message, its age and the answers paid for', async () => {
    const rejected = { throw: failure('invalid_request', { httpStatus: 400 }) };
    // Each shape pays its canonical, then its source-only rung: the first shape is rejected twice, the second refused twice.
    const mock = scripted([rejected, rejected, REFUSAL, REFUSAL]);
    const fx = await build(mock.membrane, { sourceOnlyFallback: true });
    const chunk = fx.target();
    fx.strategy.adopt(chunk);
    await fx.strategy.run(chunk, managerContext(fx.manager));
    // Another model is another request shape for the same span: it earns a fresh bounded family.
    fx.strategy.setCompressionModel('zz-other-model');
    await fx.strategy.run(chunk, managerContext(fx.manager));
    assert.equal(mock.calls.length, 4, 'two rungs per shape');

    const status = fx.strategy.getCompressionQuarantineStatus();
    const created = (fx.strategy as unknown as { readCompressionQuarantineProjection(): Map<string, { record: { created: number } }> })
      .readCompressionQuarantineProjection();
    assert.equal(status.count, 2, 'a record per shape');
    assert.equal(status.spans.length, 1, 'one span');
    const [span] = status.spans;
    assert.equal(span!.chunkSourceHash, createHash('sha256').update(JSON.stringify(fx.ids.slice(10))).digest('hex'));
    assert.equal(span!.firstMessageId, fx.ids[10]);
    assert.equal(span!.lastMessageId, fx.ids[12]);
    assert.equal(span!.records, 2);
    assert.equal(span!.answeredAttempts, 4, 'each record holds both of its answers');
    assert.ok(span!.closedAgeMs !== null && span!.closedAgeMs >= 0 && span!.closedAgeMs < 60_000, `aged from its messages: ${span!.closedAgeMs}`);
    assert.equal(span!.latestOutcome, 'refusal', "the newest record's last answer, not the oldest's");
    assert.equal(span!.quarantinedAt, Math.min(...[...created.values()].map((active) => active.record.created)), 'refused since its earliest record');

    // The fixture turns the klaxon off; turn it on for this one sound.
    (fx.strategy as unknown as { config: { quarantineAlarmIntervalMs: number } }).config.quarantineAlarmIntervalMs = 15 * 60_000;
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await fx.strategy.klaxon();
    } finally {
      console.error = error;
    }
    const alarm = lines.find((line) => line.startsWith('[compression-quarantine] ⚠️'));
    assert.ok(alarm, `the klaxon sounded: ${lines.join(' | ')}`);
    assert.match(alarm!, /⚠️ 1 span\(s\) in compression quarantine \(2 record\(s\)\)/);
    const since = new Date(span!.quarantinedAt).toISOString().slice(0, 16);
    assert.ok(alarm!.includes(`${fx.ids[10]}..${fx.ids[12]} (closed 0 min ago, refusing since ${since}Z, 2 records, 4 answered, last refusal)`), alarm);
    fx.manager.close();
  });

  it('after a reopen the line shows the same "refusing since" and counts, and the exhausted span is not asked again', async () => {
    const path = freshPath();
    const hours = (n: number): number => n * 3_600_000;
    // The canonical is rejected, then source-only-final is refused: the family exhausts with two answers.
    const first = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }, REFUSAL]);
    const a = await build(first.membrane, { sourceOnlyFallback: true, path });
    // The chunk closed four hours ago, and its family exhausted three hours ago.
    const closedAt = new Date(Date.now() - hours(4));
    const want = new Set(a.ids.slice(10));
    const agedChunk = (fx: Awaited<ReturnType<typeof build>>): Chunk => ({
      index: 999, startIndex: 10, endIndex: 13, tokens: 100, compressed: false,
      messages: managerContext(fx.manager).messageStore.getAll().filter((m) => want.has(m.id)).map((m) => ({ ...m, timestamp: closedAt })),
    });
    const chunk = agedChunk(a);
    a.strategy.adopt(chunk);
    // A real chunk has a persisted raw record, and the paid-off sweep keeps a quarantine only against one.
    (a.strategy as unknown as { appendChunkRecord(record: unknown): void })
      .appendChunkRecord({ id: 'c-zz-reopen', sourceIds: chunk.messages.map((m) => m.id), compressed: false });
    const realNow = Date.now;
    const from = realNow() - hours(3);
    Date.now = () => realNow() - hours(3);
    try {
      await a.strategy.run(chunk, managerContext(a.manager));
    } finally {
      Date.now = realNow;
    }
    const to = Date.now() - hours(3);
    assert.equal(first.calls.length, 2);
    const lineOf = async (fx: Awaited<ReturnType<typeof build>>): Promise<string> => {
      (fx.strategy as unknown as { config: { quarantineAlarmIntervalMs: number } }).config.quarantineAlarmIntervalMs = 15 * 60_000;
      const lines: string[] = [];
      const error = console.error;
      console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
      try {
        await fx.strategy.klaxon();
      } finally {
        console.error = error;
      }
      const alarm = lines.find((line) => line.startsWith('[compression-quarantine] ⚠️'));
      assert.ok(alarm, `the klaxon sounded: ${lines.join(' | ')}`);
      return alarm!;
    };
    const before = a.strategy.getCompressionQuarantineStatus().spans;
    assert.equal(before.length, 1);
    assert.ok(before[0]!.quarantinedAt >= from && before[0]!.quarantinedAt <= to, 'refusing since its record was made, three hours ago, not since now');
    const figures = `${a.ids[10]}..${a.ids[12]} (closed 4.0 h ago, refusing since ${new Date(before[0]!.quarantinedAt).toISOString().slice(0, 16)}Z, 1 record, 2 answered, last refusal)`;
    const lineBefore = await lineOf(a);
    assert.ok(lineBefore.includes(figures), lineBefore);
    a.manager.close();

    const second = scripted([OK('a summary nobody should ask for')]);
    const b = await build(second.membrane, { sourceOnlyFallback: true, path });
    b.strategy.adopt(agedChunk(b));
    const after = b.strategy.getCompressionQuarantineStatus().spans;
    assert.deepEqual(
      after.map((span) => [span.chunkSourceHash, span.quarantinedAt, span.records, span.answeredAttempts, span.latestOutcome]),
      before.map((span) => [span.chunkSourceHash, span.quarantinedAt, span.records, span.answeredAttempts, span.latestOutcome]),
      'the durable figures read back unchanged',
    );
    const lineAfter = await lineOf(b);
    assert.ok(lineAfter.includes(figures), lineAfter);
    await b.strategy.run(agedChunk(b), managerContext(b.manager));
    assert.equal(second.calls.length, 0, 'the exhausted span is not asked again after the reopen');
    assert.equal(b.strategy.getCompressionQuarantineStatus().spans.length, 1, 'and it is still quarantined');
    b.manager.close();
  });

  it('lists the longest-waiting span first', async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane);
    const recent = fx.target();
    // An earlier chunk, closed an hour before: its messages carry older timestamps.
    const hourAgo = new Date(Date.now() - 3_600_000);
    const want = new Set(fx.ids.slice(2, 5));
    const older: Chunk = {
      index: 998, startIndex: 2, endIndex: 5, tokens: 100, compressed: false,
      messages: managerContext(fx.manager).messageStore.getAll().filter((m) => want.has(m.id)).map((m) => ({ ...m, timestamp: hourAgo })),
    };
    fx.strategy.adopt(recent);
    fx.strategy.adopt(older);
    await fx.strategy.run(recent, managerContext(fx.manager));
    await fx.strategy.run(older, managerContext(fx.manager));
    const spans = fx.strategy.getCompressionQuarantineStatus().spans;
    assert.deepEqual(spans.map((span) => span.firstMessageId), [fx.ids[2], fx.ids[10]], 'the longest waiting first');
    assert.ok(spans[0]!.closedAgeMs! >= 3_600_000);
    fx.manager.close();
  });

  it('a span no current chunk has is still counted once, unnamed and undated', async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane);
    await fx.strategy.run(fx.target(), managerContext(fx.manager));
    const status = fx.strategy.getCompressionQuarantineStatus();
    assert.equal(status.count, 1);
    assert.deepEqual(
      status.spans.map((span) => [span.firstMessageId, span.lastMessageId, span.closedAgeMs, span.records]),
      [[null, null, null, 1]],
    );
    fx.manager.close();
  });
});

describe('how a new stuck span reaches the operator', () => {
  const capture = async (fn: () => Promise<unknown>): Promise<string[]> => {
    const lines: string[] = [];
    const error = console.error;
    const warn = console.warn;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    console.warn = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      console.warn = warn;
    }
    return lines;
  };
  const alerts = (lines: string[]): Array<Record<string, unknown>> => lines
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((payload) => payload.event === 'compression:quarantine-alert');
  const alarms = (lines: string[]): string[] => lines.filter((line) => line.startsWith('[compression-quarantine] ⚠️'));
  const turnKlaxonOn = (fx: Awaited<ReturnType<typeof build>>): void => {
    (fx.strategy as unknown as { config: { quarantineAlarmIntervalMs: number } }).config.quarantineAlarmIntervalMs = 15 * 60_000;
  };

  it('entering quarantine emits its keyed alert at once, and once', async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane);
    const first = await capture(() => fx.strategy.run(fx.target(), managerContext(fx.manager)));
    const status = fx.strategy.getCompressionQuarantineStatus();
    assert.equal(status.count, 1, 'the family is exhausted');
    const sent = alerts(first);
    assert.equal(sent.length, 1, `one alert on entry: ${first.join(' | ')}`);
    assert.equal(sent[0]!.quarantine_key, status.keys[0]);
    assert.equal(sent[0]!.alert_key, status.keys[0]);
    assert.equal(sent[0]!.chunk_hash, status.spans[0]!.chunkSourceHash);
    const again = await capture(() => fx.strategy.run(fx.target(), managerContext(fx.manager)));
    assert.equal(alerts(again).length, 0, 'a span already quarantined makes no new alert');
    fx.manager.close();
  });

  it('the alarm repeats every interval while a span stays quarantined, and not within one', async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane);
    await capture(() => fx.strategy.run(fx.target(), managerContext(fx.manager)));
    turnKlaxonOn(fx);
    assert.equal(alarms(await capture(() => fx.strategy.klaxon())).length, 1, 'the first sound');
    assert.equal(alarms(await capture(() => fx.strategy.klaxon())).length, 0, 'within the interval: quiet');
    // Stand for an interval passing since the last sound.
    (fx.strategy as unknown as { quarantineAlarmLastAt: number }).quarantineAlarmLastAt -= 15 * 60_000;
    assert.equal(alarms(await capture(() => fx.strategy.klaxon())).length, 1, 'an interval later it sounds again');
    fx.manager.close();
  });

  it("tick sounds the alarm, and the line lists a span quarantined after the last sound", async () => {
    const mock = scripted([{ throw: failure('invalid_request', { httpStatus: 400 }) }]);
    const fx = await build(mock.membrane);
    turnKlaxonOn(fx);
    // No membrane on the tick's context: it sounds the alarm, then stops before any compression.
    const quiet = { ...managerContext(fx.manager), membrane: undefined } as unknown as StrategyContext;
    await capture(() => fx.strategy.run(fx.target(), managerContext(fx.manager)));
    const firstTick = alarms(await capture(() => fx.strategy.tick(quiet)));
    assert.equal(firstTick.length, 1, 'the tick sounded it');
    assert.match(firstTick[0]!, /⚠️ 1 span\(s\)/);
    // A second span quarantines while the first is listed: no debt state need change.
    const want = new Set(fx.ids.slice(2, 5));
    const older: Chunk = {
      index: 998, startIndex: 2, endIndex: 5, tokens: 100, compressed: false,
      messages: managerContext(fx.manager).messageStore.getAll().filter((m) => want.has(m.id)),
    };
    fx.strategy.adopt(older);
    const entry = await capture(() => fx.strategy.run(older, managerContext(fx.manager)));
    assert.equal(alerts(entry).length, 1, 'its own keyed alert, at once');
    (fx.strategy as unknown as { quarantineAlarmLastAt: number }).quarantineAlarmLastAt -= 15 * 60_000;
    const nextTick = alarms(await capture(() => fx.strategy.tick(quiet)));
    assert.equal(nextTick.length, 1, 'the next due tick sounded it again');
    assert.match(nextTick[0]!, /⚠️ 2 span\(s\)/);
    assert.ok(nextTick[0]!.includes(`${fx.ids[2]}..${fx.ids[4]} (`), nextTick[0]);
    fx.manager.close();
  });
});

describe('the span table, read from records the test writes', () => {
  type Outcome = { outcome: string; errorType?: string };
  const hashOf = (ids: readonly string[]): string => createHash('sha256').update(JSON.stringify(ids)).digest('hex');
  /** The ledger as the status reads it, in the order given; the alarm's sweep leaves it alone. */
  const writeLedger = (fx: Awaited<ReturnType<typeof build>>, records: Array<{ hash: string; created: number; outcomes: Outcome[] }>): void => {
    const projection = new Map(records.map((record, i) => [
      `zz-key-${i}`,
      { record: { chunkSourceHash: record.hash, created: record.created }, outcomes: record.outcomes },
    ]));
    const lane = fx.strategy as unknown as { readCompressionQuarantineProjection(): unknown; sweepPaidOffQuarantineRecords(): Promise<void> };
    lane.readCompressionQuarantineProjection = () => projection;
    lane.sweepPaidOffQuarantineRecords = async () => {};
  };
  const chunkOf = (fx: Awaited<ReturnType<typeof build>>, ids: readonly string[], timestamps: Array<Date | number | undefined>): Chunk => {
    const want = new Set(ids);
    const messages = managerContext(fx.manager).messageStore.getAll().filter((m) => want.has(m.id))
      .map((m, i) => ({ ...m, timestamp: timestamps[i] as Date }));
    return { index: 900, startIndex: 0, endIndex: messages.length, tokens: 100, compressed: false, messages };
  };

  it("names the newest record's last outcome, error type and all, null when it holds none; counts only what a provider answered", async () => {
    const fx = await build(scripted([]).membrane);
    const recent = fx.ids.slice(10);
    const older = fx.ids.slice(2, 5);
    fx.strategy.adopt(fx.target());
    fx.strategy.adopt(chunkOf(fx, older, [new Date(), new Date(), new Date()]));
    writeLedger(fx, [
      // The newest record comes first in the ledger, so the order read can't stand in for the newest.
      { hash: hashOf(recent), created: 300, outcomes: [{ outcome: 'refusal' }, { outcome: 'provider_error', errorType: 'invalid_request' }] },
      { hash: hashOf(recent), created: 100, outcomes: [{ outcome: 'incomplete' }, { outcome: 'admission_rejected' }] },
      // An older record that answered, and a newer one that holds nothing yet.
      { hash: hashOf(older), created: 200, outcomes: [{ outcome: 'refusal' }] },
      { hash: hashOf(older), created: 400, outcomes: [] },
    ]);
    const spans = new Map(fx.strategy.getCompressionQuarantineStatus().spans.map((span) => [span.firstMessageId, span]));
    assert.equal(spans.get(recent[0]!)!.latestOutcome, 'provider_error:invalid_request', "the newest record's last answer, with its error type");
    assert.equal(spans.get(recent[0]!)!.answeredAttempts, 3, 'a recall variant planned over the context budget was never sent');
    assert.equal(spans.get(recent[0]!)!.quarantinedAt, 100);
    assert.equal(spans.get(older[0]!)!.latestOutcome, null, 'its newest record holds no answer');
    assert.equal(spans.get(older[0]!)!.answeredAttempts, 1);
    fx.manager.close();
  });

  it("dates a span from its messages' valid timestamps, skipping an invalid Date", async () => {
    const fx = await build(scripted([]).membrane);
    const ids = fx.ids.slice(2, 5);
    const twoHoursAgo = Date.now() - 2 * 3_600_000;
    // First, where a NaN would have stuck as the close time.
    fx.strategy.adopt(chunkOf(fx, ids, [new Date(Number.NaN), new Date(twoHoursAgo - 60_000), new Date(twoHoursAgo)]));
    writeLedger(fx, [{ hash: hashOf(ids), created: 100, outcomes: [] }]);
    const [span] = fx.strategy.getCompressionQuarantineStatus().spans;
    assert.ok(span!.closedAgeMs !== null && Math.abs(span!.closedAgeMs - 2 * 3_600_000) < 60_000, `aged from the newest valid timestamp: ${span!.closedAgeMs}`);
    fx.manager.close();
  });

  it("a record's created time that no Date can hold shows as unknown, and the alarm doesn't throw", async () => {
    const fx = await build(scripted([]).membrane);
    const ids = fx.ids.slice(2, 5);
    fx.strategy.adopt(chunkOf(fx, ids, [new Date(), new Date(), new Date()]));
    writeLedger(fx, [{ hash: hashOf(ids), created: 1e20, outcomes: [{ outcome: 'refusal' }] }]);
    (fx.strategy as unknown as { config: { quarantineAlarmIntervalMs: number } }).config.quarantineAlarmIntervalMs = 15 * 60_000;
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await fx.strategy.klaxon();
    } finally {
      console.error = error;
    }
    const alarm = lines.find((line) => line.startsWith('[compression-quarantine] ⚠️'));
    assert.ok(alarm, `the klaxon sounded: ${lines.join(' | ')}`);
    assert.ok(alarm!.includes(`${ids[0]}..${ids[2]} (closed 0 min ago, refusing since unknown, 1 record, 1 answered, last refusal)`), alarm);
    fx.manager.close();
  });

  it('the alarm line: hours past an hour, close time unknown for an unnamed span (listed last), one record, and no last outcome when none answered', async () => {
    const fx = await build(scripted([]).membrane);
    const recent = fx.ids.slice(10);
    const older = fx.ids.slice(2, 5);
    const stamp = Date.now() - 2.5 * 3_600_000;
    fx.strategy.adopt(fx.target());
    fx.strategy.adopt(chunkOf(fx, older, [new Date(stamp - 60_000), new Date(stamp - 30_000), new Date(stamp)]));
    const at = (iso: string): number => Date.parse(iso);
    writeLedger(fx, [
      { hash: 'zz-no-current-chunk', created: at('2026-10-14T23:05:00Z'), outcomes: [{ outcome: 'refusal' }] },
      { hash: hashOf(recent), created: at('2026-10-15T10:21:30Z'), outcomes: [{ outcome: 'provider_error', errorType: 'invalid_request' }] },
      { hash: hashOf(older), created: at('2026-10-15T09:40:00Z'), outcomes: [] },
    ]);
    (fx.strategy as unknown as { config: { quarantineAlarmIntervalMs: number } }).config.quarantineAlarmIntervalMs = 15 * 60_000;
    const lines: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    try {
      await fx.strategy.klaxon();
    } finally {
      console.error = error;
    }
    const alarm = lines.find((line) => line.startsWith('[compression-quarantine] ⚠️'));
    assert.ok(alarm, `the klaxon sounded: ${lines.join(' | ')}`);
    const listed = alarm!.slice(alarm!.indexOf('spans: ') + 'spans: '.length, alarm!.indexOf('. keys='));
    assert.equal(listed, [
      `${older[0]}..${older[2]} (closed 2.5 h ago, refusing since 2026-10-15T09:40Z, 1 record, 0 answered)`,
      `${recent[0]}..${recent[2]} (closed 0 min ago, refusing since 2026-10-15T10:21Z, 1 record, 1 answered, last provider_error:invalid_request)`,
      '?..? (close time unknown, refusing since 2026-10-14T23:05Z, 1 record, 1 answered, last refusal)',
    ].join('; '));
    fx.manager.close();
  });
});
