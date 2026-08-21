# Documentation Index

Everything in `docs/`, one table. The suite is hand-maintained markdown — GitHub renders it (and the mermaid diagrams) natively. Grep symbol names to jump into code.

| Doc | What it covers | Mode |
| --- | --- | --- |
| [`GDD.md`](GDD.md) | **The game design document — business-rules source of truth.** Docs reference it, never duplicate or restructure it. Gameplay numbers change only with a GDD change. | reference |
| [`architecture.md`](architecture.md) | The codemap: bird's-eye view, the three packages and how they relate, server layering, architecture invariants, cross-cutting concerns. Start here. | explanation |
| [`architecture/netcode.md`](architecture/netcode.md) | Input round trip, prediction/reconciliation, the dual-channel sync (batched schema state vs domain events), reconnection. | explanation |
| [`architecture/simulation.md`](architecture/simulation.md) | The 60Hz server tick pipeline (exact step order), match phase machine, zone siege cascade, death resolution. | explanation |
| [`architecture/bot-ai.md`](architecture/bot-ai.md) | Bot-AI v2 layered architecture (stimulus → perception → beliefs → reactor → intent → executors), LOD + the ≤4ms budget guard, BotManager, the deterministic fast-forward benchmark. | explanation |
| [`architecture/map-generation.md`](architecture/map-generation.md) | Seeded procedural map pipeline, Named Districts identity (ADR-0038), server hydration + client bake. | explanation |
| [`architecture/client.md`](architecture/client.md) | Phaser 4 scene flow, GameScene wiring, the deferred lighting overview, and the deterministic IK animation sim. | explanation |
| [`architecture/lighting.md`](architecture/lighting.md) | **The deferred lighting pipeline in full** — pass chain, g-buffer capture, light budget, tonemap tiers, atmosphere, lifecycle, diagnostics. | explanation |
| [`architecture/combat-and-loot.md`](architecture/combat-and-loot.md) | Combat resolution (SAT hitboxes, DamagePipeline), the loot economy's three acquisition paths, eliminations/kill feed. | explanation |
| [`navigation.md`](navigation.md) | The codebase tour by architectural role — where to start reading, per package. | explanation |
| [`glossary.md`](glossary.md) | Domain language: netcode, combat, map-gen, bot-ai-v2, Named Districts vocab. | reference |
| [`performance.md`](performance.md) | The enforced budgets (16.67ms tick, ≤4ms AI), measurement how-tos, the pool pattern. | how-to |
| [`gotchas.md`](gotchas.md) | Known traps (input edge-triggering, pickup gating, tier scaling). | reference |
| [`file-constraints.md`](file-constraints.md) | The GDD §19 file rules and their enforcement. | reference |
| [`anti-patterns.md`](anti-patterns.md) | The 27 forbidden patterns. | reference |

## Subtrees

- [`design/bot-ai-v2/`](design/bot-ai-v2/SPEC.md) + [`research/bot-ai-v2/`](research/bot-ai-v2/game-ai-architecture.md) — the bot-ai-v2 design effort (SPEC, orchestrator ledger, decision log DEC-001..014, open questions) and its research digests.
- [`design/map-redesign/`](design/map-redesign/SPEC.md) + [`research/map-redesign/`](research/map-redesign/br-map-design-principles.md) — the Named Districts map-identity redesign and its research digests.

## Retired

- `KEY_FILES.md`, `INPUT_FLOW.md` — redirect stubs only; superseded by [`navigation.md`](navigation.md) and [`architecture/netcode.md`](architecture/netcode.md).
