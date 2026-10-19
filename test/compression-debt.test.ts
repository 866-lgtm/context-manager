/**
 * getCompressionDebt() — the single-authority reduction behind the
 * fleet-watch compression-debt alarm and the af #99 resident notice.
 * The 2026-08-06 five-resident wedge day is the motivating incident:
 * every outage was silently-failing compression surfacing weeks later
 * as a budget crisis. These tests pin the state thresholds.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AutobiographicalStrategy } from '../src/index.js';
import type { Chunk } from '../src/strategies/autobiographical.js';
import type { SummaryEntry } from '../src/types/index.js';

const HOUR = 60 * 60 * 1000;

class Probe extends AutobiographicalStrategy {
  setChunks(chunks: Chunk[]): void {
    (this as unknown as { chunks: Chunk[] }).chunks = chunks;
  }
  seedSummary(entry: SummaryEntry): void {
    (this as unknown as { summaries: SummaryEntry[] }).summaries.push(entry);
  }
  setMergeQueue(entries: Array<{ attempts?: number }>): void {
    (this as unknown as { mergeQueue: Array<{ attempts?: number }> }).mergeQueue = entries;
  }
  setMergeQuarantine(keys: string[]): void {
    const m = (this as unknown as { mergeQuarantine: Map<string, unknown> }).mergeQuarantine;
    m.clear();
    for (const k of keys) m.set(k, { key: k });
  }
}

function chunk(opts: { compressed: boolean; lastMessageAt?: number }): Chunk {
  return {
    index: 0,
    startIndex: 0,
    endIndex: 1,
    messages: opts.lastMessageAt !== undefined
      ? ([{ timestamp: opts.lastMessageAt }] as never)
      : ([] as never),
    tokens: 100,
    compressed: opts.compressed,
  } as Chunk;
}

function fresh(): Probe {
  return new Probe({ hierarchical: true, autoTickOnNewMessage: false });
}

describe('getCompressionDebt', () => {
  const NOW = 1_800_000_000_000;

  it('empty strategy is healthy', () => {
    const d = fresh().getCompressionDebt(NOW);
    assert.equal(d.state, 'healthy');
    assert.equal(d.pendingChunks, 0);
    assert.equal(d.oldestPendingAgeMs, null);
    assert.equal(d.mergeQueueMaxAttempts, 0);
  });

  it('the open frontier chunk is life, not debt', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: true }), chunk({ compressed: false, lastMessageAt: NOW - 10 * HOUR })]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.pendingChunks, 0, 'trailing uncompressed chunk excluded');
    assert.equal(d.state, 'healthy');
  });

  it('a closed chunk pending under an hour is healthy; over an hour is degraded', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: false, lastMessageAt: NOW - HOUR / 2 }), chunk({ compressed: true })]);
    assert.equal(s.getCompressionDebt(NOW).state, 'healthy');
    s.setChunks([chunk({ compressed: false, lastMessageAt: NOW - 2 * HOUR }), chunk({ compressed: true })]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'degraded');
    assert.ok((d.oldestPendingAgeMs ?? 0) > HOUR);
  });

  it('any quarantine record is at least degraded', () => {
    const s = fresh();
    s.setMergeQuarantine(['abc123']);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'degraded');
    assert.equal(d.mergeQuarantineCount, 1);
  });

  it('stale pending + quarantine escalates to critical', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: false, lastMessageAt: NOW - 7 * HOUR }), chunk({ compressed: true })]);
    s.setMergeQuarantine(['abc123']);
    assert.equal(s.getCompressionDebt(NOW).state, 'critical');
  });

  it('a 5+ chunk stale backlog is critical even without quarantines (the sonn5 freeze shape)', () => {
    const s = fresh();
    const stale = Array.from({ length: 5 }, () => chunk({ compressed: false, lastMessageAt: NOW - 7 * HOUR }));
    s.setChunks([...stale, chunk({ compressed: true })]);
    assert.equal(s.getCompressionDebt(NOW).state, 'critical');
  });

  it('Date timestamps (the live StoredMessage shape) age correctly', () => {
    // Production chunks hold StoredMessage objects whose timestamp is a
    // Date; the number-only filter made every such chunk age-invisible and
    // the staleness ladder unreachable. The live signature (2026-08-29):
    // pendingChunks > 0, oldestPendingAgeMs null, state healthy.
    const s = fresh();
    s.setChunks([
      { ...chunk({ compressed: false }), messages: [{ timestamp: new Date(NOW - 2 * HOUR) }] as never },
      chunk({ compressed: true }),
    ]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.pendingChunks, 1);
    assert.ok((d.oldestPendingAgeMs ?? 0) > HOUR, 'Date timestamps must produce an age');
    assert.equal(d.state, 'degraded');
  });

  it('microsecond timestamps normalize (chronicle stores µs)', () => {
    const s = fresh();
    s.setChunks([chunk({ compressed: false, lastMessageAt: (NOW - 2 * HOUR) * 1000 }), chunk({ compressed: true })]);
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.state, 'degraded');
    assert.ok((d.oldestPendingAgeMs ?? 0) < 3 * HOUR, 'µs value read as ms would be absurdly old');
  });

  it('reports a store with more summaries and merge groups than a call takes as spread arguments (#258)', () => {
    // A call takes about 125,000 spread arguments on node 22 and 24, so the
    // newest mint and the most merge attempts are folded, not spread; a spread
    // here would throw, and the method's catch would report the empty, healthy
    // state. A failure of this premise means the runtime takes more spread
    // arguments, as with a larger stack (`node --stack-size`) or a newer V8, not
    // that the method changed: raise the count until a spread throws again.
    const count = 200_000;
    assert.throws(() => Math.max(...new Array<number>(count).fill(0)), RangeError,
      'premise: this runtime takes fewer spread arguments than there are summaries');
    const s = fresh();
    // The newest mint and the most attempts sit in the middle, so a fold that
    // kept the first or the last entry fails.
    for (let i = 0; i < count; i++) {
      s.seedSummary({
        id: `L1-${i}`, level: 1, content: 'x', tokens: 5, sourceLevel: 0,
        sourceIds: [], sourceRange: { first: 'a', last: 'b' }, created: NOW - HOUR - Math.abs(i - 123_456),
      } as SummaryEntry);
    }
    // Every fifth entry has never been tried, so it carries no attempts.
    s.setMergeQueue(Array.from({ length: count }, (_, i) => (i === 77_777 ? { attempts: 9 } : i % 5 === 0 ? {} : { attempts: i % 5 })));
    const d = s.getCompressionDebt(NOW);
    assert.equal(d.unmergedFrontier.l1, count, 'the report is the store\'s, not the empty one');
    assert.equal(d.lastMintAt, NOW - HOUR);
    assert.equal(d.mergeQueueDepth, count);
    assert.equal(d.mergeQueueMaxAttempts, 9);
  });

  it('lastMintAt reflects the newest summary', () => {
    const s = fresh();
    s.seedSummary({
      id: 'L1-1', level: 1, content: 'x', tokens: 5, sourceLevel: 0,
      sourceIds: [], sourceRange: { first: 'a', last: 'b' }, created: NOW - HOUR,
    } as SummaryEntry);
    assert.equal(s.getCompressionDebt(NOW).lastMintAt, NOW - HOUR);
  });
});
