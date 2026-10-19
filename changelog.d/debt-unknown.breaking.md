- **Hosts and tools that read `getCompressionDebt()`:** the report no longer
  answers `healthy` when it can't read what it reports. Its new state,
  `unknown`, means it couldn't read what decides its state. `error` then says
  what and why, and each count it couldn't compute is `null` rather than 0.
  When only the compression quarantine ledger can't be read, only
  `compressionQuarantineCount` is `null`, and the state is still given
  wherever the rest decides it. The strategy's diagnostics log a line when
  the report starts failing or its failure changes, and one when it reads
  again. `scripts/audit-topology.ts` prints the error beside the state.
  - **Who needs to act:** whatever branches on the state or reads the counts.
    Treat `unknown` as needing attention, show a `null` count as unknown
    rather than 0, and show `error` beside the state. A TypeScript caller
    that adds or compares the counts gets a type error until it handles
    `null`. Anyone who runs `scripts/drain-autobiographical.ts` on a
    schedule: on a store whose debt it can't read, the drain now stops
    before a tick and exits 1, so the job fails where it succeeded.
  - **Unchanged:** the report never throws, and a report that reads
    everything gives its state and every count as before, except
    `topologyRefusals` and a refused crossed merge's `critical`, as described
    under Fixed. `scripts/audit-topology.ts` keeps its exit codes.
