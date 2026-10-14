- `addMessage`, `editMessage`, `MessageStore.append` and `edit`,
  `ContextLog.append`, `edit` and `replaceAll`, and `blockAsStored` now
  refuse content that doesn't match `ContentBlock` where its readers read
  it, and store nothing of it. The error names each place by its path, such
  as `Message refused: content[1] is a string, not a content block.`
  `addMessage` refuses such a message before anything else happens: no
  compression hold expires or is placed, and the strategy's ingress
  chunking never reads it. Every shard a strategy's chunking makes is
  refused before any is stored, though by then expired holds have been
  released, as at any add, and `ContextLog.replaceAll` refuses every entry
  before it clears the log. Before, such content was stored, and a reader
  written against `ContentBlock` could throw on it from then on.
