- A message's edit, a context log entry's edit, a merge recorded on a
  summary, a chunk record's update, the strategy's whole-state writes and
  `scripts/backfill-summary-reasoning.ts`'s summary edits store a lone UTF-16
  surrogate half in a string as U+FFFD, as an append of the same string
  stores it. In an object key the half becomes U+FFFD too, where an append
  drops the key. Before, these writes stored the half as a JSON escape the
  store couldn't parse back, so every later read of that state threw. A
  message's edit itself threw, every message then failed to read, and the
  store couldn't be opened; after a merge's record, the summaries failed to
  read and the store couldn't be opened. A store that already holds such a
  write isn't repaired by this (anima-research/chronicle#52).
