import type { CanonicalSummaryForest } from './kv-unified.js';
import type { SummaryTree } from './summary-tree.js';
import type { CertificateDag } from './kv-unified-certificate.js';
import type { SubtreeMemo } from './kv-unified-subtree.js';

/**
 * Mutable holder a host keeps across compiles so structures that depend only
 * on unchanged ownership can be derived instead of rebuilt. Every entry is
 * validated against the new inputs before use; a stale holder costs a miss.
 * A what-if solve never writes the live entries: it keeps its own holder in
 * `whatIf`, keyed by candidate and recall cost, because the same candidate is
 * scored again on every compile until its merge exists.
 */
export interface KvUnifiedReuse {
  forest?: CanonicalSummaryForest;
  tree?: SummaryTree;
  certificate?: CertificateDag;
  /** The subtree engine's delta sets per summary id, validated against the
   * summary's structure and its leaves on every read, so they survive a
   * full forest rebuild (see kv-unified-subtree.ts). What-if holders share
   * the live one. */
  subtree?: SubtreeMemo;
  whatIf?: Map<string, KvUnifiedReuse>;
  /** A digest of the inputs under which this holder's joint what-if solve
   * exceeded the label ceiling (everything the solve reads: leaves,
   * summaries, presentation, receipt, ceiling, wall, grid, policy; the
   * candidate set is the holder's key). While they are unchanged the joint
   * ranking goes straight to the individual one instead of paying the
   * propagation up to the ceiling again; any change is a new question. */
  jointFailure?: string;
}
