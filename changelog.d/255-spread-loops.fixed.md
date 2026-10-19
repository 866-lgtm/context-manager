- A kv-unified solve with `terminalEvaluation: 'full'` or `storage: 'objects'`
  no longer dies with `RangeError: Maximum call stack size exceeded` below its
  label ceiling when it leaves more terminal labels than a call takes as spread
  arguments (about 125,000 on Node 22 and 24), or, with `storage: 'objects'`,
  when one prune group keeps more labels than that. The exact scorer takes its
  floors in a loop, and the object-storage engine's prune appends each group's
  labels one by one (#255). The strategy built from a `kvUnified` recipe sets
  neither option.
