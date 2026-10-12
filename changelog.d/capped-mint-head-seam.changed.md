- Compression requests whose recall ladder is capped by
  `compressionRecallBudgetTokens` now carry one cache marker, at the end of
  the head window, instead of none. Front-eviction shifts the recall pairs on
  every mint, so their seams stay suppressed, but tools, system prompt and
  head window precede the ladder and repeat unchanged. A capped request with
  no head window is unchanged (no marker, no `cacheTtl`). Capped requests
  that gain the marker change their canonical hash.
