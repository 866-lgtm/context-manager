- A compile's provenance no longer reads a stored message to learn where it
  sits. Attribution looks up the sequence of each raw run's first message,
  and since 0.16.0 that lookup was `get(id)`, which deserializes the whole
  message through chronicle to report one field: on a long-lived store with a
  few hundred raw runs per compile, that was about 100 ms of every compile.
  `MessageStoreView` gains an optional `sequenceOf(id)`, which `MessageStore`
  answers from its id index and the listing the compile has just read, and
  merged views pass through; a view without it is still asked through `get`
  (#273).
