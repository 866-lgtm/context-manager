- Requires `@animalabs/membrane` ^0.6.1 (was ^0.6.0), whose native tool loops
  and `complete()` run complete tool calls a provider returns under
  `stop_reason: end_turn`, where 0.6.0 ended the turn without running them.
