- **Hosts that write content they didn't build,** such as a channel's
  messages: `addMessage`, `editMessage`, `MessageStore.append` and `edit`,
  `ContextLog.append`, `edit` and `replaceAll`, and `blockAsStored` now
  refuse content that doesn't match `ContentBlock` where its readers read
  it, and store nothing of it. Before, such content was stored, and a
  reader written against `ContentBlock` could throw on it from then on.
  What's refused: a block that isn't an object, is an array, or has no
  string `type`; a text or thinking block whose `text` or `thinking` isn't
  a string; a `tool_result` whose content is neither a string nor an array
  of such blocks, at any depth; an image, document, audio or video block
  whose `source` isn't an object; a generated image whose `data` or
  `mimeType` isn't a string; a `tool_use` whose `input` isn't an object
  and has no JSON form, such as a `bigint`; and a `blob_ref`, which only
  the store writes. The refusal is a `MalformedContentError`. Its message
  names each place by its path, such as `Message refused: content[1] is a
  string, not a content block.`, and its `places` lists them.
  `malformedContentPlaces(content)` lists the same places without
  throwing, so a host can check content before it writes or queues it, and
  drop a write this refuses rather than requeue it. `addMessage` refuses
  such a message before anything else happens: no compression hold expires
  or is placed, and the strategy's ingress chunking never reads it. A shard
  of a strategy's chunking that doesn't match is refused before any shard
  is stored, with an error naming the shard, though by then expired holds
  have been released, as at any add; and `ContextLog.replaceAll` refuses an
  entry holding such content before it clears the log.
