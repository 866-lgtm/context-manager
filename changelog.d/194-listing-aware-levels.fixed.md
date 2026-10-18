- kv-stable: a pin-at-level at a level its chunk's lineage skips, where a
  summary's parent is more than one level up, now holds the chunk at the next
  level down where it has a summary. It was kept there and rendered raw, and
  the picker reported its level as one it can't realize. A context that holds
  such a pin compiles differently once after the upgrade, which rewrites its
  prompt cache from where the compiled context first changes (#194).
