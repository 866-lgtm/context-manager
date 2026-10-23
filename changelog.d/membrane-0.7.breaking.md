- **Hosts and anyone installing context-manager beside its siblings:**
  context-manager now requires `@animalabs/membrane` ^0.7.1 (was ^0.6.1),
  which admits no 0.6.x. A host whose own membrane range is still ^0.6 gets
  two membrane copies, and an error one copy builds isn't an instance of the
  other's `MembraneError`. **Migration:** move the host, agent-framework and
  context-manager to membrane ^0.7.1 together (agent-framework 0.26.0,
  connectome-host 0.13.0). context-manager's compression calls run on the
  `Membrane` the host passes in, so membrane 0.7's retry changes reach them
  through the host's retry config; its compression lane keeps its own
  backoff. **Unchanged:** context-manager's API, and what a compile sends.
