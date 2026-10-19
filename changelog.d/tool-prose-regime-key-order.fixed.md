- With `compressionToolProseFallback` set, the compression quarantine holds a
  quarantined chunk by its family and by the per-chunk shape cap, as it does
  with the rung off. The gate compared a hash of the rung's options in
  each stored record with a hash of the current ones, and the store gives
  those options back with their keys in another order, so no stored record
  was ever in the current request regime, and only an exact key match held
  the chunk. Where the provider had counted the chunk's request, the key
  never matched either, and every pass that reached the chunk called the
  model for it again, without recording a new exhaustion. Each new shape of
  the request, such as one at a moved recall frontier, was attempted with no
  cap. The options are now compared whatever the order of their keys. With
  the rung on, the cap now holds a chunk after three refused shapes until the
  quarantine is cleared, a switch of compression model included, as with the
  rung off.
