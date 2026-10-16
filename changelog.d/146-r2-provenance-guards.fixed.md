- `acceptRound` refuses a compile whose branch its store doesn't know, live or
  recorded in the manager's namespace, as it already refused one of another
  namespace. Another store's compile in the same namespace used to land as a
  receipt for a branch that store never had, announced to its listeners. A
  compile of a branch deleted before any of its compiles was accepted is
  refused the same way; a deleted branch with records still takes one.
