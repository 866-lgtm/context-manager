- `getCompressionDebt()` reads `critical` for a refused crossed merge while
  the group's merge-quarantine record stands. A restart no longer clears it:
  `clearMergeQuarantine()` of the group's key lifts it, and so does the
  record going any other way. `topologyRefusals` now counts those standing
  groups. It counted refusals since the process started, so `critical`
  stayed after a clear until a restart, and a restart dropped it to
  `degraded` while the record stood. A record counts only while every source
  of its group is still present and unparented, so a group paid off since
  reads as paid off before a sweep removes the record.
  - **On upgrade:** an agent whose store already holds a standing refusal,
    which an older version read as `degraded` after a restart, reads
    `critical` from its first report. `clearMergeQuarantine()` of the
    group's key, or the drain's `--clear-merge-quarantine=<key>`, lifts it.
