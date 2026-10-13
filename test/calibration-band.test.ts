/**
 * Estimator calibration band: a sample is learned from when EITHER the
 * observed real/est ratio OR the implied raw multiplier is inside the clamp
 * range. Regression for the pinned-ceiling trap: with the multiplier at
 * 1.8 (driven there by a wrong per-class rate) and the rate then fixed,
 * every honest sample reads real/est ≈ 0.56 — out of band on the ratio
 * alone — so the multiplier could never come back down.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Membrane, MockAdapter, NativeFormatter } from '@animalabs/membrane';
import { ContextManager, AutobiographicalStrategy } from '../src/index.js';

const dir = mkdtempSync(join(tmpdir(), 'calibration-band-'));
const BUDGET = { maxTokens: 100_000, reserveForResponse: 2_000 };
after(() => rmSync(dir, { recursive: true, force: true }));

type Internals = {
  _calibration: number;
  calibrationStateId: string;
  store: { setStateJson(id: string, value: unknown): void; getStateJson(id: string): unknown } | null;
  _lastCompileEstimate: number;
  applyCalibration(): void;
};

/** Anthropic keep-all signed thinking: the content pricing epoch 1 repriced. */
const SIGNED_THINKING = { type: 'thinking', thinking: '', signature: 'sig'.repeat(110) } as const;

async function openManager(name: string, opts: { signedThinking?: boolean } = {}) {
  const membrane = new Membrane(new MockAdapter({}), { formatter: new NativeFormatter() });
  const strategy = new AutobiographicalStrategy({
    targetChunkTokens: 5_000,
    recentWindowTokens: 50_000,
    compressionModel: 'mock',
    adaptiveResolution: true, // the calibration sample is armed on the adaptive (folding) path only
  });
  const cm = await ContextManager.open({ path: join(dir, name), strategy, membrane });
  for (let i = 0; i < 6; i++) {
    cm.addMessage(i % 2 ? 'Claude' : 'User', [
      ...(i % 2 && opts.signedThinking ? [SIGNED_THINKING as never] : []),
      { type: 'text', text: `turn ${i} ${'lorem ipsum '.repeat(120)}` },
    ]);
  }
  return { cm, strategy, internals: strategy as unknown as Internals };
}

