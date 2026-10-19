- With `foldingStrategy: 'kv-unified'`, the solver no longer counts as cached
  a prefix whose bytes changed after the request that cached it while its
  messages kept their place in the solved layout. A message changes in place
  when `ContextManager.editMessage` rewrites it; when its image is stripped,
  once newer images reach `maxLiveImages` or leave it no room in
  `maxLiveImageBytes`, or once the conversation from it on runs past
  `imageStripDepthTokens` (all on by default); when its tool result is
  replaced, once newer results of the same tool reach `toolResultMaxLastN`;
  when a late result moves up over the stub pairing repair had put after its
  call; or when a different `maxMessageTokens` cuts it. A recall pair changes
  in place under a different `maxMessageTokens`, `recallEnvelope`,
  `carrierPolicy`, `summaryContextLabel` or `summaryParticipant`. The provider
  serves nothing past such a change, but every cache marker after it was still
  credited, so the solver priced no churn for a rewrite the provider charges.
  An accepted request's cache reference now records, for each marker, a hash
  of the entries up to it as the strategy emitted them. Before each solve, a
  marker whose prefix no longer renders that way is left out of the reference
  the solver weighs, and so is a marker on the head window's end once the head
  window no longer ends at its message. The check renders the presentation the
  reference kept, so a candidate that renders raw a message the reference had
  folded, holding an image or a tool result newer than an earlier raw one, can
  change that earlier one and still be credited. `beforeUser` and `afterUser`
  injections, which `compile` adds after the strategy's selection, are outside
  the record. A reference written before this release has no record, and its
  markers are credited as before until the next request is accepted. Two new
  warnings, each logged at most once per strategy instance, mean the check
  itself has gone wrong: `[kv-unified] the cache check couldn't render recall
  …`, after which the markers past that recall pair aren't credited, and
  `[kv-unified] the cache check rebuilt the prefix through …`, when a compile
  that kept the accepted presentation sent something other than the check
  rebuilt.
