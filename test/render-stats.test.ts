/**
 * getRenderStats must INSPECT what select() actually rendered, not RECONSTRUCT
 * a hierarchical view. Regression for the adaptive-resolution case where the
 * reconstructed pyramid (head/tail windows + every live summary) bore no
 * relation to the folded output — and had no bucket at all for raw messages the
 * picker kept verbatim in the middle.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { RenderStats } from '../src/types/index.js';

const TEST_STORE_PATH = './test-render-stats';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}
function text(t: string): ContentBlock[] {
  return [{ type: 'text', text: t }];
}

/** The store's estimate of the compiled messages as they go out. */
function sentTokens(manager: ContextManager, messages: ReadonlyArray<{ content: ContentBlock[] }>): number {
  const store = (manager as unknown as { messageStore: { estimateTokens(m: { content: ContentBlock[] }): number } }).messageStore;
  return messages.reduce((sum, m) => sum + store.estimateTokens({ content: m.content }), 0);
}

function assertConsistent(rs: RenderStats): void {
  const s = rs.summaries;
  const sumTokens =
    rs.head.tokens + rs.tail.tokens + rs.middleRaw.tokens +
    s.l1.tokens + s.l2.tokens + s.l3.tokens;
  assert.strictEqual(rs.total.tokens, sumTokens, 'total.tokens === sum of bucket tokens');
  const sumMsgs =
    rs.head.messages + rs.tail.messages + rs.middleRaw.messages +
    (s.l1.count + s.l2.count + s.l3.count) * 2;
  assert.strictEqual(rs.total.messages, sumMsgs, 'total.messages === sum of bucket messages');
}

