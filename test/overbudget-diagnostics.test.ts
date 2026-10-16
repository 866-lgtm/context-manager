import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';
import { Picker, type PickerInputs } from '../src/adaptive/picker.js';
import type { FoldingBudget } from '../src/adaptive/folding-strategy.js';
import type { Membrane } from '@animalabs/membrane';

class DiagnosticStrategy extends AutobiographicalStrategy {
  level = 1;
  drift = false;
  /** When set, the plan says it's over the budget whatever it renders, as a planner that overestimates does. */
  overstate = false;
  useRealPicker = false;
  /** When set, the fixture solver asks for an L1 over the middle, as a plan with summaries still to produce does. */
  produce = false;
  /** Holds the drain at the speculative cap, as unmerged L1s past maxSpeculativeL1s do. */
  atCap = false;
  /** Blocks every queued merge, as a hold on a message its sources cover does. */
  holdBlocksMerges = false;
  /** When false, chunks keep no records, as a subclass with its own chunking does. */
  persistChunks = true;
  /** Each picker run's chunks, with the L1 each folds through. */
  pickerL1s: (string | undefined)[][] = [];

  protected get chunkPersistenceEnabled(): boolean {
    // Read during construction too, before the field is set.
    return this.persistChunks !== false;
  }

  protected isAtSpeculativeCap(): boolean {
    return this.atCap || super.isAtSpeculativeCap();
  }

  protected mergeBlockedByHold(sourceIds: string[], store: Parameters<AutobiographicalStrategy['mergeBlockedByHold']>[1]): boolean {
    return this.holdBlocksMerges || super.mergeBlockedByHold(sourceIds, store);
  }

  /** Marks a compression as running, as tick does while one is in flight. */
  startCompressing(): void {
    this.pendingCompression = Promise.resolve();
  }

  /** Queues a merge, as a merge produce op or the merge threshold does. */
  queueMerge(): void {
    this.enqueueMerge({ level: 2, sourceIds: ['L1-queued-a', 'L1-queued-b'] });
  }

  /** An L1 over the given messages, as a compression writes one. */
  seedL1(id: string, sourceIds: string[]): void {
    this.pushSummary({
      id, level: 1, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
      content: 'summary '.repeat(100), tokens: 200, created: 0,
    });
  }

  /** Queues a merge of real summaries. */
  queueMergeOf(sourceIds: string[]): void {
    this.enqueueMerge({ level: 2, sourceIds });
  }

  /** An L1 over the given messages that only the store holds, as another instance over the same store writes one. */
  seedStoredL1(id: string, sourceIds: string[]): void {
    const persisted = this.store?.getStateJson(this.summariesStateId);
    this.store?.setStateJson(this.summariesStateId, [...(Array.isArray(persisted) ? persisted : []), {
      id, level: 1, sourceLevel: 0, sourceIds,
      sourceRange: { first: sourceIds[0], last: sourceIds[sourceIds.length - 1] },
      content: 'summary '.repeat(100), tokens: 200, created: 0,
    }]);
  }

  /** The ids of the summaries in memory. */
  summaryIds(): string[] {
    return this.summaries.map((summary) => summary.id);
  }

  /** When set, the reserved tail's emission reports one message fewer, as an emission that ran out of room does. */
  dropTailMessage = false;

  /** When set, the compression preflight says no, as a host that schedules compression itself does. */
  preflightNo = false;

  protected shouldCompressPreflight(): boolean {
    return !this.preflightNo && super.shouldCompressPreflight();
  }

  /** The message ids of each queued chunk, in queue order. */
  queuedChunkIds(): string[][] {
    return this.compressionQueue.map((index) => this.chunks[index]!.messages.map((m) => m.id));
  }

  protected emitRecentNewestFirst(...args: Parameters<AutobiographicalStrategy['emitRecentNewestFirst']>): ReturnType<AutobiographicalStrategy['emitRecentNewestFirst']> {
    const stats = super.emitRecentNewestFirst(...args);
    return this.dropTailMessage ? { ...stats, messages: stats.messages - 1 } : stats;
  }

  seedPyramid(ids: string[], depth: number): void {
    for (let level = 1; level <= depth; level++) {
      const content = 'summary '.repeat(100);
      const summary: SummaryEntry = {
        id: `L${level}-diagnostic`,
        level: level as SummaryLevel,
        sourceLevel: (level - 1) as SummaryLevel,
        sourceIds: level === 1 ? ids : [`L${level - 1}-diagnostic`],
        sourceRange: { first: ids[0], last: ids[ids.length - 1] },
        content,
        tokens: 200,
        created: 0,
        ...(level < depth ? { mergedInto: `L${level + 1}-diagnostic` } : {}),
      };
      this.pushSummary(summary);
    }
  }

