- A store's load now says what it leaves out of the merge quarantine. A
  stored record whose `key` isn't a string or whose `sourceIds` isn't a
  list, and a stored merge quarantine that holds no list, were left out with
  no line, though what's left out no longer holds its group out of merges,
  isn't counted by the merge-quarantine alarm or `getCompressionDebt()` (a
  refused crossed merge's `topologyRefusals` included), and the next write
  of the quarantine erases it. Each load that meets them now warns, naming
  the branch, the state's id and how many records it left out, or that the
  stored value holds no list.
  - **A record's `sourceIds` is now read as the merge queue's load reads
    its own:** a non-empty list of ids. A record whose `sourceIds` was an
    empty list stayed for good, reading `critical` as a refused crossed
    merge and `degraded` otherwise, and one whose ids weren't strings was
    removed by the load's sweep as paid off. Both are now left out at load
    and named by the same line.