describe('estimator calibration band', () => {
  it('a multiplier pinned at the ceiling comes back down once the raw estimate is honest', async () => {
    const { cm, strategy, internals } = await openManager('pinned');
    await cm.compile(BUDGET);
    internals._calibration = 1.8;
    internals.applyCalibration();
    await cm.compile(BUDGET); // arms one sample; estimate is in calibrated units (raw × 1.8)
    const est = internals._lastCompileEstimate;
    assert.ok(est > 0);
    // The provider bills exactly the raw estimate: real/est = 1/1.8 ≈ 0.56.
    strategy.reportRealInputTokens(est / 1.8);
    assert.ok(internals._calibration < 1.8, `multiplier should decay from 1.8, got ${internals._calibration}`);
    assert.ok(internals._calibration > 1.0, `EMA moves gradually, got ${internals._calibration}`);
    cm.close();
  });

  it('a structurally wrong sample is still rejected', async () => {
    const { cm, strategy, internals } = await openManager('wild');
    await cm.compile(BUDGET);
    const est = internals._lastCompileEstimate;
    assert.equal(internals._calibration, 1);
    strategy.reportRealInputTokens(est * 3); // 3× the window: not a window-shaped request
    assert.equal(internals._calibration, 1);
    cm.close();
  });

  it('an in-band ratio is learned from as before', async () => {
    const { cm, strategy, internals } = await openManager('inband');
    await cm.compile(BUDGET);
    const est = internals._lastCompileEstimate;
    strategy.reportRealInputTokens(est * 1.5);
    assert.ok(internals._calibration > 1.0 && internals._calibration < 1.5, `got ${internals._calibration}`);
    cm.close();
  });

  it('the startup wedge: a stale-epoch 1.8 no longer makes the first compile throw', async () => {
    // A store that pinned 1.8 under flat-600 thinking pricing reopens
    // estimating ~1.8x its real size; if that is over the hard budget the
    // first compile throws OverBudgetError, so no inference runs and no sample
    // can ever decay it. Size a budget that fits at 1.0 but not at 1.8.
    // Measure what the hard-budget check counts at 1.0 (the OverBudgetError's
    // `actual`), rather than inferring it from the estimator's own fields.
    // (openManager appends six messages per open, so the probe goes through the
    // same open → close → reopen as the stores under test, to hold the same content.)
    const ST = { signedThinking: true };
    const probeFirst = await openManager('wedge-probe', ST);
    await probeFirst.cm.compile(BUDGET);
    probeFirst.cm.close();
    const probe = await openManager('wedge-probe', ST);
    const reserve = 500;
    const raw = await probe.cm.compile({ maxTokens: reserve + 1, reserveForResponse: reserve }).then(
      () => { throw new Error('probe budget unexpectedly fit'); },
      (e: { actual?: number }) => e.actual!,
    );
    probe.cm.close();
    assert.ok(raw > 0);
    const tight = { maxTokens: Math.ceil(raw * 1.35) + reserve, reserveForResponse: reserve };

    // Control: the SAME budget with a current-epoch 1.8 does throw, so the
    // assertion below can't pass vacuously.
    const control = await openManager('wedge-control', ST);
    await control.cm.compile(BUDGET);
    control.internals.store!.setStateJson(control.internals.calibrationStateId, {
      multiplier: 1.8, at: Date.now(), pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH,
    });
    control.cm.close();
    const controlReopened = await openManager('wedge-control', ST);
    await assert.rejects(controlReopened.cm.compile(tight), /budget/i);
    controlReopened.cm.close();

    // The wedge case: an unstamped (epoch 0) 1.8 is discarded and the first
    // compile resolves; the reset is persisted, so a rollback can't reload 1.8.
    const first = await openManager('wedge', ST);
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 1.8, at: Date.now() });
    first.cm.close();
    const reopened = await openManager('wedge', ST);
    await reopened.cm.compile(tight);
    assert.equal(reopened.internals._calibration, 1);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { multiplier?: number; pricing?: number };
    assert.equal(saved.multiplier, 1, 'the reset must be persisted');
    assert.equal(saved.pricing, AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH);
    reopened.cm.close();
  });

  it('a record from a newer pricing epoch is not used, and is left on disk', async () => {
    const first = await openManager('newer-epoch');
    await first.cm.compile(BUDGET);
    const future = { multiplier: 1.4, at: 123, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH + 1 };
    first.internals.store!.setStateJson(first.internals.calibrationStateId, future);
    first.cm.close();

    const reopened = await openManager('newer-epoch');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 1);
    assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), future);
    reopened.cm.close();
  });

  it('a multiplier learned under the current pricing epoch survives reopen', async () => {
    const first = await openManager('current-epoch');
    await first.cm.compile(BUDGET);
    first.strategy.reportRealInputTokens(first.internals._lastCompileEstimate * 1.5);
    const learned = first.internals._calibration;
    assert.ok(learned > 1);
    const saved = first.internals.store!.getStateJson(first.internals.calibrationStateId) as { pricing?: number };
    assert.equal(saved.pricing, AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH);
    first.cm.close();

    const reopened = await openManager('current-epoch');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, learned);
    reopened.cm.close();
  });

  it('a discard is visible in render stats and survives restarts and learning, until re-stamped', async () => {
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    // An unstamped 0.6: e.g. a store on another provider's tokenizer, where
    // the old value was still accurate. The discard must not be silent.
    const first = await openManager('visible', { signedThinking: true });
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.6, at: 1 });
    first.cm.close();

    const reopened = await openManager('visible', { signedThinking: true });
    await reopened.cm.compile(BUDGET);
    const cal = reopened.cm.getRenderStats()!.calibration!;
    assert.equal(cal.multiplier, 1);
    assert.equal(cal.pricingEpoch, epoch);
    assert.equal(cal.reset?.discardedMultiplier, 0.6);
    assert.equal(cal.reset?.fromEpoch, 0);
    const resetAt = cal.reset!.at;
    // Learning after the reset keeps the record (it is a fact about this
    // store's history, not about the current value).
    reopened.strategy.reportRealInputTokens(reopened.internals._lastCompileEstimate * 1.5);
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { reset?: { at: number } };
    assert.equal(saved.reset?.at, resetAt);
    reopened.cm.close();

    // Still visible after another restart, with no second discard.
    const again = await openManager('visible', { signedThinking: true });
    await again.cm.compile(BUDGET);
    assert.equal(again.cm.getRenderStats()!.calibration!.reset?.at, resetAt);
    // An operator re-stamp (the old value, checked against provider billing)
    // clears it.
    again.internals.store!.setStateJson(again.internals.calibrationStateId, { multiplier: 0.6, at: Date.now(), pricing: epoch });
    again.cm.close();
    const restamped = await openManager('visible', { signedThinking: true });
    await restamped.cm.compile(BUDGET);
    const after = restamped.cm.getRenderStats()!.calibration!;
    assert.equal(after.multiplier, 0.6);
    assert.equal(after.reset, undefined);
    restamped.cm.close();
  });

  it('an unstamped multiplier is kept and re-stamped when nothing in the store was repriced', async () => {
    // A store with no signed thinking (e.g. a resident on another provider's
    // tokenizer): epoch 1 changed nothing it holds, so its 0.6 still holds.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const first = await openManager('kept');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.6, at: 1 });
    first.cm.close();
    const reopened = await openManager('kept');
    await reopened.cm.compile(BUDGET);
    assert.equal(reopened.internals._calibration, 0.6);
    assert.deepEqual(reopened.cm.getRenderStats()!.calibration, { multiplier: 0.6, pricingEpoch: epoch });
    const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as { multiplier?: number; pricing?: number };
    assert.equal(saved.multiplier, 0.6);
    assert.equal(saved.pricing, epoch, 're-stamped under the current epoch');
    reopened.cm.close();

    // Control: the same record in a store holding signed thinking is discarded.
    const signed = await openManager('kept-control', { signedThinking: true });
    await signed.cm.compile(BUDGET);
    signed.internals.store!.setStateJson(signed.internals.calibrationStateId, { multiplier: 0.6, at: 1 });
    signed.cm.close();
    const signedReopened = await openManager('kept-control', { signedThinking: true });
    await signedReopened.cm.compile(BUDGET);
    assert.equal(signedReopened.internals._calibration, 1);
    assert.equal(signedReopened.cm.getRenderStats()!.calibration!.reset?.discardedMultiplier, 0.6);
    signedReopened.cm.close();
  });

  it('a store with no calibration history reports its multiplier and no reset', async () => {
    const { cm } = await openManager('no-history');
    await cm.compile(BUDGET);
    assert.deepEqual(cm.getRenderStats()!.calibration, { multiplier: 1, pricingEpoch: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    cm.close();
  });

  it('a dry select leaves the record as it was, and the next real compile persists the load', async () => {
    // A preview (previewContext) and a dry compile each select with dryRun:
    // the load decides as a real one would, but writes and logs nothing, and
    // it must not latch, or the real compile after it would never persist.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const cases = [
      { name: 'dry-reset-preview', signedThinking: true, dry: 'preview' },
      { name: 'dry-reset-compile', signedThinking: true, dry: 'compile' },
      { name: 'dry-restamp-preview', signedThinking: false, dry: 'preview' },
      { name: 'dry-restamp-compile', signedThinking: false, dry: 'compile' },
    ] as const;
    for (const c of cases) {
      const first = await openManager(c.name, { signedThinking: c.signedThinking });
      await first.cm.compile(BUDGET);
      const old = { multiplier: 0.7, at: 1, pricing: 0 };
      first.internals.store!.setStateJson(first.internals.calibrationStateId, old);
      first.cm.close();

      const reopened = await openManager(c.name, { signedThinking: c.signedThinking });
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(' ')); };
      try {
        if (c.dry === 'preview') assert.ok(reopened.cm.previewContext(BUDGET));
        else await reopened.cm.compile(BUDGET, undefined, { dryRun: true });
        const calibrationLines = () => warned.filter((l) => l.includes('[estimator-calibration]'));
        assert.deepEqual(reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId), old,
          `${c.name}: a dry select must not write the record`);
        assert.equal(calibrationLines().length, 0, `${c.name}: a dry select logs nothing`);
        await reopened.cm.compile(BUDGET);
        assert.equal(calibrationLines().length, 1, `${c.name}: the real compile logs the load once`);
      } finally {
        console.warn = warn;
      }
      const saved = reopened.internals.store!.getStateJson(reopened.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: { discardedMultiplier: number } };
      assert.equal(saved.pricing, epoch, `${c.name}: the real compile persists the load's decision`);
      assert.equal(saved.multiplier, c.signedThinking ? 1 : 0.7);
      assert.equal(saved.reset?.discardedMultiplier, c.signedThinking ? 0.7 : undefined);
      reopened.cm.close();
    }
  });

  it('a dry select prices by the multiplier its load decided', async () => {
    // The dry load applies its decision to the store, so a preview's plan is
    // priced as the next real compile's is: a kept 0.7 against no record.
    const plans: number[] = [];
    const cases = [['priced-kept', { multiplier: 0.7, at: 1 }], ['priced-none', null]] as const;
    for (const [name, record] of cases) {
      const first = await openManager(name);
      await first.cm.compile(BUDGET);
      if (record) first.internals.store!.setStateJson(first.internals.calibrationStateId, record);
      first.cm.close();
      const reopened = await openManager(name);
      const preview = reopened.cm.previewContext(BUDGET)!;
      await reopened.cm.compile(BUDGET);
      assert.equal(preview.finalTokens, reopened.cm.getRenderStats()!.planVsActual!.planned,
        `${name}: the preview's plan is the real compile's`);
      plans.push(preview.finalTokens);
      reopened.cm.close();
    }
    assert.ok(plans[0] < plans[1] * 0.8, `the kept 0.7 priced the preview: ${plans.join(' vs ')}`);
  });

  it('a real load after a dry one decides from the record and history as they are then', async () => {
    // Whatever a dry load decided stays its own: the store can change before
    // the first real compile, and that compile's load decides afresh, for the
    // multiplier and for the reset alike.
    const epoch = AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH;
    const storeCalibration = (cm: ContextManager) =>
      (cm as unknown as { messageStore: { getTokenCalibration(): number } }).messageStore.getTokenCalibration();
    // Returns the multiplier the dry select priced by, where it reports one.
    const dryRun = async (cm: ContextManager, how: 'preview' | 'compile') => {
      if (how === 'preview') return cm.previewContext(BUDGET, undefined, { render: true })!.stats!.calibration!.multiplier;
      await cm.compile(BUDGET, undefined, { dryRun: true });
      return undefined;
    };
    for (const how of ['preview', 'compile'] as const) {
      // Kept by the dry load (nothing repriced held yet); unstamped signed
      // thinking arrives, so the real load discards it.
      const first = await openManager(`dry-keep-then-discard-${how}`);
      await first.cm.compile(BUDGET);
      first.internals.store!.setStateJson(first.internals.calibrationStateId, { multiplier: 0.7, at: 1, pricing: 0 });
      first.cm.close();
      const kept = await openManager(`dry-keep-then-discard-${how}`);
      const priced = await dryRun(kept.cm, how);
      if (how === 'preview') assert.equal(priced, 0.7, 'the preview priced by the kept 0.7');
      // Nothing the dry load decided is left: neither the strategy's multiplier
      // nor the one the store prices new messages by, which chunking reads.
      assert.equal(kept.internals._calibration, 1, `${how}: the strategy's multiplier is as it was`);
      assert.equal(storeCalibration(kept.cm), 1, `${how}: the store prices by what it did before`);
      kept.cm.addMessage('Claude', [SIGNED_THINKING as never, { type: 'text', text: 'and then' }]);
      await kept.cm.compile(BUDGET);
      assert.equal(kept.internals._calibration, 1, `${how}: the real load discarded it`);
      assert.equal(kept.cm.getRenderStats()!.calibration!.multiplier, 1);
      const discarded = kept.internals.store!.getStateJson(kept.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: { discardedMultiplier: number } };
      assert.deepEqual([discarded.multiplier, discarded.pricing, discarded.reset?.discardedMultiplier], [1, epoch, 0.7]);
      kept.cm.close();

      // Discarded by the dry load (unstamped signed thinking); that content
      // goes, so the real load keeps it, with no reset anywhere.
      const second = await openManager(`dry-discard-then-keep-${how}`, { signedThinking: true });
      await second.cm.compile(BUDGET);
      second.internals.store!.setStateJson(second.internals.calibrationStateId, { multiplier: 0.7, at: 1, pricing: 0 });
      second.cm.close();
      const reset = await openManager(`dry-discard-then-keep-${how}`, { signedThinking: true });
      await dryRun(reset.cm, how);
      for (const m of reset.cm.getAllMessages()) {
        if (m.content.some((b) => (b as { type?: string }).type === 'thinking')) reset.cm.removeMessage(m.id);
      }
      await reset.cm.compile(BUDGET);
      assert.equal(reset.internals._calibration, 0.7, `${how}: the real load kept it`);
      assert.deepEqual(reset.cm.getRenderStats()!.calibration, { multiplier: 0.7, pricingEpoch: epoch }, `${how}: no reset`);
      const restamped = reset.internals.store!.getStateJson(reset.internals.calibrationStateId) as
        { multiplier?: number; pricing?: number; reset?: unknown };
      assert.deepEqual([restamped.multiplier, restamped.pricing, restamped.reset], [0.7, epoch, undefined]);
      reset.cm.close();
    }
  });

  it('a dry select refuses a store view whose calibration it could not put back', async () => {
    // A view with the calibration setter but not the getter: select() can't
    // read its factor to restore it, so a dry select refuses before changing
    // it, and the caller's own factor stays.
    const first = await openManager('setter-only');
    await first.cm.compile(BUDGET);
    first.internals.store!.setStateJson(first.internals.calibrationStateId,
      { multiplier: 0.7, at: 1, pricing: AutobiographicalStrategy.CALIBRATION_PRICING_EPOCH });
    first.cm.close();
    const reopened = await openManager('setter-only');
    const cm = reopened.cm as unknown as {
      strategyMessageView(): Record<string, unknown>;
      messageStore: { getTokenCalibration(): number; setTokenCalibration(factor: number): void };
    };
    const build = Object.getPrototypeOf(reopened.cm).strategyMessageView as () => Record<string, unknown>;
    cm.strategyMessageView = function (this: unknown) {
      const view = build.call(this);
      delete view.getTokenCalibration;
      return view;
    };
    cm.messageStore.setTokenCalibration(1.3); // the caller's own factor
    assert.throws(() => reopened.cm.previewContext(BUDGET), /getTokenCalibration/);
    await assert.rejects(reopened.cm.compile(BUDGET, undefined, { dryRun: true }), /getTokenCalibration/);
    assert.equal(cm.messageStore.getTokenCalibration(), 1.3, 'neither dry select changed the caller\'s factor');
    await reopened.cm.compile(BUDGET);
    assert.equal(cm.messageStore.getTokenCalibration(), 0.7, 'a real compile applies the loaded one');
    reopened.cm.close();
  });

  it('a drift inside 2% is not applied; once the EMA passes 2% it is', async () => {
    const { cm, strategy, internals } = await openManager('deadband');
    await cm.compile(BUDGET);
    assert.equal(internals._calibration, 1);
    // real/est = 1.01 every compile: the EMA creeps toward 1.01 and never
    // leaves the band, so nothing is repriced between compiles.
    for (let i = 0; i < 12; i++) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.01);
      assert.equal(internals._calibration, 1, `sample ${i} must not move the applied multiplier`);
      await cm.compile(BUDGET);
    }
    // real/est = 1.10: the EMA passes 2% within a few samples and is applied.
    let applied = false;
    for (let i = 0; i < 6 && !applied; i++) {
      strategy.reportRealInputTokens(internals._lastCompileEstimate * 1.1);
      applied = internals._calibration !== 1;
      await cm.compile(BUDGET);
    }
    assert.ok(applied, 'a sustained 10% error must be applied');
    assert.ok(internals._calibration > 1.02 && internals._calibration < 1.1, `got ${internals._calibration}`);
    cm.close();
  });
});
