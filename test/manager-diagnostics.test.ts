/**
 * The manager's own diagnostics name the namespace whose work they report, or
 * the slot whose state they describe (#239), so one process's managers' lines
 * can be told apart.
 */

import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';
import { JsStore } from '@animalabs/chronicle';
import { ContextManager } from '../src/index.js';

describe('the manager\'s diagnostics', () => {
  it('logs a compiled context as JSON naming its namespace (debugLogContext)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-debug-log-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const logged: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => {
      if (args[0] === '[debugLogContext]') logged.push(String(args[1]));
    });
    const manager = await ContextManager.open({
      path: join(dir, 'store'),
      namespace: 'agents/tern',
      debugLogContext: true,
    });
    manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
    await manager.compile();
    manager.close();
    assert.equal(logged.length, 1, logged.join('\n'));
    const entry = JSON.parse(logged[0]!) as { type: string; namespace: string; messageCount: number };
    assert.equal(entry.type, 'compiled_context');
    assert.equal(entry.namespace, 'agents/tern');
    assert.equal(entry.messageCount, 1);
  });

  it('names its namespace on a compile\'s cache line (CM_CACHE_DIAG)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-cache-diag-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const prior = process.env.CM_CACHE_DIAG;
    t.after(() => {
      if (prior === undefined) delete process.env.CM_CACHE_DIAG;
      else process.env.CM_CACHE_DIAG = prior;
    });
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(String(args[0])); });
    const manager = await ContextManager.open({ path: join(dir, 'store'), namespace: 'agents/tern' });
    manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
    process.env.CM_CACHE_DIAG = '1';
    await manager.compile();
    manager.close();
    const select = lines.filter((line) => line.startsWith('[cm-cache] compile: select'));
    assert.equal(select.length, 1, lines.join('\n'));
    assert.match(select[0]!, / ns=agents\/tern$/);
  });

  it('names an isolated slot\'s namespace on its cache lines, and the shared slot\'s none (CM_CACHE_DIAG)', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-cache-slot-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const prior = process.env.CM_CACHE_DIAG;
    t.after(() => {
      if (prior === undefined) delete process.env.CM_CACHE_DIAG;
      else process.env.CM_CACHE_DIAG = prior;
    });
    const lines: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => { lines.push(String(args[0])); });
    const isolated = await ContextManager.open({ path: join(dir, 'isolated'), namespace: 'agents/tern', isolate: true });
    const shared = await ContextManager.open({ path: join(dir, 'shared'), namespace: 'agents/kite' });
    // Read at each write, so it can be set here.
    process.env.CM_CACHE_DIAG = '1';
    isolated.addMessage('User', [{ type: 'text', text: 'hello' }]);
    shared.addMessage('User', [{ type: 'text', text: 'hello' }]);
    isolated.close();
    shared.close();
    const bumps = lines.filter((line) => line.startsWith('[cm-cache] writeVersion bump'));
    assert.equal(bumps.length, 2, lines.join('\n'));
    assert.ok(bumps[0]!.startsWith('[cm-cache] writeVersion bump agents/tern/messages ') && bumps[0]!.endsWith(' ns=agents/tern'), bumps[0]);
    assert.ok(bumps[1]!.startsWith('[cm-cache] writeVersion bump messages ') && !bumps[1]!.includes(' ns='), bumps[1]);
  });

  /**
   * Opens a manager twice on one store, so the second open retunes the slot the first made,
   * through a store whose retune throws when `refuse` is set, and returns what the second
   * printed, formatted as console formats its arguments.
   */
  async function retuneLines(
    t: TestContext,
    options: { namespace: string; isolate?: boolean; refuse?: boolean },
  ): Promise<string[]> {
    const dir = mkdtempSync(join(tmpdir(), 'cm-retune-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'store');
    const { namespace, isolate } = options;
    (await ContextManager.open({ path, namespace, isolate })).close();
    const real = JsStore.openOrCreate({ path });
    const store = options.refuse
      ? (new Proxy(real, {
          get(target, prop) {
            if (prop === 'updateStateStrategy') return () => { throw new Error('retune refused'); };
            const value = Reflect.get(target, prop, target) as unknown;
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }) as JsStore)
      : real;
    const printed: string[] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => { printed.push(format(...args)); };
    try {
      (await ContextManager.open({ store, namespace, isolate })).close();
    } finally {
      console.error = error;
      real.close();
    }
    return printed.filter((line) => line.startsWith('[message-store] snapshot'));
  }

  it('names an isolated slot\'s namespace when it retunes the slot\'s snapshot cadence at open, and the shared slot\'s none', async (t) => {
    const isolated = await retuneLines(t, { namespace: 'agents/tern', isolate: true });
    assert.equal(isolated.length, 1, isolated.join('\n'));
    assert.match(isolated[0]!, /^\[message-store\] snapshot cadence retuned: agents\/tern\/messages -> delta \d+ x full \d+ ns=agents\/tern$/);
    const shared = await retuneLines(t, { namespace: 'agents/tern' });
    assert.equal(shared.length, 1, shared.join('\n'));
    assert.match(shared[0]!, /^\[message-store\] snapshot cadence retuned: messages -> delta \d+ x full \d+$/);
  });

  it('names the message slot, as written, when retuning its snapshot cadence fails at open', async (t) => {
    // A % in the namespace stays as written, in the slot and in the suffix.
    const isolated = await retuneLines(t, { namespace: 'agents/100%s', isolate: true, refuse: true });
    assert.equal(isolated.length, 1, isolated.join('\n'));
    assert.ok(
      isolated[0]!.startsWith('[message-store] snapshot-cadence retune failed for agents/100%s/messages: ns=agents/100%s Error: retune refused'),
      isolated[0],
    );
    const shared = await retuneLines(t, { namespace: 'agents/100%s', refuse: true });
    assert.equal(shared.length, 1, shared.join('\n'));
    assert.ok(shared[0]!.startsWith('[message-store] snapshot-cadence retune failed for messages: Error: retune refused'), shared[0]);
  });
});
