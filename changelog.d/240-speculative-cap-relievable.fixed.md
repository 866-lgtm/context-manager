- Past `maxSpeculativeL1s`, compressing chunks into L1s now waits only while
  an L1 merge is queued to bring the count of unmerged L1s back down (#240).
  With none queued, it goes on. Compression used to stop for good, with
  chunks still queued and nothing able to start it again, wherever no such
  merge could come: with the cap below `mergeThreshold - 1`; with unmerged L1s
  that can't merge filling the cap, as after a merge goes to the merge
  quarantine; or with `hierarchical` false, where no merge runs. A host whose
  compression had stopped this way compresses its queued chunks after the
  upgrade, as it would have when they formed.
- The option's documentation said the cap counted queued chunks too and held
  back only the auto-tick. It counts produced, unmerged L1s, and its hold
  applies in `tick` itself, background or manual.
