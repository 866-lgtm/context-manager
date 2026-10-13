import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';
import { AutobiographicalStrategy } from '../src/index.js';

class Prepared extends AutobiographicalStrategy {
  prepare(request: NormalizedRequest) { return this.prepareCompressionRequest(request); }
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
  it('preparing a prepared request replaces nothing more', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const image = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;
    const strategy = new Prepared({ maxCompressionImageBytes: 4 });
    const first = strategy.prepare(request([{ type: 'text', text: url + '\\n' + url + '\\"' }, image('AAAAAAAA'), image('AAA')]));
    assert.equal(first.serializedMediaReplacements, 2);
    assert.equal(first.imageReplacements, 1);
    const second = strategy.prepare(first.request);
    assert.equal(second.serializedMediaReplacements, 0);
    assert.equal(second.imageReplacements, 0);
    assert.equal(JSON.stringify(second.request), JSON.stringify(first.request));
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

describe('preparation counts and logging', () => {
  it('returns its counts without logging; a candidate logs each kind of replacement once, naming the request', () => {
    const strategy = new Prepared({ maxCompressionImageBytes: 4 });
    const image = (data: string) => ({ type: 'image', source: { type: 'base64', mediaType: 'image/png', data } }) as ContentBlock;
    const input = request([
      { type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(5000) },
      image('AAAAAAAA'),
      image('AAA'),
    ]);
    const logs: string[] = [];
    const original = console.error;
    console.error = (...parts: unknown[]) => { logs.push(parts.map(String).join(' ')); };
    try {
      const prepared = strategy.prepare(input);
      assert.equal(prepared.serializedMediaReplacements, 1);
      assert.equal(prepared.imageReplacements, 1, 'the 8-byte image is over the budget, the 3-byte one fits');
      assert.equal(prepared.imageBudgetBytes, 4);
      assert.equal(prepared.imageBytesKept, 3);
      assert.equal(logs.length, 0, 'prepareCompressionRequest logs nothing');
      const candidate = (strategy as unknown as {
        prepareCompressionCandidate(r: NormalizedRequest, label: string): NormalizedRequest;
      }).prepareCompressionCandidate.bind(strategy);
      candidate(input, 'count-test');
      assert.deepEqual(logs, [
        '[autobiographical] compression prompt: replaced 1 serialized data URL(s) with markers [count-test]',
        '[autobiographical] compression prompt: replaced 1 older image(s) with placeholders to stay under the ' +
          '0MB image-byte budget (kept 0MB, newest-first) [count-test]',
      ]);
      candidate(request([{ type: 'text', text: 'plain' }]), 'unchanged');
      assert.equal(logs.length, 2, 'nothing replaced, nothing logged');
    } finally { console.error = original; }
  });
});
