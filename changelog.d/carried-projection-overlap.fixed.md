- kv-stable: on a store whose summary tree isn't nested (where
  `[kv-overlap]` warns), the next compile no longer un-folds a summary around
  a leaf that the summary lists but whose own lineage doesn't run through it.
  The validity projection now leaves such a leaf out of the summary's
  unanimity by its lineage, for the carried frontier and each suffix-adoption
  candidate as for the ideal cut. Before, a plan that held re-laid the window
  from that summary on, on unchanged inputs, and reported a perturbation of 0;
  a plan that adopted the same frontier again reported a fold and a
  perturbation it hadn't made; and suffix adoption could never take such a
  summary. LariTesserae's #130 named the re-layout.
