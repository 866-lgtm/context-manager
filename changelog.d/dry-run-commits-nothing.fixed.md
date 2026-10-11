- A dry compile (`compile(…, { dryRun: true })`) on `AutobiographicalStrategy`
  now leaves what a select leaves behind as the last committing compile left
  it, on every path out, throws included. Before, only `previewContext` put
  part of it back. A plain dry compile changed what the next real compile
  sent: its stable-prefix cache marker was measured against the dry layout,
  and under kv-unified the next submission carried marker indices from it.
  A dry select (a preview's too) also recorded chunks and queued their
  compression: over another writer's messages, or at a preview's overridden
  chunk size, whose boundaries then stayed for good. And it left readers in
  between the dry run's `getHotContextSettings()` (`currentFrontierTokens`,
  `prepared`, `blocked`) and `getRenderStats()`, and replaced calibration's
  estimate, or armed a second sample, between a real compile and its usage
  reports.
