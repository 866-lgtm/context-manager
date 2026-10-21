/**
 * addMessage throws only before anything is stored, whatever the strategy's
 * onNewMessage does (#288).
 *
 * The manager calls a strategy's onNewMessage from its own store listener,
 * inside the append that stored the message. A host-written strategy whose
 * onNewMessage isn't async can throw there synchronously, or return no
 * promise at all. Either is now logged, as a rejection is, and the message
 * stays stored: addMessage returns its id, every shard of a sharded body is
 * written, and a host's onMessage listener still hears the add. The
 * strategy's synchronous part still runs before addMessage returns.
 */

import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import type { ContentBlock } from '@animalabs/membrane';
import { ContextManager, PassthroughStrategy } from '../src/index.js';
import type { StoredMessage, StrategyContext } from '../src/index.js';

const TEST_STORE_PATH = './test-strategy-new-message-throw';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

/** console.error's calls while `fn` runs. */
async function errorsDuring(fn: () => Promise<void>): Promise<unknown[][]> {
  const errors: unknown[][] = [];
  const realError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await fn();
  } finally {
    console.error = realError;
  }
  return errors;
}

function watchUnhandled() {
  const seen: string[] = [];
  const onError = (err: unknown) => { seen.push(String(err)); };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { seen, restore: () => { process.off('uncaughtException', onError); process.off('unhandledRejection', onError); } };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A host strategy whose onNewMessage isn't async and throws synchronously. */
class ThrowsSynchronously extends PassthroughStrategy {
  heard: string[] = [];
  onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    this.heard.push(message.id);
    throw new Error('zz onNewMessage threw synchronously');
  }
}

/** A host strategy whose onNewMessage isn't async and returns no promise. */
class ReturnsNothing extends PassthroughStrategy {
  heard: string[] = [];
  onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
    this.heard.push(message.id);
    return undefined as unknown as Promise<void>;
  }
}

/** ThrowsSynchronously, storing each message as three shards. */
class ShardsAndThrows extends ThrowsSynchronously {
  chunkIngressMessage(_participant: string, content: ContentBlock[]) {
    const body = content.map((b) => (b.type === 'text' ? b.text : '')).join('');
    return { bodyGroupId: 'zz-group', shards: [0, 1, 2].map((shardIndex) => ({ content: [text(`${body} part ${shardIndex}`)], shardIndex })) };
  }
}

describe('a strategy onNewMessage that fails without rejecting (#288)', () => {
  beforeEach(cleanup);
  after(cleanup);

  it('a synchronous throw is logged, and addMessage returns the id of the message it stored', async () => {
    const strategy = new ThrowsSynchronously();
    const unhandled = watchUnhandled();
    try {
      let id: string | undefined;
      let stored: string[] = [];
      const errors = await errorsDuring(async () => {
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, namespace: 'agents/zz-sync' });
        id = manager.addMessage('User', [text('hello')]);
        stored = manager.getAllMessages().map((m) => m.id);
        await settle();
        manager.close();
      });
      assert.ok(id, 'addMessage returned an id');
      assert.deepEqual(stored, [id], 'the store holds the message');
      assert.deepEqual(strategy.heard, [id], 'the strategy heard it once');
      const logged = errors.filter((args) => args[0] === 'Strategy onNewMessage failed: ns=agents/zz-sync');
      assert.equal(logged.length, 1, 'the failure is logged once, naming the namespace');
      assert.match(String(logged[0]![1]), /zz onNewMessage threw synchronously/);
      assert.deepEqual(unhandled.seen, [], 'nothing escapes as an uncaught error');
    } finally {
      unhandled.restore();
    }
  });

  it('an onNewMessage that returns no promise passes, logging nothing', async () => {
    const strategy = new ReturnsNothing();
    const unhandled = watchUnhandled();
    try {
      let id: string | undefined;
      const errors = await errorsDuring(async () => {
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, namespace: 'agents/zz-void' });
        id = manager.addMessage('User', [text('hello')]);
        assert.equal(manager.getAllMessages().length, 1);
        await settle();
        manager.close();
      });
      assert.ok(id, 'addMessage returned an id');
      assert.deepEqual(strategy.heard, [id]);
      assert.deepEqual(errors.filter((args) => String(args[0]).startsWith('Strategy onNewMessage failed')), [], 'no promise is no failure');
      assert.deepEqual(unhandled.seen, []);
    } finally {
      unhandled.restore();
    }
  });

  it('a sharded add whose every shard the strategy throws on stores the whole body, and returns shard 0', async () => {
    const strategy = new ShardsAndThrows();
    let id: string | undefined;
    let shards: Array<number | undefined> = [];
    const errors = await errorsDuring(async () => {
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, namespace: 'agents/zz-shards' });
      id = manager.addMessage('User', [text('a long body')]);
      const stored = manager.getAllMessages();
      shards = stored.map((m) => m.shardIndex);
      assert.equal(stored[0]!.id, id, "addMessage returned shard 0's id");
      assert.ok(stored.every((m) => m.bodyGroupId === 'zz-group' && m.shardCount === 3), 'one body of three shards');
      await settle();
      manager.close();
    });
    assert.deepEqual(shards, [0, 1, 2], 'every shard is stored, in order');
    assert.equal(strategy.heard.length, 3, 'the strategy heard each shard');
    assert.equal(errors.filter((args) => args[0] === 'Strategy onNewMessage failed: ns=agents/zz-shards').length, 3, 'each throw is logged');
  });

  it("a host's onMessage listener still hears the add", async () => {
    const strategy = new ThrowsSynchronously();
    const heard: string[] = [];
    await errorsDuring(async () => {
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy, namespace: 'agents/zz-listener' });
      manager.onMessage((event) => { if (event.type === 'add') heard.push(event.message.id); });
      const id = manager.addMessage('User', [text('hello')]);
      assert.deepEqual(heard, [id], 'the listener registered after the manager heard the add');
      manager.close();
    });
  });

  it('a rejection is still logged, as before, and nothing is left unhandled', async () => {
    class Rejects extends PassthroughStrategy {
      async onNewMessage(_message: StoredMessage, _ctx: StrategyContext): Promise<void> {
        throw new Error('zz onNewMessage rejected');
      }
    }
    const unhandled = watchUnhandled();
    try {
      const errors = await errorsDuring(async () => {
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new Rejects(), namespace: 'agents/zz-rejects' });
        manager.addMessage('User', [text('hello')]);
        await settle();
        manager.close();
      });
      const logged = errors.filter((args) => args[0] === 'Strategy onNewMessage failed: ns=agents/zz-rejects');
      assert.equal(logged.length, 1);
      assert.match(String(logged[0]![1]), /zz onNewMessage rejected/);
      assert.deepEqual(unhandled.seen, []);
    } finally {
      unhandled.restore();
    }
  });

  it("the strategy's synchronous part still runs before addMessage returns", async () => {
    // Pins the order: deferring the hook would move this past the return.
    class Records extends PassthroughStrategy {
      sawBeforeAwait: string[] = [];
      async onNewMessage(message: StoredMessage, _ctx: StrategyContext): Promise<void> {
        this.sawBeforeAwait.push(message.id);
        await settle();
      }
    }
    const strategy = new Records();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    const id = manager.addMessage('User', [text('hello')]);
    assert.deepEqual(strategy.sawBeforeAwait, [id], 'the hook ran inside addMessage');
    await settle();
    manager.close();
  });
});
