- In the adaptive selection's middle, a run of a sharded body's raw shards,
  which goes out joined into one text block, is now counted as the shards it
  joins, each by the store's estimate of it, as the plan already counted them
  and as the head and recent windows already did. It was counted as the
  joined block, which the store's default estimator prices at the rate its
  first 2,000 characters set, so where the shards' densities differed, the
  middle's count left the plan's. A run whose first 2,000 characters were
  denser than the rest of it was counted over the plan, so a compile whose
  plan fit could refuse with `OverBudgetError` ("Emission overran the plan"),
  and refused again on every compile until the budget or the store changed:
  with an 80,000-character body that opens with 12,000 characters of JSON raw
  in the middle, a compile planned at 28,670 tokens was counted at 34,786. A
  run whose first characters were the lighter was counted under the plan: the
  same characters the other way round, planned at 28,670, were counted at
  27,590. A compile that went out before sends the same bytes; one refused
  this way now goes out.
  - The render stats, which the calibration sample compares with provider
    usage, count such a run at its new price. A store whose recent samples
    had such a body raw in the middle learned its multiplier against the old
    count, and over its next samples the multiplier moves to where the plan's
    own prices put it, as it already did whenever such a body left the
    middle. Until then, a multiplier learned against a count over the plan's
    runs low: when one such body is the whole window, the plan prices that
    store's requests up to about a fifth under what they cost, and a compile
    refused at a budget between the plan and the old count can now go out
    costing up to about a quarter more than its budget. One learned against a
    count under the plan's runs high, so the plan folds more than it needs to,
    as it did before. No calibration epoch starts, since no plan price
    changes: the first compile after the upgrade plans as the last one before
    it did.
