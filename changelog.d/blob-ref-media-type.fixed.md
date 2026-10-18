- Reads leave out a stored `blob_ref` of a document, audio or video whose
  reference has no string `mediaType`, and log the line naming it, such as
  `content[2].ref.mediaType is undefined, not a string`, as they do one whose
  `originalType` isn't image, document, audio or video. Before, it read back
  as media without a media type, which a write refuses, so a host copying
  messages as read with blobs resolved couldn't store that message. The
  store's own writes don't make such a reference, since every write path
  refuses inline media the store can't give a type. An image's reference
  without a `mediaType` still reads back with the type its bytes' signature
  names, and without one when its bytes carry no png, jpeg, gif or webp
  signature.
