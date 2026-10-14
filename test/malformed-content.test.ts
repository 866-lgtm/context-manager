/**
 * Content that doesn't match ContentBlock where its readers read it (#184):
 * a block that isn't an object; a text block whose text, or a thinking block
 * whose thinking, isn't a string; a tool_use whose input isn't an object; a
 * tool_result whose content is neither a string nor an array of such blocks,
 * at any depth. A store written before writes refused it can hold it. Reads
 * leave it out or make it match, so every compile, compression pass and
 * reopen works, and the store keeps it as written. A write refuses it,
 * naming where it is.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsStore } from '@animalabs/chronicle';
import type { ContentBlock } from '@animalabs/membrane';
import {
  AutobiographicalStrategy,
  blockAsStored,
  ContextLog,
  ContextManager,
  MessageStore,
  PassthroughStrategy,
  WindowedPassthroughStrategy,
} from '../src/index.js';

const t = (text: string) => ({ type: 'text', text }) as ContentBlock;
const toolResult = (toolUseId: string, content: unknown) => ({ type: 'tool_result', toolUseId, content });
const toolUse = (id: string, input?: unknown) => ({ type: 'tool_use', id, name: 'probe', ...(input === undefined ? {} : { input }) });

/** Each user message that doesn't match ContentBlock at its top level. */
const MALFORMED_BLOCKS: unknown[][] = [
  [t('kept'), 'a bare string'],
  ['only a string'],
  [t('kept'), 42],
  [t('kept'), true],
  [t('kept'), null],
  [t('kept'), { type: 'text' }],
  [t('kept'), { type: 'text', text: null }],
  [t('kept'), { type: 'text', text: 42 }],
];
/** Each assistant message whose thinking doesn't match. */
const MALFORMED_ASSISTANT: unknown[][] = [
  [{ type: 'thinking' }, t('kept')],
  [{ type: 'thinking', thinking: null }, t('kept')],
];
/** Each tool_use input that doesn't match: missing, null, a string, an array. */
const MALFORMED_INPUTS: unknown[] = [undefined, null, 'x', [1]];
/** Each tool_result content that doesn't match: elements, a nested tool_result, and content that is neither a string nor an array. */
const MALFORMED_TOOL_CONTENT: unknown[] = [
  ['nested string'],
  [42],
  [true],
  [null],
  [t('ok'), null],
  [t('ok'), { type: 'text' }],
  [t('outer'), toolResult('inner', [t('deep'), null])],
  null,
  42,
  {},
];

/** Write content to the message slot as a store can hold it, past MessageStore. */
function writeRaw(store: JsStore, participant: string, content: unknown[]): void {
  store.appendToStateJsonWithIdentity('messages', { participant, content, timestamp: Date.now() }, 'id', 'sequence');
}

/** Each place in compiled or read messages that doesn't match ContentBlock, at any depth. */
function malformedIn(messages: ReadonlyArray<{ content: readonly unknown[] }>): string[] {
  const places: string[] = [];
  const isObject = (value: unknown) => typeof value === 'object' && value !== null;
  const walk = (blocks: readonly unknown[], at: string) => {
    for (let i = 0; i < blocks.length; i++) {
      const block = blocks[i] as { type?: unknown; text?: unknown; thinking?: unknown; input?: unknown; content?: unknown } | null;
      const here = `${at}[${i}]`;
      if (!isObject(block)) places.push(here);
      else if (block!.type === 'text' && typeof block!.text !== 'string') places.push(`${here}.text`);
      else if (block!.type === 'thinking' && typeof block!.thinking !== 'string') places.push(`${here}.thinking`);
      else if (block!.type === 'tool_use' && (!isObject(block!.input) || Array.isArray(block!.input))) places.push(`${here}.input`);
      else if (block!.type === 'tool_result') {
        if (Array.isArray(block!.content)) walk(block!.content, `${here}.content`);
        else if (typeof block!.content !== 'string') places.push(`${here}.content`);
      }
    }
  };
  messages.forEach((message, m) => walk(message.content, `message ${m}`));
  return places;
}

async function withStore(run: (store: JsStore) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'cm-malformed-'));
  const store = JsStore.create({ path: join(dir, 'store') });
  try {
    await run(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Capture console.error while `run` runs. */
async function errorLines(run: () => Promise<void> | void): Promise<string[]> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    await run();
  } finally {
    console.error = original;
  }
  return lines;
}