describe('getRenderStats — inspect, not reconstruct', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('reflects the actually-rendered raw conversation (every message accounted for once)', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ adaptiveResolution: true }),
    });
    const N = 8;
    for (let i = 0; i < N; i++) {
      manager.addMessage(i % 2 ? 'lena' : 'user', text(`message ${i} ${'x'.repeat(20)}`));
    }
    await manager.compile();

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present after compile');
    assertConsistent(rs!);
    // Small conversation, no membrane => no compression => no summaries.
    assert.strictEqual(
      rs!.summaries.l1.count + rs!.summaries.l2.count + rs!.summaries.l3.count,
      0,
      'no summaries for a small raw conversation',
    );
    const rawMsgs = rs!.head.messages + rs!.tail.messages + rs!.middleRaw.messages;
    assert.strictEqual(rawMsgs, N, 'every raw message accounted for exactly once');
    assert.ok(rs!.total.tokens > 0, 'non-zero rendered tokens');
    manager.close();
  });

  it('populates middleRaw for mid-conversation messages the picker keeps verbatim', async () => {
    // Small head/recent windows push most messages into the MIDDLE region; with
    // no summaries to fold into, the picker keeps them raw — which the old
    // reconstruction would have reported as 0 middle / all-pyramid.
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({
        adaptiveResolution: true,
        headWindowTokens: 100,
        recentWindowTokens: 100,
      }),
    });
    const N = 20;
    for (let i = 0; i < N; i++) {
      manager.addMessage(i % 2 ? 'lena' : 'user', text(`msg ${i} ${'y'.repeat(40)}`));
    }
    // Generous budget so nothing is evicted (and the picker doesn't go over-budget).
    await manager.compile({ maxTokens: 100_000, reserveForResponse: 1_000 });

    const rs = manager.getRenderStats();
    assert.ok(rs, 'stats present');
    assertConsistent(rs!);
    assert.ok(
      rs!.middleRaw.messages > 0,
      'middle messages kept raw by the picker must show up in middleRaw (inspect, not reconstruct)',
    );
    const rawMsgs = rs!.head.messages + rs!.tail.messages + rs!.middleRaw.messages;
    assert.strictEqual(rawMsgs, N, 'all raw, all accounted for');
    manager.close();
  });

  // Before a live compile there are no stats to report: they depend on the
  // budget a compile is given. The pyramid of live summaries that stood in
  // for them was neither cut (#304; connectome-host#425, where a kv-stable
  // resident's health readout showed 192 messages against a 377-message
  // request).
  it("is null before a live compile, and a dry run doesn't fill it (#304, the hierarchical path)", async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ headWindowTokens: 60, recentWindowTokens: 120, autoTickOnNewMessage: false }),
    });
    for (let i = 0; i < 24; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', text(`M-${i} ${'word '.repeat(10)}`));
    assert.strictEqual(manager.getRenderStats(), null, 'no live compile yet');
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    await manager.compile(budget, undefined, { dryRun: true });
    assert.strictEqual(manager.getRenderStats(), null, 'a dry run records no stats');
    const compiled = await manager.compile(budget);
    const rs = manager.getRenderStats();
    assert.ok(rs, 'a live compile records its stats');
    assertConsistent(rs!);
    assert.strictEqual(rs!.total.messages, compiled.messages.length, 'the stats count every message the compile sent');
    assert.strictEqual(rs!.total.tokens, sentTokens(manager, compiled.messages), 'and price them as it sent them');
    assert.ok(rs!.middleRaw.messages > 0, "the middle's raw messages are counted");
    manager.close();
  });

  it('is null again after a branch switch on the same strategy, until a live compile there', async () => {
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy: new AutobiographicalStrategy({ headWindowTokens: 60, recentWindowTokens: 120, autoTickOnNewMessage: false }),
    });
    for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', text(`M-${i} ${'word '.repeat(10)}`));
    const budget = { maxTokens: 1_000_000, reserveForResponse: 0 };
    await manager.compile(budget);
    assert.ok(manager.getRenderStats(), 'the live compile recorded its stats');
    await manager.fork('other');
    assert.strictEqual(manager.getRenderStats(), null, "the other branch hasn't compiled");
    const compiled = await manager.compile(budget);
    assert.strictEqual(manager.getRenderStats()?.total.messages, compiled.messages.length, "its first live compile records the branch's own stats");
    manager.close();
  });

  it('is null after a reopen until a live compile under kv-stable, then describes that compile', async () => {
    const summarizer = {
      complete: async () => ({
        stopReason: 'end_turn',
        content: [{ type: 'text', text: 'A memory of this stretch, kept brief: ' + 'detail '.repeat(12) }],
        usage: { input_tokens: 1000, output_tokens: 40 },
      }),
    };
    const strategy = () => new AutobiographicalStrategy({
      compressionModel: 'zz-model',
      targetChunkTokens: 120,
      headWindowTokens: 0,
      recentWindowTokens: 400,
      hierarchical: true,
      mergeThreshold: 3,
      adaptiveResolution: true,
      foldingStrategy: 'kv-stable',
    } as ConstructorParameters<typeof AutobiographicalStrategy>[0]);
    const budget = { maxTokens: 4_000, reserveForResponse: 0 };
    // A compressed history with L1s and merges, as budget-expands-detail builds it.
    const builder = await ContextManager.open({ path: TEST_STORE_PATH, strategy: strategy(), membrane: summarizer as any });
    for (let i = 0; i < 160; i++) {
      builder.addMessage(i % 2 === 0 ? 'user' : 'agent',
        text(`turn ${i}: steady substantive traffic about the ongoing work, with specifics `.repeat(4)));
      for (let k = 0; k < 200 && !builder.isReady(); k++) await builder.tick();
    }
    await builder.compile(budget);
    for (let k = 0; k < 500 && !builder.isReady(); k++) await builder.tick();
    await builder.close();

    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: strategy(), membrane: summarizer as any });
    assert.strictEqual(manager.getRenderStats(), null, 'no live compile since the store opened');
    await manager.compile(budget, undefined, { dryRun: true });
    assert.strictEqual(manager.getRenderStats(), null, 'a dry run records no stats');
    const compiled = await manager.compile(budget);
    const rs = manager.getRenderStats();
    assert.ok(rs, 'a live compile records its stats');
    assertConsistent(rs!);
    const s = rs!.summaries;
    assert.ok(s.l1.count + s.l2.count + s.l3.count > 0, 'the cut holds recall pairs');
    assert.strictEqual(rs!.total.messages, compiled.messages.length, 'the stats count every message the compile sent');
    assert.strictEqual(rs!.total.tokens, sentTokens(manager, compiled.messages), 'and price them as it sent them, recall pairs included');
    await manager.close();
  });
});
