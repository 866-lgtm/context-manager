/**
 * [fold-diff] wiring in the real strategy, driven through
 * ContextManager.compile() with adaptiveResolution: the dry-run gate, the
 * per-compile reset, logging only at the commit point, the attach on
 * planVsActual, the kept committed layout, and observability never failing a
 * compile (PR #157 review §1).
 *
 * The picker is replaced (buildPicker hook, as in hard-fail.test.ts) by one
 * whose plan the test sets per compile, over real L1 summaries produced by a
 * mock membrane; everything after picker.run is the production path.
 */

import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';

import { ContextManager, AutobiographicalStrategy } from '../../src/index.js';
import { accountFrontier, type PickerInputs } from '../../src/adaptive/picker.js';
import type { ChunkId } from '../../src/adaptive/folding-strategy.js';
import { SummaryTree } from '../../src/adaptive/summary-tree.js';
import { formatFoldDiff, type FoldDiff } from '../../src/adaptive/fold-diff.js';

const TEST_STORE_PATH = './test-adaptive-fold-diff-strategy-store';

function cleanup() {
  if (existsSync(TEST_STORE_PATH)) rmSync(TEST_STORE_PATH, { recursive: true, force: true });
}

function makeMockMembrane() {
  let n = 0;
  return {
    complete: async () => ({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: `[mock summary #${++n}]` }],
    }),
  };
}

type Plan = 'fold' | 'raw' | 'carried';

/** A strategy whose picker applies the plan the test sets: every middle chunk
 *  with an L1 at L1 ('fold'), everything raw ('raw'), or the carried frontier
 *  unchanged ('carried', zero moves). `lie` reports a 1-token plan, so the
 *  plan check passes and the EMITTER refuses an over-budget frontier — a
 *  failure after the fold diff was staged. */
class PlannedStrategy extends AutobiographicalStrategy {
  plan: Plan = 'fold';
  lie = false;
  protected buildPicker(): any {
    return {
      solverName: 'test-plan',
      run: (inputs: PickerInputs, budget: { targetBudget: number }) => {
        const middle = (id: ChunkId) => !inputs.headChunkIds.has(id) && !inputs.tailChunkIds.has(id);
        const finalResolutions = new Map<ChunkId, number>();
        for (const c of inputs.chunks) {
          const level = this.plan === 'carried'
            ? c.currentResolution
            : this.plan === 'fold' && middle(c.id) && c.l1Id ? 1 : 0;
          finalResolutions.set(c.id, level);
        }
        let moves = 0;
        for (const c of inputs.chunks) if ((finalResolutions.get(c.id) ?? 0) !== c.currentResolution) moves++;
        const finalTokens = this.lie ? 1 : accountFrontier(inputs, finalResolutions).tokens;
        return {
          finalResolutions,
          applied: [],
          produced: [],
          finalTokens,
          budgetMet: finalTokens <= budget.targetBudget,
          exhausted: false,
          iterations: 1,
          moves,
        };
      },
    };
  }
}

type Stats = { planVsActual?: { foldDiff?: FoldDiff } } | null;

