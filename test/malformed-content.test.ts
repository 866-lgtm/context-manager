/**
 * Content that doesn't match ContentBlock where its readers read it (#184):
 * a block that isn't an object; a text block whose text, or a thinking block
 * whose thinking, isn't a string; a tool_use whose input isn't an object; a
 * tool_result whose content is neither a string nor an array of such blocks,
 * at any depth. Reads leave it out or make it match, so every compile,
 * compression pass and reopen works, and the store keeps it as written.
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
});
