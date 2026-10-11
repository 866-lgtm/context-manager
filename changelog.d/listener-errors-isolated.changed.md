- A listener added with `onMessage` that throws no longer fails the write
  that emitted its event: the error is logged, the write stands, and the
  other listeners are still told. Before, the write threw after it had
  landed, so a caller that retried wrote it twice, and a sharded
  `addMessage` stopped partway through its body.
