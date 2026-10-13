/**
 * Tests for AutobiographicalStrategy persistence + branch fork.
 *
 * Strategy state (summaries, summaryIdCounter, mergeQueue) was previously
 * in-memory only — first process restart wiped the entire L1/L2/L3 pyramid.
 * Forking the underlying chronicle branch silently shared state across
 * branches because nothing was actually branch-scoped.
 *
 * These tests cover:
 *  1. restart-and-resume: state survives close/reopen of the same path.
 *  2. branch fork: a forked branch has its own summary timeline.
 *  3. branch switch: switching back picks up the right branch's state.
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { rmSync, existsSync } from 'node:fs';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';
import type { ContentBlock } from '@animalabs/membrane';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';

const TEST_STORE_PATH = './test-strategy-persistence';

function cleanup(): void {
  if (existsSync(TEST_STORE_PATH)) {
    rmSync(TEST_STORE_PATH, { recursive: true, force: true });
  }
}

function textBlock(text: string): ContentBlock[] {
  return [{ type: 'text', text }];
}

/**
 * Test subclass that exposes the protected persistence helpers + lets the
 * test seed summaries through the same code path that production uses.
 */
class TestableStrategy extends AutobiographicalStrategy {
  seedL1(content: string, sourceIds: string[]): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L1-${this.nextSummaryIdCounter()}`,
      level: 1,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 0,
      sourceIds,
      sourceRange: {
        first: sourceIds[0] ?? '',
        last: sourceIds[sourceIds.length - 1] ?? '',
      },
      created: Date.now(),
    };
    this.pushSummary(entry);
    return entry;
  }

  seedL2(sourceL1Ids: string[], content = 'merged'): SummaryEntry {
    const entry: SummaryEntry = {
      id: `L2-${this.nextSummaryIdCounter()}`,
      level: 2,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: 1,
      sourceIds: sourceL1Ids,
      sourceRange: { first: 'a', last: 'z' },
      created: Date.now(),
    };
    this.pushSummary(entry);
    for (const id of sourceL1Ids) {
      const src = this.summaries.find(s => s.id === id);
      if (src) this.setMergedInto(src, entry.id);
    }
    return entry;
  }

  seedMerge(level: SummaryLevel, sourceIds: string[]): void {
    this.enqueueMerge({ level, sourceIds });
  }

  persistRawSummaries(entries: SummaryEntry[]): void {
    this.store?.setStateJson(this.summariesStateId, entries);
  }

  persistRawMergeQueue(items: unknown[]): void {
    this.store?.setStateJson(this.mergeQueueStateId, items);
  }

  readPersistedSummaries(): SummaryEntry[] {
    return (this.store?.getStateJson(this.summariesStateId) as SummaryEntry[] | null) ?? [];
  }

  // Read-only views for assertions
  getSummariesView(): SummaryEntry[] { return [...this.summaries]; }
  getCounter(): number { return this.summaryIdCounter; }
  getMergeQueueView(): Array<{ level: SummaryLevel; sourceIds: string[] }> {
    return [...this.mergeQueue];
  }
}

describe('AutobiographicalStrategy — persistence', () => {
  before(cleanup);
  after(cleanup);
  beforeEach(cleanup);

  it('restores summaries, counter, and merge queue across close/reopen', async () => {
    // Phase 1: build state
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const m1 = manager.addMessage('User', textBlock('hello'));
      const m2 = manager.addMessage('Claude', textBlock('hi back'));

      strategy.seedL1('summary one', [m1]);
      strategy.seedL1('summary two', [m2]);
      strategy.seedMerge(2, ['L1-0', 'L1-1']);

      assert.equal(strategy.getSummariesView().length, 2);
      assert.equal(strategy.getCounter(), 2);
      assert.equal(strategy.getMergeQueueView().length, 1);

      manager.sync();
      manager.close();
    }

    // Phase 2: reopen, verify reload
    {
      const strategy2 = new TestableStrategy({ targetChunkTokens: 300 });
      const manager2 = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy: strategy2,
      });

      const summaries = strategy2.getSummariesView();
      assert.equal(summaries.length, 2, 'summaries should reload from chronicle');
      assert.equal(summaries[0].content, 'summary one');
      assert.equal(summaries[1].content, 'summary two');
      assert.equal(strategy2.getCounter(), 2, 'counter should reload');

      const queue = strategy2.getMergeQueueView();
      assert.equal(queue.length, 1, 'merge queue should reload');
      assert.equal(queue[0].level, 2);
      assert.deepEqual(queue[0].sourceIds, ['L1-0', 'L1-1']);

      manager2.close();
    }
  });

  it('persists mergedInto edits so merged sources stay merged after restart', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const a = strategy.seedL1('a', ['m1']);
      const b = strategy.seedL1('b', ['m2']);
      const merged = strategy.seedL2([a.id, b.id], 'merged a+b');

      const summaries = strategy.getSummariesView();
      assert.ok(summaries[0].mergedInto === merged.id);
      assert.ok(summaries[1].mergedInto === merged.id);

      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const summaries = strategy.getSummariesView();
      assert.equal(summaries.length, 3);
      assert.equal(summaries[0].mergedInto, 'L2-2', 'L1 mergedInto must persist');
      assert.equal(summaries[1].mergedInto, 'L2-2');
      assert.equal(summaries[2].mergedInto, undefined);

      manager.close();
    }
  });

  it('rejects empty summaries at the persistence boundary', async () => {
    const strategy = new TestableStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    assert.throws(
      () => strategy.seedL1('   ', ['m1']),
      /refusing to persist empty summary L1-0 at L1/,
    );
    assert.equal(strategy.getSummariesView().length, 0);

    manager.close();
  });

  it('removes empty legacy parents and clears their child pointers on load', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const a = strategy.seedL1('summary a', ['m1']);
      const b = strategy.seedL1('summary b', ['m2']);
      const parent = strategy.seedL2([a.id, b.id], 'valid before legacy corruption');
      const corrupted = strategy.getSummariesView().map((summary) =>
        summary.id === parent.id ? { ...summary, content: '', tokens: 0 } : summary,
      );
      strategy.persistRawSummaries(corrupted);
      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const summaries = strategy.getSummariesView();
      assert.equal(summaries.length, 2, 'empty parent should be removed');
      assert.ok(summaries.every(summary => summary.content.trim().length > 0));
      assert.ok(summaries.every(summary => summary.mergedInto === undefined));

      manager.close();
    }
  });

  it('drops summaries whose sourceIds are not a list of ids on load, and repairs what pointed at them', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const a = strategy.seedL1('summary a', ['m1']);
      const b = strategy.seedL1('summary b', ['m2']);
      const parent = strategy.seedL2([a.id, b.id], 'parent whose sources were lost');
      const kept = strategy.seedL1('summary c', ['m3']);
      const other = strategy.seedL2([kept.id], 'parent of c');
      const view = strategy.getSummariesView();
      const corrupted: SummaryEntry[] = [
        ...view.map((summary) =>
          summary.id === parent.id ? ({ ...summary, sourceIds: null } as unknown as SummaryEntry) : summary),
        // A superseded L1 with no sources, whose parent doesn't list it.
        { ...kept, id: 'L1-lost', content: 'superseded', sourceIds: null, mergedInto: other.id } as unknown as SummaryEntry,
        // Sources that aren't a list, or hold something other than ids.
        { ...kept, id: 'L1-string', content: 'string sources', sourceIds: 'm3' } as unknown as SummaryEntry,
        { ...kept, id: 'L1-mixed', content: 'mixed sources', sourceIds: ['m3', 7] } as unknown as SummaryEntry,
        { ...kept, id: 'L1-none', content: 'no sources', sourceIds: [] } as unknown as SummaryEntry,
      ];
      strategy.persistRawSummaries(corrupted);
      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const summaries = strategy.getSummariesView();
      assert.deepEqual(summaries.map((s) => s.id).sort(), ['L1-0', 'L1-1', 'L1-3', 'L2-4']);
      assert.ok(summaries.every((s) => Array.isArray(s.sourceIds) && s.sourceIds.length > 0));
      // The dropped parent's children are free to merge again; the kept parent's child stays merged.
      assert.equal(summaries.find((s) => s.id === 'L1-0')?.mergedInto, undefined);
      assert.equal(summaries.find((s) => s.id === 'L1-1')?.mergedInto, undefined);
      assert.equal(summaries.find((s) => s.id === 'L1-3')?.mergedInto, 'L2-4');
      assert.deepEqual(
        strategy.readPersistedSummaries().map((s) => s.id).sort(),
        ['L1-0', 'L1-1', 'L1-3', 'L2-4'],
        'the repair is persisted, so it does not run again on the next open',
      );
      manager.close();
    }
  });

  it('drops a merge queue item whose sourceIds are not a list on load', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const m1 = manager.addMessage('User', textBlock('hello'));
      const m2 = manager.addMessage('Claude', textBlock('hi back'));
      const a = strategy.seedL1('summary a', [m1]);
      const b = strategy.seedL1('summary b', [m2]);
      strategy.persistRawMergeQueue([{ level: 2, sourceIds: null }, { level: 2, sourceIds: [a.id, b.id] }]);
      manager.sync();
      manager.close();
    }

    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300 });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      assert.deepEqual(strategy.getMergeQueueView(), [{ level: 2, sourceIds: ['L1-0', 'L1-1'] }]);
      manager.close();
    }
  });

  for (const [label, options] of [
    ['hierarchical', {}],
    ['adaptive, default solver', { adaptiveResolution: true }],
    ['adaptive, kv-stable', { adaptiveResolution: true, foldingStrategy: 'kv-stable' }],
  ] as const) {
    it(`compiles a store that held an L1 with null sourceIds, after a reopen (${label})`, async () => {
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, ...options });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        const ids = ['one', 'two', 'three', 'four'].map((text, i) => manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', textBlock(text)));
        const good = strategy.seedL1('summary of one and two', ids.slice(0, 2));
        const parent = strategy.seedL2([good.id], 'parent of the good one');
        strategy.persistRawSummaries([
          ...strategy.getSummariesView(),
          // A superseded L1 that no chunk record points at, whose parent doesn't list it.
          { ...good, id: 'L1-lost', content: 'superseded', sourceIds: null, mergedInto: parent.id } as unknown as SummaryEntry,
        ]);
        manager.sync();
        manager.close();
      }

      const strategy = new TestableStrategy({ targetChunkTokens: 300, ...options });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        assert.ok(compiled.messages.length > 0);
        const dry = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun: true });
        assert.ok(dry.messages.length > 0);
        assert.ok(!strategy.getSummariesView().some((s) => s.id === 'L1-lost'), 'the record is dropped on load');
        assert.ok(!strategy.readPersistedSummaries().some((s) => s.id === 'L1-lost'), 'and the drop is persisted, with nothing else to repair');
      } finally {
        manager.close();
      }
    });
  }

  it('isolates summary state per chronicle branch (fork)', async () => {
    const strategy = new TestableStrategy({ targetChunkTokens: 300 });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
    });

    // Build pre-fork state, then fork at current head so the forked branch
    // inherits everything we've written so far.
    manager.addMessage('User', textBlock('m1'));
    manager.addMessage('Claude', textBlock('m2'));
    strategy.seedL1('common L1 (pre-fork)', ['m1', 'm2']);

    const mainBranchName = manager.currentBranch().name;

    const forkedName = await manager.fork('experimental');
    assert.equal(forkedName, 'experimental');
    assert.notEqual(forkedName, mainBranchName);

    // On the forked branch, add a divergent summary
    const strategyAfterFork = manager.getStrategy() as TestableStrategy;
    assert.equal(
      strategyAfterFork.getSummariesView().length,
      1,
      'forked branch should start with the pre-fork summary',
    );
    strategyAfterFork.seedL1('divergent on fork', ['x', 'y']);
    assert.equal(strategyAfterFork.getSummariesView().length, 2);

    // Switch back to main: should see only the pre-fork summary
    await manager.switchBranch(mainBranchName);
    const mainStrategy = manager.getStrategy() as TestableStrategy;
    const mainSummaries = mainStrategy.getSummariesView();
    assert.equal(
      mainSummaries.length,
      1,
      'main branch must NOT see summaries created on fork',
    );
    assert.equal(mainSummaries[0].content, 'common L1 (pre-fork)');

    // Add a summary unique to main
    mainStrategy.seedL1('unique to main', ['p', 'q']);
    assert.equal(mainStrategy.getSummariesView().length, 2);

    // Switch back to fork: should still have its own divergent state
    await manager.switchBranch(forkedName);
    const forkStrategy = manager.getStrategy() as TestableStrategy;
    const forkSummaries = forkStrategy.getSummariesView();
    assert.equal(forkSummaries.length, 2, 'fork branch should still have 2 summaries');
    assert.equal(forkSummaries[1].content, 'divergent on fork');
    assert.ok(
      !forkSummaries.some(s => s.content === 'unique to main'),
      'fork must not see main-only summary',
    );

    manager.close();
  });

  it('keeps merge queue intact when executeMerge throws (no eager dequeue)', async () => {
    // Regression test for the eager-dequeue footgun: dequeueMerge() used to
    // run *before* the LLM call, so a transient failure (429, network drop,
    // timeout) would silently drop the merge from the persisted queue
    // forever. The fix is peek + shift-on-success — these assertions lock
    // that contract in.
    class FailingMergeStrategy extends TestableStrategy {
      executeMergeError = new Error('simulated LLM failure');

      protected override async executeMerge(
        _level: SummaryLevel,
        _sourceIds: string[],
        _ctx: import('../src/types/index.js').StrategyContext,
      ): Promise<void> {
        throw this.executeMergeError;
      }
    }

    const stubMembrane = {} as unknown as import('@animalabs/membrane').Membrane;

    // Phase 1: enqueue a merge, force tick to fail, verify queue intact
    {
      const strategy = new FailingMergeStrategy({
        targetChunkTokens: 300,
        hierarchical: true,
      });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
        membrane: stubMembrane,
      });

      const m1 = manager.addMessage('User', textBlock('source one'));
      const m2 = manager.addMessage('Claude', textBlock('source two'));
      strategy.seedL1('summary one', [m1]);
      strategy.seedL1('summary two', [m2]);
      strategy.seedMerge(2, ['L1-0', 'L1-1']);
      assert.equal(strategy.getMergeQueueView().length, 1, 'merge enqueued');

      // tick() will pick up the merge, invoke (our failing) executeMerge,
      // and surface the error. The queue must still be intact afterward.
      await assert.rejects(
        () => manager.tick(),
        /simulated LLM failure/,
        'tick should propagate the LLM failure',
      );

      const queue = strategy.getMergeQueueView();
      assert.equal(queue.length, 1, 'merge MUST remain in queue after failure');
      assert.equal(queue[0].level, 2);
      assert.deepEqual(queue[0].sourceIds, ['L1-0', 'L1-1']);

      manager.sync();
      manager.close();
    }

    // Phase 2: reopen the store; the un-merged entry must still be there.
    // This is the part that mattered most pre-fix — the failure was *durable*
    // because dequeueMerge persisted the shorter queue before the LLM call.
    {
      const strategy = new TestableStrategy({
        targetChunkTokens: 300,
        hierarchical: true,
      });
      const manager = await ContextManager.open({
        path: TEST_STORE_PATH,
        strategy,
      });

      const queue = strategy.getMergeQueueView();
      assert.equal(queue.length, 1, 'merge MUST survive close/reopen');
      assert.equal(queue[0].level, 2);
      assert.deepEqual(queue[0].sourceIds, ['L1-0', 'L1-1']);

      manager.close();
    }
  });
});
