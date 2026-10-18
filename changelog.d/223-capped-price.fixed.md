- A message `maxMessageTokens` cuts is now priced, in both strategies, at its
  uncapped price plus the store's estimate of what the cut changed, so the
  cut is priced as it renders (#223). It was priced at no more than the cap
  plus 50 tokens. But the cap cuts only text and string tool results, so a
  capped message's images, tool calls and thinking went out whole beyond that
  price. And the cap keeps four characters a token, which the store prices at
  its own rates: a string tool result cut at a 10,000-token cap estimates at
  about 17,400 tokens, and prose at about 13,800. At small caps the price
  falls instead: a message of text alone cut at a cap of 1 estimates at about
  15 tokens, where it was priced at 51. In the autobiographical strategy, a
  message the cap leaves whole is priced as it is with no cap, where it was
  priced at no more than the cap plus 50. In the adaptive selection's middle,
  a body sharded at ingress is priced whole where the plan keeps it raw, as
  it renders there, where a cap smaller than a shard had the plan count it
  cut, so emission could overrun the plan and refuse. A compile's render
  stats count each message at its new price. A `maxMessageTokens` that isn't
  a positive number, such as NaN, is no cap in the windowed strategy too,
  which cut away a message's text and left the cap's notices in its place.
  - Where `maxMessageTokens` is set, a compile fits fewer raw messages in its
    budget where capped messages carry images, tool calls or thinking, and at
    large caps such as connectome-host's 10,000. The autobiographical
    strategy folds or evicts sooner, and can refuse with `OverBudgetError`
    where it sent a window over its budget. The windowed strategy re-anchors
    sooner, and refuses a newest message that renders past the budget, where
    it sent it. At small caps, a compile fits more capped messages of text
    alone.
  - The hierarchical selection, which runs when `adaptiveResolution` is off
    (the default), prices raw messages before the image strip. So a capped
    message whose image the strip replaces is now priced with that image
    whole, as an uncapped message there already is, where it was priced at
    no more than the cap plus 50. Such a window can be refused where its
    rendered size fits the budget.
  - A window this moves misses the prompt cache on its first request after the
    upgrade.
