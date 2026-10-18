- kv-stable: a compile no longer logs `[kv-overlap]` about the shadow
  production pick's plan, which no compile renders. A compile that isn't a dry
  run makes that pick when `productionBudgetTokens` is set below its budget,
  and the pick planned the same way and logged its own plan's lines. So a
  compile whose own plan rendered no such summary could warn, and one whose
  plan did could warn twice (#222).
