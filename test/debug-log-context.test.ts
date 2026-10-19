/**
 * debugLogContext: each compiled context logged as one structured line, which
 * names the namespace that compiled it (#239), so one process's managers'
 * lines can be told apart.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager } from '../src/index.js';

describe('debugLogContext', () => {
  it('logs a compiled context as JSON naming its namespace', async (t) => {
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
});
