import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

class Prepared extends AutobiographicalStrategy {
  prepare(request: NormalizedRequest) { return this.prepareCompressionRequest(request); }
  static bytes(block: unknown) { return this.imageBlockBytes(block); }
}
const request = (content: ContentBlock[]): NormalizedRequest => ({
  messages: [{ participant: 'User', content }], config: { model: 'mock', maxTokens: 1000 },
});
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
describe('compression request preparation', () => {
  it('owns wrappers, releases edited/shared raw forms, and retains untouched blocks and arrays', () => {
    const payload = 'A'.repeat(5000);
    const rawXml = '<function_results>data:image/png;base64,' + payload + '</function_results>';
    const rawItem = { type: 'function_call_output', id: 'old', output: rawXml };
    const changed = { type: 'tool_result', toolUseId: 'a', content: 'data:image/png;base64,' + payload, rawXml, rawItem } as ContentBlock;
    const sibling = { type: 'tool_result', toolUseId: 'b', content: 'other result', rawXml, rawItem } as ContentBlock;
    const untouched = { type: 'tool_result', toolUseId: 'c', content: [{ type: 'text', text: 'unchanged' }],
      rawItem: { type: 'function_call_output', id: 'untouched', output: 'unchanged' } } as ContentBlock;
    const input = request([changed, sibling, untouched]);
    const before = JSON.stringify(input);
    freeze(input);
    const result = new Prepared().prepare(input);
    assert.notStrictEqual(result.request, input);
    assert.notStrictEqual(result.request.messages[0], input.messages[0]);
    assert.equal(result.serializedMediaReplacements, 1);
    assert.equal(JSON.stringify(input), before);
    assert.ok(!JSON.stringify(result.request).includes(payload));
    for (const b of result.request.messages[0].content.slice(0, 2)) {
      assert.equal((b as { rawXml?: unknown }).rawXml, undefined);
      assert.equal((b as { rawItem?: unknown }).rawItem, undefined);
    }
    assert.strictEqual(result.request.messages[0].content[2], untouched);
    assert.strictEqual((result.request.messages[0].content[2] as { content?: unknown }).content,
      (untouched as { content?: unknown }).content);
  });
  it('retains a wholly untouched nested array and raw form by identity', () => {
    const nested = [{ type: 'text', text: 'plain' }] as ContentBlock[];
    const block = { type: 'tool_result', toolUseId: 'a', content: nested, rawXml: '<function_results>plain</function_results>' } as ContentBlock;
    const input = request([block]);
    const prepared = new Prepared().prepare(input);
    assert.strictEqual(prepared.request.messages[0].content, input.messages[0].content);
    assert.strictEqual(prepared.request.messages[0].content[0], block);
    assert.strictEqual((prepared.request.messages[0].content[0] as { content?: unknown }).content, nested);
  });
  it('preparing an expanded candidate cannot change the canonical head image', () => {
    const image = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;
    const head = { participant: 'User', content: [image('AAAA')] };
    const canonical = { ...request([]), messages: [head] };
    const strategy = new Prepared({ maxCompressionImageBytes: 6 });
    const preparedCanonical = strategy.prepare(canonical).request;
    const before = JSON.stringify(preparedCanonical);
    const variant = { ...canonical, messages: [head, { participant: 'User', content: [image('BBBBBB')] }] };
    assert.equal(strategy.prepare(variant).imageReplacements, 1);
    assert.equal(JSON.stringify(preparedCanonical), before);
    assert.equal(head.content[0].type, 'image');
  });
  it('counts URL and MCP payloads and caps either shape inside a tool result', () => {
    const images = [
      { type: 'image', source: { type: 'url', url: 'data:image/png;base64,AAAAAAAA' } },
      { type: 'image', data: 'AAAAAAAA', mimeType: 'image/png' },
    ];
    for (const image of images) {
      assert.equal(Prepared.bytes(image), 8);
      const block = { type: 'tool_result', toolUseId: 'a', content: [image] } as ContentBlock;
      const result = new Prepared({ maxCompressionImageBytes: 4 }).prepare(request([block]));
      assert.equal(result.imageReplacements, 1);
      assert.equal((result.request.messages[0].content[0] as { content: ContentBlock[] }).content[0].type, 'text');
      assert.equal((block as { content: ContentBlock[] }).content[0].type, 'image');
    }
    assert.equal(Prepared.bytes({ type: 'image', source: { type: 'url', url: 'https://example.test/a.png' } }), 0);
  });
  it('reports serialized payload characters including JSON slash escapes, at the existing floor', () => {
    const payload = 'A\\/'.repeat(1500);
    const result = new Prepared().prepare(request([{ type: 'text', text: 'data:image\\/png;base64,' + payload }]));
    assert.equal(result.serializedMediaReplacements, 1);
    assert.ok(JSON.stringify(result.request).includes('4500 serialized payload characters'));
    for (const size of [4095, 4096]) {
      const r = new Prepared().prepare(request([{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(size) }]));
      assert.equal(r.serializedMediaReplacements, size < 4096 ? 0 : 1);
    }
  });
});

describe('inline image accounting in the live window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'live-inline-image-'));
  const path = join(dir, 'store');
  after(() => rmSync(dir, { recursive: true, force: true }));
  it('the live byte cap counts data-URL top-level images', async () => {
    const strategy = new AutobiographicalStrategy({
      headWindowTokens: 0, recentWindowTokens: 1000000, hierarchical: true,
      autoTickOnNewMessage: false, maxLiveImageBytes: 4, maxLiveImages: 0, imageStripDepthTokens: 0,
    });
    const cm = await ContextManager.open({ path, strategy });
    cm.addMessage('User', [{ type: 'text', text: 'look' }, {
      type: 'image', source: { type: 'url', url: 'data:image/png;base64,AAAAAAAA' },
    } as ContentBlock]);
    const compiled = await cm.compile({ maxTokens: 100000, reserveForResponse: 0 });
    assert.equal(compiled.messages.flatMap(m => m.content).filter(b => b.type === 'image').length, 0);
    assert.equal(compiled.messages.flatMap(m => m.content).filter(b =>
      b.type === 'text' && b.text.includes('image dropped')).length, 1);
    cm.close();
  });
});
