- kv-unified: a receipt chain written back by a pre-format-2 build after a
  rollback loads again. Until that build advances the presentation (only
  keepalives or an unchanged layout were accepted), it persists the format-2
  head it loaded in the legacy shape, without `changes`, and the next format-2
  build threw in `serializeHead` on its first acceptance (#164). The head is
  decoded from its `changeRuns`; a legacy head with neither shape is refused
  as malformed.
