/**
 * imageStripHysteresisRatio (opt-in): a binding live-image limit trims down to
 * ratio × the limit and records a watermark, so the stripped set changes once
 * per trim instead of once per new image (each change invalidates the prompt
 * cache from that message on).
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';

const STORE = './test-image-strip-hysteresis';
const cleanup = () => { if (existsSync(STORE)) rmSync(STORE, { recursive: true, force: true }); };

const img = (label: string, bytes = 4): ContentBlock[] => [
  { type: 'image', source: { type: 'base64', data: 'A'.repeat(bytes), mediaType: 'image/png' }, tokenEstimate: 100 } as ContentBlock,
  { type: 'text', text: label },
];
const strategy = (extra: Record<string, unknown>) => new AutobiographicalStrategy({
  headWindowTokens: 0, recentWindowTokens: 1_000_000, hierarchical: true, imageStripDepthTokens: 0, ...extra,
} as ConstructorParameters<typeof AutobiographicalStrategy>[0]);

async function stripped(m: ContextManager, n: number): Promise<string> {
  const c = await m.compile({ maxTokens: 1_000_000, reserveForResponse: 0 });
  let out = '';
  for (let i = 1; i <= n; i++) {
    const e = c.messages.find((x) => x.content.some((b) => b.type === 'text' && b.text === `img-${i}`));
    out += e?.content.some((b) => b.type === 'image') ? 'I' : '.';
  }
  return out; // e.g. "...II": img-1..3 stripped, img-4..5 live
}

describe('imageStripHysteresisRatio', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('count cap: trims to ratio × cap once, then leaves older messages alone until it binds again', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 4), 'IIII', 'under the cap: all live');
    m.addMessage('user', img('img-5'));
    assert.equal(await stripped(m, 5), '...II', 'cap binds: trim to 2');
    m.addMessage('user', img('img-6'));
    assert.equal(await stripped(m, 6), '...III', 'room left: nothing older changes');
    m.addMessage('user', img('img-7'));
    assert.equal(await stripped(m, 7), '...IIII');
    m.addMessage('user', img('img-8'));
    assert.equal(await stripped(m, 8), '......II', 'binds again: one more trim');
    await m.close();
  });

  it('the watermark survives a reopen (a restart renders the same stripped set)', async () => {
    let m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
    const before = await stripped(m, 6);
    await m.close();
    m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4, imageStripHysteresisRatio: 0.5 }) });
    assert.equal(await stripped(m, 6), before);
    await m.close();
  });

  it('byte cap works the same way', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImageBytes: 400, imageStripHysteresisRatio: 0.5 }) });
    for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`, 100));
    assert.equal(await stripped(m, 4), 'IIII');
    m.addMessage('user', img('img-5', 100));
    assert.equal(await stripped(m, 5), '...II', '500 > 400: trim to 200');
    m.addMessage('user', img('img-6', 100));
    assert.equal(await stripped(m, 6), '...III');
    await m.close();
  });

  describe('a dry select leaves the watermark as it found it', () => {
    // compile() and previewContext() reach the watermark through the adaptive
    // picker's post-strip estimates.
    const adaptive = () => strategy({
      hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
      autoTickOnNewMessage: false, maxLiveImages: 4, imageStripHysteresisRatio: 0.5,
    });
    const BUDGET = { maxTokens: 1_000_000, reserveForResponse: 0 };
    const slot = (m: ContextManager, s: AutobiographicalStrategy) =>
      JSON.stringify(m.getStore().getStateJson((s as unknown as { imageWatermarkStateId: string }).imageWatermarkStateId) ?? null);
    const previewed = (m: ContextManager, n: number, overrides: Record<string, unknown> = { maxLiveImages: 2 }) => {
      const entries = m.previewContext(BUDGET, overrides, { render: true })?.entries ?? [];
      assert.ok(entries.length > 0, 'the preview rendered its entries');
      let out = '';
      for (let i = 1; i <= n; i++) {
        const e = entries.find((x) => x.content.some((b) => b.type === 'text' && b.text === `img-${i}`));
        out += e?.content.some((b) => b.type === 'image') ? 'I' : '.';
      }
      return out;
    };

    it('a stricter preview changes neither the next live compile nor the stored watermark', async () => {
      const s = adaptive();
      const m = await ContextManager.open({ path: STORE, strategy: s });
      for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 4), 'IIII');
      const before = slot(m, s);
      assert.equal(previewed(m, 4), '...I', 'the preview renders its own trim');
      assert.equal(slot(m, s), before, 'the preview writes nothing');
      assert.equal(await stripped(m, 4), 'IIII', 'the live compile keeps what it kept');
      await m.close();
    });

    it('a preview that turns the ratio off prices images as a store without it does, even after a live compile', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 6; i++) m.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(m, 6), '...III', 'the live compile prices images under ratio 0.5');
      const warm = m.previewContext(BUDGET, { imageStripHysteresisRatio: 0 });
      await m.close();
      const off = await ContextManager.open({ path: STORE + '-off', strategy: strategy({
        hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
        autoTickOnNewMessage: false, maxLiveImages: 4,
      }) });
      try {
        for (let i = 1; i <= 6; i++) off.addMessage('user', img(`img-${i}`));
        assert.equal(await stripped(off, 6), '..IIII');
        assert.equal(warm?.finalTokens, off.previewContext(BUDGET)?.finalTokens);
      } finally {
        await off.close();
        rmSync(STORE + '-off', { recursive: true, force: true });
      }
    });

    it('a store opened with the ratio off keeps its stored watermark through previews that turn the ratio on', async () => {
      const first = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 6; i++) first.addMessage('user', img(`img-${i}`));
      assert.equal(await stripped(first, 6), '...III');
      await first.close();
      // Opened with the ratio off, nothing loads the stored watermark: the
      // first preview that turns the ratio on is the one that loads it.
      const m = await ContextManager.open({ path: STORE, strategy: strategy({
        hierarchical: false, adaptiveResolution: true, compressionModel: 'mock', targetChunkTokens: 100,
        autoTickOnNewMessage: false, maxLiveImages: 10,
      }) });
      try {
        assert.equal(previewed(m, 6, { imageStripHysteresisRatio: 0.5 }), '...III');
        assert.equal(previewed(m, 6, { imageStripHysteresisRatio: 0.5 }), '...III', 'the second preview finds the stored watermark too');
      } finally {
        await m.close();
      }
    });

    it('the same preview twice renders the same images', async () => {
      const m = await ContextManager.open({ path: STORE, strategy: adaptive() });
      for (let i = 1; i <= 4; i++) m.addMessage('user', img(`img-${i}`));
      const first = previewed(m, 4);
      assert.equal(previewed(m, 4), first);
      await m.close();
    });
  });

  it('off (default): the classic window slides one image at a time', async () => {
    const m = await ContextManager.open({ path: STORE, strategy: strategy({ maxLiveImages: 4 }) });
    for (let i = 1; i <= 5; i++) m.addMessage('user', img(`img-${i}`));
    assert.equal(await stripped(m, 5), '.IIII');
    m.addMessage('user', img('img-6'));
    assert.equal(await stripped(m, 6), '..IIII', 'img-2 changes: the per-image rewrite this option avoids');
    await m.close();
  });
});
