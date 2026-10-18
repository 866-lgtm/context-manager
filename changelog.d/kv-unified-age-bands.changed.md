- kv-unified reads ages in geometric bands: a strategy built from a recipe
  prices a leaf's fidelity age, continuity recency and stability at the
  lower edge of the band they fall in, 4 bands per doubling (a band is a
  factor of about 1.19 wide), so a leaf's weight changes only when it
  crosses a band edge instead of on every append. Exact ages moved every
  leaf's weight on every compile, which is what kept a solve from reusing
  anything from the compile before (#45). With banding on, continuity
  recency is at its floor from eight half-lives out, and stability is 1 for
  the first half of a half-life after a move and then read at whole
  doublings, whatever the band count. `policy.ageBandSteps: 0` in the
  recipe's `kvUnified` block restores exact ages; the solver-level policy
  treats an absent value as exact, so direct solver callers are unchanged.
