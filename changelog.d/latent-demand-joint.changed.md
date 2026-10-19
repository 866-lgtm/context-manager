- kv-unified latent demand measures the producible merges jointly by
  default: one what-if solve with every candidate present at its
  conservative recall cost, demanding the merges the pool's best cut in the
  frame it shares with the live solve uses, when that cut beats the live
  one by more than `adoptEpsilon`. A compile with a
  merge backlog paid two full solves per candidate (up to 16 candidates,
  the multi-second compiles of #131); it now pays one extra solve, and the
  gain gating a demand is the set's, measured once, instead of per-candidate
  differences at the approximation's noise floor. `latentDemandMode:
  'individual'` in the recipe's `kvUnified` block restores the per-candidate
  ranking; the solver-level `latentDemand.mode` treats an absent value as
  `individual`. A merge in the strategy's merge quarantine is not a
  candidate in either mode (`latentDemand.blocked`): its request would be
  refused at the queue, and a joint cut that used it would hide the merge
  it would otherwise demand.
