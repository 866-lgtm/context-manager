- A dry compile that is the first compile after a message is removed no longer
  leaves later compiles positioning messages as they stood before the removal.
  After a middle message was removed, every later compile, dry or committing,
  could throw `UncoveredDropError` until the strategy was set again. The dry
  run put the strategy's store order back without the listing it was built
  from. A regression in 0.14.0.
