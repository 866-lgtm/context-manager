/**
 * A stale merge-quarantine record (its sources merged or repaired while the
 * store was closed) holds nothing, but `getCompressionDebt()` still lists its
 * key. It must be swept when the store loads, not only when the alarm next
 * fires; with `quarantineAlarmIntervalMs: 0` the alarm never fires at all
 * (#117 review).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'mq-load-sweep-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const membrane = { complete: async () => ({ stopReason: 'end_turn', content: [{ type: 'text', text: 'summary' }], usage: { inputTokens: 10, outputTokens: 5 } }) };
const open = (path = join(dir, 'store')) => ContextManager.open({
  path,
  strategy: new AutobiographicalStrategy({ compressionModel: 'm', hierarchical: true, autoTickOnNewMessage: false, quarantineAlarmIntervalMs: 0 }),
  membrane: membrane as never,
});

/** Opens the store with console.warn captured, returning what was warned. */
async function openWarned(path?: string): Promise<{ manager: ContextManager; warned: string[] }> {
  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
  try {
    return { manager: await open(path), warned };
  } finally {
    console.warn = warn;
  }
}

type Internals = { store: { setStateJson(id: string, v: unknown): void; getStateJson(id: string): unknown }; mergeQuarantineStateId: string };
const internals = (manager: ContextManager): Internals => (manager as unknown as { strategy: Internals }).strategy;
const stored = (manager: ContextManager): unknown => internals(manager).store.getStateJson(internals(manager).mergeQuarantineStateId);
const unreadable = (warned: string[]): string[] => warned.filter((line) => line.includes('[merge-quarantine]') && line.includes("can't read"));

/** Stores `value` as the merge quarantine, reopens with console.warn captured, and returns the reopened manager and what was warned. */
async function reopenHolding(value: unknown): Promise<{ manager: ContextManager; warned: string[] }> {
  const first = await open();
  first.addMessage('User', [{ type: 'text', text: 'hello' }]);
  internals(first).store.setStateJson(internals(first).mergeQuarantineStateId, value);
  first.close();
  return openWarned();
}

const ONE_LEFT_OUT = /^\[merge-quarantine\] on branch 'main', default\/autobio:merge-quarantine holds 1 entry the load can't read as a record \(it needs a string key and a non-empty sourceIds list of non-empty string ids\), so the load leaves it out and writes the quarantine back without it: whatever group it held is no longer held out of merges or counted by the merge-quarantine alarm or getCompressionDebt\(\)/;
const NO_LIST = /^\[merge-quarantine\] on branch 'main', default\/autobio:merge-quarantine holds no list, so the load reads no record from it and writes an empty list in its place: whatever it held is lost/;

test('a record whose sourceIds is an empty list is left out at load, named and written back without, so it no longer stands for good as a refused crossed merge', async () => {
  const { manager, warned } = await reopenHolding([
    { key: 'empty', level: 2, sourceIds: [], attempts: 0, quarantinedAt: 1, lastOutcome: 'topology_violation', lastErrorType: '0 source(s); a merge needs at least two' },
  ]);
  try {
    const named = unreadable(warned);
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], ONE_LEFT_OUT);
    assert.match(named[0], / ns=default$/, 'through the strategy\'s diagnostics, which end the line with its namespace');
    const strategy = (manager as unknown as { strategy: AutobiographicalStrategy }).strategy;
    assert.equal(strategy.getMergeQuarantineStatus().count, 0);
    const debt = strategy.getCompressionDebt();
    assert.equal(debt.topologyRefusals, 0);
    assert.notEqual(debt.state, 'critical');
    assert.deepEqual(stored(manager), [], 'the load wrote the quarantine back without it');
  } finally {
    manager.close();
  }
});

test('a record whose sourceIds holds ids that aren\'t strings is left out at load and named, not swept as paid off', async () => {
  const { manager, warned } = await reopenHolding([
    { key: 'not-strings', level: 2, sourceIds: [7, 8], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
  ]);
  try {
    const named = unreadable(warned);
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], ONE_LEFT_OUT);
    assert.ok(!warned.some((line) => line.includes('[merge-quarantine] swept')), `no sweep line: ${JSON.stringify(warned)}`);
    assert.equal((manager as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus().count, 0);
    assert.deepEqual(stored(manager), []);
  } finally {
    manager.close();
  }
});

