- A dry compile that is the first compile after a message is removed no
  longer leaves later compiles reading message positions from before the
  removal. Those stale positions could make every later compile, dry or
  committing, throw `UncoveredDropError`, as they did with the middle one of
  three messages removed, until something rebuilt the order, such as setting
  the strategy again. The dry run had put the strategy's store order back
  without the listing it was built from. A regression in 0.14.0.
