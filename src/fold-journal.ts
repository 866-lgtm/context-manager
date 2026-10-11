/**
 * The fold journal: an append-only record of when a resident's rendered
 * context changed resolution, written at accepted provider rounds.
 *
 * A compile produces a rendered layout (see compile-provenance.ts). When the
 * host confirms that a provider round carrying that compile succeeded, it
 * hands the compile's provenance back (`ContextManager.acceptRound`). The
 * journal compares the layout with the last layout accepted on the same
 * branch, only over messages present in both, and appends one receipt when
 * any of them changed form: raw to summary, one summary to another, summary
 * to raw, rendered to omitted, omitted to rendered, or a raw copy becoming
 * partial or complete. Messages that arrived since the last accepted round
 * are arrivals, not folds. The first accepted round on a branch the journal
 * has never recorded writes a baseline receipt that says history before it
 * is unknown.
 *
 * Storage is Chronicle typed records, not branch state: typed records are
 * enumerable from any branch and survive branch deletion, so every branch's
 * receipts stay queryable and a round can be accepted onto the branch it was
 * compiled on even after another branch was selected. Two record types:
 *
 * - `context-manager/store-identity`: minted once per store; names the
 *   store in every receipt.
 * - `context-manager/accepted-layout`: one per accepted compile, holding the
 *   branch's new last accepted layout (a snapshot, or a delta on the
 *   previous record; an unchanged layout is an empty delta) AND the fold
 *   receipt that acceptance produced, if any. One record is one commit: a
 *   receipt can never exist without the layout it was compared into, or the
 *   reverse, so a crash or a failed append between the two cannot duplicate
 *   or lose a receipt. Diffs read only the persisted layout, never the live
 *   message view. A layout persists as its members (gap-coded sequences) and
 *   its units (forms with counts). A delta's size follows what changed. A
 *   snapshot holds the whole layout, the history behind the window as its
 *   members; it is written only once the records since the last one would
 *   outweigh it, so snapshots cost about as much again as the deltas between
 *   them, and the bytes stored per acceptance don't grow with the session.
 *
 * Typed records are enumerable from any branch, but each one takes the next
 * sequence of the branch selected when it is written, as any record does:
 * the journal's own records sit between a branch's messages.
 *
 * The records are the journal's only truth, and a use reads only the ones
 * it needs. Every acceptance compares with the branch's newest record,
 * whichever journal on the store wrote it, read back from the store's newest
 * record. A compile is accepted once: it carries where the journal stood
 * when it ran (a durable record, see JournalMark), and a retry finds the
 * record its first acceptance wrote among the records after that, whether
 * that acceptance changed the layout or not, reported success or failure
 * after landing, ran in another journal, or ran before a reopen. Each record
 * names its branch's previous receipt, so reading a branch's receipts reads
 * only receipts.
 *
 * An acceptance is durable before it is reported, and never outlives what it
 * names: the store syncs before the record is appended (so the messages and
 * summaries it names are durable first) and again after (so the record is),
 * and only then does `accept` return or tell its listeners.
 */

import { randomUUID } from 'node:crypto';
import type { JsStore } from '@animalabs/chronicle';
import type { BranchRef, CompileProvenance, JournalMark, LayoutUnit, RenderedLayout } from './types/index.js';

export const STORE_IDENTITY_RECORD = 'context-manager/store-identity';
export const ACCEPTED_LAYOUT_RECORD = 'context-manager/accepted-layout';

/** The accepted-layout record format. Records of another format are not
 *  read: formats 1 and 2 were never released. */
const RECORD_VERSION = 3;
/** How many receipts listFoldReceipts returns when no limit is given, and the most it returns for any limit. */
export const FOLD_QUERY_DEFAULT_LIMIT = 10;
export const FOLD_QUERY_MAX_LIMIT = 100;

