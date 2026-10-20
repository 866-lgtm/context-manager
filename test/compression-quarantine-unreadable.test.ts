/**
 * A compression attempt while the store can't read the compression quarantine
 * ledger. An attempt that would call the model reads it first, so while it
 * can't be read each such attempt stops there, and its error says so in the
 * words the debt report gives an operator: a host that reports a failed tick,
 * as agent-framework's maintenance does, shows them. A failed read pauses
 * nothing, so once the ledger reads again, compression resumes by itself.
 */

import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import type { ContentBlock, NormalizedRequest } from '@animalabs/membrane';

import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const BASE = './test-compression-quarantine-unreadable';
const paths: string[] = [];
after(() => { for (const p of paths) if (existsSync(p)) rmSync(p, { recursive: true, force: true }); });

const text = (t: string): ContentBlock => ({ type: 'text', text: t });

describe('compression while the quarantine ledger cannot be read', () => {
  it('stops before any model call with the words an operator reads, and resumes once the ledger reads', async () => {
    const calls: NormalizedRequest[] = [];
    const membrane = {
      complete: async (request: NormalizedRequest) => {
        calls.push(request);
        return { content: [text('A summary of what happened in this part of the conversation.')], stopReason: 'end_turn', usage: { inputTokens: 80, outputTokens: 20 } };
      },
    };
    const strategy = new AutobiographicalStrategy({
      compressionModel: 'same-model', targetChunkTokens: 50, headWindowTokens: 0, recentWindowTokens: 0,
      autoTickOnNewMessage: false, l1HoldbackChunks: 0, minChunkCharsForLLM: 0, mergeThreshold: 99,
      quarantineAlarmIntervalMs: 0, compressionRefusalCurveFallbacks: 0,
    } as never);
    const path = `${BASE}-${process.pid}`;
    paths.push(path);
    const manager = await ContextManager.open({ path, strategy, membrane: membrane as never });
    try {
      for (let i = 0; i < 8; i++) manager.addMessage(i % 2 ? 'Claude' : 'User', [text(`raw-${i} ` + 'word '.repeat(30))]);
      const internals = strategy as unknown as {
        store: { getStateJson(id: string): unknown };
        compressionRefusalQuarantineLedgerStateId: string;
        compressionRefusalQuarantineStateId: string;
        compressionPause: unknown;
      };
      assert.ok((strategy.getCompressionDebt().pendingChunks ?? 0) > 0, 'a chunk waits to be compressed');
      // The store can't read the ledger's state, as a damaged or unreadable store wouldn't.
      const store = internals.store;
      const read = store.getStateJson.bind(store);
      const ledger = new Set([internals.compressionRefusalQuarantineLedgerStateId, internals.compressionRefusalQuarantineStateId]);
      const cause = new Error('EACCES: permission denied (test)');
      const message = [
        'Compression of new conversation has stalled.',
        "Cause: the store couldn't read this agent's compression quarantine ledger (EACCES: permission denied (test)).",
        'Effect: chunks that need the model go unsummarized, so in time its context fills and its turns fail until compression catches up.',
        'Fix: fix what the cause names; compression then resumes by itself.',
      ].join('\n');
      store.getStateJson = (id: string) => {
        if (ledger.has(id)) throw cause;
        return read(id);
      };
      for (let tick = 1; tick <= 2; tick++) {
        await assert.rejects(manager.tick(), (error: Error) => {
          assert.equal(error.name, 'CompressionQuarantineUnreadableError');
          assert.equal(error.message, message);
          assert.equal(error.cause, cause, "the store's own error is its cause");
          return true;
        });
      }
      assert.equal(calls.length, 0, 'no attempt reached the model');
      assert.equal(strategy.getStats().l1, 0, 'nothing was summarized');
      const debt = strategy.getCompressionDebt();
      assert.equal(debt.failure, 'quarantine-ledger');
      assert.equal(debt.error, message, 'the report and the attempt say the same');
      assert.equal(internals.compressionPause, null, 'a failed read pauses nothing, so the next tick after it reads compresses');

      store.getStateJson = read;
      await manager.tick();
      assert.ok(calls.length > 0, 'once the ledger reads, the next tick calls the model');
      assert.ok(strategy.getStats().l1 > 0, 'and summarizes');
      assert.equal(strategy.getCompressionDebt().failure, undefined);
    } finally {
      manager.close();
    }
  });
});
