/**
 * The manager's own diagnostics name the namespace whose work they report, or
 * the slot whose state they describe (#239), so one process's managers' lines
 * can be told apart.
 */

import { describe, it } from 'node:test';
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

  it('names the message slot, as written, when retuning its snapshot cadence fails at open', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'cm-retune-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, 'store');
    // The slot exists before this open, so open retunes it; a % in the namespace stays as written.
    const namespace = 'agents/100%s';
    (await ContextManager.open({ path, namespace, isolate: true })).close();
    const real = JsStore.openOrCreate({ path });
    const refusing = new Proxy(real, {
      get(target, prop) {
        if (prop === 'updateStateStrategy') return () => { throw new Error('retune refused'); };
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    }) as JsStore;
    const printed: string[] = [];
    // Formatted as console formats its arguments.
    t.mock.method(console, 'error', (...args: unknown[]) => { printed.push(format(...args)); });
    try {
      (await ContextManager.open({ store: refusing, namespace, isolate: true })).close();
    } finally {
      real.close();
    }
    const failed = printed.filter((line) => line.startsWith('[message-store] snapshot-cadence retune failed'));
    assert.equal(failed.length, 1, printed.join('\n'));
    assert.ok(failed[0]!.startsWith(`[message-store] snapshot-cadence retune failed for ${namespace}/messages: Error: retune refused`), failed[0]);
  });
});
