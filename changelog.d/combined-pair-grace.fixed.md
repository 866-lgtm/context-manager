- Under `positionedRecallPairs: false`, a hierarchical compile whose combined
  recall pair takes it past the grace window now refuses at the pair with
  `OverBudgetError`, as it refuses a positioned pair: stage "Hierarchical
  emission overran the budget", `middleCountUnit` `'selection-items'`.
  Before, the pair went out unguarded, so the compile returned a context over
  the budget, refused at the raw message after the pair, or refused the
  recent window's eviction (`UncoveredDropError`). The pair is priced at what
  goes out: each summary its answer holds is floored at its measured `tokens`
  under `carrierPolicy: 'full'`, as a positioned pair's answer is.
- The hierarchical path prices recall pairs with the store's estimator (its
  `tokenEstimator` and calibration) while it selects, as it prices raw
  messages. Before, it priced them by the fallback rules, so under an
  estimator that differs a pair could go out past the grace window, or be
  refused where it fit. A compression or merge request prices its recall
  pairs as before.
- The hierarchical middle's refusals (a positioned pair, a raw middle
  message, and the combined pair) report what the head took as `headTokens`,
  and the rest, the refused item included, as `middleTokens`. Before, they
  reported `headTokens: 0` and counted the head as middle.
- Those refusals name `'compression'` in `clearedBy` only for work that folds
  a message before the refused item or in it, where a summary the combined
  pair's cap leaves out counts as neither. Before, they named it for work on
  any message the selection can fold, including messages after the refused
  item, and for a chunk's compression that only moves raw messages into the
  combined pair, neither of which can clear the refusal.
