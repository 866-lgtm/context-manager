- Reads leave out a stored `blob_ref` of a document, audio or video whose
  reference has no string `mediaType`, and log the line naming it, such as
  `content[2].ref.mediaType is undefined, not a string`, as they do one whose
  `originalType` isn't image, document, audio or video. Before, it read back
  as media without a string media type, which the store's write can't keep,
  so a host copying messages as read with blobs resolved couldn't store that
  message. The store's own writes don't make such a reference: it keeps media
  as a blob only at the top of a message's or context entry's content, where
  every write path refuses media it can't give a type. An image's reference
  still reads back with the type its bytes' signature names, whatever its
  `mediaType` holds, and with that `mediaType` when its bytes carry no png,
  jpeg, gif or webp signature.
