- With `foldingStrategy: 'kv-unified'`, `reportKvUnifiedAccepted` or
  `reportKvUnifiedFailed` for a submission that is no longer in flight,
  already settled or superseded by a later one, no longer clears the
  in-flight submission's pending compile. The receipt chain already takes
  such a callback as a duplicate that changes nothing, but the strategy
  cleared its pending state whatever the id, so the in-flight submission's
  acceptance kept no cache reference and the next compile's solver weighed
  no cache costs, with nothing logged. By our reading no current host sends
  such a callback while another submission is in flight: agent-framework
  settles each submission in the order its receipts arrive, and fails a
  previous activation's open ones before the next activation compiles.
