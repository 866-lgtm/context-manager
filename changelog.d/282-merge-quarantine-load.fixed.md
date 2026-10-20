- A store's load now names what it can't read in the merge quarantine, and
  writes the quarantine back without it. An entry that isn't a record with a
  string `key` and a non-empty `sourceIds` list of non-empty string ids, and
  a stored merge quarantine that holds no list, were left out with no line
  and erased at the quarantine's next write. Yet what's left out no longer
  holds a group out of merges or counts toward the merge-quarantine alarm or
  `getCompressionDebt()`, a refused crossed merge's `topologyRefusals`
  included. The load now warns, naming the branch, the state's id and how
  many entries it left out, or that the stored value holds no list.
  - **A record's `sourceIds` is now read as the merge queue's load reads
    its own:** a non-empty list of non-empty string ids. A record whose
    `sourceIds` was an empty list stayed for good, reading `critical` as a
    refused crossed merge and `degraded` otherwise. One whose ids weren't
    strings, or were empty, was removed by the load's sweep as paid off. At
    load both are now left out and named. A record of no sources made while
    the store is open, as `mergeThreshold: 0` makes one (#285), no longer
    stands as a refusal, so the sweep removes it.
