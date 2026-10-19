- `getCompressionDebt()` reads `critical` for a refused crossed merge while
  the group's merge-quarantine record stands. A restart no longer clears it:
  `clearMergeQuarantine()` of the group's key lifts it, and so does the
  record going any other way. `topologyRefusals` now counts those standing
  groups. It counted refusals since the process started, so `critical`
  stayed after a clear until a restart, and a restart dropped it to
  `degraded` while the record stood.
