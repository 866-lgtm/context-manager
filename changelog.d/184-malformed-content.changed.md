- `addMessage`, `editMessage`, `MessageStore.append` and `edit`,
  `ContextLog.append`, `edit` and `replaceAll`, and `blockAsStored` now
  refuse content that doesn't match `ContentBlock` where its readers read
  it, and store nothing of it. The error names each place by its path, such
  as `Message refused: content[1] is a string, not a content block.`
  `addMessage` refuses such a message before anything else happens: no
  compression hold expires or is placed, and the strategy's ingress
  chunking never reads it. A shard of a strategy's chunking that doesn't
  match is refused before any shard is stored, with an error naming the
  shard, though by then expired holds have been released, as at any add;
  and `ContextLog.replaceAll` refuses an entry holding such content before
  it clears the log. Before, such content was stored, and a reader written
  against `ContentBlock` could throw on it from then on.
