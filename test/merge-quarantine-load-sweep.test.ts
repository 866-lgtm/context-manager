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

/** Stores `records` as the merge quarantine, reopens with console.warn captured, and returns the reopened manager and what was warned. */
async function reopenHolding(records: unknown[]): Promise<{ manager: ContextManager; warned: string[] }> {
  const first = await open();
  first.addMessage('User', [{ type: 'text', text: 'hello' }]);
  const strategy = (first as unknown as { strategy: { store: { setStateJson(id: string, v: unknown): void }; mergeQuarantineStateId: string } }).strategy;
  strategy.store.setStateJson(strategy.mergeQuarantineStateId, records);
  first.close();
  return openWarned();
}

const ONE_LEFT_OUT = /^\[merge-quarantine\] on branch 'main', default\/autobio:merge-quarantine holds 1 record whose key isn't a string or whose sourceIds isn't a non-empty list of ids, so the merge quarantine leaves it out: its group is no longer held out of merges or counted by the merge-quarantine alarm or getCompressionDebt\(\), and the next write of the quarantine erases it/;

test('a record whose sourceIds is an empty list is left out at load and named, so it no longer stands for good as a refused crossed merge', async () => {
  const { manager, warned } = await reopenHolding([
    { key: 'empty', level: 2, sourceIds: [], attempts: 0, quarantinedAt: 1, lastOutcome: 'topology_violation', lastErrorType: '0 source(s); a merge needs at least two' },
  ]);
  try {
    const named = warned.filter((line) => line.includes('[merge-quarantine]') && line.includes('non-empty list of ids'));
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], ONE_LEFT_OUT);
    const strategy = (manager as unknown as { strategy: AutobiographicalStrategy }).strategy;
    assert.equal(strategy.getMergeQuarantineStatus().count, 0);
    const debt = strategy.getCompressionDebt();
    assert.equal(debt.topologyRefusals, 0);
    assert.notEqual(debt.state, 'critical');
  } finally {
    manager.close();
  }
});

test('a record whose sourceIds holds ids that aren\'t strings is left out at load and named, not swept as paid off', async () => {
  const { manager, warned } = await reopenHolding([
    { key: 'not-strings', level: 2, sourceIds: [7, 8], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
  ]);
  try {
    const named = warned.filter((line) => line.includes('[merge-quarantine]') && line.includes('non-empty list of ids'));
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], ONE_LEFT_OUT);
    assert.ok(!warned.some((line) => line.includes('[merge-quarantine] swept')), `no sweep line: ${JSON.stringify(warned)}`);
    assert.equal((manager as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus().count, 0);
  } finally {
    manager.close();
  }
});

test('records whose key isn\'t a string or whose sourceIds isn\'t a list are left out at load, and one line names the state and how many', async () => {
  const first = await open();
  first.addMessage('User', [{ type: 'text', text: 'hello' }]);
  const strategy = (first as unknown as { strategy: { store: { setStateJson(id: string, v: unknown): void }; mergeQuarantineStateId: string } }).strategy;
  strategy.store.setStateJson(strategy.mergeQuarantineStateId, [
    { key: 7, level: 2, sourceIds: ['L1-x', 'L1-y'], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
    { key: 'no-list', level: 2, sourceIds: 'L1-x', attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
    null,
    // Well formed, so it loads, and its sources are gone, so the load's sweep removes it with a line of its own.
    { key: 'stale', level: 2, sourceIds: ['L1-gone-1', 'L1-gone-2'], attempts: 5, quarantinedAt: 1, lastOutcome: 'refusal' },
  ]);
  first.close();

  const { manager, warned } = await openWarned();
  try {
    const named = warned.filter((line) => line.includes('[merge-quarantine]') && line.includes('non-empty list of ids'));
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], /^\[merge-quarantine\] on branch 'main', default\/autobio:merge-quarantine holds 3 records whose key isn't a string or whose sourceIds isn't a non-empty list of ids, so the merge quarantine leaves them out: their groups are no longer held out of merges or counted by the merge-quarantine alarm or getCompressionDebt\(\), and the next write of the quarantine erases them/);
    assert.ok(warned.some((line) => line.includes('[merge-quarantine] swept 1')), 'the well-formed stale record is the sweep\'s, not this line\'s');
  } finally {
    manager.close();
  }
});

test('a stored merge quarantine that holds no list is named at load, and none stored or an empty list is not', async () => {
  const { manager: fresh, warned: none } = await openWarned(join(dir, 'fresh'));
  try {
    assert.deepEqual(none.filter((line) => line.includes('[merge-quarantine]')), [], 'a store with no merge quarantine names nothing');
  } finally {
    fresh.close();
  }

  const first = await open();
  const strategy = (first as unknown as { strategy: { store: { setStateJson(id: string, v: unknown): void }; mergeQuarantineStateId: string } }).strategy;
  strategy.store.setStateJson(strategy.mergeQuarantineStateId, { records: [] });
  first.close();
  const { manager: second, warned } = await openWarned();
  try {
    const named = warned.filter((line) => line.includes('[merge-quarantine]') && line.includes('holds no list'));
    assert.equal(named.length, 1, `one line: ${JSON.stringify(warned)}`);
    assert.match(named[0], /^\[merge-quarantine\] on branch 'main', default\/autobio:merge-quarantine holds no list, so the merge quarantine reads no record from it and has lost whatever it held; the next write of the quarantine replaces it/);
    assert.equal((second as unknown as { strategy: AutobiographicalStrategy }).strategy.getMergeQuarantineStatus().count, 0);
    const again = (second as unknown as { strategy: { store: { setStateJson(id: string, v: unknown): void }; mergeQuarantineStateId: string } }).strategy;
    again.store.setStateJson(again.mergeQuarantineStateId, []);
  } finally {
    second.close();
  }
  const { manager: third, warned: quiet } = await openWarned();
  try {
    assert.deepEqual(quiet.filter((line) => line.includes('non-empty list of ids') || line.includes('holds no list')), [], 'an empty list names nothing');
  } finally {
    third.close();
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
