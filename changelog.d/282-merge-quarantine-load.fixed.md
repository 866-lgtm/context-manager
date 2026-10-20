- A store's load now says what it leaves out of the merge quarantine. A
  stored record without a string `key` or a list of `sourceIds`, and a
  stored merge quarantine that holds no list, were left out with no line,
  though what's left out no longer holds its group out of merges, isn't
  counted by the merge-quarantine alarm or `getCompressionDebt()` (a refused
  crossed merge's `topologyRefusals` included), and the next write of the
  quarantine erases it. Each load that meets them now warns, naming the
  branch, the state's id and how many records it left out, or that the
  stored value holds no list. What it keeps is unchanged.
