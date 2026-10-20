- **Hosts and tools that read `getCompressionDebt()`:** the report no longer
  answers `healthy` when it can't read what it reports. Its new state,
  `unknown`, means it couldn't read what decides its state. `error` then says
  what happened, what it means and what to do, for an operator: a line saying
  what can't happen, then `Cause:`, `Effect:` and `Fix:` lines. `failure`
  says which read failed, `quarantine-ledger` or `report`, and each count it
  couldn't compute is `null` rather than 0. When only the compression
  quarantine ledger can't be read, only `compressionQuarantineCount` is
  `null`, and the state is still given wherever the rest decides it. The
  strategy's diagnostics log the error when the report starts failing or its
  failure changes, and a line when it reads again.
  `scripts/audit-topology.ts` prints the error's lines under its summary.
  - **Who needs to act:** whatever branches on the state or reads the counts.
    Treat `unknown` as needing attention, show a `null` count as unknown
    rather than 0, and show `error` whole, with its line breaks, beside the
    state. A TypeScript caller that adds or compares the counts gets a type
    error until it handles `null`. Anyone who runs
    `scripts/drain-autobiographical.ts` on a schedule: on a store whose debt
    it can't read, the drain now stops before a tick and exits 1, so the job
    fails where it succeeded.
  - **Unchanged:** the report never throws, and a report that reads
    everything gives its state and every count as before, except
    `topologyRefusals` and a refused crossed merge's `critical`, as described
    under Fixed. `scripts/audit-topology.ts` keeps its exit codes.
- **Hosts that read a failed compression tick's error:** while the store
  can't read the compression quarantine ledger, a compression attempt still
  stops before any model call, but now with a
  `CompressionQuarantineUnreadableError`, whose message is the report's words
  for it and whose `cause` is the store's own error, the one it threw before.
  A host that shows the error shows an operator what it means; one that
  inspects the store's error, such as its code, reads it from `cause`.
