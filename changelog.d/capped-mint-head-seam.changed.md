- Compression requests whose recall ladder is capped by
  `compressionRecallBudgetTokens` now carry one cache marker, at the end of
  the head window, instead of none. Front-eviction shifts the recall pairs on
  every mint, so their seams stay suppressed, but tools, system prompt and
  head window precede the ladder and repeat unchanged, except when image
  shedding replaces a head-window image for one payload and not for another
  (the head marker of uncapped requests has the same exposure). A capped
  request with no head window is unchanged (no marker, no `cacheTtl`). Capped
  requests that gain the marker change their canonical hash.
