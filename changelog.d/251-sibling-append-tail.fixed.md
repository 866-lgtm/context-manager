- A `MessageStore` no longer re-materializes its whole message slot at its
  next read after another `MessageStore` on the same store appends to it
  (#251). A sibling's append moved the write version the instances share,
  and every read took that as a reason to reload the slot. Where only
  appends happened since its cache was built, a read now fetches the
  appended records by point lookup and adds them, and the instance's own
  append after a sibling's keeps its cache for that read instead of
  dropping it. A sibling's edit or removal, or a branch switch, still costs
  a reload. On chronicle 0.4.0, a point lookup of any record but the newest
  after a write rebuilds chronicle's per-item cache, so a read after one
  append costs a point lookup, and a read after several still pays that
  rebuild. Like the cache's revalidation before it, this relies on the slot
  being written only through `MessageStore`: a write outside it, beside a
  sibling's edit or removal, can now leave a reader's listing stale, and an
  edit or removal through that listing can reach another record.
