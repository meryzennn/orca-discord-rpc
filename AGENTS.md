# Agent instructions

No user-visible string literals inline in presence-building code. Discord-facing text comes from the shared format definition (`config/presence-format.json`, composed in `src/presence-format.ts`); agent names, logos, and model resolvers come from the agent registry (`config/agents.json`, resolved in `src/agent-registry.ts`). Every change must update both the plugin and the headless daemon, and their tests.

`src/format-literals.test.ts` fails when a Discord-facing word or an agent display name appears as a string literal in source.