test('entries the load can\'t read as records are left out, one line names the state and how many, the quarantine is written back without them, and the next load names nothing', async () => {
  const { manager, warned } = await reopenHolding([
    { key: 7, level: 2, sourceIds: ['L1-x', 'L1-y'], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
    { key: 'no-list', level: 2, sourceIds: 'L1-x', attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
    { key: 'empty-id', level: 2, sourceIds: ['L1-x', ''], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
    null,
    // Well formed, so it loads, and its sources are gone, so the load's sweep removes it with a line of its own.
    { key: 'stale', level: 2, sourceIds: ['L1-gone-1', 'L1-gone-2'], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
  ]);
  try {
    const named = unreadable(warned);
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], /^\[merge-quarantine\] on branch 'main', default\/autobio:merge-quarantine holds 4 entries the load can't read as records \(each needs a string key and a non-empty sourceIds list of non-empty string ids\), so the load leaves them out and writes the quarantine back without them: whatever groups they held are no longer held out of merges or counted by the merge-quarantine alarm or getCompressionDebt\(\)/);
    assert.ok(warned.some((line) => line.includes('[merge-quarantine] swept 1')), 'the well-formed stale record is the sweep\'s, not this line\'s');
    assert.deepEqual(stored(manager), [], 'written back without the four, and swept of the stale one');
  } finally {
    manager.close();
  }
  const { manager: again, warned: quiet } = await openWarned();
  try {
    assert.deepEqual(quiet.filter((line) => line.includes('[merge-quarantine]')), [], 'nothing left to name');
  } finally {
    again.close();
  }
});

test('a stored merge quarantine that holds no list is named at load and replaced with an empty list, and none stored or an empty list is not named', async () => {
  const { manager: fresh, warned: none } = await openWarned(join(dir, 'fresh'));
  try {
    assert.deepEqual(none.filter((line) => line.includes('[merge-quarantine]')), [], 'a store with no merge quarantine names nothing');
  } finally {
    fresh.close();
  }
  for (const value of [{ records: [] }, false]) {
    const { manager, warned } = await reopenHolding(value);
    try {
      const named = warned.filter((line) => line.includes('[merge-quarantine]') && line.includes('holds no list'));
      assert.equal(named.length, 1, `one line for ${JSON.stringify(value)}: ${JSON.stringify(warned)}`);
      assert.match(named[0], NO_LIST);
      assert.equal((manager as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus().count, 0);
      assert.deepEqual(stored(manager), [], 'an empty list in its place');
    } finally {
      manager.close();
    }
  }
  const { manager: third, warned: quiet } = await openWarned();
  try {
    assert.deepEqual(quiet.filter((line) => line.includes("can't read") || line.includes('holds no list')), [], 'an empty list names nothing');
  } finally {
    third.close();
  }
});

test('a take-up of another instance\'s writes leaves out what it can\'t read, names it, and writes the quarantine back without it', async () => {
  const manager = await open();
  try {
    manager.addMessage('User', [{ type: 'text', text: 'hello' }]);
    // As another instance sharing the store might leave it.
    internals(manager).store.setStateJson(internals(manager).mergeQuarantineStateId, [
      { key: 'empty', level: 2, sourceIds: [], attempts: 0, quarantinedAt: 1, lastOutcome: 'topology_violation' },
    ]);
    const warned: string[] = [];
    const warn = console.warn;
    console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
    try {
      (manager as unknown as { strategy: { takeUpStoreState(): void } }).strategy.takeUpStoreState();
    } finally {
      console.warn = warn;
    }
    const named = unreadable(warned);
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], ONE_LEFT_OUT);
    assert.equal((manager as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus().count, 0);
    assert.deepEqual(stored(manager), []);
  } finally {
    manager.close();
  }
});

test('a stale merge-quarantine record is swept at load', async () => {
  const first = await open();
  first.addMessage('User', [{ type: 'text', text: 'hello' }]);
  const strategy = (first as unknown as { strategy: { store: { setStateJson(id: string, v: unknown): void }; mergeQuarantineStateId: string } }).strategy;
  // Sources that no longer exist: the record is orphaned (paid off by a repair).
  strategy.store.setStateJson(strategy.mergeQuarantineStateId, [
    { key: 'stale', level: 2, sourceIds: ['L1-gone-1', 'L1-gone-2'], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
  ]);
  first.close();

  const reopened = await open();
  const status = (reopened as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus();
  assert.equal(status.count, 0, 'swept on load, without any tick or alarm');
  reopened.close();
});