const STRATEGIES: Record<string, () => PassthroughStrategy | WindowedPassthroughStrategy | AutobiographicalStrategy> = {
  passthrough: () => new PassthroughStrategy(),
  windowed: () => new WindowedPassthroughStrategy(),
  // Compression runs over the earliest messages, where the malformed ones are.
  autobiographical: () => new AutobiographicalStrategy({
    targetChunkTokens: 20, headWindowTokens: 0, recentWindowTokens: 0, hierarchical: true,
    l1HoldbackChunks: 0, minChunkCharsForLLM: 0, autoTickOnNewMessage: false, compressionModel: 'test-model',
  }),
};

describe("content that doesn't match ContentBlock", () => {
  for (const [name, strategy] of Object.entries(STRATEGIES)) {
    const compresses = name === 'autobiographical';
    it(`a store holding it compiles and reopens under ${name}${compresses ? ', and compresses' : ''}`, async () => {
      await withStore(async (store) => {
        const asked: string[] = [];
        const membrane = {
          complete: async (request: unknown) => {
            asked.push(JSON.stringify(request));
            return { stopReason: 'end_turn', content: [t('Summary of the chunk')] };
          },
        };
        const open = async () => {
          const manager = await ContextManager.open({ store, strategy: strategy(), membrane: membrane as never });
          manager.setToolDefinitions([{ name: 'probe', description: 'A probe tool', inputSchema: { type: 'object', properties: {} } }]);
          return manager;
        };
        MessageStore.register(store);
        writeRaw(store, 'User', [t('hi')]);
        for (const content of MALFORMED_BLOCKS) writeRaw(store, 'User', content);
        for (const content of MALFORMED_ASSISTANT) {
          writeRaw(store, 'Claude', content);
          writeRaw(store, 'User', [t('go on')]);
        }
        MALFORMED_INPUTS.forEach((input, i) => {
          writeRaw(store, 'Claude', [toolUse(`u${i}`, input)]);
          writeRaw(store, 'User', [toolResult(`u${i}`, [t('kept')])]);
        });
        MALFORMED_TOOL_CONTENT.forEach((content, i) => {
          writeRaw(store, 'Claude', [toolUse(`t${i}`, {})]);
          writeRaw(store, 'User', [toolResult(`t${i}`, content)]);
        });
        const compiled: Array<{ messages: ReadonlyArray<{ content: readonly unknown[] }> }> = [];
        await errorLines(async () => {
          let manager = await open();
          try {
            for (let i = 0; i < 12; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [t(`filler ${i}: ${'x'.repeat(60)}`)]);
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
            for (let k = 0; k < 4; k++) await manager.tick();
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
            // And a tighter budget.
            compiled.push(await manager.compile({ maxTokens: 900, reserveForResponse: 50 }));
          } finally {
            manager.close();
          }
          manager = await open();
          try {
            compiled.push(await manager.compile({ maxTokens: 100_000, reserveForResponse: 200 }));
          } finally {
            manager.close();
          }
        });
        for (const result of compiled) assert.deepEqual(malformedIn(result.messages), []);
        assert.ok(JSON.stringify(compiled[0]!.messages).includes('"kept"'), 'what matches in the malformed messages reaches the compile');
        if (compresses) assert.ok(asked.some((request) => request.includes('"kept"')), 'compression read the malformed messages');
      });
    });
  }

  it('reads leave out or mend what doesn\'t match, at any depth, keep a string tool_result content, and the store keeps it as written', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', [t('a'), null, { type: 'text' }]);
      writeRaw(store, 'Claude', [{ type: 'thinking', thinking: 7 }, toolUse('t0'), ...['t1', 't2', 't3', 't4'].map((id) => toolUse(id, {}))]);
      writeRaw(store, 'User', [
        toolResult('t0', [t('done')]),
        toolResult('t1', [t('x'), null, 3]),
        toolResult('t2', 'a string'),
        toolResult('t3', [t('outer'), toolResult('inner', [t('deep'), null, { type: 'text', text: null }])]),
        toolResult('t4', null),
      ]);
      const expected = [
        [t('a')],
        [{ ...toolUse('t0'), input: {} }, ...['t1', 't2', 't3', 't4'].map((id) => toolUse(id, {}))],
        [
          toolResult('t0', [t('done')]),
          toolResult('t1', [t('x')]),
          toolResult('t2', 'a string'),
          toolResult('t3', [t('outer'), toolResult('inner', [t('deep')])]),
          toolResult('t4', []),
        ],
      ];
      await errorLines(() => {
        const messages = new MessageStore(store);
        assert.deepEqual(messages.getAll().map((message) => message.content), expected);
        const viewed = messages.getWindow(0, 3, { resolveBlobs: false }).messages;
        assert.deepEqual(viewed.map((message) => message.content), expected, 'a read without blob resolution gives the same');
      });
      const stored = store.getStateJson('messages') as Array<{ content: unknown[] }>;
      assert.deepEqual(stored[0]!.content, [t('a'), null, { type: 'text' }], 'the store keeps it as written');
      assert.deepEqual(stored[1]!.content[1], toolUse('t0'));
      assert.deepEqual((stored[2]!.content[1] as { content: unknown[] }).content, [t('x'), null, 3]);
      assert.equal((stored[2]!.content[4] as { content: unknown }).content, null);
    });
  });

  it('a block that shares a raw replay form with one a read changes or leaves out gives the form up too', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      const sharedXml = '<function_results><result>x</result><result>y</result></function_results>';
      const ownXml = '<function_results><result>z</result></function_results>';
      const sharedItem = { type: 'function_call_output', id: 'fco_1', call_id: 't4', output: 'u v' };
      const ownItem = { type: 'function_call_output', id: 'fco_2', call_id: 't6', output: 'w' };
      const message = { type: 'message', id: 'msg_1', role: 'assistant', content: [] };
      writeRaw(store, 'Claude', ['t1', 't2', 't3', 't4', 't5', 't6'].map((id) => toolUse(id, {})));
      writeRaw(store, 'User', [
        { ...toolResult('t1', [t('x'), null]), rawXml: sharedXml },
        { ...toolResult('t2', [t('y')]), rawXml: sharedXml },
        { ...toolResult('t3', [t('z')]), rawXml: ownXml },
        { ...toolResult('t4', [t('u'), 7]), rawItem: sharedItem },
        { ...toolResult('t5', [t('v')]), rawItem: sharedItem },
        { ...toolResult('t6', [t('w')]), rawItem: ownItem },
      ]);
      // A message item whose parts are text blocks: one has no text, so it is left out.
      writeRaw(store, 'Claude', [{ type: 'text', rawItem: message }, { ...t('kept part'), rawItem: message }]);
      await errorLines(() => {
        const [, results, parts] = new MessageStore(store).getAll();
        assert.deepEqual(results!.content, [
          toolResult('t1', [t('x')]),
          toolResult('t2', [t('y')]),
          { ...toolResult('t3', [t('z')]), rawXml: ownXml },
          toolResult('t4', [t('u')]),
          toolResult('t5', [t('v')]),
          { ...toolResult('t6', [t('w')]), rawItem: ownItem },
        ]);
        assert.deepEqual(parts!.content, [t('kept part')], 'the part that stays gives up the item it shared with the one left out');
      });
    });
  });

  it('one line per message names what reads leave out', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', [t('a'), null]);
      writeRaw(store, 'User', [t('fine')]);
      writeRaw(store, 'User', [toolResult('t1', ['s', toolResult('t2', [false, { type: 'text' }])])]);
      const messages = new MessageStore(store);
      let ids: string[] = [];
      const lines = (await errorLines(() => {
        ids = messages.getAll().map((message) => String(message.id));
        messages.getAll();
        messages.getWindow(0, 3);
      })).filter((line) => line.startsWith('[context-manager]'));
      assert.deepEqual(lines, [
        `[context-manager] message ${ids[0]}: reads leave out what doesn't match ContentBlock (content[1] is null, not a content block); the store keeps it as written`,
        `[context-manager] message ${ids[2]}: reads leave out what doesn't match ContentBlock (content[0].content[0] is a string, not a content block; content[0].content[1].content[0] is a boolean, not a content block; content[0].content[1].content[1].text is undefined, not a string); the store keeps it as written`,
      ]);
    });
  });

  it('an edit replaces a message that holds it, through ContextManager.editMessage', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      writeRaw(store, 'User', [t('a'), null]);
      const manager = await ContextManager.open({ store });
      try {
        await errorLines(() => {
          const [held] = manager.getAllMessages();
          manager.editMessage(held!.id, [t('fixed')]);
          assert.deepEqual(manager.getAllMessages()[0]!.content, [t('fixed')]);
        });
      } finally {
        manager.close();
      }
      assert.deepEqual((store.getStateJson('messages') as Array<{ content: unknown[] }>)[0]!.content, [t('fixed')]);
    });
  });

  it('a context entry holding it is read without it, with one line', async () => {
    await withStore(async (store) => {
      ContextLog.register(store);
      store.appendToStateJson('context', {
        index: 0,
        participant: 'User',
        content: [t('x'), null, toolResult('t1', [7, t('y')])],
      });
      const log = new ContextLog(store);
      const lines = (await errorLines(() => {
        assert.deepEqual(log.getAll()[0]!.content, [t('x'), toolResult('t1', [t('y')])]);
        log.getAll();
      })).filter((line) => line.startsWith('[context-manager]'));
      assert.deepEqual(lines, [
        "[context-manager] context entry 0: reads leave out what doesn't match ContentBlock (content[1] is null, not a content block; content[2].content[0] is a number, not a content block); the store keeps it as written",
      ]);
    });
  });

  it('addMessage refuses it, naming where it is, before anything changes', async () => {
    await withStore(async (store) => {
      const manager = await ContextManager.open({ store });
      try {
        const events: unknown[] = [];
        manager.onMessage((event) => { events.push(event); });
        const sequence = store.currentSequence();
        const refusals: Array<[unknown[], string]> = [
          [[t('kept'), 'a bare string'], 'content\\[1\\] is a string, not a content block'],
          [['only a string'], 'content\\[0\\] is a string, not a content block'],
          [[t('kept'), 42], 'content\\[1\\] is a number, not a content block'],
          [[t('kept'), true], 'content\\[1\\] is a boolean, not a content block'],
          [[t('kept'), null], 'content\\[1\\] is null, not a content block'],
          [[t('kept'), undefined], 'content\\[1\\] is undefined, not a content block'],
          [[, t('kept')], 'content\\[0\\] is undefined, not a content block'],
          [[{ type: 'text' }], 'content\\[0\\]\\.text is undefined, not a string'],
          [[{ type: 'text', text: 42 }], 'content\\[0\\]\\.text is a number, not a string'],
          [[{ type: 'thinking', thinking: null }], 'content\\[0\\]\\.thinking is null, not a string'],
          [[toolUse('u1')], 'content\\[0\\]\\.input is undefined, not an object'],
          [[toolUse('u1', null)], 'content\\[0\\]\\.input is null, not an object'],
          [[toolUse('u1', [1])], 'content\\[0\\]\\.input is an array, not an object'],
          [[toolUse('u1', 'x')], 'content\\[0\\]\\.input is a string, not an object'],
          [[toolResult('t1', [t('ok'), null, 'x'])],
            'content\\[0\\]\\.content\\[1\\] is null, not a content block; content\\[0\\]\\.content\\[2\\] is a string, not a content block'],
          [[toolResult('t1', [toolResult('t2', [null])])], 'content\\[0\\]\\.content\\[0\\]\\.content\\[0\\] is null, not a content block'],
          [[toolResult('t1', [{ type: 'text' }])], 'content\\[0\\]\\.content\\[0\\]\\.text is undefined, not a string'],
          [[toolResult('t1', 42)], 'content\\[0\\]\\.content is a number, not a string or an array of content blocks'],
          [[toolResult('t1', {})], 'content\\[0\\]\\.content is an object, not a string or an array of content blocks'],
          [[{ type: 'tool_result', toolUseId: 't1' }], 'content\\[0\\]\\.content is undefined, not a string or an array of content blocks'],
        ];
        for (const [content, places] of refusals) {
          const message = new RegExp(`^Message refused: ${places}\\.$`);
          assert.throws(() => manager.addMessage('User', content as ContentBlock[]), { message });
          assert.throws(() => manager.addMessage('User', content as ContentBlock[], undefined, undefined, { holdCompression: true }), { message });
        }
        assert.equal(store.currentSequence(), sequence, 'nothing was stored');
        assert.deepEqual(events, [], 'no event was emitted');
        assert.equal(manager.getCompressionHolds().size, 0, 'no hold was placed');
        assert.equal((manager as unknown as { holdingAdds: unknown }).holdingAdds, null);
        manager.addMessage('User', [toolResult('t1', 'a string') as ContentBlock]);
        manager.addMessage('Claude', [toolUse('u1', {}) as ContentBlock, { type: 'thinking', thinking: '' } as ContentBlock]);
        assert.equal(manager.getAllMessages().length, 2, 'a string tool_result content, an object input and an empty thinking are stored');
      } finally {
        manager.close();
      }
    });
  });

  it("a message a strategy would shard is refused before the strategy reads it, and a strategy's malformed shard before any shard is stored", async () => {
    class ShardEachBlock extends PassthroughStrategy {
      ingress = 0;
      chunkIngressMessage(_participant: string, content: ContentBlock[]) {
        this.ingress++;
        // A shard of each block, and one more the chunker makes up that doesn't match.
        const shards = content.map((block, shardIndex) => ({ content: [block], shardIndex }));
        if (content.some((block) => (block as { text?: string }).text === 'bad shard')) {
          shards.push({ content: [null as unknown as ContentBlock], shardIndex: shards.length });
        }
        return { bodyGroupId: 'each-block', shards };
      }
    }
    await withStore(async (store) => {
      const strategy = new ShardEachBlock();
      const manager = await ContextManager.open({ store, strategy });
      try {
        assert.throws(() => manager.addMessage('User', [t('a'), 'b'] as ContentBlock[]), { message: /^Message refused: content\[1\] is a string, not a content block\.$/ });
        assert.equal(strategy.ingress, 0, 'the strategy never read it');
        assert.throws(
          () => manager.addMessage('User', [t('a'), t('bad shard')], undefined, undefined, { holdCompression: true }),
          { message: /^Message refused: content\[0\] is null, not a content block\.$/ },
        );
        assert.equal(strategy.ingress, 1);
        assert.equal(manager.getAllMessages().length, 0, 'no shard of either was stored');
        assert.equal(manager.getCompressionHolds().size, 0, 'and no hold was placed');
      } finally {
        manager.close();
      }
    });
  });

  it('the stores refuse it at append and at edit, ContextLog.replaceAll before it clears, and blockAsStored as the store does', async () => {
    await withStore(async (store) => {
      MessageStore.register(store);
      ContextLog.register(store);
      assert.throws(() => new MessageStore(store).append('User', [t('a'), null] as ContentBlock[]), { message: /^Message refused: content\[1\] is null, not a content block\.$/ });
      writeRaw(store, 'User', [t('a'), null]);
      const messages = new MessageStore(store);
      await errorLines(() => {
        const [held] = messages.getAll();
        assert.throws(
          () => messages.edit(held!.id, [t('b'), 'x'] as ContentBlock[]),
          { message: new RegExp(`^Edit of ${held!.id} refused: content\\[1\\] is a string, not a content block\\.$`) },
        );
        messages.edit(held!.id, [t('fixed')]);
        assert.deepEqual(messages.get(held!.id)!.content, [t('fixed')]);
      });
      const log = new ContextLog(store);
      assert.throws(() => log.append('User', [toolResult('t1', [null])] as ContentBlock[]), { message: /^Context entry refused: content\[0\]\.content\[0\] is null, not a content block\.$/ });
      log.append('User', [t('entry')]);
      assert.throws(() => log.edit(0, [{ type: 'text' }] as ContentBlock[]), { message: /^Edit of context entry 0 refused: content\[0\]\.text is undefined, not a string\.$/ });
      assert.deepEqual(log.getAll().map((entry) => entry.content), [[t('entry')]], 'the context log stored nothing refused');
      assert.throws(
        () => log.replaceAll([
          { participant: 'User', content: [t('new 1')] },
          { participant: 'User', content: [null] as unknown as ContentBlock[] },
        ]),
        { message: /^Context entry 1 of the replacement refused: content\[0\] is null, not a content block\.$/ },
      );
      assert.deepEqual(log.getAll().map((entry) => entry.content), [[t('entry')]], 'a refused replacement leaves the log as it was');
      assert.throws(() => blockAsStored(null as unknown as ContentBlock), { message: /^blockAsStored: block is null, not a content block\.$/ });
      assert.throws(() => blockAsStored(toolResult('t1', [t('ok'), 'x']) as ContentBlock), { message: /^blockAsStored: block\.content\[1\] is a string, not a content block\.$/ });
      assert.throws(() => blockAsStored(toolUse('u1') as ContentBlock), { message: /^blockAsStored: block\.input is undefined, not an object\.$/ });
      assert.deepEqual(blockAsStored(toolResult('t1', 'fine') as ContentBlock), toolResult('t1', 'fine'));
    });
  });
});
