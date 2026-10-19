- Stderr diagnostics about one namespace's work now name it, as
  ` ns=<namespace>` at the end of their first line, after their fields, so
  the lines of several managers in one process, such as agent-framework's
  agents on one store, can be told apart (#239). That covers the
  strategy's lines, `[plan-vs-actual]`, `[kv-overlap]`, `[kv-unified]` and
  `[kv-escalation]` among them, the manager's, and the planner's, picker's,
  fold journal's, mint preimage's, windowed strategy's and content checks'
  lines that run for one namespace. The namespace is the manager's,
  `default` when it has none. A strategy no manager has initialized names
  none, and so do lines about the store as a whole, such as the message
  slot's cadence retune and the fold journal's index warnings, and those of
  the message slot the managers share. A grep for a line's prefix still
  matches. A reader that took a line's end as its last field, such as
  `[kv-overlap]`'s `sample=`, now finds ` ns=` there.
- The JSON diagnostics `config:effective` and
  `compression:quarantine-alert`, each `[debugLogContext]` entry, and each
  entry of the compression log (`CONTEXT_MANAGER_COMPRESSION_LOG`) gain a
  `namespace` field. `MessageStore` and `ContextLog` take an optional
  `diagnostics` option, and `persistMintRequestPreimage` an optional fourth
  argument, which their lines go through. `ContextManager.open` gives an
  isolated message slot and the context log their manager's.
