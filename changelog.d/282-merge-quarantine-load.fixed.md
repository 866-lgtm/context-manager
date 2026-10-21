- A store's load now names what it can't read in the merge quarantine, and
  writes the quarantine back without it. An entry with no string `key`, or
  whose `sourceIds` isn't a list, and a stored merge quarantine that isn't a
  list, were left out with no line and erased at the quarantine's next write.
  A record whose ids weren't strings, or were empty strings, was kept and
  then removed by the sweep, counted among its paid-off/orphaned records
  rather than named as damage. Both kinds are now left out at load
  and named in one warning, giving the branch, the state's id and how many
  entries it left out, or that the stored value isn't a list, which is then
  replaced with an empty list. What's left out no longer holds a group out of
  merges or counts toward the merge-quarantine alarm or `getCompressionDebt()`.
  A record whose `sourceIds` is an empty list, which `mergeThreshold: 0`
  stores (#285), still loads and stands as before.
