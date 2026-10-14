- A store holding content that doesn't match `ContentBlock` where its
  readers read it no longer wedges its agent. Such content is a block that
  isn't an object; a text block whose `text`, or a thinking block whose
  `thinking`, isn't a string; a `tool_use` whose `input` isn't an object;
  or a `tool_result` whose content is neither a string nor an array of such
  blocks, at any depth. Readers written against `ContentBlock` throw on it.
  With a block that isn't an object, every compile threw under every
  strategy and after a reopen, and under the autobiographical strategy
  opening the store threw too; with a text or thinking block missing its
  `text` or `thinking`, every compile under the autobiographical strategy
  threw, and so did opening the store. Reads
  (`MessageStore`'s messages and `ContextLog`'s entries) now leave such
  content out, or make it match, before anything reads it, blob resolution
  included, and log one line per message or context entry naming what they
  leave out. A `tool_use` keeps its block with `{}` for its input, and a
  `tool_result` keeps its block with an empty content array, so the pair
  they make survives. The store keeps the content as written, and
  `editMessage` can replace it. A block of the message that shares a raw
  replay form (`rawXml`, `rawItem`) with a block a read changes or leaves
  out gives that form up, as after any edit.