  protected buildPicker(inputs: PickerInputs): Picker {
    this.pickerL1s.push(inputs.chunks.map((chunk) => chunk.l1Id));
    if (this.useRealPicker) return super.buildPicker(inputs);
    const level = this.level;
    const produce = this.produce;
    class DriftPicker extends Picker {
      run(inputs: PickerInputs, budget: FoldingBudget) {
        const result = super.run(inputs, budget);
        return { ...result, finalTokens: 1, budgetMet: true };
      }
    }
    class OverstatePicker extends Picker {
      run(inputs: PickerInputs, budget: FoldingBudget) {
        const result = super.run(inputs, budget);
        return { ...result, finalTokens: 10_000, budgetMet: false };
      }
    }
    const Constructor = this.drift ? DriftPicker : this.overstate ? OverstatePicker : Picker;
    return new Constructor({
      name: 'diagnostic-fixture',
      solve: (inputs) => ({
        frontier: new Map(inputs.chunks.map(chunk => [chunk.id, chunk.pinned || !chunk.l1Id ? 0 : level])),
        produced: produce && inputs.chunks.length > 0
          ? [{ level: 1, range: { firstChunkId: inputs.chunks[0].id, lastChunkId: inputs.chunks[inputs.chunks.length - 1].id } }]
          : [],
      }),
    });
  }
}

/** A membrane whose every model call is counted and fails. */
function countingMembrane(calls: { n: number }): Membrane {
  return { complete: async () => { calls.n++; throw new Error('no model in this test'); } } as unknown as Membrane;
}

async function withManager(
  strategy: AutobiographicalStrategy,
  run: (manager: ContextManager) => Promise<void>,
  opts?: { membrane?: true | Membrane },
) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-budget-diagnostics-'));
  // A stub is enough for tick to adopt an exact L1, which calls no model.
  const membrane = opts?.membrane ? { membrane: opts.membrane === true ? ({} as unknown as Membrane) : opts.membrane } : {};
  const manager = await ContextManager.open({ path: join(directory, 'store'), strategy, ...membrane });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function refusal(manager: ContextManager, opts?: { dryRun?: boolean }): Promise<OverBudgetError> {
  try {
    await manager.compile({ maxTokens: 100, reserveForResponse: 20 }, undefined, opts);
    assert.fail('compile should refuse');
  } catch (error) {
    assert.ok(error instanceof OverBudgetError);
    return error;
  }
}

function checkBudget(error: OverBudgetError): void {
  // Runtime shape assertions also run against the old implementation.
  assert.equal(Reflect.get(error.diagnostics, 'configuredBudget'), 100);
  assert.equal(Reflect.get(error.diagnostics, 'reserveForResponse'), 20);
  assert.equal(Reflect.get(error.diagnostics, 'inputBudget'), 80);
  assert.equal(error.budget, 100, '25% grace applies to the 80-token input budget');
  assert.match(error.message, /configured=100, response reserve=20, input budget=80/);
}

