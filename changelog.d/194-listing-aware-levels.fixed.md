- kv-stable: a pin-at-level at a level its chunk's lineage skips, where a
  summary's parent is more than one level up, now holds the chunk at the next
  level down where it has a summary. It was kept there and rendered raw, and
  the picker reported its level as one it can't realize. A context that holds
  such a pin compiles differently once after the upgrade, which rewrites its
  prompt cache from where the compiled context first changes (#194).
- flat-profile and oldest-first: a chunk's summary at a level is now one that
  lists it, as for kv-stable. Where a summary's parent pointer named a summary
  written again without its branch, they could choose that summary for the
  chunk, raise the summary's own leaves and leave the chunk where it was, and
  choose it again on every step until the solve threw "greedy fold solver
  exceeded internal bound". Raising a summary now moves the leaves whose own
  summary at its level it is, as kv-stable's folds decide: a leaf it lists
  through another lineage keeps its level, where it used to be raised too,
  even to a level where its own lineage has no summary. On a store whose
  summary tree isn't nested this changes their plans, and oldest-first, which
  chooses a summary only for the oldest chunk, can meet its target less often.
  A chunk carried at a level whose summary doesn't list it now starts at the
  next level down where it has one. And a step raises a chunk past a level
  where it has no summary, one its lineage skips or one whose summary doesn't
  list it, through the next summary up that lists it. Past a level its
  lineage skips, it used to ask for a summary at that level, which the
  strategy can't produce for a chunk whose lineage already links past it, and
  stop there, short of its target, on every compile (#194).
