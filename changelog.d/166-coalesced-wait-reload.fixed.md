- A compression that waited on another strategy instance's in-flight
  compression of the same family reloaded the strategy's persisted state to
  take up that result, and under `foldingStrategy: 'kv-unified'` that reload
  replaced the receipt chain and dropped the presentation in flight. A
  submission begun before the wait then failed its acceptance ("kv-unified
  callback … does not match the in-flight submission") (#166). The waiter now
  keeps its own kv-unified receipt chain, whose pending submission is never
  persisted, and its draft and pending layout, with the layout's marker indices
  and immutable prefix hash, which live only in memory. It no longer reads the
  store's receipt state there, so between initializations a kv-unified
  instance's chain is its own. Everything else reloads as before.
