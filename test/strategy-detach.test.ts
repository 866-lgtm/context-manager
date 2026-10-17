/**
 * A manager tells a strategy it is done with it (#209).
 *
 * setStrategy() and close() call ContextStrategy.detach?() on the strategy
 * they let go of. AutobiographicalStrategy then discards a compression that
 * was in flight, instead of writing its summary and chunk record into a
 * store and namespace that another strategy now owns, and its background
 * drain makes no further provider call. Setting the same instance again
 * initializes it as before.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager, AutobiographicalStrategy, PassthroughStrategy } from '../src/index.js';

const TEST_STORE_PATH = './test-strategy-detach';
const SUMMARIES = 'default/autobio:summaries';
const CHUNKS = 'default/autobio:chunks';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

const filler = (n: number) => 'word '.repeat(n);

/** A membrane whose compression calls each wait until the test releases them. */
function heldMembrane() {
  const calls: Array<{ release: () => void }> = [];
  return {
    calls,
    membrane: {
      complete: (_req: unknown) => new Promise((resolve) => {
        const n = calls.length + 1;
        calls.push({
          release: () => resolve({ stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${n}` }] }),
        });
      }),
    },
  };
}

function newStrategy(autoTickOnNewMessage = false) {
  return new AutobiographicalStrategy({
    compressionModel: 'test-compression-model',
    targetChunkTokens: 50,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    autoTickOnNewMessage,
    minChunkCharsForLLM: 0,
    l1HoldbackChunks: 0,
  });
}

function seed(manager: ContextManager, count = 12) {
  for (let i = 0; i < count; i++) {
    manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', [{ type: 'text', text: `${i} ${filler(30)}` }]);
  }
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = (ms = 100) => new Promise((r) => setTimeout(r, ms));

function persisted(store: JsStore, id: string): unknown[] {
  try {
    return (store.getStateJson(id) as unknown[] | null) ?? [];
  } catch {
    return [];
  }
}

/** No summary, and the chunk records as they were before the strategy was let go of. */
function assertNothingWritten(store: JsStore, chunksBefore: unknown[], when: string) {
  const summaries = persisted(store, SUMMARIES);
  const chunks = persisted(store, CHUNKS);
  const chunksSame = JSON.stringify(chunks) === JSON.stringify(chunksBefore);
  assert.deepStrictEqual(
    { summaries, chunks },
    { summaries: [], chunks: chunksBefore },
    `written ${when}: ${summaries.length} summaries; chunk records ${chunksSame ? 'unchanged' : `changed (${chunksBefore.length} before, ${chunks.length} after)`}`,
  );
}

describe('a manager detaches the strategy it lets go of (#209)', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it('setStrategy(): the replaced strategy writes nothing from a compression in flight', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      const chunksBefore = persisted(store, CHUNKS);

      await manager.setStrategy(new PassthroughStrategy());
      calls[0].release();
      await ticking.catch(() => {});
      await settle();

      assertNothingWritten(store, chunksBefore, 'after the swap');
    } finally {
      manager.close();
      store.close();
    }
  });

  it('setStrategy(): a drain armed before the swap makes no further provider call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(true), membrane: membrane as never });
    try {
      seed(manager);
      await waitFor(() => calls.length === 1);

      await manager.setStrategy(new PassthroughStrategy());
      calls[0].release();
      await settle(200);

      assert.strictEqual(calls.length, 1, `the replaced strategy's drain called the provider ${calls.length - 1} more time(s)`);
      assert.deepStrictEqual(persisted(store, SUMMARIES), [], 'no summary written after the swap');
    } finally {
      manager.close();
      store.close();
    }
  });

  it('close(): with an app-owned store, the strategy writes nothing from a compression in flight', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      const chunksBefore = persisted(store, CHUNKS);

      manager.close();
      assert.strictEqual(store.isClosed(), false, 'the app still owns its store');
      calls[0].release();
      await ticking.catch(() => {});
      await settle();

      assertNothingWritten(store, chunksBefore, 'after close()');
    } finally {
      store.close();
    }
  });

  it('the manager detaches a strategy only when it lets go of it', async () => {
    const detached: string[] = [];
    class Recording extends PassthroughStrategy {
      constructor(readonly label: string) { super(); }
      detach(): void { detached.push(this.label); }
    }
    const first = new Recording('first');
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: first });
    await manager.setStrategy(first);
    assert.deepStrictEqual(detached, [], 'setting the same instance again detaches nothing');
    await manager.setStrategy(new Recording('second'));
    assert.deepStrictEqual(detached, ['first'], 'a replacement detaches the strategy it replaces');
    manager.close();
    assert.deepStrictEqual(detached, ['first', 'second'], 'close() detaches the current strategy');
  });

  it('a strategy whose detach() throws is still replaced, and close() still closes an owned store', async () => {
    class ThrowingDetach extends PassthroughStrategy {
      detach(): void {
        throw new Error('detach failed');
      }
    }
    const errors: unknown[][] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => { errors.push(args); };
    try {
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new ThrowingDetach() });
      const replacement = new ThrowingDetach();
      await manager.setStrategy(replacement);
      assert.strictEqual(manager.getStrategy(), replacement);
      manager.addMessage('User', [{ type: 'text', text: 'still works' }]);
      manager.close();
      assert.strictEqual(manager.isClosed(), true, 'close() closed the store it owns');
      assert.strictEqual(errors.filter((args) => args[0] === 'Strategy detach failed:').length, 2, 'each failed detach is logged');
    } finally {
      console.error = realError;
    }
  });

  it('a drain tick armed before the store\'s branch moved stops instead of throwing from its timer', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}` }] };
      },
    };
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown) => { uncaught.push(err); };
    process.on('uncaughtException', onUncaught);
    const realSetTimeout = globalThis.setTimeout;
    let moved = false;
    const manager = await ContextManager.open({ store, strategy: newStrategy(true), membrane: membrane as never });
    try {
      // The drain re-arms with setTimeout(…, 0) after a tick that compressed;
      // move the store's branch directly, as a host may, before that timer runs.
      globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        if (!moved && ms === 0 && String(fn).includes('driveSpeculativeDrain')) {
          moved = true;
          store.createBranch('elsewhere');
          store.switchBranch('elsewhere');
        }
        return realSetTimeout(fn, ms, ...args);
      }) as typeof setTimeout;
      seed(manager);
      await waitFor(() => moved);
      await settle();
      assert.deepStrictEqual(uncaught.map(String), [], 'nothing thrown from the drain timer');
    } finally {
      globalThis.setTimeout = realSetTimeout;
      process.off('uncaughtException', onUncaught);
      manager.close();
      store.close();
    }
  });

  it('setting the same instance again initializes it and it compresses as before', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.setStrategy(new PassthroughStrategy());
      await manager.setStrategy(strategy);

      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      calls[0].release();
      await ticking;

      assert.strictEqual(persisted(store, SUMMARIES).length, 1, 'the re-set strategy wrote its summary');
    } finally {
      manager.close();
      store.close();
    }
  });
});