/** Provider usage of the round that confirmed a layout, as reported. */
export interface RoundUsage {
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

/** Deployment facts the host supplies; recorded in every receipt as written. */
export interface ReceiptSource {
  runtime?: string;
  dataDirectory?: string;
  agent?: string;
}

export type FoldForm =
  | { form: 'raw'; partial?: true }
  | { form: 'summary'; level: number; summaries: Array<{ id: string; level: number; method: string; partial?: true }> }
  | { form: 'omitted' };

export interface FoldSpanBound {
  sequence: number;
  messageId: string;
}

/** One run of messages whose form changed, as rendered before and after. */
export interface FoldChange {
  first: FoldSpanBound;
  last: FoldSpanBound;
  /** How many messages the run holds (exact: present in both layouts). */
  messages?: number;
  before: FoldForm;
  after: FoldForm;
  /** Estimated rendered tokens of the run in each form (a summary is counted
   *  once per receipt side, in the first run it appears in). */
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

/** One run of a baseline's layout, as rendered then. */
export interface FoldLayoutRun {
  first: FoldSpanBound;
  last: FoldSpanBound;
  messages?: number;
  form: FoldForm;
  estimatedTokens: number;
}

export interface FoldReceiptSource {
  runtime: string;
  storeId: string;
  agent: string;
  namespace: string;
  dataDirectory: string;
  branch: BranchRef;
}

export interface FoldReceipt {
  v: 1;
  /** The journal record's id: stable, ordered, usable as `afterId`. */
  id: string;
  kind: 'baseline' | 'change';
  /** When the confirming round was accepted. Context only, never identity. */
  acceptedAt: string;
  /** The log these sequences and ids belong to. */
  source: FoldReceiptSource;
  compileId: string;
  strategy: string;
  /** 'change': the runs whose form changed. */
  changes?: FoldChange[];
  /** 'baseline': the whole layout as rendered then; history before it is unknown. */
  layout?: FoldLayoutRun[];
  historyBefore?: 'unknown';
  renderedTokens: { before: number | 'unknown'; after: number };
  cause: string;
  /** The confirming round's usage. It belongs to the whole round: no part of
   *  it is the cost of the fold. */
  usage: { input: number | 'unknown'; cacheRead: number | 'unknown'; cacheWrite: number | 'unknown'; scope: 'round' };
  /**
   * How the confirming round carried this compile, as its producer reported:
   * `verbatim` (every consumer message carried as compiled), `altered` (some
   * consumer content was not carried verbatim), or `unknown` (the producer
   * could not establish it, or did not report). The layout is the compile's;
   * only `verbatim` makes it exactly what the resident was shown.
   */
  presentation: Presentation;
  /** The calibration the confirming compile captured: every estimated token
   *  count in the receipt applies it, on both sides, to the layouts' base
   *  estimates. (`usage` is the provider's report, not an estimate.) */
  estimate: { calibration: number };
}

export type Presentation = 'verbatim' | 'altered' | 'unknown';

export interface FoldQuery {
  /**
   * Only receipts after this receipt id, OLDEST first: a continuation. Pass
   * the last receipt a previous `afterId` query returned to read on from it
   * (`more` says whether there is more), a result's `latestId` to see only
   * new receipts, or `'0'` to page through the whole record from its start.
   * Without it, a query returns the newest receipts first; the last receipt
   * of such a page is its oldest, so reading on from it would repeat newer
   * ones.
   */
  afterId?: string;
  /** Only receipts accepted at or after this ISO 8601 time, such as
   *  `2026-10-09T14:00:00Z`. A bare number is refused: it could be either an
   *  id or epoch milliseconds, and an id goes in `afterId`. */
  since?: string;
  limit?: number;
  /**
   * The branch: a name, or a branch as receipts name it (`{ id, created }`);
   * the selected branch when omitted. A name finds the live branch first,
   * then the most recently recorded deleted branch of that name with
   * receipts. An older branch whose name was reused is reached by its id.
   */
  branch?: string | Pick<BranchRef, 'id' | 'created'>;
}

export interface FoldQueryResult {
  branch: BranchRef | null;
  /** Newest first; with `afterId`, oldest first from just after it. */
  receipts: FoldReceipt[];
  /** Newest receipt id on that branch, if any. */
  latestId: string | null;
  /**
   * The query matched more receipts than `limit` let it return. With
   * `afterId`, continue from the last receipt returned; without, the newest
   * `limit` were returned and the older ones were left out.
   */
  more: boolean;
  /** Explains an empty or unknown answer (unknown branch, no layout reporting). */
  note?: string;
}

/**
 * One accepted-layout record (format 3). Every acceptance writes one: the
 * branch's new last accepted layout, as a snapshot or as a delta on the
 * branch's previous record, together with the receipt it produced, if any.
 *
 * A layout is kept as two parts: its members (sequences, gap-coded; see
 * encodeSequences) and its units (forms with counts). A delta edits each
 * part separately: members as the sequences removed and added, units as a
 * prefix kept, a span replaced and a tail appended. Arrivals cost their own
 * members and units; a fold costs the units it changes; and the history
 * behind the window costs nothing beyond its members, in snapshots only.
 */
interface AcceptedLayoutRecord {
  v: typeof RECORD_VERSION;
  ns: string;
  branch: BranchRef;
  compileId: string;
  kind: 'snapshot' | 'delta';
  /** Snapshot: the members, gap-coded. */
  m?: string;
  /** Snapshot: the units. */
  units?: LayoutUnit[];
  /** Delta: the record it edits. */
  prev?: string;
  /** Delta: the members removed and added, gap-coded. */
  mr?: string;
  ma?: string;
  /** Delta: keep `p` units, drop `drop`, insert `ins`, keep the rest, append `app`. */
  p?: number;
  drop?: number;
  ins?: LayoutUnit[];
  app?: LayoutUnit[];
  totalTokens: number;
  /** Deltas since the snapshot, this one included (0 for a snapshot). */
  chain: number;
  /** The snapshot record's size, and the delta records' since it (this one
   *  included; 0 for a snapshot), each as its JSON, receipt and all. */
  sb: number;
  db: number;
  /** The branch's newest receipt before this record, if any: receipts link
   *  back through it, so a branch's receipts are found by reading only them. */
  pr?: string;
  /** The receipt this acceptance produced; its id is the record's id. */
  receipt?: Omit<FoldReceipt, 'id'>;
}

/** A layout as an acceptance persists it: membership and forms, no ids. */
export interface StoredLayout {
  members: number[];
  units: LayoutUnit[];
}

interface LatestLayout extends StoredLayout {
  recordId: string;
  totalTokens: number;
  chain: number;
  snapshotBytes: number;
  deltaBytes: number;
}

const storeIdentityCache = new WeakMap<JsStore, string>();

/** The store's id, minted once (as a typed record) on first use. */
export function storeIdentity(store: JsStore): string {
  const cached = storeIdentityCache.get(store);
  if (cached) return cached;
  const ids = store.getRecordIdsByType(STORE_IDENTITY_RECORD);
  for (const id of ids) {
    const parsed = readRecord<{ storeId?: unknown }>(store, id);
    if (parsed && typeof parsed.storeId === 'string' && parsed.storeId) {
      // It may be the record of a mint whose sync failed, durable or not:
      // make it durable before anyone is told it, as after a mint.
      store.sync();
      storeIdentityCache.set(store, parsed.storeId);
      return parsed.storeId;
    }
  }
  const storeId = randomUUID();
  store.appendJson(STORE_IDENTITY_RECORD, { v: 1, storeId, mintedAt: new Date().toISOString() });
  store.sync();
  storeIdentityCache.set(store, storeId);
  return storeId;
}

export function branchRefOf(store: JsStore): BranchRef {
  const b = store.currentBranch();
  return { id: b.id, name: b.name, created: b.created };
}

export function branchKey(branch: BranchRef): string {
  return `${branch.id}@${branch.created}`;
}

function readRecord<T>(store: JsStore, id: string): T | null {
  const record = store.getRecord(id);
  if (!record) return null;
  try {
    return JSON.parse(record.payload.toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** A record's size as stored: its JSON, in UTF-8 bytes. */
function recordBytes(record: AcceptedLayoutRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

function isLayoutRecord(record: AcceptedLayoutRecord | null): record is AcceptedLayoutRecord {
  return !!record && record.v === RECORD_VERSION && typeof record.ns === 'string'
    && typeof record.compileId === 'string' && !!record.branch;
}

/** What a record's envelope says: enough to place it, without its layout. */
interface RecordHead {
  id: string;
  ns: string;
  branch: BranchRef;
  compileId: string;
  /** Its receipt's acceptance time (ms) when it holds one, else null. */
  receiptAt: number | null;
  /** The branch's newest receipt before it, if any. */
  prevReceipt: string | null;
  /** Of this format, so its layout can be rebuilt. */
  readable: boolean;
}

function headOf(id: string, record: Partial<AcceptedLayoutRecord> | null): RecordHead | null {
  if (!record || typeof record !== 'object' || typeof record.ns !== 'string'
    || typeof record.compileId !== 'string' || !record.branch || typeof record.branch.id !== 'string') return null;
  return {
    id,
    ns: record.ns,
    branch: record.branch,
    compileId: record.compileId,
    receiptAt: record.receipt ? Date.parse(record.receipt.acceptedAt) : null,
    prevReceipt: typeof record.pr === 'string' ? record.pr : null,
    readable: record.v === RECORD_VERSION,
  };
}

/** One branch's records, as far as a use has needed them. */
interface BranchState {
  ref: BranchRef;
  /** Its newest record, whatever its format. */
  newest: RecordHead;
  /** Its newest receipt's record id, if any. */
  newestReceipt: string | null;
  /** Its receipts, oldest first: walked back from the newest the first time
   *  a query needs them, or kept from the branch's first record when this
   *  store object wrote it; extended as records are written. */
  receipts?: Array<{ id: string; at: number }>;
}

/**
 * What the journals on one store object know of its accepted-layout
 * records. Chronicle locks a store to one open object, so every writer is a
 * journal on it. The index lists the type's ids once (in log order, which is
 * ascending by id, after a torn tail's truncation too) and adds each record
 * a journal writes; it reads a record only when a use needs it. An append
 * that throws may still have landed, so it leaves the index stale, and the
 * next use lists again, reading only the records it didn't have. A reopened
 * store is a new object, indexed afresh.
 */
interface StoreIndex {
  ids: string[];
  /** Until the records after an append that threw are listed. */
  stale: boolean;
  /** How many of `ids` are known durable: those before the last successful sync. */
  durable: number;
  /** The newest durable record whose compile is known, for compiles to carry. */
  mark: JournalMark | null;
  /** The newest record's envelope, when it could be read. */
  newest: RecordHead | null;
  /** Each branch found so far, by namespace and branch key; null when the
   *  records hold none of it. */
  branches: Map<string, BranchState | null>;
  /** Records already reported as unreadable. */
  warned: Set<string>;
}

const storeIndexes = new WeakMap<JsStore, StoreIndex>();
/** Store objects whose index couldn't be read for a compile's mark, already reported. */
const markFailures = new WeakSet<JsStore>();

function stateKey(namespace: string, branch: Pick<BranchRef, 'id' | 'created'>): string {
  return `${namespace}\u0000${branch.id}@${branch.created}`;
}

/** The store's index, listing its records first if it must. */
function storeIndex(store: JsStore): StoreIndex {
  let index = storeIndexes.get(store);
  if (!index) {
    const built: StoreIndex = { ids: store.getRecordIdsByType(ACCEPTED_LAYOUT_RECORD), stale: false, durable: 0, mark: null, newest: null, branches: new Map(), warned: new Set() };
    if (built.ids.length > 0) {
      // One sync makes everything present at open durable, so a compile can
      // carry any of it as its mark: a record a crash could still take might
      // have its id reissued.
      store.sync();
      built.durable = built.ids.length;
      built.newest = readHead(store, built, built.ids[built.ids.length - 1]!);
      for (let i = built.ids.length - 1; i >= 0 && !built.mark; i--) {
        const head = i === built.ids.length - 1 ? built.newest : readHead(store, built, built.ids[i]!);
        if (head) built.mark = { recordId: head.id, compileId: head.compileId };
      }
    }
    // Kept only once every step above has succeeded, so a failed one is
    // tried again at the next use.
    storeIndexes.set(store, built);
    index = built;
  } else if (index.stale) {
    // Only an append of this object's can have added to the list: one at a
    // time, so a read that throws partway counts nothing twice.
    const ids = store.getRecordIdsByType(ACCEPTED_LAYOUT_RECORD);
    for (let i = index.ids.length; i < ids.length; i++) {
      const head = readHead(store, index, ids[i]!);
      index.ids.push(ids[i]!);
      index.newest = head;
      if (head) noteRecord(index, head);
    }
    index.stale = false;
  }
  return index;
}

/** A record's envelope, or null when it has none to read (reported once). */
function readHead(store: JsStore, index: StoreIndex, id: string): RecordHead | null {
  const head = headOf(id, readRecord<AcceptedLayoutRecord>(store, id));
  if (!head) warnUnreadable(index, id, 'it does not parse as an accepted-layout record');
  return head;
}

function warnUnreadable(index: StoreIndex, id: string, why: string): void {
  if (index.warned.has(id)) return;
  index.warned.add(id);
  console.error(`[fold-journal] accepted-layout record ${id} is unreadable (${why})`);
}

/** A record now the newest of its branch: its envelope says what came before. */
function noteRecord(index: StoreIndex, head: RecordHead): void {
  const key = stateKey(head.ns, head.branch);
  const known = index.branches.get(key);
  const newestReceipt = head.receiptAt !== null ? head.id : head.prevReceipt;
  if (known) {
    known.ref = head.branch;
    known.newest = head;
    known.newestReceipt = newestReceipt;
    if (known.receipts && head.receiptAt !== null) known.receipts.push({ id: head.id, at: head.receiptAt });
    return;
  }
  // A branch the records held none of starts here, so its receipts are known.
  const receipts = known === null ? (head.receiptAt !== null ? [{ id: head.id, at: head.receiptAt }] : []) : undefined;
  index.branches.set(key, { ref: head.branch, newest: head, newestReceipt, ...(receipts ? { receipts } : {}) });
}

/** Everything listed is durable now: a sync has just succeeded. */
function markDurable(index: StoreIndex): void {
  index.durable = index.ids.length;
  if (index.newest) index.mark = { recordId: index.newest.id, compileId: index.newest.compileId };
}

/** The position just after `id` in an ascending id list (ids are decimal integers). */
function positionAfter(ids: readonly string[], id: string): number {
  const after = Number(id);
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(ids[mid]!) <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export class FoldJournal {
  private source: ReceiptSource = {};
  /** Each branch's last accepted layout as this journal last read or wrote
   *  it, used only while its record is still the branch's newest. */
  private readonly latest = new Map<string, LatestLayout>();
  private readonly listeners = new Set<(receipt: FoldReceipt) => void>();
  /** Receipt ids this journal has announced to its listeners. */
  private readonly notified = new Set<string>();

  constructor(
    private readonly store: JsStore,
    private readonly namespace: string,
  ) {}

  /**
   * Where the journal stands, for a compile to carry (see JournalMark).
   * Called inside every compile, so it never throws: when the store can't
   * be read or synced, the compile carries no mark (an acceptance of it then
   * reads every record), and the failure is reported once per store object.
   */
  mark(): JournalMark | null {
    try {
      return storeIndex(this.store).mark;
    } catch (err) {
      if (!markFailures.has(this.store)) {
        markFailures.add(this.store);
        console.error(`[fold-journal] can't tell where the journal stands (${(err as Error).message}); compiles carry no mark until it can`);
      }
      return null;
    }
  }

  setSource(source: ReceiptSource): void {
    this.source = { ...this.source, ...source };
  }

  onReceipt(listener: (receipt: FoldReceipt) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Accept the layout of a compile whose provider round succeeded. Writes a
   * receipt when the layout changed form relative to the last accepted layout
   * on the compile's branch (or a baseline when that branch has none, or its
   * newest record can't be read), and records the layout as the branch's
   * last accepted one. Idempotent per compile: a compile accepted before
   * returns the receipt that acceptance wrote, or null when it wrote none.
   * Returns the receipt, if any. A compile of another namespace is refused.
   */
  accept(
    provenance: CompileProvenance,
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation = 'unknown',
  ): FoldReceipt | null {
    if (provenance.namespace !== this.namespace) {
      throw new Error(
        `a compile of namespace ${JSON.stringify(provenance.namespace)} can't be accepted by the manager of ` +
          `${JSON.stringify(this.namespace)}: accept it on the manager that compiled it`,
      );
    }
    const layout = provenance.layout;
    if (!layout) return null;
    const index = storeIndex(this.store);
    const branch = this.branchState(index, provenance.branch);
    // The branch's newest receipt may be one this journal never announced:
    // its write reported failure after landing, in this stream or the turn
    // before, or another journal wrote it, whether or not records without a
    // receipt followed it. Announce it now, whatever this compile turns out
    // to be, so listeners (a projection) converge on the canonical record.
    if (branch?.newestReceipt && !this.notified.has(branch.newestReceipt)) {
      const receipt = this.loadReceipt(branch.newestReceipt);
      if (receipt) {
        // Its write may have failed at the sync after the append, leaving it
        // in the log with its durability unknown: durable before heard of.
        this.makeDurable(index, receipt.id);
        this.announce(receipt);
      }
    }
    // A compile is accepted once, whichever journal accepted it, and whether
    // or not that acceptance changed the layout or reported success: a retry
    // gets the first acceptance's answer, once its record is durable.
    const accepted = this.findAccepted(index, provenance);
    if (accepted) {
      this.makeDurable(index, accepted.id);
      const receipt = accepted.receiptAt !== null ? this.loadReceipt(accepted.id) : null;
      if (receipt) this.announce(receipt);
      return receipt;
    }
    const prev = branch ? this.loadLatest(index, branch) : null;

    let draft: Omit<FoldReceipt, 'id'> | null = null;
    if (!prev) {
      draft = this.baselineReceipt(provenance, layout, acceptedAt, usage, presentation);
    } else {
      const changes = diffLayouts(prev, layout, layout.calibration);
      if (changes.length > 0) draft = this.changeReceipt(provenance, layout, prev, changes, acceptedAt, usage, presentation);
    }
    const receipt = this.commit(index, branch, provenance, layout, prev, draft);
    if (receipt) this.announce(receipt);
    return receipt;
  }

  /**
   * This namespace's record of a compile's acceptance, if one exists. Only a
   * record after the compile's mark can hold it: the mark was durable when
   * the compile ran, so it outlives any crash, keeps its id, and precedes
   * every record written since. A mark that is gone, or whose id now names
   * another compile's record (its record rotted at the end of the log, and
   * the id went to a later one), proves nothing, and every record is read.
   */
  private findAccepted(index: StoreIndex, provenance: CompileProvenance): RecordHead | null {
    let from = 0;
    const mark = provenance.journalMark;
    if (mark) {
      const head = readHead(this.store, index, mark.recordId);
      if (head && head.compileId === mark.compileId) from = positionAfter(index.ids, mark.recordId);
    }
    for (let i = index.ids.length - 1; i >= from; i--) {
      const head = readHead(this.store, index, index.ids[i]!);
      if (head && head.ns === this.namespace && head.compileId === provenance.compileId) return head;
    }
    return null;
  }

  /** Sync, unless the record is known durable already. */
  private makeDurable(index: StoreIndex, id: string): void {
    if (positionAfter(index.ids, id) <= index.durable) return;
    this.store.sync();
    markDurable(index);
  }

  /** The branch as far as the records say, read back from the newest record. */
  private branchState(index: StoreIndex, ref: Pick<BranchRef, 'id' | 'created'>): BranchState | null {
    const key = stateKey(this.namespace, ref);
    const known = index.branches.get(key);
    if (known !== undefined) return known;
    for (let i = index.ids.length - 1; i >= 0; i--) {
      const head = readHead(this.store, index, index.ids[i]!);
      if (!head || stateKey(head.ns, head.branch) !== key) continue;
      const state: BranchState = { ref: head.branch, newest: head, newestReceipt: head.receiptAt !== null ? head.id : head.prevReceipt };
      index.branches.set(key, state);
      return state;
    }
    index.branches.set(key, null);
    return null;
  }

  /** A branch's receipts, oldest first, walked back once from its newest. */
  private receiptsOf(index: StoreIndex, branch: BranchState): Array<{ id: string; at: number }> {
    if (branch.receipts) return branch.receipts;
    const list: Array<{ id: string; at: number }> = [];
    let id = branch.newestReceipt;
    while (id !== null) {
      const head = readHead(this.store, index, id);
      if (!head || head.receiptAt === null) break;
      list.push({ id, at: head.receiptAt });
      // Each link points to an earlier record; anything else ends the walk.
      id = head.prevReceipt !== null && Number(head.prevReceipt) < Number(id) ? head.prevReceipt : null;
    }
    branch.receipts = list.reverse();
    return branch.receipts;
  }

  /** Tell listeners about a receipt, once per receipt per journal. */
  private announce(receipt: FoldReceipt): void {
    if (this.notified.has(receipt.id)) return;
    this.notified.add(receipt.id);
    for (const listener of this.listeners) {
      try {
        listener(receipt);
      } catch (err) {
        console.error('[fold-journal] receipt listener failed:', err);
      }
    }
  }

  /**
   * Receipts of one branch, newest first, filtered per `query`. Reads only
   * the receipts it returns.
   */
  query(query: FoldQuery = {}): FoldQueryResult {
    const index = storeIndex(this.store);
    const branch = this.resolveBranch(index, query.branch);
    if (!branch) {
      const named = typeof query.branch === 'string'
        ? `named ${JSON.stringify(query.branch)}`
        : `with id ${JSON.stringify(query.branch?.id)} created ${String(query.branch?.created)}`;
      return { branch: null, receipts: [], latestId: null, more: false, note: `No branch ${named} exists in this store.` };
    }
    const limit = clampLimit(query.limit);
    const after = query.afterId !== undefined ? parseAfterId(query.afterId) : undefined;
    const since = query.since !== undefined ? parseSince(query.since) : undefined;
    const state = this.branchState(index, branch);
    const list = state ? this.receiptsOf(index, state) : [];
    const latestId = list.length > 0 ? list[list.length - 1]!.id : null;
    const matches = (entry: { at: number }) => since === undefined || entry.at >= since;
    const receipts: FoldReceipt[] = [];
    let more = false;
    const take = (entry: { id: string; at: number }): boolean => {
      if (!matches(entry)) return true;
      if (receipts.length === limit) {
        more = true;
        return false;
      }
      const receipt = this.loadReceipt(entry.id);
      if (receipt) receipts.push(receipt);
      return true;
    };
    if (after !== undefined) {
      // Ids ascend: start just after the cursor and read forward.
      for (let i = firstAfter(list, after); i < list.length && take(list[i]!); i++);
    } else {
      for (let i = list.length - 1; i >= 0 && take(list[i]!); i--);
    }
    return { branch, receipts, latestId, more };
  }

  /** The store's id (minted on first use). */
  storeId(): string {
    return storeIdentity(this.store);
  }

  // --------------------------------------------------------------------------

  private loadReceipt(id: string): FoldReceipt | null {
    const record = readRecord<AcceptedLayoutRecord>(this.store, id);
    return isLayoutRecord(record) && record.receipt ? ({ ...record.receipt, id } as FoldReceipt) : null;
  }

  private resolveBranch(index: StoreIndex, branch: FoldQuery['branch']): BranchRef | null {
    if (branch === undefined) return branchRefOf(this.store);
    const live = this.store.listBranches();
    if (typeof branch !== 'string') {
      // As receipts name it: live or deleted, whatever its name now.
      const match = live.find((b) => b.id === branch.id && b.created === branch.created);
      if (match) return { id: match.id, name: match.name, created: match.created };
      return this.branchState(index, branch)?.ref ?? null;
    }
    const match = live.find((b) => b.name === branch);
    if (match) return { id: match.id, name: match.name, created: match.created };
    // A deleted branch's receipts remain in the journal: the most recently
    // recorded branch of that name that has any. The first record met of
    // each branch, reading back, is its newest, and says so.
    const seen = new Set<string>();
    for (let i = index.ids.length - 1; i >= 0; i--) {
      const head = readHead(this.store, index, index.ids[i]!);
      if (!head || head.ns !== this.namespace || head.branch.name !== branch) continue;
      const key = stateKey(head.ns, head.branch);
      if (seen.has(key)) continue;
      seen.add(key);
      if (head.receiptAt !== null || head.prevReceipt !== null) return head.branch;
    }
    return null;
  }

  private sourceFor(provenance: CompileProvenance): FoldReceiptSource {
    return {
      runtime: this.source.runtime ?? 'unknown',
      storeId: this.storeId(),
      agent: this.source.agent ?? 'unknown',
      namespace: this.namespace,
      dataDirectory: this.source.dataDirectory ?? 'unknown',
      branch: provenance.branch,
    };
  }

  private common(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation,
  ) {
    return {
      v: 1 as const,
      acceptedAt: new Date(acceptedAt).toISOString(),
      source: this.sourceFor(provenance),
      compileId: provenance.compileId,
      strategy: provenance.strategy,
      cause: layout.cause ?? 'unknown',
      usage: {
        input: knownOrUnknown(usage?.inputTokens),
        cacheRead: knownOrUnknown(usage?.cacheReadTokens),
        cacheWrite: knownOrUnknown(usage?.cacheCreationTokens),
        scope: 'round' as const,
      },
      estimate: { calibration: layout.calibration },
      presentation,
    };
  }

  private baselineReceipt(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation,
  ): Omit<FoldReceipt, 'id'> {
    return {
      ...this.common(provenance, layout, acceptedAt, usage, presentation),
      kind: 'baseline',
      historyBefore: 'unknown',
      layout: layoutRuns(layout, layout.calibration),
      renderedTokens: { before: 'unknown', after: calibrated(layout.totalTokens, layout.calibration) },
    };
  }

  private changeReceipt(
    provenance: CompileProvenance,
    layout: RenderedLayout,
    prev: LatestLayout,
    changes: FoldChange[],
    acceptedAt: number,
    usage: RoundUsage | undefined,
    presentation: Presentation,
  ): Omit<FoldReceipt, 'id'> {
    return {
      ...this.common(provenance, layout, acceptedAt, usage, presentation),
      kind: 'change',
      changes,
      renderedTokens: {
        before: calibrated(prev.totalTokens, layout.calibration),
        after: calibrated(layout.totalTokens, layout.calibration),
      },
    };
  }

  /**
   * Commit one acceptance: the branch's new last accepted layout together
   * with its receipt (if any), as ONE record. Returns the receipt.
   *
   * Every acceptance writes its record, an unchanged layout included (an
   * empty delta), so every accepted compile is in the index. The layout is a
   * delta on the branch's previous record, or a snapshot once the delta
   * records written since the last snapshot, this one included, would
   * outweigh that snapshot's record. Sizes are whole records as JSON,
   * receipts included, so the bound holds on what is stored. The records
   * after a snapshot never outweigh it, and every snapshot but the newest is
   * outweighed by the records after it plus the one that tipped the next:
   * snapshots in all cost about as much again as the deltas between them,
   * and rebuilding a layout reads at most two snapshots' worth. No count of
   * deltas forces a snapshot, so a chain of small deltas behind a large
   * snapshot stays a chain. A failed append may or may not have landed, so
   * the branch's cached latest layout is dropped and the index is listed
   * again at its next use: the next acceptance finds this compile already
   * accepted if its record did land, instead of writing a second receipt.
   */
  private commit(
    index: StoreIndex,
    branch: BranchState | null,
    provenance: CompileProvenance,
    layout: RenderedLayout,
    prev: LatestLayout | null,
    draft: Omit<FoldReceipt, 'id'> | null,
  ): FoldReceipt | null {
    const key = branchKey(provenance.branch);
    const next: StoredLayout = { members: layout.members, units: layout.units };
    const pr = branch?.newestReceipt ?? null;
    const base = {
      v: RECORD_VERSION as typeof RECORD_VERSION,
      ns: this.namespace,
      branch: provenance.branch,
      compileId: provenance.compileId,
      totalTokens: layout.totalTokens,
      ...(pr !== null ? { pr } : {}),
    };
    const receipt = draft ? { receipt: draft } : {};
    let record: AcceptedLayoutRecord | null = null;
    if (prev) {
      const delta: AcceptedLayoutRecord = {
        ...base, kind: 'delta', prev: prev.recordId, ...layoutDelta(prev, next),
        chain: prev.chain + 1, sb: prev.snapshotBytes, db: 0, ...receipt,
      };
      const db = prev.deltaBytes + recordBytes(delta);
      if (db <= prev.snapshotBytes) record = { ...delta, db };
    }
    if (!record) {
      const snapshot: AcceptedLayoutRecord = {
        ...base, kind: 'snapshot', m: encodeSequences(next.members), units: next.units,
        chain: 0, sb: 0, db: 0, ...receipt,
      };
      record = { ...snapshot, sb: recordBytes(snapshot) };
    }

    let written: { id: string };
    try {
      // The record names state committed in Chronicle states (summaries,
      // strategy state) as well as messages. A state's head is persisted
      // only by sync, and Chronicle 0.4 does not advance it from the log on
      // open, so a record synced alone could outlive the state it names
      // after an unclean stop: make that state durable first.
      this.store.sync();
      markDurable(index);
      written = this.store.appendJson(ACCEPTED_LAYOUT_RECORD, record);
      // Then the record itself, before anyone hears of it: the caller marks
      // the round accepted and listeners project the receipt once this
      // returns.
      this.store.sync();
    } catch (err) {
      this.latest.delete(key);
      index.stale = true;
      throw err;
    }
    const head = headOf(written.id, record)!;
    index.ids.push(written.id);
    index.newest = head;
    noteRecord(index, head);
    markDurable(index);
    this.latest.set(key, {
      recordId: written.id,
      members: next.members,
      units: next.units,
      totalTokens: layout.totalTokens,
      chain: record.chain,
      snapshotBytes: record.sb,
      deltaBytes: record.db,
    });
    return draft ? ({ ...draft, id: written.id } as FoldReceipt) : null;
  }

  /**
   * The last accepted layout of a branch: its newest record in the index,
   * whichever journal on the store wrote it, rebuilt unless this journal
   * already holds that record's layout.
   */
  private loadLatest(index: StoreIndex, branch: BranchState): LatestLayout | null {
    const key = branchKey(branch.ref);
    const id = branch.newest.id;
    const cached = this.latest.get(key);
    if (cached && cached.recordId === id) return cached;
    if (!branch.newest.readable) {
      warnUnreadable(index, id, `it is of another format; branch ${branch.ref.name} is treated as unrecorded`);
      return null;
    }
    const record = readRecord<AcceptedLayoutRecord>(this.store, id);
    let layout: StoredLayout | null = null;
    try {
      if (!isLayoutRecord(record)) throw new Error('it no longer reads as one');
      layout = this.reconstruct(record);
    } catch (err) {
      warnUnreadable(index, id, `its layout doesn't rebuild: ${(err as Error).message}; branch ${branch.ref.name} is treated as unrecorded`);
      return null;
    }
    const latest: LatestLayout = {
      recordId: id,
      ...layout,
      totalTokens: record.totalTokens,
      chain: record.chain,
      snapshotBytes: record.sb,
      deltaBytes: record.db,
    };
    this.latest.set(key, latest);
    return latest;
  }

  /** A record's layout, from its snapshot and the deltas since. Throws when the chain doesn't rebuild. */
  private reconstruct(record: AcceptedLayoutRecord): StoredLayout {
    const chain: AcceptedLayoutRecord[] = [];
    let current: AcceptedLayoutRecord | null = record;
    while (current && current.kind === 'delta') {
      chain.push(current);
      if (!current.prev) throw new Error(`delta ${current.compileId} names no record before it`);
      const older: AcceptedLayoutRecord | null = readRecord<AcceptedLayoutRecord>(this.store, current.prev);
      if (!isLayoutRecord(older)) throw new Error(`record ${current.prev} in its chain can't be read`);
      current = older;
    }
    if (current.m === undefined || !current.units) throw new Error('its snapshot holds no layout');
    const layout = applyLayoutChain({ members: decodeSequences(current.m), units: current.units }, chain.reverse());
    if (!wellFormed(layout)) throw new Error('members and units disagree');
    return layout;
  }
}

function knownOrUnknown(value: number | undefined): number | 'unknown' {
  return typeof value === 'number' && Number.isFinite(value) ? value : 'unknown';
}

function calibrated(base: number, calibration: number): number {
  return Math.round(base * (Number.isFinite(calibration) && calibration > 0 ? calibration : 1));
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return FOLD_QUERY_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`limit must be a positive integer (got ${String(limit)})`);
  }
  return Math.min(limit, FOLD_QUERY_MAX_LIMIT);
}

/** The index of the first entry whose id is above `after` (ids ascend). */
function firstAfter(list: ReadonlyArray<{ id: string }>, after: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Number(list[mid]!.id) <= after) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A receipt id: Chronicle record ids are decimal integers. */
function parseAfterId(afterId: string): number {
  if (!/^\d+$/.test(afterId)) {
    throw new Error(`afterId must be a receipt id, a decimal integer (got ${JSON.stringify(afterId)})`);
  }
  return Number(afterId);
}

/** An ISO 8601 date or date-time; anything else, a bare number included, is refused. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function parseSince(since: string): number {
  const ms = ISO_TIME.test(since) ? Date.parse(since) : NaN;
  if (!Number.isFinite(ms)) {
    const hint = /^\d+$/.test(since) ? ' To continue after a receipt, pass its id as afterId.' : '';
    throw new Error(`since must be an ISO 8601 time such as 2026-10-09T14:00:00Z (got ${JSON.stringify(since)}).${hint}`);
  }
  return ms;
}

// ============================================================================
// Membership encoding
// ============================================================================

/**
 * Ascending sequences as text: the first, then each gap to the next, every
 * number an unsigned LEB128 varint, all base64url. Store sequences are
 * shared with every other record on the branch, so a layout's members are
 * rarely consecutive; their gaps are small, about 1.3 bytes each.
 */
export function encodeSequences(sequences: readonly number[]): string {
  const bytes: number[] = [];
  let prev = 0;
  for (let i = 0; i < sequences.length; i++) {
    const value = sequences[i]!;
    let v = i === 0 ? value : value - prev;
    if (!Number.isSafeInteger(value) || v < (i === 0 ? 0 : 1)) {
      throw new Error(`sequences must be ascending non-negative integers (at ${i}: ${value})`);
    }
    while (v >= 128) {
      bytes.push((v % 128) + 128);
      v = Math.floor(v / 128);
    }
    bytes.push(v);
    prev = value;
  }
  return Buffer.from(bytes).toString('base64url');
}

export function decodeSequences(text: string): number[] {
  const bytes = Buffer.from(text, 'base64url');
  const out: number[] = [];
  let value = 0;
  let scale = 1;
  let prev = 0;
  for (const byte of bytes) {
    value += (byte % 128) * scale;
    if (byte >= 128) {
      scale *= 128;
      if (scale > 2 ** 56) throw new Error('sequence varint too long');
      continue;
    }
    const sequence = out.length === 0 ? value : prev + value;
    if (out.length > 0 && value < 1) throw new Error('sequences must ascend');
    out.push(sequence);
    prev = sequence;
    value = 0;
    scale = 1;
  }
  if (scale !== 1) throw new Error('truncated sequence varint');
  return out;
}

/** The sequences only `before` holds, and those only `after` holds. */
function membershipDelta(before: readonly number[], after: readonly number[]): { removed: number[]; added: number[] } {
  const removed: number[] = [];
  const added: number[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length || j < after.length) {
    if (j >= after.length || (i < before.length && before[i]! < after[j]!)) removed.push(before[i++]!);
    else if (i >= before.length || after[j]! < before[i]!) added.push(after[j++]!);
    else { i++; j++; }
  }
  return { removed, added };
}

/** `members` with each sequence's final change applied: false removes it, true adds it. */
function applyMembershipChanges(members: readonly number[], changed: ReadonlyMap<number, boolean>): number[] {
  if (changed.size === 0) return [...members];
  const kept = members.filter((s) => changed.get(s) !== false);
  const added = [...changed].filter(([, present]) => present).map(([s]) => s).sort((a, b) => a - b);
  const out: number[] = [];
  let i = 0;
  let j = 0;
  while (i < kept.length || j < added.length) {
    if (j >= added.length || (i < kept.length && kept[i]! < added[j]!)) out.push(kept[i++]!);
    else if (i < kept.length && kept[i] === added[j]) { out.push(kept[i++]!); j++; }
    else out.push(added[j++]!);
  }
  return out;
}

/** How many members a unit covers. */
function unitCount(u: LayoutUnit): number {
  return u.k === 'r' ? 1 : u.n;
}

/** Members ascend, and the units cover exactly the members. */
function wellFormed(layout: StoredLayout): boolean {
  let covered = 0;
  for (const u of layout.units) {
    const n = unitCount(u);
    if (!Number.isInteger(n) || n < 1) return false;
    covered += n;
  }
  if (covered !== layout.members.length) return false;
  for (let i = 1; i < layout.members.length; i++) {
    if (!(layout.members[i]! > layout.members[i - 1]!)) return false;
  }
  return true;
}

// ============================================================================
// Layout comparison
// ============================================================================

function formKey(u: LayoutUnit): string {
  if (u.k === 'r') return u.p ? 'r:p' : 'r';
  if (u.k === 's') return `s:${u.sm.map((s) => `${s[0]}${s[3] ? '~' : ''}`).join(',')}`;
  return 'o';
}

function formOf(u: LayoutUnit): FoldForm {
  if (u.k === 'r') return u.p ? { form: 'raw', partial: true } : { form: 'raw' };
  if (u.k === 's') {
    return {
      form: 'summary',
      level: Math.max(...u.sm.map((s) => s[1])),
      summaries: u.sm.map(([id, level, method, partial]) => (partial ? { id, level, method, partial: true as const } : { id, level, method })),
    };
  }
  return { form: 'omitted' };
}

/** Walks a layout's members in order, naming the unit each belongs to. */
class UnitCursor {
  private unit = 0;
  private left: number;

  constructor(private readonly units: readonly LayoutUnit[]) {
    this.left = units.length > 0 ? unitCount(units[0]!) : 0;
  }

  get current(): LayoutUnit {
    return this.units[this.unit]!;
  }

  get index(): number {
    return this.unit;
  }

  /** Move to the next member. */
  step(): void {
    this.left--;
    if (this.left === 0 && this.unit + 1 < this.units.length) {
      this.unit++;
      this.left = unitCount(this.units[this.unit]!);
    }
  }
}

/**
 * Compare two layouts over exactly the messages present in both: a merge
 * walk over the two member lists, so a message one view lacked (removed,
 * filtered out) never counts, however near a range it lies. Each message
 * whose form differs is part of a change, and consecutive changed messages
 * with the same before/after forms make one run (messages present on only
 * one side do not break a run). Boundaries and counts are exact; boundary
 * ids are the compile's, from `after`. Tokens count each raw message once,
 * and each summary once per side, in the first changed run that names it.
 */
export function diffLayouts(before: StoredLayout, after: RenderedLayout, calibration: number): FoldChange[] {
  const changes: FoldChange[] = [];
  const countedBefore = new Set<string>();
  const countedAfter = new Set<string>();
  let open: (FoldChange & { key: string }) | null = null;
  const flush = () => {
    if (!open) return;
    const { key: _key, ...change } = open;
    changes.push(change);
    open = null;
  };

  const A = before.members;
  const B = after.members;
  const a = new UnitCursor(before.units);
  const b = new UnitCursor(after.units);
  let i = 0;
  let j = 0;
  while (i < A.length && j < B.length) {
    if (A[i]! < B[j]!) { i++; a.step(); continue; }
    if (B[j]! < A[i]!) { j++; b.step(); continue; }
    const u = a.current;
    const v = b.current;
    const keyBefore = formKey(u);
    const keyAfter = formKey(v);
    if (keyBefore === keyAfter) {
      flush();
    } else {
      const bound = { sequence: B[j]!, messageId: after.memberIds[j]! };
      const tokensBefore = unitTokens(u, countedBefore);
      const tokensAfter = unitTokens(v, countedAfter);
      const key = `${keyBefore}>${keyAfter}`;
      if (open && open.key === key) {
        open.last = bound;
        open.estimatedTokensBefore += tokensBefore;
        open.estimatedTokensAfter += tokensAfter;
        open.messages = (open.messages ?? 0) + 1;
      } else {
        flush();
        open = {
          key,
          first: bound,
          last: bound,
          messages: 1,
          before: formOf(u),
          after: formOf(v),
          estimatedTokensBefore: tokensBefore,
          estimatedTokensAfter: tokensAfter,
        };
      }
    }
    i++; a.step();
    j++; b.step();
  }
  flush();
  for (const change of changes) {
    change.estimatedTokensBefore = calibrated(change.estimatedTokensBefore, calibration);
    change.estimatedTokensAfter = calibrated(change.estimatedTokensAfter, calibration);
  }
  return changes;
}

/**
 * A unit's rendered tokens on one side of a comparison, the first time that
 * side meets it: a raw message's own (a raw unit is one message), and each
 * summary's the first time that side meets the summary. `counted` holds the
 * summaries met so far.
 */
function unitTokens(u: LayoutUnit, counted: Set<string>): number {
  if (u.k === 'r') return u.t;
  if (u.k === 'o') return 0;
  let tokens = 0;
  for (const [id, , , , t] of u.sm) {
    if (counted.has(id)) continue;
    counted.add(id);
    tokens += t;
  }
  return tokens;
}

/**
 * A baseline's layout as runs: consecutive raw units grouped. Each summary's
 * tokens count once, in the first run that names it.
 */
export function layoutRuns(layout: RenderedLayout, calibration: number): FoldLayoutRun[] {
  const runs: FoldLayoutRun[] = [];
  const counted = new Set<string>();
  let at = 0;
  for (const u of layout.units) {
    const n = unitCount(u);
    const first = { sequence: layout.members[at]!, messageId: layout.memberIds[at]! };
    const last = { sequence: layout.members[at + n - 1]!, messageId: layout.memberIds[at + n - 1]! };
    at += n;
    const prev = runs[runs.length - 1];
    if (u.k === 'r' && prev && prev.form.form === 'raw' && Boolean(prev.form.partial) === Boolean(u.p)) {
      prev.last = last;
      prev.messages = (prev.messages ?? 0) + 1;
      prev.estimatedTokens += u.t;
      continue;
    }
    runs.push({ first, last, messages: n, form: formOf(u), estimatedTokens: unitTokens(u, counted) });
  }
  for (const run of runs) run.estimatedTokens = calibrated(run.estimatedTokens, calibration);
  return runs;
}

// ============================================================================
// Layout deltas
// ============================================================================

function unitEqual(a: LayoutUnit, b: LayoutUnit): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A layout as an edit of the one before it (see AcceptedLayoutRecord). */
export interface LayoutDelta {
  mr?: string;
  ma?: string;
  p?: number;
  drop?: number;
  ins?: LayoutUnit[];
  app?: LayoutUnit[];
}

/**
 * Express `next` as an edit of `prev`: its members as the sequences removed
 * and added, its units as a common prefix of `p` kept, `drop` dropped, `ins`
 * inserted, the rest of `prev` kept, then `app` appended. Arrivals become
 * added members and appended units; a fold in the middle becomes a small
 * drop/ins; a change to `prev`'s last unit replaces everything after the
 * common prefix. Every pair of layouts has one. Empty parts are left out.
 */
export function layoutDelta(prev: StoredLayout, next: StoredLayout): LayoutDelta {
  const units = unitsDelta(prev.units, next.units);
  const { removed, added } = membershipDelta(prev.members, next.members);
  return {
    ...(removed.length > 0 ? { mr: encodeSequences(removed) } : {}),
    ...(added.length > 0 ? { ma: encodeSequences(added) } : {}),
    p: units.p,
    ...(units.drop > 0 ? { drop: units.drop } : {}),
    ...(units.ins.length > 0 ? { ins: units.ins } : {}),
    ...(units.app.length > 0 ? { app: units.app } : {}),
  };
}

function unitsDelta(prev: readonly LayoutUnit[], next: readonly LayoutUnit[]): { p: number; drop: number; ins: LayoutUnit[]; app: LayoutUnit[] } {
  let p = 0;
  while (p < prev.length && p < next.length && unitEqual(prev[p]!, next[p]!)) p++;
  if (p === prev.length) return { p, drop: 0, ins: [], app: next.slice(p) };
  // Units carry no ids, so equal units are common (raw messages of one
  // size): `next` may match all the way through, short of `prev`'s end.
  if (p === next.length) return { p, drop: prev.length - p, ins: [], app: [] };
  const lastPrev = prev[prev.length - 1]!;
  let j = -1;
  for (let k = next.length - 1; k >= p; k--) {
    if (unitEqual(next[k]!, lastPrev)) { j = k; break; }
  }
  // prev's last unit changed (grew, re-leveled, became partial): replace
  // everything after the common prefix.
  if (j < 0) return { p, drop: prev.length - p, ins: next.slice(p), app: [] };
  let r = 0;
  while (
    prev.length - 1 - r >= p &&
    j - r >= p &&
    unitEqual(prev[prev.length - 1 - r]!, next[j - r]!)
  ) r++;
  return {
    p,
    drop: prev.length - r - p,
    ins: next.slice(p, j + 1 - r),
    app: next.slice(j + 1),
  };
}

export function applyLayoutDelta(prev: StoredLayout, record: LayoutDelta): StoredLayout {
  return applyLayoutChain(prev, [record]);
}

/**
 * Apply a chain of deltas, oldest first, in one pass: each sequence's last
 * change wins, merged into the members once, and each unit edit applies in
 * place. So rebuilding a long chain costs the members once plus the edits,
 * not a pass over the members per delta.
 */
export function applyLayoutChain(base: StoredLayout, deltas: readonly LayoutDelta[]): StoredLayout {
  const changed = new Map<number, boolean>();
  let units = [...base.units];
  for (const d of deltas) {
    if (d.mr !== undefined) for (const s of decodeSequences(d.mr)) changed.set(s, false);
    if (d.ma !== undefined) for (const s of decodeSequences(d.ma)) changed.set(s, true);
    const p = d.p ?? 0;
    const drop = d.drop ?? 0;
    const ins = d.ins ?? [];
    if (ins.length <= 1024) units.splice(p, drop, ...ins);
    else units = units.slice(0, p).concat(ins, units.slice(p + drop));
    for (const u of d.app ?? []) units.push(u);
  }
  return { members: applyMembershipChanges(base.members, changed), units };
}
