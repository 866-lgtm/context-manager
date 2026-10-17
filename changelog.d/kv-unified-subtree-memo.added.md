- kv-unified solves a chronological forest with a subtree-memoized engine
  (`engine: 'subtree'`, the `auto` default; a forest with gap-bearing
  ownership or internal protected holes keeps the packed DAG engine, and
  `engine: 'dag'` asks for it). What a summary subtree contributes to a
  label is a set of deltas pruned on the same grid as before, computed once
  per summary object and kept while nothing under it changed: its leaves'
  weights, constraints, zone and receipt entries, and the solve's policy,
  grid and wall. With ages read in bands, a compile re-solves only the
  subtrees an append, a band crossing, a new summary or a move touched and
  combines the rest, so the solve's cost follows what changed instead of
  the store's size (#45). Without a grid the composition is exact Pareto
  algebra and matches the object engine's nondominated terminal set; on a
  grid it is the same kind of bucketed approximation with the same error
  bound, placed from each subtree's origin, so the retained candidates can
  differ within that bound. `KvUnifiedTimings.subtree` reports the delta
  sets a solve computed and reused.
