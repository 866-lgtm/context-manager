/**
 * [local patch] Dedicated compression membrane.
 *
 * A host can route memory-formation (compression/summarization) calls to a
 * separate endpoint while live conversation stays on the primary provider:
 * ContextManager.setCompressionMembrane() (or `compressionMembrane` at open)
 * -> StrategyContext.compressionMembrane (a live getter) -> every request
 * site the autobiographical strategy dispatches: L1 mints on every ladder
 * rung, merges, the refusal-escalation retry, the carrier-transport
 * fallback, and the transition summary. With none attached, every one of
 * those goes to the primary membrane, exactly as upstream.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { StrategyContext } from '../src/index.js';
import type { ContentBlock, Membrane, NormalizedRequest } from '@animalabs/membrane';

const ZZ_STORE_PATH = './test-zz-compression-membrane';
const ZZ_COMPRESSION_MODEL = 'zz-compression-membrane-model';
/** Present in every L1 compression instruction, absent from merge prompts. */
const L1_MARKER_SNIPPET = 'You will soon form a new memory';
const ZZ_LIGHT = 'zz-light operator prompt';
const ZZ_HEAVY = 'zz-heavy refusal-escalation prompt';

function cleanup(): void {
  if (existsSync(ZZ_STORE_PATH)) rmSync(ZZ_STORE_PATH, { recursive: true, force: true });
}

const t = (text: string): ContentBlock => ({ type: 'text', text });

type Reply = (request: NormalizedRequest, n: number) => unknown;

const ok: Reply = () => ({
  stopReason: 'end_turn',
  content: [t('A stretch of routine traffic worth remembering in some detail: ' + 'word '.repeat(40))],
  usage: { input_tokens: 1000, output_tokens: 50 },
});

function capturing(label: string, reply: Reply = ok) {
  const calls: NormalizedRequest[] = [];
  const membrane = {
    label,
    complete: async (request: NormalizedRequest) => {
      calls.push(structuredClone(request));
      return reply(request, calls.length);
    },
  };
  return { membrane: membrane as unknown as Membrane, calls };
}

function isMerge(request: NormalizedRequest): boolean {
  return !request.messages.some((m) =>
    m.content.some((b) => b.type === 'text' && b.text.includes(L1_MARKER_SNIPPET)));
}

function carriesReasoning(request: NormalizedRequest): boolean {
  return request.messages.some((m) => m.content.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking'));
}

async function drain(manager: ContextManager): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (manager.isReady()) return;
    await manager.tick();
  }
  throw new Error('drain: queue did not converge within 500 ticks');
}

/** Exposes the ctx the manager hands the strategy at initialize(), and the
 *  strategy's own resolution of it. */
class CtxProbeStrategy extends AutobiographicalStrategy {
  captured?: StrategyContext;
  override async initialize(ctx: StrategyContext): Promise<void> {
    this.captured = ctx;
    return super.initialize(ctx);
  }
  resolve(ctx: StrategyContext): Membrane | undefined {
    return this.compressionMembraneFor(ctx);
  }
}

interface Workload {
  primary: Membrane;
  /** Attached via setCompressionMembrane right after open. */
  attach?: Membrane;
  /** Passed as ContextManagerConfig.compressionMembrane. */
  atOpen?: Membrane;
  strategyOptions?: Record<string, unknown>;
  turns?: number;
}

async function runWorkload(w: Workload): Promise<CtxProbeStrategy> {
  cleanup();
  const strategy = new CtxProbeStrategy({
    compressionModel: ZZ_COMPRESSION_MODEL,
    targetChunkTokens: 80,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    hierarchical: true,
    mergeThreshold: 2,
    ...w.strategyOptions,
  } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
  const manager = await ContextManager.open({
    path: ZZ_STORE_PATH,
    strategy,
    membrane: w.primary,
    ...(w.atOpen ? { compressionMembrane: w.atOpen } : {}),
  });
  if (w.attach) manager.setCompressionMembrane(w.attach);
  const turns = w.turns ?? 60;
  for (let i = 0; i < turns; i++) {
    manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [
      t(`turn ${i} of steady substantive traffic about the ongoing work `.repeat(3)),
    ]);
    await drain(manager);
  }
  await manager.close();
  cleanup();
  return strategy;
}

