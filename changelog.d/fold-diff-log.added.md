- `[fold-diff]` observability for adaptive compiles: when a non-dry-run
  compile that changed at least one resolution commits, the strategy logs
  once which chunks moved between which levels, grouped into contiguous
  source-order runs with each run's offset in the previous request's layout,
  plus the earliest layout divergence and the suffix the provider will
  re-read (`kvCost` semantics) — e.g.
  `[fold-diff] moves=860 (deepened=860 raised=0) rendered 382k→344k divergence@27k suffix=317k runs=2: L2→L3×792@27k[…] L0→L1×68@310k[…]`.
  A plan that fails after staging (budget, coverage, emission) prints
  nothing. The same record is attached to `RenderStats.planVsActual.foldDiff`
  and describes only the compile it is attached to.
- Levels in the diff are the levels the layout renders: a pinned chunk counts
  as raw whatever it carries, and locked chunks are skipped as the commit
  loop skips them, so a line never reports a move with an unchanged layout.
- The previous side is the layout the last committed compile actually sent,
  kept by the strategy, so pins added and messages appended since that
  request show in the divergence; after a restart the carried frontier is
  re-rendered from the current inputs instead. Quiet compiles and dry runs
  are unchanged.