describe('AutobiographicalStrategy — [fold-diff] wiring', () => {
  let errors: string[] = [];
  let warnings: string[] = [];
  let origError: typeof console.error;
  let origWarn: typeof console.warn;
  const foldLines = () => errors.filter((l) => l.startsWith('[fold-diff]'));

  before(() => cleanup());
  after(() => cleanup());
  beforeEach(() => {
    cleanup();
    errors = [];
    warnings = [];
    origError = console.error;
    origWarn = console.warn;
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  });
  afterEach(() => {
    console.error = origError;
    console.warn = origWarn;
  });

  async function open(): Promise<{ manager: ContextManager; strategy: PlannedStrategy }> {
    const strategy = new PlannedStrategy({
      compressionModel: 'mock',
      adaptiveResolution: true,
      targetChunkTokens: 100,
      recentWindowTokens: 200,
    });
    const manager = await ContextManager.open({
      path: TEST_STORE_PATH,
      strategy,
      membrane: makeMockMembrane() as any,
    });
    for (let i = 0; i < 30; i++) {
      manager.addMessage('User', [{ type: 'text', text: `Msg ${i}. ` + 'word '.repeat(40) }]);
    }
    while (!manager.isReady()) await manager.tick();
    errors = [];
    warnings = [];
    return { manager, strategy };
  }

  const BIG = { maxTokens: 100_000, reserveForResponse: 200 };
  const stats = (m: ContextManager): Stats => m.getRenderStats() as Stats;

  it('a committed compile that moved logs exactly once and attaches the same record', async () => {
    const { manager } = await open();
    await manager.compile(BIG);
    const lines = foldLines();
    assert.equal(lines.length, 1, `one [fold-diff] line, got ${JSON.stringify(lines)}`);
    const diff = stats(manager)?.planVsActual?.foldDiff;
    assert.ok(diff, 'foldDiff attached to planVsActual');
    assert.ok(diff.moves > 0 && diff.deepened === diff.moves, 'the fold plan deepened chunks');
    assert.equal(formatFoldDiff(diff), lines[0], 'the attached record is the one logged');
    manager.close();
  });

  it('a compile with no moves neither logs nor keeps the previous compile’s foldDiff', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    assert.ok(stats(manager)?.planVsActual?.foldDiff);
    errors = [];
    strategy.plan = 'carried';
    await manager.compile(BIG);
    assert.deepEqual(foldLines(), []);
    assert.ok(stats(manager)?.planVsActual, 'planVsActual still reported');
    assert.equal(stats(manager)?.planVsActual?.foldDiff, undefined);
    manager.close();
  });

  it('a dry run neither logs nor attaches, and leaves the live stats alone', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const live = stats(manager)?.planVsActual?.foldDiff;
    assert.ok(live);
    errors = [];
    strategy.plan = 'raw'; // would move every folded chunk
    const preview = manager.previewContext(BIG, undefined, { render: true });
    assert.ok(preview?.stats, 'the dry run produced stats of its own');
    assert.ok((preview.stats as Stats)?.planVsActual, 'preview stats carry planVsActual');
    assert.equal((preview.stats as Stats)?.planVsActual?.foldDiff, undefined);
    assert.deepEqual(foldLines(), []);
    assert.equal(stats(manager)?.planVsActual?.foldDiff, live, 'live stats unchanged by the preview');
    manager.close();
  });

  it('a plan that fails after staging logs nothing; the retry that commits logs once', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const folded = stats(manager)!.planVsActual!.foldDiff!;
    // Fits folded, not raw: the raw plan lies its way past the plan check and
    // the emitter refuses it.
    const tight = { maxTokens: folded.nextTokens + 400, reserveForResponse: 0 };
    errors = [];
    strategy.plan = 'raw';
    strategy.lie = true;
    await assert.rejects(() => manager.compile(tight));
    assert.deepEqual(foldLines(), [], 'a refused plan is not a fold the resident saw');
    strategy.lie = false;
    await manager.compile(BIG);
    assert.equal(foldLines().length, 1, 'the committed retry logs once');
    const diff = stats(manager)!.planVsActual!.foldDiff!;
    assert.equal(diff.raised, folded.deepened, 'the failed plan committed nothing');
    manager.close();
  });

  it('a throw inside describeFoldDiff leaves the compile succeeding', async () => {
    const { manager } = await open();
    const original = SummaryTree.prototype.ancestorAt;
    SummaryTree.prototype.ancestorAt = function () {
      throw new Error('boom');
    };
    try {
      const compiled = await manager.compile(BIG);
      assert.ok(compiled.messages.length > 0);
    } finally {
      SummaryTree.prototype.ancestorAt = original;
    }
    assert.deepEqual(foldLines(), []);
    assert.ok(warnings.some((w) => w.startsWith('[fold-diff] unavailable')), 'the failure is reported');
    assert.equal(stats(manager)?.planVsActual?.foldDiff, undefined);
    assert.ok((stats(manager)?.planVsActual as { moves?: number } | undefined)?.moves, 'the fold itself committed');
    manager.close();
  });

  it('diffs against the layout the last committed compile sent, not a re-render', async () => {
    const { manager, strategy } = await open();
    await manager.compile(BIG);
    const first = stats(manager)!.planVsActual!.foldDiff!;
    // A new message changes this compile's inputs: a re-render of the carried
    // frontier would include it; the kept layout is the previous request.
    manager.addMessage('User', [{ type: 'text', text: 'one more ' + 'word '.repeat(40) }]);
    strategy.plan = 'raw';
    await manager.compile(BIG);
    const second = stats(manager)!.planVsActual!.foldDiff!;
    assert.equal(second.previousTokens, first.nextTokens);
    manager.close();
  });
});
