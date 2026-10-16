- `mergeMessageStoreViews` builds the merged listing once per combination of
  source listings and serves it from a memo while every source returns the
  same array, instead of concatenating and sorting every slot on each
  `getAll`, `getFrom` and `getTail`. A manager with `auxiliaryMessageViews`
  paid that O(n log n) merge ten-odd times per compile, and the strategy's
  listing-keyed memos (post-strip estimates, the chunk index) never hit over
  a merged view because each read returned a new array (#45).
