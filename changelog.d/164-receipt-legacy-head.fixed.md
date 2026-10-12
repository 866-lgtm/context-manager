- kv-unified: a receipt chain written back by a pre-format-2 build (a rollback
  after an upgrade) loads again. That build keeps the format-2 head verbatim and
  persists it in the legacy shape without `changes`; the next format-2 build
  threw in `serializeHead` on its first acceptance (#164). The head is decoded
  from its `changeRuns`; a legacy head with neither shape is refused as
  malformed.
