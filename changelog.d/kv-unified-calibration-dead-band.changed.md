- **Estimator calibration is applied past a 2% dead band.** The closed-loop
  multiplier (`reportRealInputTokens`) is still an EMA of real/estimated, but
  it is applied to the store, persisted and logged only once the EMA is more
  than 2% from the applied value, so token estimates may lag the EMA by up to
  2%. Every applied change reprices every message and recall pair; a host
  reports once per compile, which moved the multiplier by a fraction of a
  percent each time and made the kv-unified forest, summary tree and
  certificate graph rebuild on every compile (a warm compile on a production
  store: 233 ms instead of 110 ms). A sample inside the band now leaves
  cross-compile reuse intact.
