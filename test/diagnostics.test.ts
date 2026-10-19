/**
 * Diagnostics that name the namespace whose work they report (#239):
 * diagnostics.ts's helper, which every per-namespace stderr line goes through.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { namespaceDiagnostics, withNamespace } from '../src/diagnostics.js';

describe('withNamespace', () => {
  it('ends the line with ` ns=<namespace>`, after its fields, so a grep for its prefix still matches', () => {
    assert.equal(withNamespace('[kv-overlap] sample=2', 'agents/tern'), '[kv-overlap] sample=2 ns=agents/tern');
  });

  it('ends the first line of a message that has several, where its prefix is', () => {
    assert.equal(
      withNamespace('[store-topology] ⛔ 2 summaries own non-contiguous leaves:\n  L2-1\n  L2-4', 'agents/tern'),
      '[store-topology] ⛔ 2 summaries own non-contiguous leaves: ns=agents/tern\n  L2-1\n  L2-4',
    );
  });
});

describe('namespaceDiagnostics', () => {
  it('names the namespace as each line is logged, through console as it is then, with the rest of its arguments', (t) => {
    const errors: unknown[][] = [];
    const warnings: unknown[][] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => errors.push(args));
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args));
    let namespace = '';
    const log = namespaceDiagnostics(() => namespace);
    const cause = new Error('disk full');
    // Before it has one, as a strategy before initialize: the line names none.
    log.error('[autobiographical] write failed:', cause);
    namespace = 'agents/wren';
    log.error('[autobiographical] write failed:', cause);
    log.warn('[autobiographical] repaired 2 chunk record(s)');
    assert.deepEqual(errors, [
      ['[autobiographical] write failed:', cause],
      ['[autobiographical] write failed: ns=agents/wren', cause],
    ]);
    assert.deepEqual(warnings, [['[autobiographical] repaired 2 chunk record(s) ns=agents/wren']]);
  });
});
