- A kv-unified solve that scores every terminal label exactly no longer dies
  with `RangeError: Maximum call stack size exceeded` below its label ceiling
  when it leaves more terminal labels than a call takes as spread arguments
  (about 125,000 on Node 22 and 24). Such a solve has
  `terminalEvaluation: 'full'`, `storage: 'objects'` or `engine: 'leaf'`, or is
  `ExactKvUnifiedPolicySolver.solve` with `candidateSource: 'labels'`. A solve
  with `storage: 'objects'` also no longer dies when one prune group keeps more
  labels than that. The exact scorer takes its floors in a loop, and the
  object-storage engine's prune appends each group's labels one by one (#255).
  The strategy built from a `kvUnified` recipe adds none of these, and the
  recipe's type declares none of them.
