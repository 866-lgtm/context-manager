- `[fold-diff]` observability for adaptive compiles: when a compile that
  changed at least one saved level commits, the strategy logs once which
  chunks moved between which levels, grouped into contiguous source-order
  runs, and where its request's entries first differ from those of the last
  request the strategy returned, with the tokens from there to the end, which
  no cached prefix can cover — e.g.
  `[fold-diff] moves=18 (deepened=18 raised=0) divergence@20k suffix=32k runs=1: L0→L1×18[636..656]`.
  A compile that commits no saved-level change prints nothing, whatever else
  changed in its request, and neither does a dry run or a plan refused before
  the commit. The same record is attached to
  `RenderStats.planVsActual.foldDiff`, with at most eight runs and
  `runsTotal` counting them all, and describes only the compile it is
  attached to.
- The runs compare the carried frontier with the new one, both at the levels
  chunks render at under this compile's pins and summaries: a pinned chunk
  counts as raw whatever it carries, and locked chunks are skipped as the
  commit loop skips them. So the runs describe what the commit changes, and a
  pin added or removed, a summary lost or a lock released since the previous
  request changes the request without a run; the divergence shows where. A
  compile that only saves a lower level for a chunk whose summary is gone
  logs a line with no move. A move can leave the request unchanged, when the
  summary it moves to already renders for its siblings and the one it leaves
  still renders for theirs.
- The divergence is measured: it is where this request's entries first
  differ in their bytes from the previous request's, the comparison that
  places the stable-prefix cache marker, which now also runs under
  kv-unified. A pin, an appended message or a message edited in place since
  the previous request shows where it lands; after a branch switch, the
  previous request is the other branch's. Its offsets count the entries'
  tokens only: the system prompt and tools come before them and are neither
  compared nor counted. Nor are the injections `compile()` adds after the
  comparison: one placed before the last user message moves with it, so
  where nothing earlier differs, the request first differs at the injection,
  a message before the divergence the line reports. The strategy's first
  compile after the process starts has nothing to compare with, and its line
  says so.
