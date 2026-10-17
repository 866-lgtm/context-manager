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

/** A membrane whose compression calls each wait until the test answers them
 *  (release) or fails them (fail). */
function heldMembrane() {
  const calls: Array<{ request: unknown; release: (content?: unknown[]) => void; fail: (error: unknown) => void }> = [];
  return {
    calls,
    membrane: {
      complete: (request: unknown) => new Promise((resolve, reject) => {
        const n = calls.length + 1;
        calls.push({
          request,
          release: (content = [{ type: 'text', text: `Summary #${n}` }]) => resolve({ stopReason: 'end_turn', content }),
          fail: reject,
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

/** Whether `promise` settles within `ms`. */
async function settlesWithin(promise: Promise<unknown>, ms = 1000): Promise<boolean> {
  let settled = false;
  await Promise.race([promise.then(() => { settled = true; }, () => { settled = true; }), settle(ms)]);
  return settled;
}

function persisted(store: JsStore, id: string): unknown[] {
  try {
    return (store.getStateJson(id) as unknown[] | null) ?? [];
  } catch {
    return [];
  }
}

/** Every state the strategy keeps under the manager's namespace, by id. A
 *  state that can't be read is kept as its error, never taken for empty. */
function strategyStates(store: JsStore): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const { id } of store.listStates()) {
    if (!id.startsWith('default/autobio:') && !id.startsWith('default/kvunified:')) continue;
    try {
      out[id] = store.getStateJson(id);
    } catch (error) {
      out[id] = `unreadable: ${(error as Error).message}`;
    }
  }
  return out;
}

/** No summary, and every state the strategy keeps as it was before the
 *  strategy was let go of. */
function assertNothingWritten(store: JsStore, statesBefore: Record<string, unknown>, when: string) {
  const states = strategyStates(store);
  const changed = [...new Set([...Object.keys(statesBefore), ...Object.keys(states)])]
    .filter((id) => JSON.stringify(states[id]) !== JSON.stringify(statesBefore[id]));
  assert.deepStrictEqual(
    changed,
    [],
    `written ${when}: ${persisted(store, SUMMARIES).length} summaries; changed states: ${changed.join(', ')}`,
  );
}

/** Count the drain's re-armed timers as they run, so a test can wait for the
 *  one it is about rather than for a fixed time. `onArm` runs as one is set;
 *  when it returns a promise, that timer runs once the promise settles. */
function watchDrainTimers(onArm?: () => void | Promise<unknown>) {
  const realSetTimeout = globalThis.setTimeout;
  const counts = { armed: 0, ran: 0 };
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 0 && String(fn).includes('driveSpeculativeDrain')) {
      counts.armed++;
      const before = onArm?.();
      return realSetTimeout(() => {
        void Promise.resolve(before).catch(() => {}).then(() => {
          try { fn(...args); } finally { counts.ran++; }
        });
      }, ms);
    }
    return realSetTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  return { counts, restore: () => { globalThis.setTimeout = realSetTimeout; } };
}

/** Count each time the strategy's background drain is driven, by a message or
 *  by its own re-armed timer. A drive the timer makes after the strategy was
 *  let go of is the drain going on, whether or not its tick reaches the
 *  provider before a test looks. */
function countDrives(strategy: AutobiographicalStrategy) {
  const s = strategy as unknown as { driveSpeculativeDrain: (ctx: unknown) => void };
  const real = s.driveSpeculativeDrain.bind(strategy);
  const counts = { drives: 0 };
  s.driveSpeculativeDrain = (ctx: unknown) => { counts.drives++; real(ctx); };
  return counts;
}

/** Collect what would otherwise end the process: uncaught exceptions and
 *  unhandled rejections. */
function watchUnhandled() {
  const seen: string[] = [];
  const onError = (err: unknown) => { seen.push(String(err)); };
  process.on('uncaughtException', onError);
  process.on('unhandledRejection', onError);
  return { seen, restore: () => { process.off('uncaughtException', onError); process.off('unhandledRejection', onError); } };
}

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

/** A provider's refusal of the reasoning carriers in a request. */
const carrierRejection = () => Object.assign(
  new Error('invalid_request_error: thinking blocks in this request cannot be accepted'),
  { httpStatus: 400 },
);

describe('a manager detaches the strategy it lets go of (#209)', () => {
  beforeEach(() => cleanup());
  after(() => cleanup());

  it('setStrategy(): the replaced strategy writes nothing from a compression in flight', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const replaced = newStrategy();
    const manager = await ContextManager.open({ store, strategy: replaced, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const ticking = manager.tick();
      await waitFor(() => calls.length === 1);
      const statesBefore = strategyStates(store);

      await manager.setStrategy(new PassthroughStrategy());
      calls[0].release();
      await ticking.catch(() => {});
      await settle();

      assertNothingWritten(store, statesBefore, 'after the swap');
      assert.throws(() => replaced.getStats(), /requires reinitialization/, "the replaced strategy's reads fail closed");
    } finally {
      manager.close();
      store.close();
    }
  });

  it('setStrategy(): a drain armed before the swap makes no further provider call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const timers = watchDrainTimers();
    const unhandled = watchUnhandled();
    const replaced = newStrategy(true);
    const drives = countDrives(replaced);
    const manager = await ContextManager.open({ store, strategy: replaced, membrane: membrane as never });
    try {
      seed(manager);
      await waitFor(() => calls.length === 1);
      const drivesBefore = drives.drives;

      await manager.setStrategy(new PassthroughStrategy());
      calls[0].release();
      // The drain re-arms after the tick it was running; wait for that timer.
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);

      assert.strictEqual(drives.drives, drivesBefore, "the replaced strategy's drain was driven again after the swap");
      assert.strictEqual(calls.length, 1, `the replaced strategy's drain called the provider ${calls.length - 1} more time(s)`);
      assert.deepStrictEqual(persisted(store, SUMMARIES), [], 'no summary written after the swap');
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
    } finally {
      timers.restore();
      unhandled.restore();
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
      const statesBefore = strategyStates(store);

      manager.close();
      assert.strictEqual(store.isClosed(), false, 'the app still owns its store');
      calls[0].release();
      await ticking.catch(() => {});
      await settle();

      assertNothingWritten(store, statesBefore, 'after close()');
    } finally {
      store.close();
    }
  });

  it('close(): with an app-owned store, a drain armed before it makes no further provider call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const timers = watchDrainTimers();
    const unhandled = watchUnhandled();
    const strategy = newStrategy(true);
    const drives = countDrives(strategy);
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    let closed = false;
    try {
      seed(manager);
      await waitFor(() => calls.length === 1);
      const drivesBefore = drives.drives;

      manager.close();
      closed = true;
      assert.strictEqual(store.isClosed(), false, 'the app still owns its store');
      calls[0].release();
      // The drain re-arms after the tick it was running; wait for that timer.
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);

      assert.strictEqual(drives.drives, drivesBefore, "the closed manager's strategy was driven again after close()");
      assert.strictEqual(calls.length, 1, `the closed manager's strategy called the provider ${calls.length - 1} more time(s)`);
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
    } finally {
      timers.restore();
      unhandled.restore();
      if (!closed) manager.close();
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
      initialized = 0;
      async initialize(): Promise<void> { this.initialized++; }
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
      assert.strictEqual(replacement.initialized, 1, 'the replacement initialized');
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
    const unhandled = watchUnhandled();
    let callsAtMove: number | undefined;
    // The drain re-arms with setTimeout(…, 0) after a tick that compressed;
    // move the store's branch directly, as a host may, before that timer runs.
    const timers = watchDrainTimers(() => {
      if (callsAtMove !== undefined) return;
      callsAtMove = calls;
      store.createBranch('elsewhere');
      store.switchBranch('elsewhere');
    });
    const manager = await ContextManager.open({ store, strategy: newStrategy(true), membrane: membrane as never });
    try {
      seed(manager);
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
      assert.strictEqual(calls, callsAtMove, 'the drain made no provider call after the branch moved');
    } finally {
      timers.restore();
      unhandled.restore();
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

  it('a compression whose first call fails on its reasoning carriers after the swap makes no second call', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      // The first summary keeps its reasoning, so the next request's recall
      // pair carries it, and a carrier rejection would take the text-only retry.
      const first = manager.tick();
      await waitFor(() => calls.length === 1);
      calls[0].release([
        { type: 'thinking', thinking: 'reasoning', signature: 'signature' },
        { type: 'text', text: 'Summary #1' },
      ]);
      await first;
      const second = manager.tick();
      await waitFor(() => calls.length === 2);
      assert.ok(JSON.stringify(calls[1].request).includes('"thinking"'), "the second request carries the first summary's reasoning");

      await manager.setStrategy(new PassthroughStrategy());
      calls[1].fail(carrierRejection());
      const ended = await settlesWithin(second);
      await settle(50);

      assert.strictEqual(calls.length, 2, `the replaced strategy retried the call ${calls.length - 2} time(s)`);
      assert.ok(ended, 'the tick ended');
    } finally {
      for (const call of calls.slice(2)) call.release();
      manager.close();
      store.close();
    }
  });

  it('close() of a manager that owns its store: a drain tick armed before it throws nothing from its timer', async () => {
    let calls = 0;
    const membrane = {
      complete: async () => {
        calls++;
        return { stopReason: 'end_turn', content: [{ type: 'text', text: `Summary #${calls}` }] };
      },
    };
    const unhandled = watchUnhandled();
    let manager: ContextManager | undefined;
    let closed = false;
    // Close as the drain re-arms, so its timer runs after the store is gone.
    const timers = watchDrainTimers(() => {
      if (closed || !manager) return;
      closed = true;
      manager.close();
    });
    try {
      manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: newStrategy(true), membrane: membrane as never });
      seed(manager);
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.strictEqual(manager.isClosed(), true, 'close() closed the store it owns');
      assert.deepStrictEqual(unhandled.seen, [], 'nothing thrown from the drain timer');
    } finally {
      timers.restore();
      unhandled.restore();
      if (manager && !closed) manager.close();
    }
  });

  it('close() of a manager that owns its store: a compression in flight discards its result quietly', async () => {
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: newStrategy(), membrane: membrane as never });
    seed(manager);
    await manager.compile();
    const ticking = manager.tick();
    await waitFor(() => calls.length === 1);
    let outcome = 'pending';
    const errors = await errorsDuring(async () => {
      manager.close();
      calls[0].release();
      await ticking.then(() => { outcome = 'resolved'; }, (e) => { outcome = `rejected: ${(e as Error).message}`; });
    });
    assert.strictEqual(manager.isClosed(), true, 'close() closed the store it owns');
    assert.strictEqual(outcome, 'resolved', 'the tick ends without an error');
    assert.deepStrictEqual(errors.filter((args) => String(args[0]).includes('Failed to compress')), [], 'no compression failure logged');
  });

  it('a drain armed before a swap stays stopped when the same instance is set again', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(true);
    const drives = countDrives(strategy);
    let drivesAtSwapBack: number | undefined;
    let manager: ContextManager | undefined;
    let swappedBack: Promise<unknown> | undefined;
    // As the drain re-arms after its first tick, swap the strategy out and
    // back in; the timer runs once the same instance is set again.
    const timers = watchDrainTimers(() => {
      if (swappedBack || !manager) return;
      const m = manager;
      swappedBack = m.setStrategy(new PassthroughStrategy())
        .then(() => m.setStrategy(strategy))
        .then(() => { drivesAtSwapBack = drives.drives; });
      return swappedBack;
    });
    try {
      manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      seed(manager);
      await waitFor(() => calls.length === 1);
      calls[0].release();
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.strictEqual(drives.drives, drivesAtSwapBack, 'the timer armed before the swap drove the drain again');
      assert.strictEqual(calls.length, 1, `the drain armed before the swap called the provider ${calls.length - 1} more time(s)`);
    } finally {
      timers.restore();
      manager?.close();
      store.close();
    }
  });

  it("a drain running when the manager's switchBranch() re-initializes the strategy stops, and the next message starts the new branch's drain", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy(true);
    const drives = countDrives(strategy);
    let drivesAtSwitch: number | undefined;
    let manager: ContextManager | undefined;
    let switched: Promise<unknown> | undefined;
    // As the drain re-arms after its first tick, switch the manager to another
    // branch, as a host's branch surgery does; the timer runs once the
    // switch's re-initialization is done.
    const timers = watchDrainTimers(() => {
      if (switched || !manager) return;
      const m = manager;
      store.createBranch('elsewhere');
      switched = m.switchBranch('elsewhere').then(() => { drivesAtSwitch = drives.drives; });
      return switched;
    });
    try {
      manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
      seed(manager);
      // The drain can re-arm, and the switch run, while this first call is
      // still out; a drain that goes on then calls again at once, so wait for
      // at least one call rather than exactly one.
      await waitFor(() => calls.length >= 1);
      calls[0].release();
      await waitFor(() => timers.counts.ran >= 1);
      await settle(20);
      assert.strictEqual(drives.drives, drivesAtSwitch, 'the timer armed before the switch drove the drain again');
      assert.strictEqual(calls.length, 1, `the drain armed before the switch called the provider ${calls.length - 1} more time(s)`);

      manager.addMessage('User', [{ type: 'text', text: `after the switch ${filler(30)}` }]);
      await waitFor(() => calls.length === 2);
      assert.ok(drives.drives > (drivesAtSwitch ?? Infinity), "the next message drove the new branch's drain");
    } finally {
      timers.restore();
      for (const call of calls.slice(1)) call.release();
      manager?.close();
      store.close();
    }
  });

  it('a tick whose quarantine sweep spans the swap ends there, and its alarm stays quiet', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const strategy = newStrategy();
    const alarms: unknown[] = [];
    strategy.setQuarantineAlarmHandler((status) => { alarms.push(status); });
    let openSweep!: () => void;
    const sweep = new Promise<void>((resolve) => { openSweep = resolve; });
    const internals = strategy as unknown as { sweepPaidOffQuarantineRecords: () => Promise<void>; quarantineAlarmActive: boolean };
    internals.sweepPaidOffQuarantineRecords = () => sweep;
    // An alarm episode is open, so with no quarantine left the all-clear
    // would sound once the sweep returns.
    internals.quarantineAlarmActive = true;
    const manager = await ContextManager.open({ store, strategy, membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      let outcome = 'pending';
      const ticking = manager.tick().then(() => { outcome = 'resolved'; }, (e) => { outcome = `rejected: ${(e as Error).message}`; });
      await settle(20);
      await manager.setStrategy(new PassthroughStrategy());
      openSweep();
      await settlesWithin(ticking);
      assert.strictEqual(calls.length, 0, 'the tick started no compression');
      assert.strictEqual(outcome, 'resolved', 'the tick ends without an error');
      assert.deepStrictEqual(alarms, [], 'no all-clear from the replaced strategy');
    } finally {
      for (const call of calls) call.release();
      manager.close();
      store.close();
    }
  });

  it("a replacement that joins the replaced strategy's compression in flight compresses the chunk itself", async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const { calls, membrane } = heldMembrane();
    const manager = await ContextManager.open({ store, strategy: newStrategy(), membrane: membrane as never });
    try {
      seed(manager);
      await manager.compile();
      const replacedTick = manager.tick();
      await waitFor(() => calls.length === 1);

      await manager.setStrategy(newStrategy());
      await manager.compile();
      const replacementTick = manager.tick();
      await settle(20);
      assert.strictEqual(calls.length, 1, "the replacement waits on the replaced strategy's call for the same chunk");

      calls[0].release();
      await replacedTick.catch(() => {});
      await waitFor(() => calls.length === 2, 500).catch(() => {});
      calls[1]?.release();
      await settlesWithin(replacementTick, 2000);

      assert.strictEqual(persisted(store, SUMMARIES).length, 1, `the replacement wrote the chunk's summary (${calls.length} provider calls)`);
    } finally {
      for (const call of calls.slice(1)) call.release();
      manager.close();
      store.close();
    }
  });

  it('a detach() that returns a rejected promise is logged, not left unhandled', async () => {
    class AsyncDetach extends PassthroughStrategy {
      async detach(): Promise<void> {
        throw new Error('async detach failed');
      }
    }
    const unhandled = watchUnhandled();
    try {
      const errors = await errorsDuring(async () => {
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy: new AsyncDetach() });
        await manager.setStrategy(new PassthroughStrategy());
        await settle(20);
        manager.close();
      });
      assert.deepStrictEqual(unhandled.seen, [], 'no unhandled rejection');
      assert.ok(
        errors.some((args) => args[0] === 'Strategy detach failed:' && String(args[2]).includes('async detach failed')),
        'the rejection is logged',
      );
    } finally {
      unhandled.restore();
    }
  });

  it('after close(), a message added through the manager reaches no strategy', async () => {
    const store = JsStore.openOrCreate({ path: TEST_STORE_PATH });
    const manager = await ContextManager.open({ store, strategy: newStrategy() });
    try {
      seed(manager, 2);
      manager.close();
      const errors = await errorsDuring(async () => {
        manager.addMessage('User', [{ type: 'text', text: 'after close' }]);
        await settle(20);
      });
      assert.deepStrictEqual(errors.filter((args) => String(args[0]).startsWith('Strategy ')), [], 'no strategy hook ran, so none failed');
    } finally {
      store.close();
    }
  });
});