describe('OverBudgetError diagnostics', () => {
  for (const adaptiveResolution of [true, false]) {
    it(`reports budget arithmetic and empty inventory for an early ${adaptiveResolution ? 'adaptive' : 'hierarchical'} refusal`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution,
        headWindowTokens: 10_000,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
        const error = await refusal(manager);
        checkBudget(error);
        assert.deepEqual(error.clearedBy, [], 'the head alone is over: only a larger budget clears it');
        assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 0);
        assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), {});
        assert.match(error.message, /summary inventory: empty/);
        if (adaptiveResolution) {
          assert.match(error.message, /^Head\/tail reservation exceeded budget/);
          assert.match(error.message, /fold plan=not computed/);
          assert.doesNotMatch(error.message, /deepest planned level/);
        } else {
          assert.match(error.message, /^Hierarchical emission overran the budget/);
          assert.match(error.message, /attempted representation level=L0/);
        }
      });
    });
  }

  it('counts pre-head middle messages in a refusal before planning after a head reset', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 100_000,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      strategy.resetHeadWindow(ids[4]);
      const error = await refusal(manager);
      assert.equal(error.diagnostics.middleChunkCount, 4, 'the four messages before the reset head are middle too');
      assert.deepEqual(error.clearedBy, [], 'the head alone is over');
      assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'unplanned');
      assert.match(error.message, /middle picker chunks=4/);
      assert.match(error.message, /fold plan=not computed/);
      assert.doesNotMatch(error.message, /deepest planned level/);
    });
  });

  for (const positionedRecallPairs of [true, false]) {
    it(`labels hierarchical ${positionedRecallPairs ? 'selection items' : 'raw-message fallback'} and attempted depth`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        positionedRecallPairs,
        targetChunkTokens: 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 2 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(positionedRecallPairs ? ids : ids.slice(1), 1);
        const error = await refusal(manager);
        assert.equal(error.diagnostics.middleChunkCount, 1);
        assert.deepEqual(error.clearedBy, [], 'no closed chunk waits for compression');
        assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'attempted');
        assert.equal(Reflect.get(error.diagnostics, 'middleCountUnit'), positionedRecallPairs ? 'selection-items' : 'raw-messages');
        assert.match(error.message, positionedRecallPairs
          ? /selected middle representations=1, attempted representation level=L1/
          : /middle raw messages=1, attempted representation level=L0/);
        assert.doesNotMatch(error.message, /deepest planned level|picker chunks/);
      });
    });
  }

  for (const level of [1, 5]) {
    it(`distinguishes planned L${level} from available L5 and picker chunks from summaries`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.level = level;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 12 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(ids, 5);
        // A locked planned representation still counts toward the plan's depth.
        for (const id of ids) strategy.lockChunk(id);
        const error = await refusal(manager);
        checkBudget(error);
        assert.equal(error.diagnostics.deepestLevel, level);
        assert.deepEqual(error.clearedBy, [], 'the plan has no summaries left to produce');
        assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 5);
        assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
        assert.equal(error.diagnostics.middleChunkCount, 12);
        assert.equal(Reflect.get(error.diagnostics, 'middleCountUnit'), 'picker-chunks');
        assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'planned');
        assert.match(error.message, /middle picker chunks=12/);
        assert.match(error.message, new RegExp(`deepest planned level=L${level}, deepest available level=L5`));
        assert.match(error.message, /summary inventory: L1=1 L2=1 L3=1 L4=1 L5=1/);
      });
    });
  }

  it('enriches emission-stage failures as well as picker-stage failures', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.level = 5;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'raw '.repeat(200) }]);
      const id = manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      strategy.seedPyramid([id], 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Emission overran the plan/);
      checkBudget(error);
      assert.deepEqual(error.clearedBy, [], 'the plan has no summaries left to produce');
      assert.equal(error.diagnostics.deepestLevel, 5, 'the first raw emission fails, but the complete plan reaches L5');
      assert.equal(Reflect.get(error.diagnostics, 'deepestLevelKind'), 'planned');
      assert.match(error.message, /deepest planned level=L5/);
      assert.doesNotMatch(error.message, /attempted representation level/);
      assert.equal(Reflect.get(error.diagnostics, 'deepestAvailableLevel'), 5);
      assert.deepEqual(Reflect.get(error.diagnostics, 'summaryCountsByLevel'), { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1 });
    });
  });

  it('logs both depths when the real kv-stable solver escalates', async (t) => {
    const logs: string[] = [];
    t.mock.method(console, 'error', (...args: unknown[]) => logs.push(args.map(String).join(' ')));
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      foldingStrategy: 'kv-stable',
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.useRealPicker = true;
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, () =>
        manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]));
      strategy.seedPyramid(ids, 5);
      const error = await refusal(manager);
      const escalation = logs.find(line => line.startsWith('[kv-escalation]'));
      assert.ok(escalation, 'fixture must exercise an actual solver override');
      assert.deepEqual(error.clearedBy, [], 'no closed chunk waits for compression');
      assert.match(escalation, new RegExp(`deepestPlannedLevel=L${error.diagnostics.deepestLevel}`));
      assert.match(escalation, /deepestAvailableLevel=L5/);
    });
  });

  it('keeps the original external constructor shape usable without inventing inventory', () => {
    const diagnostics = { headTokens: 1, tailTokens: 2, middleTokens: 3, middleChunkCount: 4, deepestLevel: 0 };
    const error = new OverBudgetError({ actual: 6, budget: 5, diagnostics });
    assert.strictEqual(error.diagnostics, diagnostics);
    assert.equal(error.name, 'OverBudgetError');
    assert.match(error.message, /across 4 chunks/);
    assert.match(error.message, /deepest fold level=L0/);
    assert.doesNotMatch(error.message, /planned|attempted|picker chunks/);
    assert.doesNotMatch(error.message, /available|inventory|configured|undefined/);
  });
});

