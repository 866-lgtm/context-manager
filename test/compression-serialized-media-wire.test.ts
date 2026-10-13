/**
 * Serialized-media projection, asserted on the WIRE (#115 review): capture the
 * requests the summarizer actually receives, for every compression path, and
 * check Chronicle is untouched. The helper-only tests could not see that the L1
 * strip was applied to a copy the request never shipped.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'serialized-media-wire-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const MARKER = 'omitted from compression prompt';
const TOOLS = [{ name: 'fn', description: 'test tool', inputSchema: { type: 'object' as const } }];

function recorder(refuseFirst = 0) {
  const requests: string[] = [];
  let calls = 0;
  const membrane = {
    complete: async (req: unknown) => {
      requests.push(JSON.stringify(req));
      calls++;
      if (calls <= refuseFirst) return { stopReason: 'refusal', content: [], usage: { inputTokens: 10, outputTokens: 0 } };
      return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}.` }], usage: { inputTokens: 500, outputTokens: 50 } };
    },
  };
  return { membrane, requests };
}

async function run(name: string, config: Record<string, unknown>, seed: (cm: ContextManager) => void, refuseFirst = 0) {
  const { membrane, requests } = recorder(refuseFirst);
  const strategy = new AutobiographicalStrategy({
    compressionModel: 'm', targetChunkTokens: 200, headWindowTokens: 0, recentWindowTokens: 0,
    autoTickOnNewMessage: false, minChunkCharsForLLM: 0, summaryParticipant: 'Claude', hierarchical: true,
    mergeThreshold: 1000, ...config,
  });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane: membrane as never });
  cm.setToolDefinitions(TOOLS);
  seed(cm);
  for (let i = 0; i < 40; i++) { await cm.compile(); await cm.tick(); }
  return { cm, requests };
}

const filler = (i: number) => `M-${i} ${'word '.repeat(30)}`;

describe('serialized media on the wire', () => {
  it('L1 canonical request: the payload never ships, Chronicle keeps it', async () => {
    const payload = 'Q'.repeat(20_000);
    let id = '';
    const { cm, requests } = await run('l1', {}, (cm) => {
      id = cm.addMessage('User', [{ type: 'text', text: `look: data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    });
    assert.ok(requests.length > 0);
    assert.equal(requests.filter((r) => r.includes(payload)).length, 0, 'payload on the wire');
    assert.ok(requests.some((r) => r.includes(MARKER)), 'marker on the wire');
    const stored = JSON.stringify((cm as unknown as { messageStore: { get(id: string): unknown } }).messageStore.get(id));
    assert.ok(stored.includes(payload), 'Chronicle message unchanged');
    cm.close();
  });

  it('string-form tool_result content is projected too', async () => {
    const payload = 'S'.repeat(20_000);
    const { cm, requests } = await run('string-tool-result', {}, (cm) => {
      cm.addMessage('Claude', [{ type: 'tool_use', id: 't1', name: 'fn', input: {} } as ContentBlock]);
      cm.addMessage('User', [{ type: 'tool_result', toolUseId: 't1', content: JSON.stringify({ image_url: `data:image/png;base64,${payload}` }) } as ContentBlock]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    });
    assert.ok(requests.length > 0);
    assert.equal(requests.filter((r) => r.includes(payload)).length, 0, 'payload on the wire');
    assert.ok(requests.some((r) => r.includes(MARKER)));
    cm.close();
  });

  it('merge requests are projected', async () => {
    const payload = 'R'.repeat(20_000);
    const { cm, requests } = await run('merge', { mergeThreshold: 3 }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: `see data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 60; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    });
    // Merge prompts end with "…consolidate into a single L2 memory". A merge
    // expands its L1 sources to their raw messages, so the media message is replayed.
    const merges = requests.filter((r) => r.includes('into a single L2 memory'));
    assert.ok(merges.length > 0, 'at least one L2 merge ran');
    const replaying = merges.filter((r) => r.includes('see [embedded image/png'));
    assert.ok(replaying.length > 0, 'a merge replayed the media message, projected');
    assert.equal(merges.filter((r) => r.includes(payload)).length, 0, 'payload in a merge request');
    cm.close();
  });

  it('the L1 and merge receipts summarize the prepared messages, not the payload', async () => {
    const payload = 'K'.repeat(20_000);
    const log = join(dir, 'receipts', 'compression-log.jsonl');
    process.env.CONTEXT_MANAGER_COMPRESSION_LOG = log;
    try {
      const { cm } = await run('receipts', { mergeThreshold: 3 }, (cm) => {
        cm.addMessage('User', [{ type: 'text', text: `see data:image/png;base64,${payload}` }]);
        for (let i = 0; i < 60; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
      });
      cm.close();
    } finally { delete process.env.CONTEXT_MANAGER_COMPRESSION_LOG; }
    const receipts = readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as {
      event?: string; operation?: string; messages?: Array<{ textChars: number }>;
    }).filter((entry) => !entry.event && entry.messages);
    assert.ok(receipts.some((entry) => entry.operation === 'compress_l1'), 'an L1 receipt');
    assert.ok(receipts.some((entry) => /^merge_l/.test(entry.operation ?? '')), 'a merge receipt');
    for (const entry of receipts) {
      const longest = Math.max(...entry.messages!.map((message) => message.textChars));
      assert.ok(longest < payload.length, `${entry.operation}'s receipt counts ${longest} characters in one message`);
    }
  });
});

describe('the data-URL matcher at scale (V8)', () => {
  it('does not overflow the regex stack on a ~9M-character payload', () => {
    class Exposed extends AutobiographicalStrategy {
      strip(m: Array<{ content: ContentBlock[] }>) { return this.stripSerializedCompressionMedia(m); }
    }
    const messages = [{ content: [{ type: 'text', text: 'data:image/png;base64,' + 'A'.repeat(9e6) } as ContentBlock] }];
    assert.equal(new Exposed().strip(messages), 1);
  });
});

describe('split-stitch rung', () => {
  it('sub-requests are projected (they rebuild from raw messages)', async () => {
    const payload = 'Z'.repeat(20_000);
    // Refuse the canonical request and the source-only fallback, so the chunk
    // falls through to the split-stitch rung; its sub-requests then succeed.
    const { cm, requests } = await run('split', {
      compressionRefusalCurveFallbacks: 0,
      compressionSourceOnlyFallback: true,
      compressionSplitFallback: true,
    }, (cm) => {
      cm.addMessage('User', [{ type: 'text', text: `split me data:image/png;base64,${payload}` }]);
      for (let i = 0; i < 40; i++) cm.addMessage(i % 2 ? 'Claude' : 'User', [{ type: 'text', text: filler(i) }]);
    }, 2);
    assert.ok(requests[1].includes(MARKER), 'the refused source-only request was prepared too');
    assert.ok(!requests[1].includes(payload), 'no payload in the source-only attempt');
    const split = requests.slice(2).filter((r) => r.includes('split me'));
    assert.ok(split.length > 0, 'the split rung ran and replayed the media message');
    assert.equal(split.filter((r) => r.includes(payload)).length, 0, 'payload in a split sub-request');
    assert.ok(split.some((r) => r.includes(MARKER)));
    cm.close();
  });
});

describe('matcher coverage', () => {
  class Exposed extends AutobiographicalStrategy {
    strip(m: Array<{ content: ContentBlock[] }>) { return this.stripSerializedCompressionMedia(m); }
  }
  const one = (text: string) => { const m = [{ content: [{ type: 'text', text } as ContentBlock] }]; return { n: new Exposed().strip(m), text: (m[0].content[0] as { text: string }).text }; };
  it('handles MIME parameters before ;base64', () => {
    const r = one('x data:image/png;charset=utf-8;name=a.png;base64,' + 'P'.repeat(5000) + ' y');
    assert.equal(r.n, 1); assert.match(r.text, /^x \[embedded image\/png data URL omitted/);
  });
  it('handles JSON-escaped slashes in the type and the payload', () => {
    const r = one(JSON.stringify({ u: 'data:image/png;base64,' + 'ab/cd'.repeat(1200) }).replace(/\//g, '\\/'));
    assert.equal(r.n, 1); assert.match(r.text, /\[embedded image\/png data URL omitted/);
  });
  it('still survives a ~9M-character escaped payload on V8', () => {
    assert.equal(one('data:image\\/png;base64,' + 'A\\/'.repeat(3e6)).n, 1);
  });
  it('keeps JSON escapes inside a payload, such as wrapped lines and unicode escapes, and replaces the payload whole', () => {
    // Base64 wrapped at 76 characters, serialized into a JSON string.
    const lines = Array.from({ length: 80 }, (_, i) => 'A'.repeat(75) + String.fromCharCode(66 + (i % 20)));
    const wrapped = one('"data:image/png;base64,' + lines.join('\\n') + '"');
    assert.equal(wrapped.n, 1);
    assert.equal(wrapped.text, '"[embedded image/png data URL omitted from compression prompt: ' + (80 * 76 + 79 * 2) + ' serialized payload characters]"');
    const unicode = one('data:image/png;base64,' + 'A'.repeat(3000) + '\\u002F' + 'A'.repeat(3000) + '\\u003d');
    assert.equal(unicode.n, 1);
    assert.equal(unicode.text, '[embedded image/png data URL omitted from compression prompt: 6012 serialized payload characters]');
  });
  it('leaves an escaped quote after the payload in place', () => {
    const payload = 'A'.repeat(5000);
    const quoted = one('{\\"u\\":\\"data:image/png;base64,' + payload + '\\"}');
    assert.equal(quoted.n, 1);
    assert.match(quoted.text, /: 5000 serialized payload characters\]\\"\}$/);
    const twice = one('\\\\\\"data:image/png;base64,' + payload + '\\\\\\"');
    assert.equal(twice.n, 1);
    assert.match(twice.text, /: 5000 serialized payload characters\]\\\\\\"$/);
  });
  it('matches a data URL whose type was escaped more than once', () => {
    const r = one('data:image\\\\\\/png;base64,' + 'A'.repeat(5000));
    assert.equal(r.n, 1);
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('replaces both of two data URLs that abut with no separator', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    const r = one(url + url.toUpperCase());
    assert.equal(r.n, 2);
    assert.equal(r.text, marker + marker.replace('image/png', 'IMAGE/PNG'));
  });
  it('replaces both of two data URLs that a JSON escape separates, in one pass', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    const r = one(url + '\\n' + url);
    assert.equal(r.n, 2);
    assert.equal(r.text, marker + '\\n' + marker);
    const afterShort = one('data:image/png;base64,AAAA\\n' + url);
    assert.equal(afterShort.n, 1, 'a short data URL before the escape is kept, and the next one is still found');
    assert.equal(afterShort.text, 'data:image/png;base64,AAAA\\n' + marker);
  });
  it('matches a type written with \\u escapes, and names it unescaped', () => {
    const svg = one('data:image\\u002Fsvg\\u002Bxml;base64,' + 'A'.repeat(5000));
    assert.equal(svg.n, 1);
    assert.equal(svg.text, '[embedded image/svg+xml data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('matches a type whose \\u escapes were serialized twice', () => {
    const svg = one('data:image\\\\u002Fsvg\\\\u002Bxml;base64,' + 'A'.repeat(5000));
    assert.equal(svg.n, 1);
    assert.equal(svg.text, '[embedded image/svg+xml data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('matches a MIME parameter whose value is quoted, spaces included', () => {
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    for (const parameter of [';name=\\"a.png\\"', ';name="a b.png"', ';name=\\"a b.png\\"', ';name=\\\\\\"a b.png\\\\\\"', ';name=a\\u0020b.png']) {
      const r = one('data:image/png' + parameter + ';base64,' + 'A'.repeat(5000));
      assert.equal(r.n, 1, parameter);
      assert.equal(r.text, marker, parameter);
    }
  });
  it('ends a payload before each line-break or tab escape that separates it from an abutting data URL', () => {
    const url = 'data:image/png;base64,' + 'A'.repeat(5000);
    const marker = '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]';
    for (const separator of ['\\r\\n', '\\r', '\\t', '\\u0009', '\\u000a', '\\u000A', '\\u000d', '\\u000D', '\\u0026', '\\b']) {
      const r = one(url + separator + url);
      assert.equal(r.n, 2, separator);
      assert.equal(r.text, marker + separator + marker, separator);
    }
  });
  it('keeps an escape of a character outside base64 after the payload, and an escaped base64 character in it', () => {
    const marker = (n: number) => '[embedded image/png data URL omitted from compression prompt: ' + n + ' serialized payload characters]';
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(5000) + '\\n"').text, '"' + marker(5000) + '\\n"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(5000) + '\\u0020"').text, '"' + marker(5000) + '\\u0020"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(4998) + '\\u002B"').text, '"' + marker(5004) + '"');
    assert.equal(one('"data:image/png;base64,' + 'A'.repeat(4998) + '\\/"').text, '"' + marker(5000) + '"');
  });
  it('reads the same payload on a second pass when a short data URL sits before a separator', () => {
    const short = 'data:image/png;base64,' + 'A'.repeat(4095);
    const long = 'data:image/png;base64,' + 'B'.repeat(5000);
    for (const separator of ['\\n', '\\r\\n', '\\u000a', '\\t']) {
      const first = one(short + separator + long);
      assert.equal(first.n, 1, separator);
      assert.equal(first.text, short + separator + '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]', separator);
      const second = one(first.text);
      assert.equal(second.n, 0, separator);
      assert.equal(second.text, first.text, separator);
    }
  });
  it('matches a type whose first characters are \\u escapes', () => {
    const r = one('data:\\u0069mage/\\u0070ng;base64,' + 'A'.repeat(5000));
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]');
  });
  it('keeps a short data URL with a parameter apart from a base64 one that abuts it', () => {
    const marker = '[embedded image/jpeg data URL omitted from compression prompt: 5000 serialized payload characters]';
    for (const between of ['\\n', '']) {
      const r = one('data:image/png;name=a' + between + 'data:image/jpeg;base64,' + 'A'.repeat(5000));
      assert.equal(r.text, 'data:image/png;name=a' + between + marker, JSON.stringify(between));
    }
  });
  it('fails a string that almost matches in linear time', () => {
    const timed = (text: string) => {
      const started = performance.now();
      const r = one(text);
      return { n: r.n, ms: performance.now() - started };
    };
    // Counts at which overlapping choices took seconds, so a regression fails here rather than hanging.
    for (const [parameter, count] of [[';x="1"', 28], [';x=\\"1\\"', 18], [';x=\\\\\\"1\\\\\\"', 16], [';x=1', 200], [';x=\\u00411', 200]] as const) {
      const r = timed('data:a/b' + parameter.repeat(count) + ' end');
      assert.equal(r.n, 0, parameter);
      assert.ok(r.ms < 1000, `${parameter}: ${r.ms} ms`);
    }
    const slashes = timed('data:a' + '\\u002F'.repeat(5000) + ' end');
    assert.equal(slashes.n, 0);
    assert.ok(slashes.ms < 1000, `${slashes.ms} ms`);
  });
  it("keeps 'data' at the end of a payload when no colon follows it", () => {
    const r = one('data:image/png;base64,' + 'A'.repeat(4996) + 'data"');
    assert.equal(r.text, '[embedded image/png data URL omitted from compression prompt: 5000 serialized payload characters]"');
  });
  it('matches the scheme and the base64 token in any letter case', () => {
    const r = one('DATA:image/png;BASE64,' + 'P'.repeat(5000));
    assert.equal(r.n, 1); assert.match(r.text, /^\[embedded image\/png data URL omitted/);
  });
});

describe('transition request preparation', () => {
  it('projects the transition head without changing its stored message', async () => {
    const payload = 'T'.repeat(5000);
    const { membrane, requests } = recorder();
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'm', headWindowTokens: 100000, recentWindowTokens: 100000,
      autoTickOnNewMessage: false,
    });
    const cm = await ContextManager.open({ path: join(dir, 'transition'), strategy, membrane: membrane as never });
    const id = cm.addMessage('User', [{ type: 'text', text: 'data:image/png;base64,' + payload }]);
    const ctx = (cm as unknown as { createStrategyContext(): never }).createStrategyContext();
    await strategy.generateTransitionSummary(ctx);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes(MARKER));
    assert.ok(!requests[0].includes(payload));
    assert.ok(JSON.stringify(cm.getMessage(id)).includes(payload));
    cm.close();
  });
});
