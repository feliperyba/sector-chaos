# ADR 0036: Bot AI Intent Layer is the Canonical Decision System

## Status

Accepted — 2026-07-21. Supersedes [ADR-0032](./0032-bot-ai-state-machine-rewrite.md).

## Context

The bot AI has two decision-system designs in its history:

- **ADR-0030** (Proposed) — the combat movement system foundation. Established the
  separation between deciding *what to do* and *how to move to do it*.
- **ADR-0031** (Accepted) — difficulty as tactical repertoire. Established
  personality profiles as the axis along which bots differ.
- **ADR-0032** (Proposed, never implemented) — a competing single-file state
  machine rewrite that proposed deleting the entire bot AI (~8,500 LOC) and
  replacing it with one ~1,500-2,000 LOC `BotController` + flat priority cascade.

The **intent agent architecture** (ADR-0030 Proposed + ADR-0031 Accepted) shipped
in two phases:

- **Phase 2** — `IntentSelector` + personality-weighted `Intent` implementations
  (`SurviveZoneIntent`, `RetreatAndResetIntent`, `ArmUpIntent`, `DuelIntent`,
  `LootIntent`, `HuntIntent`, `WanderIntent`). Routes to legacy `BotState`
  executors via `intentIdToBotState`.
- **Phase 3** — moment-producing intents (`HuntVulnerableIntent`,
  `BarrelTrapIntent`, `ContestLootIntent`).

After Phase 2 shipped, the legacy `decideState` priority cascade
(`BotDecision.ts`) was retained as a defensive fallback inside `tickBot`. The
fallback's own comment said "shouldn't happen post-Phase-2."

A grilling session (2026-07-21) verified the fallback was **structurally
unreachable**:

- `BotSystem.registerBot` (`:165-178`) atomically sets `bots` + `profiles` +
  `selectors` for a `playerId`.
- `BotSystem.unregisterBot` (`:186-194`) atomically deletes all three.
- `BotSystem.dispose` clears `bots` (after which `tick()` never runs again).
- These are the ONLY writers of the three maps (grep-verified).
- Therefore any bot reaching `tickBot` has its profile + selector populated, and
  the `else` branch in `tickBot` (`if (profile && selector) { ... } else { ...
  decideState ... }`) could never fire.

The dead branch was a recurring source of "is the fallback load-bearing?"
confusion, a coverage hole (no test ever exercised it), and a 242-LOC file
(`BotDecision.ts`) that nothing actually called. ADR-0032's proposed rewrite
was never started and is stale.

## Decision

1. **The intent agent layer is the canonical bot AI decision system.**
   ADR-0030 + ADR-0031 + this ADR form the complete decision-system design.
2. **Mark ADR-0032 Superseded.** Its single-file rewrite was never implemented;
   the intent-agent architecture shipped in its place.
3. **Delete the legacy `decideState` cascade and `BotDecision.ts` entirely.**
   Both exports (`decideState`, `enemyOutrunsUs`) had zero live callers.
4. **Enforce the structural invariant with a throw guard at `tickBot` entry.**
   If a bot reaches `tickBot` without a profile/selector, throw loudly. This is
   defense-in-depth against future regressions (e.g. a new bot-spawn path that
   bypasses `registerBot`). The throw is at the tick boundary, NOT at
   registration — registration is already atomic, so there is no half-state to
   catch there.

## Consequences

- **One decision path.** The recurring "is the fallback load-bearing?" question
  is settled. There is no fallback — the intent layer is the single canonical
  system.
- **Adding an intent is now a pure addition.** "Add an `Intent` implementation,
  register it in `buildPhase2Intents`." No cascade priority to slot into, no
  fallback to keep in sync.
- **242 LOC of dead code removed.** `BotTickDriver.ts` shrank by ~18 LOC (the
  fallback branch + import).
- **The throw is a hard contract.** Any code path that produces a `BotContext`
  without going through `registerBot` will crash at the first tick. This is
  intentional — silent fallbacks hide bugs.
- **Test coverage gap closed.** Four characterization tests pin scenarios the
  legacy cascade used to handle (FLEE_ZONE combat-override, endgame heal,
  booster economy, proactive zone-edge pull-in). The intent layer already
  handled them; the tests just pin the behavior so a future refactor (e.g.
  transcoding removal) can't silently drop one.
- **Risk X1 (takeoverPlayer invariant) closed.** An integration test exercises
  the AFK-reclaim path the benchmark doesn't reach, asserting the invariant
  holds through the takeover→tick transition.

## Deferred (follow-up tickets)

- **Transcoding removal (`intentIdToBotState`)** — ~600 LOC across 8 executors
  + the dispatcher. The intents currently route to legacy `BotState` executors;
  removing the mapping requires rewriting each executor to take an
  `IntentContext` directly. Tracked separately as P1.
- **Anti-stall / DEMOLITION migration into IntentSelector** — ~93 LOC of
  behavioral logic + preemption-rule design. Already half-migrated; full
  migration deserves its own ticket with its own benchmark verification. P3.

These deferrals are why this ADR is surgical: it deletes dead code, adds a
contract guard, and writes tests + documentation. It does not retune any bot
behavior.

## References

- [ADR-0030](./0030-bot-ai-combat-movement-system.md) — combat movement system
  foundation (Proposed).
- [ADR-0031](./0031-bot-difficulty-as-repertoire-not-handicap.md) — difficulty
  as tactical repertoire (Accepted).
- [ADR-0032](./0032-bot-ai-state-machine-rewrite.md) — single-file state
  machine rewrite (Superseded by this ADR).
