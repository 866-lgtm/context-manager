- kv-unified latent demand: a what-if solve derives its forest from the live
  forest (one parent added over existing summaries) instead of building every
  leaf again, and keeps its own forest and certificate graph in
  `KvUnifiedReuse.whatIf`, keyed by candidate and recall cost, for the next
  compile that scores the same candidate. A compile that ranks latent demand
  drops the holders of candidates it does not score, and a branch reset drops
  all of them; a compile that ranks nothing leaves them in place. Requests, evaluations and the emitted context
  are unchanged; on a 18.6k-message store the what-if time of a compile fell
  by about a third (1422 ms to 909 ms over seven compiles).
