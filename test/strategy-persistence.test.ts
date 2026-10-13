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
import type { ChunkRecord } from '../src/strategies/autobiographical.js';
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
    return this.seedParent(2, sourceL1Ids, content);
  }

  seedParent(level: SummaryLevel, sourceL1Ids: string[], content: string): SummaryEntry {
    const children = sourceL1Ids.map(id => this.summaries.find(summary => summary.id === id)!);
    const entry: SummaryEntry = {
      id: `L${level}-${this.nextSummaryIdCounter()}`,
      level,
      content,
      tokens: Math.ceil(content.length / 4),
      sourceLevel: level - 1,
      sourceIds: sourceL1Ids,
      sourceRange: { first: children[0]?.sourceRange.first ?? '', last: children.at(-1)?.sourceRange.last ?? '' },
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

  persistRawSummaries(entries: unknown[]): void {
    this.store?.setStateJson(this.summariesStateId, entries);
  }

  persistRawMergeQueue(items: unknown[]): void {
    this.store?.setStateJson(this.mergeQueueStateId, items);
  }

  readPersistedSummaries(): SummaryEntry[] {
    return (this.store?.getStateJson(this.summariesStateId) as SummaryEntry[] | null) ?? [];
  }

  persistRawChunks(records: ChunkRecord[]): void {
    this.store?.setStateJson(this.chunksStateId, records);
  }

  readPersistedChunks(): ChunkRecord[] {
    return (this.store?.getStateJson(this.chunksStateId) as ChunkRecord[] | null) ?? [];
  }

  readPersistedMergeQueue(): unknown[] {
    return (this.store?.getStateJson(this.mergeQueueStateId) as unknown[] | null) ?? [];
  }

  exactL1(ids: string[]): SummaryEntry | undefined {
    return (this as unknown as { findExactL1(key: string): SummaryEntry | undefined }).findExactL1(ids.join(':'));
  }

  reloadPersisted(): void { this.loadPersistedState(); }

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
      let parentId = '';
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, ...options });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        const ids = ['one', 'two', 'three', 'four'].map((text, i) => manager.addMessage(i % 2 === 0 ? 'User' : 'Claude', textBlock(text)));
        const good = strategy.seedL1('summary of one and two', ids.slice(0, 2));
        const parent = strategy.seedL2([good.id], 'parent of the good one');
        parentId = parent.id;
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
        assert.ok(strategy.getSummariesView().some(summary => summary.id === 'L1-0' && summary.content === 'summary of one and two'), 'the readable L1 survives');
        assert.ok(strategy.getSummariesView().some(summary => summary.id === parentId), 'so does its parent');
        const dry = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun: true });
        assert.ok(dry.messages.length > 0);
        for (const context of [compiled, dry]) {
          const texts = context.messages.flatMap(message => message.content).map(block => (block as { text?: string }).text);
          for (const text of ['one', 'two', 'three', 'four']) assert.equal(texts.filter(value => value === text).length, 1, JSON.stringify(texts));
          const parents = texts.filter(value => value === 'parent of the good one').length;
          // Adaptive resolution may render the parent's L1 in its place.
          if ('adaptiveResolution' in options) assert.ok(parents <= 1, JSON.stringify(texts));
          else assert.equal(parents, 1);
        }
        assert.ok(!strategy.getSummariesView().some((s) => s.id === 'L1-lost'), 'the record is dropped on load');
        assert.ok(!strategy.readPersistedSummaries().some((s) => s.id === 'L1-lost'), 'and the drop is persisted, with nothing else to repair');
      } finally {
        manager.close();
      }
    });
  }


  for (const [label, shape] of [
    ['null', null], ['missing', undefined], ['string', 'lost'], ['empty', []], ['mixed', ['lost', 7]],
  ] as const) {
    it('rebuilds an L1 with ' + label + ' sources from its compressed chunk record', async (t) => {
      const warnings: string[] = [];
      t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
      let sourceIds: string[] = [];
      let parentId = '';
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        sourceIds = ['chunk-first', 'chunk-last'].map(text => manager.addMessage('User', textBlock(text)));
        const l1 = strategy.seedL1('KEEP THIS CONTENT', sourceIds);
        const parent = strategy.seedL2([l1.id], 'its parent');
        parentId = parent.id;
        strategy.persistRawChunks([{ id: 'c-0', sourceIds, compressed: true, summaryId: l1.id }]);
        strategy.persistRawSummaries([{ ...l1, sourceIds: shape, sourceRange: { first: 'lost', last: 'lost' } }, parent]);
        manager.sync();
        manager.close();
      }
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const [l1, parent] = strategy.getSummariesView();
        assert.ok(l1, 'recoverable content survives');
        assert.equal(l1.content, 'KEEP THIS CONTENT');
        assert.deepEqual(l1.sourceIds, sourceIds);
        assert.deepEqual(l1.sourceRange, { first: sourceIds[0], last: sourceIds[1] });
        assert.equal(l1.level, 1);
        assert.equal(l1.mergedInto, parentId, 'the rebuilt L1 stays merged into its parent');
        assert.equal(parent?.id, parentId, 'and the parent is kept');
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        assert.ok(strategy.readPersistedChunks().some(record => record.summaryId === l1.id && record.compressed));
        assert.ok(warnings.some(line => /rebuilt/.test(line) && line.includes(l1.id)), warnings.join('\n'));
      } finally { manager.close(); }
    });
  }


  for (const invalid of ['uncompressed', 'non-id-chunk', 'non-L1'] as const) {
    it('drops unreadable provenance when its chunk link is ' + invalid, async (t) => {
      t.mock.method(console, 'warn', () => {});
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const id = manager.addMessage('User', textBlock('chunk message'));
        const l1 = strategy.seedL1('cannot safely rebuild', [id]);
        strategy.persistRawSummaries([{ ...l1, level: invalid === 'non-L1' ? 2 : 1, sourceIds: null }]);
        strategy.persistRawChunks([{
          id: 'c-0', sourceIds: invalid === 'non-id-chunk' ? [id, 7] as unknown as string[] : [id],
          compressed: invalid !== 'uncompressed', summaryId: l1.id,
        }]);
        // Exercise the loader before later chunk materialization can alter the record.
        strategy.reloadPersisted();
        assert.deepEqual(strategy.getSummariesView(), []);
        assert.deepEqual(strategy.readPersistedSummaries(), []);
      } finally { manager.close(); }
    });
  }

  it('dedupes before validating sources and borrows the donor range without losing merge state', async () => {
    let expectedIds: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      expectedIds = ['first', 'last'].map(text => manager.addMessage('User', textBlock(text)));
      const child = strategy.seedL1('PLAIN COPY', expectedIds);
      const plain = { ...child };
      const parent = strategy.seedL2([child.id], 'parent');
      const selected = { ...strategy.getSummariesView()[0], content: 'SELECTED MERGED COPY', sourceIds: null, sourceRange: { first: 'wrong', last: 'wrong' } };
      strategy.persistRawSummaries([plain, selected, { ...plain, content: '' }, { ...plain }, parent]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const summaries = strategy.getSummariesView();
      assert.equal(summaries.length, 2);
      const child = summaries.find(summary => summary.level === 1)!;
      assert.equal(child.content, 'SELECTED MERGED COPY');
      assert.equal(child.mergedInto, 'L2-1');
      assert.deepEqual(child.sourceIds, expectedIds);
      assert.deepEqual(child.sourceRange, { first: expectedIds[0], last: expectedIds[1] });
      assert.deepEqual(strategy.readPersistedSummaries(), summaries);
    } finally { manager.close(); }
  });

  it('resolves each parent pointer across copies: a kept parent on any copy wins over a dangling one, which is cleared once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    let childId = '';
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = ['PTR-A', 'PTR-B'].map((text) => manager.addMessage('User', textBlock(text)));
      const [child, other] = ids.map((id, i) => strategy.seedL1(['PTR-A', 'PTR-B'][i], [id]));
      const parent = strategy.seedL2([child.id], 'PTR-A');
      childId = child.id;
      parentId = parent.id;
      const plain = { ...strategy.getSummariesView()[0] };
      delete (plain as { mergedInto?: string }).mergedInto;
      strategy.persistRawSummaries([
        { ...plain, parentId: 'L2-gone', mergedInto: '' },
        { ...plain, content: '', parentId: parent.id, mergedInto: parent.id },
        { ...other, parentId: null, mergedInto: 'L9-gone' },
        parent,
      ]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const kept = new Map(strategy.getSummariesView().map((summary) => [summary.id, summary]));
        assert.equal(kept.get(childId)!.parentId, parentId, 'the kept parent on the empty copy wins over a dangling one');
        assert.equal(kept.get(childId)!.mergedInto, parentId, 'and over an empty-string one');
        const other = [...kept.values()].find((summary) => summary.content === 'PTR-B')!;
        assert.equal(other.mergedInto, undefined, 'a dangling pointer is cleared');
        assert.equal(other.parentId, null, 'a null pointer is no pointer, and is left as it is');
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        if (open === 0) assert.ok(warnings.some((line) => /cleared 1 dangling parent pointer/.test(line)), warnings.join('\n'));
        else assert.ok(!warnings.some((line) => line.includes('repaired summary state')), warnings.join('\n'));
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        const rendered = JSON.stringify(compiled.messages.map((message) => message.content));
        assert.equal(rendered.split('PTR-A').length - 1, 1, rendered);
      } finally { manager.close(); }
    }
  });

  it('a store whose only defect is a dangling parent pointer is repaired and persisted once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const id = manager.addMessage('User', textBlock('alone'));
      const l1 = strategy.seedL1('alone', [id]);
      strategy.persistRawSummaries([{ ...l1, mergedInto: 'L2-gone' }]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        assert.equal(strategy.readPersistedSummaries()[0]!.mergedInto, undefined);
        assert.equal(warnings.some((line) => line.includes('repaired summary state')), open === 0, warnings.join('\n'));
      } finally { manager.close(); }
    }
  });

  it('takes the sources and range of a summary above L1 together from a readable copy', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['up-a', 'up-b'].map((text) => manager.addMessage('User', textBlock(text)));
      const children = ids.map((id, i) => strategy.seedL1('child ' + i, [id]));
      const parent = strategy.seedL2(children.map((child) => child.id), 'parent text');
      parentId = parent.id;
      strategy.persistRawSummaries([
        ...strategy.getSummariesView().filter((summary) => summary.id !== parent.id),
        { ...parent, sourceIds: null, sourceRange: undefined },
        { ...parent, content: 'older parent text' },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const parent = strategy.getSummariesView().find((summary) => summary.id === parentId)!;
      assert.equal(parent.content, 'parent text');
      assert.deepEqual(parent.sourceIds, ['L1-0', 'L1-1']);
      assert.deepEqual(parent.sourceRange, { first: ids[0], last: ids[1] });
    } finally { manager.close(); }
  });

  it('keeps an L1 own sources over its chunk record, and rebuilds a range that is not their ends', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['own-a', 'own-b', 'own-c'].map((text) => manager.addMessage('User', textBlock(text)));
      const l1 = strategy.seedL1('own sources', ids.slice(0, 2));
      strategy.persistRawChunks([{ id: 'c-0', sourceIds: ids, compressed: true, summaryId: l1.id }]);
      strategy.persistRawSummaries([{ ...l1, sourceRange: { first: ids[0]!, last: ids[2]! } }]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const [l1] = strategy.getSummariesView();
      assert.deepEqual(l1.sourceIds, ids.slice(0, 2));
      assert.deepEqual(l1.sourceRange, { first: ids[0], last: ids[1] });
    } finally { manager.close(); }
  });

  it('keeps the parent pointer of an empty merged copy, so its plain copy renders only through its parent', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let childId = '';
    let parentId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const id = manager.addMessage('User', textBlock('DUP-A'));
      const child = strategy.seedL1('DUP-A', [id]);
      const plain = { ...child };
      const parent = strategy.seedL2([child.id], 'DUP-A');
      childId = child.id;
      parentId = parent.id;
      strategy.persistRawSummaries([plain, { ...child, content: '' }, parent]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const child = strategy.getSummariesView().find(summary => summary.id === childId)!;
      assert.equal(child.content, 'DUP-A');
      assert.equal(child.mergedInto, parentId);
      assert.ok(strategy.getSummariesView().some(summary => summary.id === parentId));
      assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
      for (const dryRun of [false, true]) {
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun });
        const rendered = JSON.stringify(compiled.messages.map(message => message.content));
        assert.equal(rendered.split('DUP-A').length - 1, 1, rendered);
      }
    } finally { manager.close(); }
  });

  it('derives an L1 range from its sources, and drops a summary above L1 whose range no copy can supply', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    let summaryIds: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['range-a', 'range-b', 'range-c'].map(text => manager.addMessage('User', textBlock(text)));
      const [a, b, c] = ids.map((id, i) => strategy.seedL1('summary ' + i, [id]));
      const parent = strategy.seedL2([c.id], 'parent without a range');
      summaryIds = [a.id, b.id, c.id, parent.id];
      strategy.persistRawSummaries([
        { ...a, sourceIds: null, sourceRange: { first: 'lost', last: 'lost' } },
        { ...a, sourceRange: undefined },
        { ...b, sourceRange: {} },
        c,
        { ...parent, sourceRange: undefined },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const [a, b, c, parentId] = summaryIds;
      const kept = new Map(strategy.getSummariesView().map(summary => [summary.id, summary]));
      assert.deepEqual([...kept.keys()], [a, b, c], 'the parent with no readable range is dropped');
      assert.deepEqual(kept.get(a)!.sourceIds, [ids[0]], 'sources from the copy that has them');
      assert.deepEqual(kept.get(a)!.sourceRange, { first: ids[0], last: ids[0] }, 'range from those sources');
      assert.deepEqual(kept.get(b)!.sourceRange, { first: ids[1], last: ids[1] });
      assert.equal(kept.get(c)!.mergedInto, undefined, `its child no longer points at ${parentId}`);
      assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
    } finally { manager.close(); }
  });

  it('takes an L1 sources from its compressed chunk record before a copy of the L1', async (t) => {
    t.mock.method(console, 'warn', () => {});
    let ids: string[] = [];
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      ids = ['record-first', 'record-last'].map(text => manager.addMessage('User', textBlock(text)));
      const l1 = strategy.seedL1('recorded summary', ids);
      strategy.persistRawChunks([{ id: 'c-0', sourceIds: ids, compressed: true, summaryId: l1.id }]);
      strategy.persistRawSummaries([{ ...l1, sourceIds: null }, { ...l1, sourceIds: [ids[1]] }]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const [l1] = strategy.getSummariesView();
      assert.deepEqual(l1.sourceIds, ids);
      assert.deepEqual(l1.sourceRange, { first: ids[0], last: ids[1] });
    } finally { manager.close(); }
  });

  it('drops a summary that names one an earlier open removed, with what is queued on it, once', async (t) => {
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    let survivorId = '';
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = ['GONE-A', 'GONE-B'].map(text => manager.addMessage('User', textBlock(text)));
      const [lost, survivor] = ids.map((id, i) => strategy.seedL1(['GONE-A', 'GONE-B'][i], [id]));
      const parent = strategy.seedL2([lost.id, survivor.id], 'GONE-A GONE-B');
      const grandparent = strategy.seedParent(3, [parent.id], 'GONE-A GONE-B');
      survivorId = survivor.id;
      // As an earlier version leaves a store after dropping an empty L1. The
      // survivor also carries the newer parent pointer, which readers take first.
      strategy.persistRawSummaries(strategy.getSummariesView()
        .filter(summary => summary.id !== lost.id)
        .map(summary => summary.id === survivor.id ? { ...summary, parentId: parent.id } : summary));
      // One merge names the grandparent, which only the cascade drops; the
      // other names the L1 that was already gone.
      strategy.persistRawMergeQueue([{ level: 4, sourceIds: [grandparent.id] }, { level: 2, sourceIds: [lost.id, survivor.id] }]);
      manager.sync();
      manager.close();
    }
    for (let open = 0; open < 2; open++) {
      warnings.length = 0;
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        assert.deepEqual(strategy.getSummariesView().map(summary => summary.id), [survivorId]);
        assert.equal(strategy.getSummariesView()[0].mergedInto, undefined);
        assert.equal(strategy.getSummariesView()[0].parentId, undefined);
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        assert.deepEqual(strategy.readPersistedMergeQueue(), []);
        if (open === 1) assert.ok(!warnings.some(line => line.includes('repaired summary state')), warnings.join('\n'));
        const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 });
        const rendered = JSON.stringify(compiled.messages.map(message => message.content));
        for (const marker of ['GONE-A', 'GONE-B']) assert.equal(rendered.split(marker).length - 1, 1, rendered);
      } finally { manager.close(); }
    }
  });

  for (const defect of ['null-parent', 'empty-parent', 'empty-child'] as const) {
    it('cascades ' + defect + ' drops upward, repairs descendants and renders each source once', async (t) => {
      const markers = ['CASCADE-A', 'CASCADE-B', 'CASCADE-C'];
      let childIds: string[] = [];
      let safeParentId = '';
      t.mock.method(console, 'warn', () => {});
      {
        const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
        const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
        const ids = markers.map(text => manager.addMessage('User', textBlock(text)));
        const children = ids.map((id, i) => strategy.seedL1(markers[i], [id]));
        childIds = children.map(child => child.id);
        const parent = strategy.seedL2(childIds.slice(0, 2), markers.slice(0, 2).join(' '));
        const safeParent = strategy.seedL2([childIds[2]], markers[2]);
        safeParentId = safeParent.id;
        const grandparent = strategy.seedParent(3, [parent.id, safeParent.id], markers.join(' '));
        strategy.seedParent(4, [grandparent.id], markers.join(' '));
        // Only the cascade drops the grandparent, in every case.
        strategy.persistRawMergeQueue([{ level: 4, sourceIds: [grandparent.id] }]);
        strategy.persistRawChunks(children.map((child, i) => ({ id: 'c-' + i, sourceIds: [ids[i]], compressed: true, summaryId: child.id })));
        const brokenId = defect === 'empty-child' ? childIds[0] : parent.id;
        const records = strategy.getSummariesView().map(summary => summary.id !== brokenId ? summary
          : defect === 'null-parent' ? { ...summary, sourceIds: null }
          : { ...summary, content: ' ', tokens: 0 });
        // Visit the ancestors before the initial defect, so a single pass is insufficient.
        strategy.persistRawSummaries(records.reverse());
        manager.sync();
        manager.close();
      }
      const strategy = new TestableStrategy({ targetChunkTokens: 300, recentWindowTokens: 1, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        const kept = [...(defect === 'empty-child' ? childIds.slice(1) : childIds), safeParentId];
        assert.deepEqual(strategy.getSummariesView().map(summary => summary.id).sort(), [...kept].sort());
        for (const summary of strategy.getSummariesView()) {
          assert.equal(summary.mergedInto, summary.id === childIds[2] ? safeParentId : undefined);
        }
        assert.deepEqual(strategy.readPersistedSummaries(), strategy.getSummariesView());
        assert.deepEqual(strategy.readPersistedMergeQueue(), [], 'the merge queued on a dropped ancestor is removed');
        if (defect === 'empty-child') {
          const reopened = strategy.readPersistedChunks().find(record => record.id === 'c-0')!;
          assert.equal(reopened.compressed, false);
          assert.equal(reopened.summaryId, undefined);
        }
        for (const dryRun of [false, true]) {
          const compiled = await manager.compile({ maxTokens: 100_000, reserveForResponse: 0 }, undefined, { dryRun });
          const rendered = JSON.stringify(compiled.messages.map(message => message.content));
          for (const marker of markers) assert.equal(rendered.split(marker).length - 1, 1, rendered);
        }
      } finally { manager.close(); }
    });
  }

  it('removes malformed queued merges and merges naming a dropped summary, even in auditOnly', async () => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      const ids = ['first', 'last'].map(text => manager.addMessage('User', textBlock(text)));
      const a = strategy.seedL1('a', [ids[0]]);
      const b = strategy.seedL1('b', [ids[1]]);
      strategy.persistRawSummaries([...strategy.getSummariesView(), { ...a, id: 'L2-dropped', level: 2, sourceLevel: 1, sourceIds: null }]);
      strategy.persistRawMergeQueue([
        null, 7, 'primitive', { level: 2, sourceIds: null }, { level: 2, sourceIds: 'string' },
        { level: 2, sourceIds: [] }, { level: 2, sourceIds: [a.id, 7] }, { level: 2, sourceIds: [a.id, ''] },
        { level: 3, sourceIds: ['L2-dropped'] }, { level: 2, sourceIds: [a.id, b.id] },
      ]);
      manager.sync();
      manager.close();
    }
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const expected = [{ level: 2, sourceIds: ['L1-0', 'L1-1'] }];
      assert.deepEqual(strategy.getMergeQueueView(), expected);
      assert.deepEqual(strategy.readPersistedMergeQueue(), expected);
    } finally { manager.close(); }
  });

  it('persists and logs a null-only summary repair once', async (t) => {
    {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      strategy.persistRawSummaries([null]);
      manager.sync();
      manager.close();
    }
    const warnings: string[] = [];
    t.mock.method(console, 'warn', (...args: unknown[]) => warnings.push(args.map(String).join(' ')));
    for (let open = 0; open < 2; open++) {
      const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
      const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
      try {
        assert.deepEqual(strategy.readPersistedSummaries(), []);
        if (open === 0) assert.ok(warnings.some(line => /(?:dropped|removed) 1/.test(line)), warnings.join('\n'));
        else assert.equal(warnings.length, 0, 'a canonical store needs no second repair');
      } finally { manager.close(); warnings.length = 0; }
    }
  });

  it('adopts a live-appended L1 only as the loader would keep it', async () => {
    const strategy = new TestableStrategy({ targetChunkTokens: 300, auditOnly: true });
    const manager = await ContextManager.open({ path: TEST_STORE_PATH, strategy });
    try {
      const id = manager.addMessage('User', textBlock('live message'));
      const base = { id: 'L1-live', level: 1, content: 'live', tokens: 1, sourceLevel: 0, sourceRange: { first: id, last: id }, created: 0 };
      strategy.persistRawSummaries([
        { ...base, id: 'L1-string', sourceIds: id },
        { ...base, id: 'L1-number', sourceIds: 1 },
        { ...base, id: 'L1-null', sourceIds: null },
        { ...base, id: 'L1-empty', sourceIds: [id], content: ' ' },
        { ...base, sourceIds: [id], sourceRange: undefined, mergedInto: 'L2-elsewhere' },
      ]);
      const found = strategy.exactL1([id]);
      assert.equal(found?.id, 'L1-live');
      assert.deepEqual(found?.sourceRange, { first: id, last: id }, 'its range is derived from its sources');
      assert.equal(found?.mergedInto, undefined, 'a parent this instance does not hold is not adopted');
      assert.ok(strategy.getSummariesView().includes(found!));
    } finally { manager.close(); }
  });

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
