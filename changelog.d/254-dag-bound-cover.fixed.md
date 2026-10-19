- The kv-unified solver's packed and object DAG engines report an
  `approximationScoreErrorBound` that covers the cuts their grid prunes
  (#254). A pruned partial cut's error was charged to the representative
  cheapest to stand in for it, which could have more tokens than the cut and
  be pruned at the wall later, taking that error with it, where the cut's own
  continuation would have fit. The bound could then read 0 beside a cut 37%
  worse than the exact solver's. A cut is now charged only to a
  representative with no more tokens than its own, as the subtree engine
  already does. The cut each engine selects is unchanged.
