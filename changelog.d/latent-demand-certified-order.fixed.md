- kv-unified latent demand: a certified what-if solve no longer decides the
  order of the merge requests. A certified what-if that passes the
  `adoptEpsilon` gate is solved again without the certificate when another
  passing candidate's gain lies within its certificate slack, and the
  expected-cost solve runs without the certificate for requests whose
  conservative gains tie. Before, the weaker of two merges could be
  summarized first.
- The expected-cost solve of an already decided candidate no longer runs
  again when a certified what-if is decided late (one extra solve per
  emitted candidate per pass). The emitted context is unchanged by both.