describe('Dedicated compression membrane', () => {
  before(() => cleanup());
  after(() => cleanup());

  it('none attached: every L1 mint and merge goes to the primary membrane (upstream behavior)', async () => {
    const primary = capturing('primary');
    await runWorkload({ primary: primary.membrane });
    assert.ok(primary.calls.filter((r) => !isMerge(r)).length >= 2, 'expected L1 mints on the primary');
    assert.ok(primary.calls.filter(isMerge).length >= 1, 'expected merges on the primary');
  });

  it('setCompressionMembrane: every L1 mint and merge goes to the compression membrane, none to the primary', async () => {
    const primary = capturing('primary');
    const compression = capturing('compression');
    await runWorkload({ primary: primary.membrane, attach: compression.membrane });
    assert.strictEqual(primary.calls.length, 0, 'the primary must carry no memory-write');
    assert.ok(compression.calls.filter((r) => !isMerge(r)).length >= 2, 'expected L1 mints on the compression membrane');
    assert.ok(compression.calls.filter(isMerge).length >= 1, 'expected merges on the compression membrane');
  });

  it('compressionMembrane at open() routes the same way', async () => {
    const primary = capturing('primary');
    const compression = capturing('compression');
    await runWorkload({ primary: primary.membrane, atOpen: compression.membrane });
    assert.strictEqual(primary.calls.length, 0);
    assert.ok(compression.calls.length >= 3);
  });

  it('requests are byte-identical whichever membrane carries them', async () => {
    const viaPrimary = capturing('primary');
    await runWorkload({ primary: viaPrimary.membrane });
    const primary = capturing('primary');
    const viaCompression = capturing('compression');
    await runWorkload({ primary: primary.membrane, attach: viaCompression.membrane });
    assert.strictEqual(primary.calls.length, 0);
    assert.deepStrictEqual(viaCompression.calls, viaPrimary.calls);
  });

  it('the strategy ctx reads the attachment live: a ctx captured before attach/detach sees each change', async () => {
    cleanup();
    const primary = capturing('primary');
    const compression = capturing('compression');
    const strategy = new CtxProbeStrategy({ compressionModel: ZZ_COMPRESSION_MODEL });
    const manager = await ContextManager.open({ path: ZZ_STORE_PATH, strategy, membrane: primary.membrane });
    const ctx = strategy.captured!;
    assert.ok(ctx, 'setup: initialize() captured a ctx');
    assert.strictEqual(manager.getCompressionMembrane(), undefined);
    assert.strictEqual(strategy.resolve(ctx), primary.membrane);
    manager.setCompressionMembrane(compression.membrane);
    assert.strictEqual(manager.getCompressionMembrane(), compression.membrane);
    assert.strictEqual(strategy.resolve(ctx), compression.membrane);
    manager.setCompressionMembrane(undefined);
    assert.strictEqual(strategy.resolve(ctx), primary.membrane);
    await manager.close();
    cleanup();
  });

  it('only a compression membrane (no primary): compression still runs on it', async () => {
    cleanup();
    const compression = capturing('compression');
    const strategy = new AutobiographicalStrategy({
      compressionModel: ZZ_COMPRESSION_MODEL, targetChunkTokens: 80, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true,
    });
    const manager = await ContextManager.open({ path: ZZ_STORE_PATH, strategy, compressionMembrane: compression.membrane });
    for (let i = 0; i < 30; i++) {
      manager.addMessage(i % 2 === 0 ? 'user' : 'agent', [t(`turn ${i} of steady traffic `.repeat(4))]);
      await drain(manager);
    }
    assert.ok(compression.calls.length > 0);
    await manager.close();
    cleanup();
  });

  for (const mode of ['stopReason', 'thrown'] as const) {
    it(`refusal escalation (${mode}): the retry rides the compression membrane on L1 and merge`, async () => {
      const primary = capturing('primary');
      const compression = capturing('compression', (request, n) => {
        if (request.system === ZZ_HEAVY) return ok(request, n);
        if (mode === 'thrown') throw Object.assign(new Error('content_filter: output blocked'), { type: 'content_filter' });
        return { stopReason: 'refusal', content: [t('I cannot help with that.')], usage: { input_tokens: 10, output_tokens: 5 } };
      });
      await runWorkload({
        primary: primary.membrane,
        attach: compression.membrane,
        strategyOptions: { compressionSystemPrompt: ZZ_LIGHT, compressionRefusalSystemPrompt: ZZ_HEAVY },
      });
      assert.strictEqual(primary.calls.length, 0, 'neither the attempt nor its escalation may touch the primary');
      const light = compression.calls.filter((r) => r.system === ZZ_LIGHT);
      const heavy = compression.calls.filter((r) => r.system === ZZ_HEAVY);
      assert.ok(light.length >= 3, `expected refused light attempts, got ${light.length}`);
      assert.ok(heavy.filter((r) => !isMerge(r)).length >= 2, 'expected L1 escalations on the compression membrane');
      assert.ok(heavy.filter(isMerge).length >= 1, 'expected merge escalations on the compression membrane');
    });
  }

  it('carrier-transport fallback: the stripped retry rides the compression membrane', async () => {
    const primary = capturing('primary');
    let rejected = 0;
    const compression = capturing('compression', (request, n) => {
      if (carriesReasoning(request)) {
        rejected++;
        throw Object.assign(new Error('invalid_request_error: thinking blocks cannot be modified'), { httpStatus: 400 });
      }
      return {
        stopReason: 'end_turn',
        content: [
          { type: 'thinking', thinking: `scratch ${n}`, signature: `sig-${n}-0123456789abcdef` },
          t(`Summary #${n}: things happened and I remember them. ` + 'word '.repeat(30)),
        ],
        usage: { input_tokens: 500, output_tokens: 80 },
      };
    });
    await runWorkload({ primary: primary.membrane, attach: compression.membrane });
    assert.strictEqual(primary.calls.length, 0);
    assert.ok(rejected >= 1, 'setup: a request carrying reasoning carriers reached the compression transport');
    const accepted = compression.calls.filter((r) => !carriesReasoning(r));
    assert.ok(accepted.length > rejected, 'each rejection was followed by a stripped retry on the compression membrane');
  });

  it('transition summary (resetHeadWindow without text) rides the compression membrane', async () => {
    cleanup();
    const primary = capturing('primary');
    const compression = capturing('compression', () => ({
      stopReason: 'end_turn', content: [t('zz transition summary')], usage: { input_tokens: 10, output_tokens: 5 },
    }));
    const strategy = new AutobiographicalStrategy({ compressionModel: ZZ_COMPRESSION_MODEL, autoTickOnNewMessage: false });
    const manager = await ContextManager.open({ path: ZZ_STORE_PATH, strategy, membrane: primary.membrane });
    manager.setCompressionMembrane(compression.membrane);
    manager.addMessage('user', [t('what we were doing before the topic changed')]);
    const summary = await manager.resetHeadWindow();
    assert.strictEqual(summary, 'zz transition summary');
    assert.strictEqual(primary.calls.length, 0);
    assert.strictEqual(compression.calls.length, 1);
    await manager.close();
    cleanup();
  });
});
