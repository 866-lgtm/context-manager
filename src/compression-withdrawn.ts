/**
 * A host's withdrawal of a compression or merge call.
 *
 * A host that hands the strategy its membrane can refuse a call it doesn't
 * want made, such as one that arrives while it holds the store for surgery or
 * while it stops, by throwing from that membrane. Thrown as, or from a
 * subclass of, `CompressionWithdrawn`, the refusal is no outcome of the call:
 * every rung of the compression ladder and the merge path rethrow it
 * unchanged, with no outcome, attempt, streak or quarantine event recorded,
 * so it never counts toward a quarantine. The opt-in compression log marks
 * the call's receipts withdrawn, and a withdrawn split part gives its slot in
 * the split call window back once its call returns. `tick` puts the chunk
 * back at the head of the queue, unless a rebuild while the call was out
 * decided the queue afresh (a preview's dry-run rebuild puts the table and the
 * queue back, so after one the chunk still goes back), and a merge stays at
 * the head of its own, for the next `tick` after the host lets calls through
 * again. If the strategy's branch moved during an L1 call, that call discards
 * the withdrawal, as it discards any error, so nothing is rethrown or put
 * back.
 *
 * The strategy recognises a withdrawal by a brand the constructor sets,
 * `Symbol.for('@animalabs/context-manager:compression-withdrawn')`, not by
 * `name` or `instanceof`, so a subclass can carry a name of its own, and two
 * copies of this package agree.
 */
const WITHDRAWN = Symbol.for('@animalabs/context-manager:compression-withdrawn');

export class CompressionWithdrawn extends Error {
  constructor(message = 'compression call withdrawn by the host', options?: ErrorOptions) {
    super(message, options);
    this.name = 'CompressionWithdrawn';
    Object.defineProperty(this, WITHDRAWN, { value: true });
  }
}

/** Whether `error` is a host's withdrawal, by its brand. */
export function isCompressionWithdrawn(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[WITHDRAWN] === true;
}
