- A store with a summary whose child covers more messages than a call takes as
  spread arguments (about 125,000 on Node 22 and 24) now opens: the topology
  audit that runs at load threw `RangeError` on it. `planTopologyRepair()` no
  longer throws on such a store either, and compression's recall curve now
  collects its leaves the same way.
  `getCompressionDebt()` reports a store with more summaries, or more pending
  merge groups, than that limit, where the `RangeError` inside it used to come
  back as its empty report: state `healthy`, with no last mint (#258).
