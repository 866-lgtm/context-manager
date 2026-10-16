- The kv-unified hysteresis certificate is on by default for a strategy built
  from a recipe: a `kvUnified` block without `hysteresisCertificate` now takes
  the certified exit, and `hysteresisCertificate: false` restores the full
  solver on every compile. The certificate only skips the full solve when it
  proves the carried layout is what the `adoptEpsilon` rule selects, and
  declines to the full solver on a turn it cannot prove (changed ownership,
  pins or locks, cache churn, a forced budget transition, or a cap), so
  eligibility, adoption and fallback are unchanged; a certified result proves
  the hysteresis policy, not identity with the bucketed solver's pick. The
  solver-level `ParetoSolveOptions` flag keeps its absent-means-off reading.
