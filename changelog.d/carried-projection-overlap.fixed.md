- kv-stable: on a store whose summary tree isn't nested (where
  `[kv-overlap]` warns), the next compile no longer un-folds a summary around
  a leaf that the summary lists but whose own lineage doesn't run through it,
  or around a leaf of its own folded above it. The validity projection now
  decides both from the tree, for the carried frontier and each
  suffix-adoption candidate as for the ideal cut: a leaf vetoes a summary
  only when it renders below the summary's level and the summary is its own
  lineage there. Before, a plan that held re-laid the window from that
  summary on, on unchanged inputs, and reported a perturbation of 0; a plan
  that adopted the same frontier again reported a fold and a perturbation it
  hadn't made; and suffix adoption could never take such a summary. On such
  a store a plan can now also keep a summary folded where it used to render
  that summary's leaves raw, since the solve's own exemption covered only
  the leaves its folds had met. LariTesserae's #130 named the re-layout.
- kv-stable: a compile no longer leaves a leaf at a level whose own-lineage
  summary doesn't list it, on any store. A level carried from before a
  summary was written again without one of its sources, a lock or a pin
  could point there, and so could a fresh plan's passes on a store whose tree
  isn't nested. The leaf's recall didn't hold it, and where no other recall
  did, the turn was refused with `UncoveredDropError`. The projection now
  lowers such a leaf, and the base lowers a locked or pinned leaf's level the
  same way, so a lock or a pin can now render below the level it holds when
  the summary there doesn't list the leaf. A held level with no summary at
  all is kept, as before, and renders raw.
- kv-stable: on a store whose summary tree isn't nested, the solve's
  un-fold pass now moves the leaves a summary renders, decided by each
  leaf's own lineage as the projection decides. It used to leave out any
  leaf that some fold in the same compile had met under another lineage,
  and could then settle on a plan above `foldAt`, the same on every
  compile.
- kv-stable: `[kv-overlap]` now reports what the plan renders: it warns on
  every compile whose plan renders a summary over a leaf of another
  lineage, and only then. It used to report the folds the compile made, so
  a plan that kept the carried folds could render the overlap without a
  warning, and a plan that didn't render it could still warn.
- kv-stable: a locked chunk with a pin-max-level is lowered to the cap at
  plan start, as the cap promises. It used to keep its carried level above
  the cap.
- kv-stable: a level carried far above the summary tree's top is now
  lowered in one compile to a level its summaries render. A plan that held
  it could emit a level with no summary, which renders raw, and the next
  compile then rendered the summary while reporting a perturbation of 0.
