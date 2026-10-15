import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AutobiographicalStrategy, ContextManager, OverBudgetError } from '../src/index.js';
import type { SummaryEntry, SummaryLevel } from '../src/types/index.js';
import { Picker, type PickerInputs } from '../src/adaptive/picker.js';
import type { FoldingBudget } from '../src/adaptive/folding-strategy.js';

class DiagnosticStrategy extends AutobiographicalStrategy {
  level = 1;
  drift = false;
  useRealPicker = false;
  /** When set, the fixture solver asks for an L1 over the middle, as a plan with summaries still to produce does. */
  produce = false;

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
    if (this.useRealPicker) return super.buildPicker(inputs);
    const level = this.level;
    const produce = this.produce;
    class DriftPicker extends Picker {
      run(inputs: PickerInputs, budget: FoldingBudget) {
        const result = super.run(inputs, budget);
        return { ...result, finalTokens: 1, budgetMet: true };
      }
    }
    const Constructor = this.drift ? DriftPicker : Picker;
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

async function withManager(strategy: AutobiographicalStrategy, run: (manager: ContextManager) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'cm-budget-diagnostics-'));
  const manager = await ContextManager.open({ path: join(directory, 'store'), strategy });
  try {
    await run(manager);
  } finally {
    await manager.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function refusal(manager: ContextManager): Promise<OverBudgetError> {
  try {
    await manager.compile({ maxTokens: 100, reserveForResponse: 20 });
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

  it('names nothing when the newest message alone is over, since no window keeps less', async () => {
    await withManager(recentOnly(100_000), async (manager) => {
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(10) }]);
      manager.addMessage('user', [{ type: 'text', text: 'word '.repeat(200) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Head\/tail reservation exceeded budget/);
      assert.deepEqual(error.clearedBy, []);
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

  it('names compression when the plan still has summaries to produce', async () => {
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
      for (let i = 0; i < 12; i++) manager.addMessage('user', [{ type: 'text', text: `message ${i} ` + 'word '.repeat(30) }]);
      const error = await refusal(manager);
      assert.match(error.message, /^Adaptive picker exhausted/);
      assert.deepEqual(error.clearedBy, ['compression']);
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
});
