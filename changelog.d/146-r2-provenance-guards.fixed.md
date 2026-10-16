- `acceptRound` refuses a compile whose branch its store doesn't know, live or
  recorded in the manager's namespace, as it already refused one of another
  namespace. Another store's compile in the same namespace used to land as a
  receipt for a branch that store never had, announced to its listeners. A
  compile of a branch deleted before any of its compiles was accepted is
  refused the same way; a deleted branch with records still takes one.
- `listFoldReceipts` stops where a receipt's link leaves its namespace or
  branch, and its `note` says so, instead of listing the other branch's
  receipts as this one's. An acceptance no longer announces another branch's
  receipt that such a link names.
