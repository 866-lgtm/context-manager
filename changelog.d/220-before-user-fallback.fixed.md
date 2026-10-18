- A `beforeUser` injection passed to `compile()` now reaches the agent when
  no compiled message has the participant `user`, in any letter case, as
  when messages are stored under their authors' names: it goes at the end,
  ahead of any `afterUser` injection, which already fell back to the end
  there. Before, it was dropped without a log line or a trace. Its provenance
  source and its tokens in the rendered layout come with it (#220).
