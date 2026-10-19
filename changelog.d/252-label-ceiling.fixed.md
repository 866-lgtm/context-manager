- A kv-unified compile no longer fails when a label search exceeds
  `labelCeiling` (#252): the ceiling bounds a search, not the turn.
  Where the live solve exceeds it, on the engine a recipe names or after
  the subtree engine's retry on the packed one, the compile takes the
  minimum-token cut, which the solve's feasibility check computes before
  any search, and demands no merge. An autobiographical strategy's first
  solve that exceeds it, in any pick, warns, naming the ceiling, the
  labels the search stopped at and the engine. A latent-demand search
  that exceeds it measures nothing, and the demand goes on with what the
  searches that fit showed: a conservative what-if's candidate isn't
  demanded, as one with no feasible cut isn't; a certified what-if whose
  re-solve without the certificate is stopped stands at its certified
  gain; an expected-cost solve that's stopped leaves the conservative
  gain to order its request; and a joint forest that's stopped has its
  candidates ranked one at a time. A stopped what-if or joint search
  isn't run again while the inputs that decide its label count hold.
  Where the base solve without the certificate, which a merge that
  passes the gate against the certified base is decided against, exceeds
  it, no merge is demanded that compile, and the joint ranking no longer
  takes that for its own forest's failure. A compile where the ceiling
  stopped something carries `ceiling=` on `[plan-vs-actual]` and in its
  stats (`live`, `joint`, `gate`, `whatIfs:N`), and
  `KvUnifiedStrategy`'s `lastTimings.ceiling` reports it;
  `onCeilingFallback` tells a host of a live fallback.
  `ParetoKvUnifiedPolicySolver` itself still throws
  `SparseLabelCeilingError`. A compile whose searches stay within the
  ceiling is unchanged.