describe('OverBudgetError.clearedBy', () => {
  it('is empty and frozen when the thrower names nothing', () => {
    const error = new OverBudgetError({
      budget: 10,
      actual: 20,
      diagnostics: { headTokens: 0, tailTokens: 20, middleTokens: 0, middleChunkCount: 0, deepestLevel: 0 },
    });
    assert.deepEqual(error.clearedBy, []);
    assert.ok(Object.isFrozen(error.clearedBy));
  });

  const recentOnly = (recentWindowTokens: number) => new AutobiographicalStrategy({
    adaptiveResolution: true,
    headWindowTokens: 0,
    recentWindowTokens,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
  });

  it('names a smaller recent window when the raw recent window is what is over and the newest message fits', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  it('names a smaller window when a message split into shards is over but its newest shard fits, since its earlier shards can fold', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 20,
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      // Over twice targetChunkTokens, so ingress splits it into shards of about 20 tokens.
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      const shards = manager.getAllMessages();
      assert.ok(shards.length > 4, `the message is stored as shards (got ${shards.length})`);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.ok(error.diagnostics.tailTokens > error.budget, 'the whole body is over the budget');
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  const toolTurn = (manager: ContextManager, id: string, callWords: number, resultWords: number): void => {
    manager.addMessage('agent', [
      { type: 'text', text: 'calling ' + 'word '.repeat(callWords) },
      { type: 'tool_use', id, name: 'read', input: {} },
    ]);
    manager.addMessage('user', [{ type: 'tool_result', toolUseId: id, content: 'result ' + 'word '.repeat(resultWords) }]);
  };

  it('counts a newest tool_result with the tool_use before it, since no window splits the pair', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      // The result alone fits the budget, but its call and it together don't.
      toolTurn(manager, 't1', 150, 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, [], 'the newest turn the compile must keep raw is the call and its result');
    });
  });

  it('names a smaller window when the newest tool_result and its call fit together', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 4; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      toolTurn(manager, 't1', 10, 5);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  for (const [callWords, expected] of [[200, []], [30, ['smaller-recent-window']]] as const) {
    it(`counts a call split into shards from its first shard, which holds the tool_use, before the newest tool_result (${expected.length ? 'names a smaller window when the whole call and its result fit' : 'names nothing when only its last shard and the result would'})`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true,
        targetChunkTokens: 10,
        headWindowTokens: 0,
        recentWindowTokens: 100_000,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const before = manager.getAllMessages().length;
        // Over twice targetChunkTokens, so ingress splits the call into shards.
        toolTurn(manager, 't1', callWords, 5);
        const stored = manager.getAllMessages();
        const shards = stored.slice(before, -1);
        assert.ok(shards.length > 1, `the call is stored as shards (got ${shards.length})`);
        assert.ok(shards[0]!.content.some((block) => block.type === 'tool_use'), 'its first shard holds the tool_use');
        assert.ok(!shards.at(-1)!.content.some((block) => block.type === 'tool_use'), 'its last shard holds none');
        const error = await refusal(manager);
        assert.match(error.message, /^Head\/tail reservation exceeded budget/);
        assert.deepEqual(error.clearedBy, expected);
      });
    });
  }

  for (const [resultWords, callWords, expected, when] of [
    [200, 0, [], 'names nothing when only its last shard would fit'],
    [30, 0, ['smaller-recent-window'], 'names a smaller window when they fit'],
    [30, 60, [], 'names nothing when its body alone would fit but not with its call'],
  ] as const) {
    it(`counts a result split into shards with its whole body and its call, since its first shard holds the tool_result (${when})`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true,
        targetChunkTokens: 10,
        headWindowTokens: 0,
        recentWindowTokens: 100_000,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 4; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const beforeCall = manager.getAllMessages().length;
        manager.addMessage('agent', [{ type: 'text', text: 'calling ' + 'word '.repeat(callWords) }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
        const before = manager.getAllMessages().length;
        if (callWords > 0) assert.ok(before - beforeCall > 1, 'the call is stored as shards too');
        // Over twice targetChunkTokens, so ingress splits the result into shards.
        manager.addMessage('user', [
          { type: 'tool_result', toolUseId: 't1', content: 'ok' },
          { type: 'text', text: 'result ' + 'word '.repeat(resultWords) },
        ]);
        const shards = manager.getAllMessages().slice(before);
        assert.ok(shards.length > 1, `the result is stored as shards (got ${shards.length})`);
        assert.ok(shards[0]!.content.some((block) => block.type === 'tool_result'), 'its first shard holds the tool_result');
        assert.ok(!shards.at(-1)!.content.some((block) => block.type === 'tool_result'), 'its last shard holds none');
        const error = await refusal(manager);
        assert.match(error.message, /^Head\/tail reservation exceeded budget/);
        assert.deepEqual(error.clearedBy, expected);
      });
    });
  }

  it('clears the head/tail refusal at the smaller window it names (the next refusal can be the picker\'s)', async () => {
    const strategy = recentOnly(100_000);
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const first = await refusal(manager);
      assert.deepEqual(first.clearedBy, ['smaller-recent-window']);
      // The newest turn is the newest message: a window that holds only it.
      strategy.updateHotContextSettings({ tailTokens: 1 });
      const next = await refusal(manager);
      assert.doesNotMatch(next.message, /^Head\/tail reservation exceeded budget/, 'the raw windows now fit');
      assert.match(next.message, /^Adaptive picker exhausted/, 'the next refusal is the picker\'s, with no summaries to fold through');
    });
  });

  it('names nothing when a hold inside the head leaves every window\'s tail at the head\'s end', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 30,
      recentWindowTokens: 100_000,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 6 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(20) }]));
      const unheld = await refusal(manager);
      assert.deepEqual(unheld.clearedBy, ['smaller-recent-window'], 'the head and the newest message fit');
      manager.holdCompression([ids[0]], { timeoutMs: 60_000 });
      const held = await refusal(manager);
      assert.match(held.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(held.clearedBy, [], 'no window starts after the hold, so every tail starts at the head\'s end');
      manager.releaseCompression([ids[0]]);
    });
  });

  it('names nothing when the newest message alone is over, since it stays raw whatever the window', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(10) }]);
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, []);
    });
  });

  it('names nothing when a hold inside the window would stop a smaller one short of fitting', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      const ids = Array.from({ length: 6 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      manager.holdCompression([ids[3]], { timeoutMs: 60_000 });
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, [], 'no window starts after the hold, and messages 3 to 5 are over the budget');
      manager.releaseCompression([ids[3]]);
    });
  });

  it('names nothing when a compression hold is what keeps the recent window this large', async () => {
    await withManager(recentOnly(60), async (manager) => {
      const ids = Array.from({ length: 6 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      manager.holdCompression([ids[0]], { timeoutMs: 60_000 });
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, []);
      manager.releaseCompression([ids[0]]);
    });
  });

  it('prices the newest turn as the cap prices it, and names a smaller window when the head and that turn just fit', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 100_000,
      maxMessageTokens: 50,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      // Each message is over the cap, so each costs exactly 50 + 50 tokens:
      // the newest alone is the whole 100-token budget, and six are over it.
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(200) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.equal(error.budget, 100);
      assert.equal(error.diagnostics.tailTokens, 600);
      assert.deepEqual(error.clearedBy, ['smaller-recent-window']);
    });
  });

  for (const [closed, produce, expected] of [
    [true, true, ['compression']],
    [false, true, []],
    [true, false, []],
  ] as const) {
    it(`names compression for the picker only when its plan has summaries to produce and chunks are there to make them (${closed ? 'closed chunks' : 'the unclosed trailing span'}, ${produce ? 'summaries to produce' : 'none to produce'})`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        // Small chunks close as messages arrive; large ones leave every message
        // in the unclosed span, where a produce op enqueues nothing.
        targetChunkTokens: closed ? 40 : 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.produce = produce;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const error = await refusal(manager);
        assert.match(error.message, /^Adaptive picker exhausted/);
        assert.deepEqual(error.clearedBy, expected);
      });
    });
  }

  it('names compression at the emission refusal while its plan has summaries to produce and a compression runs', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.level = 5;
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'raw '.repeat(200) }]);
      const id = manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      strategy.seedPyramid([id], 5);
      strategy.startCompressing();
      const error = await refusal(manager);
      assert.match(error.message, /^Emission overran the plan/);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  it('names the plan\'s list at the tail-check refusal', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 30,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.produce = true;
    strategy.dropTailMessage = true;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(10) }]);
      strategy.startCompressing();
      const error = await refusal(manager);
      assert.match(error.message, /^Tail emission dropped reserved recent-window messages/);
      assert.deepEqual(error.clearedBy, ['compression']);
      strategy.produce = false;
      const without = await refusal(manager);
      assert.match(without.message, /^Tail emission dropped reserved recent-window messages/);
      assert.deepEqual(without.clearedBy, [], 'a plan with nothing to produce names nothing');
    });
  });

  it('carries the refusal\'s list into a preview that doesn\'t fit', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const preview = manager.previewContext({ maxTokens: 100, reserveForResponse: 20 });
      assert.ok(preview);
      assert.equal(preview.fits, false);
      assert.deepEqual(preview.clearedBy, ['smaller-recent-window']);
    });
  });

  for (const running of [true, false]) {
    it(`carries the plan's list into a preview whose plan is over though its render fits (${running ? 'a compression runs' : 'no compression work'})`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: true,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.overstate = true;
      strategy.produce = true;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(10) }]);
        if (running) strategy.startCompressing();
        // A dry run reports a plan over the budget rather than refusing it,
        // and this one renders within the budget, so nothing later throws:
        // the dry compile resolves, and the preview is the one the plan recorded.
        await manager.compile({ maxTokens: 100, reserveForResponse: 20 }, undefined, { dryRun: true });
        const preview = manager.previewContext({ maxTokens: 100, reserveForResponse: 20 });
        assert.ok(preview);
        assert.equal(preview.fits, false);
        assert.equal(preview.finalTokens, 10_000, 'the preview is the plan\'s, not a later refusal\'s');
        assert.deepEqual(preview.clearedBy, running ? ['compression'] : []);
        // The live compile refuses the same plan at the picker's gate, with the same list.
        const live = await refusal(manager);
        assert.match(live.message, /^Adaptive picker exhausted/);
        assert.deepEqual(live.clearedBy, running ? ['compression'] : []);
      });
    });
  }

  it('keeps the plan\'s list and numbers in a preview whose plan is over when a later stage refuses with another', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.overstate = true;
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'message ' + 'word '.repeat(10) }]);
      // An unanswered call is the newest turn; the structural repair trims it
      // and then refuses, naming nothing.
      manager.addMessage('agent', [{ type: 'text', text: 'calling' }, { type: 'tool_use', id: 't1', name: 'read', input: {} }]);
      strategy.startCompressing();
      const dry = await refusal(manager, { dryRun: true });
      assert.match(dry.message, /^Structural repair did not retain the newest turn/);
      assert.deepEqual(dry.clearedBy, []);
      // The live compile refuses the plan at its gate first, so the preview
      // names what that refusal names.
      const preview = manager.previewContext({ maxTokens: 100, reserveForResponse: 20 });
      assert.ok(preview);
      assert.equal(preview.fits, false);
      assert.deepEqual(preview.clearedBy, ['compression']);
      const live = await refusal(manager);
      assert.match(live.message, /^Adaptive picker exhausted/);
      assert.deepEqual(live.clearedBy, ['compression']);
      // The preview's numbers are that refusal's too, not the later stage's.
      assert.equal(preview.finalTokens, live.actual);
      assert.equal(preview.budgetTokens, live.budget);
      assert.notEqual(dry.actual, live.actual, 'the later stage measured something else');
    });
  });

  it('carries no list in a preview that fits, with compression work running', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 2; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(10) }]);
      strategy.startCompressing();
      const preview = manager.previewContext({ maxTokens: 100_000, reserveForResponse: 20 });
      assert.ok(preview);
      assert.equal(preview.fits, true);
      assert.equal('clearedBy' in preview, false);
    });
  });

  it('names compression in a dry run only for work queued without its plan\'s ops', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.drift = true;
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      // One closed chunk, which the holdback keeps out of the queue until a
      // produce op demands it. A dry run never enqueues its plan's ops.
      for (let i = 0; i < 6; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const dry = await refusal(manager, { dryRun: true });
      assert.match(dry.message, /^Emission overran the plan/);
      assert.deepEqual(dry.clearedBy, []);
      const live = await refusal(manager);
      assert.match(live.message, /^Emission overran the plan/);
      assert.deepEqual(live.clearedBy, ['compression'], 'the live compile demands the chunk first');
    });
  });

  it('names compression for a hierarchical refusal of history that chunks waiting for compression cover', async () => {
    const strategy = new AutobiographicalStrategy({
      adaptiveResolution: false,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      assert.equal(strategy.checkReadiness().ready, false, 'chunks are waiting for compression');
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  const queuedChunks = () => new DiagnosticStrategy({
    adaptiveResolution: false,
    targetChunkTokens: 40,
    headWindowTokens: 0,
    recentWindowTokens: 0,
    overBudgetGraceRatio: 0.25,
    autoTickOnNewMessage: false,
    speculativeProduction: false,
  });

  it('names nothing for queued chunks an L1 already covers under other boundaries, which tick drops without compressing', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      assert.ok(strategy.queuedChunkIds().length > 0, 'chunks are queued');
      // One L1 over every message: each queued chunk is covered, none exactly.
      strategy.seedL1('L1-covering', ids);
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, []);
      // Tick drops each one without compressing it: the stub membrane has no
      // model to call, and no L1 is added.
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.deepEqual(strategy.summaryIds(), ['L1-covering']);
    }, { membrane: true });
  });

  for (const adaptiveResolution of [false, true]) {
    it(`names nothing on the ${adaptiveResolution ? 'adaptive' : 'hierarchical'} path for queued chunks an L1 covers only partly, which tick refuses`, async () => {
      const calls = { n: 0 };
      const strategy = new DiagnosticStrategy({
        adaptiveResolution,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.produce = true;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        // An L1 over each queued chunk's first message only: every queued
        // chunk is partly covered, none exactly.
        queued.forEach((ids, i) => strategy.seedL1(`L1-part-${i}`, [ids[0]!]));
        const error = await refusal(manager);
        assert.match(error.message, adaptiveResolution ? /^Adaptive picker exhausted/ : /^Hierarchical emission overran the budget/);
        assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile closed no new chunk');
        assert.deepEqual(error.clearedBy, []);
        // Tick refuses each one without compressing it: no model call, and
        // no L1 is added.
        const l1s = strategy.summaryIds();
        for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
        assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
        assert.deepEqual(strategy.summaryIds(), l1s);
        assert.equal(calls.n, 0, 'no model call');
      }, { membrane: countingMembrane(calls) });
    });
  }

  it('names compression for queued chunks an in-memory L1 covers partly when the store holds their exact L1s, and tick adopts them', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => {
        strategy.seedL1(`L1-part-${i}`, [ids[0]!]);
        strategy.seedStoredL1(`L1-stored-${i}`, ids);
      });
      assert.ok(!strategy.summaryIds().some((id) => id.startsWith('L1-stored-')), 'no exact L1 is in memory');
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      for (let i = 0; i < queued.length; i++) assert.ok(strategy.summaryIds().includes(`L1-stored-${i}`), `tick adopted L1-stored-${i}`);
    }, { membrane: true });
  });

  it('names nothing for queued chunks an in-memory L1 covers partly when the store holds their exact L1s, if chunks keep no records', async () => {
    const strategy = queuedChunks();
    strategy.persistChunks = false;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => {
        strategy.seedL1(`L1-part-${i}`, [ids[0]!]);
        strategy.seedStoredL1(`L1-stored-${i}`, ids);
      });
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, [], 'adoption doesn\'t persist, so the stored L1s shrink nothing');
    }, { membrane: true });
  });

  it('names compression for queued chunks whose exact L1s only the store holds, and tick adopts them without a model call', async () => {
    const strategy = queuedChunks();
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => strategy.seedStoredL1(`L1-stored-${i}`, ids));
      assert.deepEqual(strategy.summaryIds(), [], 'no L1 is in memory');
      const error = await refusal(manager);
      assert.match(error.message, /^Hierarchical emission overran the budget/);
      assert.deepEqual(error.clearedBy, ['compression']);
      for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
      assert.deepEqual(strategy.queuedChunkIds(), [], 'tick took every queued chunk');
      assert.deepEqual([...strategy.summaryIds()].sort(), queued.map((_, i) => `L1-stored-${i}`).sort(), 'tick adopted each stored L1');
    }, { membrane: true });
  });

  /** The queued chunks once a compile has closed every chunk the messages make. */
  const settledQueue = async (manager: ContextManager, strategy: DiagnosticStrategy): Promise<string[][]> => {
    await refusal(manager);
    const queued = strategy.queuedChunkIds();
    assert.ok(queued.length > 0, 'chunks are queued');
    return queued;
  };

  /** Ticks until tick has taken every queued chunk; each adopts its exact L1 without a model call. */
  const adoptAll = async (manager: ContextManager, strategy: DiagnosticStrategy): Promise<void> => {
    for (let i = 0; i < 20 && strategy.queuedChunkIds().length > 0; i++) await manager.tick();
  };

  for (const persistChunks of [true, false]) {
    it(`names ${persistChunks ? 'compression' : 'nothing'} on the hierarchical path for queued chunks L1s match exactly${persistChunks ? ', since adoption ends their raw fallback' : ' when chunks keep no records, since adoption doesn\'t persist'}`, async () => {
      const strategy = queuedChunks();
      strategy.persistChunks = persistChunks;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        const queued = await settledQueue(manager, strategy);
        queued.forEach((ids, i) => strategy.seedL1(`L1-exact-${i}`, ids));
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile closed no new chunk');
        assert.deepEqual(error.clearedBy, persistChunks ? ['compression'] : []);
        if (!persistChunks) return;
        // The premise: adopting the exact L1s makes the hierarchical render smaller.
        const before = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 20 })).messages.length;
        await adoptAll(manager, strategy);
        const after = (await manager.compile({ maxTokens: 100_000, reserveForResponse: 20 })).messages.length;
        assert.deepEqual(strategy.queuedChunkIds(), [], 'the adoptions persisted, so the rebuild queued nothing');
        assert.ok(after < before, `the render went from ${before} to ${after} messages`);
      }, { membrane: true });
    });
  }

  it('names nothing on the adaptive path for queued chunks L1s match exactly, since the picker already folds through them', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    strategy.produce = true;
    await withManager(strategy, async (manager) => {
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const queued = await settledQueue(manager, strategy);
      queued.forEach((ids, i) => strategy.seedL1(`L1-exact-${i}`, ids));
      const error = await refusal(manager);
      assert.match(error.message, /^Adaptive picker exhausted/);
      assert.deepEqual(strategy.queuedChunkIds(), queued, 'the compile closed no new chunk');
      assert.deepEqual(error.clearedBy, []);
      // The premise: the picker folds each message through the same L1 before and after adoption.
      const before = strategy.pickerL1s.at(-1);
      const runs = strategy.pickerL1s.length;
      await adoptAll(manager, strategy);
      const after = await refusal(manager);
      assert.match(after.message, /^Adaptive picker exhausted/);
      assert.ok(strategy.pickerL1s.length > runs, 'the picker ran again after the adoptions');
      assert.deepEqual(strategy.queuedChunkIds(), [], 'the adoptions persisted, so the rebuild queued nothing');
      assert.deepEqual(strategy.pickerL1s.at(-1), before);
      assert.ok(before?.some((id) => id !== undefined), 'the picker saw the L1s');
    }, { membrane: true });
  });

  for (const merge of [false, true]) {
    it(`names compression when the compression preflight says no${merge ? ', for the merge too' : ''}, since a host's tick takes the queue whatever it says`, async () => {
      const strategy = queuedChunks();
      strategy.preflightNo = true;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 12 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (merge) {
          strategy.seedL1('L1-a', [ids[0]!]);
          strategy.seedL1('L1-b', [ids[1]!]);
          strategy.queueMergeOf(['L1-a', 'L1-b']);
          // At the cap the drain takes no chunk, so only the merge can count.
          strategy.atCap = true;
        }
        const error = await refusal(manager);
        assert.deepEqual(error.clearedBy, ['compression']);
      });
    });
  }

  for (const held of [false, true]) {
    it(`names ${held ? 'nothing' : 'compression'} for a queued merge of real summaries ${held ? 'while a real hold covers one of its sources' : 'with no hold'}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        hierarchical: true,
        positionedRecallPairs: true,
        targetChunkTokens: 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 2 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedL1('L1-a', [ids[0]!]);
        strategy.seedL1('L1-b', [ids[1]!]);
        strategy.queueMergeOf(['L1-a', 'L1-b']);
        if (held) manager.holdCompression([ids[1]!], { timeoutMs: 60_000 });
        const error = await refusal(manager);
        assert.deepEqual(error.clearedBy, held ? [] : ['compression']);
        if (held) manager.releaseCompression([ids[1]!]);
      });
    });
  }

  it('names compression for a queued chunk behind a merge a hold blocks, since tick takes chunks before any merge', async () => {
    const strategy = new DiagnosticStrategy({
      adaptiveResolution: false,
      hierarchical: true,
      positionedRecallPairs: true,
      targetChunkTokens: 40,
      headWindowTokens: 0,
      recentWindowTokens: 0,
      overBudgetGraceRatio: 0.25,
      autoTickOnNewMessage: false,
      speculativeProduction: false,
    });
    await withManager(strategy, async (manager) => {
      const ids = Array.from({ length: 12 }, (_, i) =>
        manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
      const queued = await settledQueue(manager, strategy);
      strategy.seedL1('L1-a', [ids[0]!]);
      strategy.seedL1('L1-b', [ids[1]!]);
      strategy.queueMergeOf(['L1-a', 'L1-b']);
      // A hold on a source blocks the merge; this one leaves the windows and
      // the chunks as they are.
      strategy.holdBlocksMerges = true;
      // The first queued chunk holds both sources; the others hold neither.
      assert.ok(queued.slice(1).some((chunk) => !chunk.includes(ids[0]!) && !chunk.includes(ids[1]!)), 'a queued chunk the L1s leave alone');
      const error = await refusal(manager);
      assert.deepEqual(error.clearedBy, ['compression']);
    });
  });

  for (const positionedRecallPairs of [true, false]) {
    for (const work of ['running', 'merge'] as const) {
      it(`names compression at the hierarchical ${positionedRecallPairs ? 'recall pair' : 'raw-message fallback'} refusal while ${work === 'running' ? 'a compression runs' : 'a merge is queued'}`, async () => {
        const strategy = new DiagnosticStrategy({
          adaptiveResolution: false,
          hierarchical: true,
          positionedRecallPairs,
          targetChunkTokens: 100_000,
          headWindowTokens: 0,
          recentWindowTokens: 0,
          overBudgetGraceRatio: 0.25,
          autoTickOnNewMessage: false,
          speculativeProduction: false,
        });
        await withManager(strategy, async (manager) => {
          const ids = Array.from({ length: 2 }, (_, i) =>
            manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
          strategy.seedPyramid(positionedRecallPairs ? ids : ids.slice(1), 1);
          if (work === 'running') strategy.startCompressing();
          else strategy.queueMerge();
          const error = await refusal(manager);
          assert.match(error.message, positionedRecallPairs
            ? /selected middle representations=1, attempted representation level=L1/
            : /middle raw messages=1, attempted representation level=L0/);
          assert.deepEqual(error.clearedBy, ['compression']);
        });
      });
    }
  }

  for (const lateHold of [false, true]) {
    it(`names ${lateHold ? 'nothing' : 'compression'} for the chunk the picker's plan demands ${lateHold ? 'when a hold placed after it closed covers it, since tick skips it' : 'with no hold'}`, async () => {
      const strategy = new AutobiographicalStrategy({
        adaptiveResolution: true,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      await withManager(strategy, async (manager) => {
        // Messages 0 to 3 close into one chunk, which the holdback keeps out of
        // the queue until the plan's produce op demands it.
        const ids = Array.from({ length: 5 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        if (lateHold) manager.holdCompression([ids[3]], { timeoutMs: 60_000 });
        let error: OverBudgetError | undefined;
        try {
          await manager.compile({ maxTokens: 200, reserveForResponse: 20 });
        } catch (caught) {
          if (!(caught instanceof OverBudgetError)) throw caught;
          error = caught;
        }
        assert.ok(error, 'compile should refuse');
        assert.match(error.message, /^Adaptive picker exhausted/);
        assert.deepEqual(error.clearedBy, lateHold ? [] : ['compression']);
        if (lateHold) manager.releaseCompression([ids[3]]);
      });
    });
  }

  for (const positionedRecallPairs of [true, false]) {
    it(`names nothing at the hierarchical ${positionedRecallPairs ? 'recall pair' : 'raw-message fallback'} refusal while a hold blocks the only queued merge`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        hierarchical: true,
        positionedRecallPairs,
        targetChunkTokens: 100_000,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.holdBlocksMerges = true;
      await withManager(strategy, async (manager) => {
        const ids = Array.from({ length: 2 }, (_, i) =>
          manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]));
        strategy.seedPyramid(positionedRecallPairs ? ids : ids.slice(1), 1);
        strategy.queueMerge();
        assert.equal(strategy.checkReadiness().ready, false, 'the merge is queued');
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(error.clearedBy, [], 'tick stops at a blocked merge until the hold is released');
      });
    });
  }

  for (const merge of [false, true]) {
    it(`names ${merge ? 'compression' : 'nothing'} for queued chunks the speculative cap holds ${merge ? 'when a merge is queued to relieve it' : 'with no merge queued'}`, async () => {
      const strategy = new DiagnosticStrategy({
        adaptiveResolution: false,
        hierarchical: true,
        targetChunkTokens: 40,
        headWindowTokens: 0,
        recentWindowTokens: 0,
        overBudgetGraceRatio: 0.25,
        autoTickOnNewMessage: false,
        speculativeProduction: false,
      });
      strategy.atCap = true;
      await withManager(strategy, async (manager) => {
        for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
        if (merge) strategy.queueMerge();
        assert.equal(strategy.checkReadiness().ready, false, 'chunks are queued');
        const error = await refusal(manager);
        assert.match(error.message, /^Hierarchical emission overran the budget/);
        assert.deepEqual(error.clearedBy, merge ? ['compression'] : []);
      });
    });
  }
});
