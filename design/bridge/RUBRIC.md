# Architect arena rubric: agent bridge and system access

Artifact: a design package (DESIGN.md plus a not-implemented sketch) for the agent bridge and Siri/Shortcuts/Spotlight access, per `GROUNDING.md`.

Score each 1-5:

1. Interface depth. Small public surfaces (JS native module, relay tools, app-target intents) hiding the most complexity. No wire or storage types leaking across boundaries. Short call chains.
2. Invariants in structure. Privacy rules (no vectors leave, only reviewed or pre-approved content leaves, photos need explicit approval, relay holds no user data at rest) are enforced by types or single owners, not by convention. One owner per piece of state.
3. Honest availability. Correct and explicit about locked or suspended phones with a free Apple ID (no push), about what the relay can see, and about what agents experience in each state. Any wake path claimed is grounded in a read source or flagged as belief.
4. Buildability here. Concrete, verified Expo SDK 55 prebuild path (config plugin, pods, entitlements), parity plan for anything ported, and an end-to-end demo on this Mac (simulator, relay on localhost, Claude Code or an MCP CLI as agent) with a scripted smoke test.
5. Agent fit. Tool surface that works with today's MCP clients and their timeouts, idempotent retries, a credible path to OAuth for hosted connectors.
6. Parsimony. Smallest design that meets the task: no duplicated implementations or hand-synced lists, no speculative layers, clear subtraction of the code it replaces.

Red flags to check (from `skills/architect/references/design-red-flags.md`): shallow module, information leakage, temporal decomposition, pass-through method, split ownership, two ways to do one task, importable internals, hand-synced list.
