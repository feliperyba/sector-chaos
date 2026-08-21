# ADR 0039: Bot AI v2 — Layered Lively-Bots Architecture (Stimulus, Beliefs, Reactor, Macro-Goals, LOD)

## Status

Accepted — 2026-08-19. Extends [ADR-0036](./0036-bot-ai-intent-layer-canonical.md) (intent layer is
canonical); complements [ADR-0035](./0035-determinism-contract.md) (determinism discipline) and
[ADR-0031](./0031-bot-difficulty-as-repertoire-not-handicap.md) (difficulty as repertoire).

## Context

The owner's complaint: the 63 lobby bots did not feel like people. They did not react to the world
(explosions two screens away, off-screen shots, the kill feed, zone telegraphs produced zero
perception — the AI consumed no domain events at all, only 3-tick polling within fixed radii); they got
stuck (steering blended hazards AFTER wall-slide resolution so the emitted angle could point into a
wall every tick; the anti-stall exempted any bot that was "fighting" even while wedged; retreat had no
pathfinding); and they took random pointless actions (WANDER was a memoryless roll every 120 ticks;
CONTEST_LOOT did not lock the item; per-tick item claims ping-ponged). A verified personality-jitter
bug collapsed intra-archetype variance (~71% of draws clamped to one value), all 63 bots shared one
room-constant difficulty, and the benchmark could measure none of the qualities being complained about.

The audit of record (`docs/research/bot-ai-v2/current-state-audit.md`, file:line evidence for every
claim) also found the documentation lying in both directions: GDD §14 described a behavior-tree
architecture that never shipped, while specifying valuable things (per-difficulty reaction times and
detection ranges, phase weights, the MMR difficulty distribution, the §14.8 `recentDamage` term) that
had never been implemented.

The decision session (2026-08-17, `docs/design/bot-ai-v2/decision_log.md`, DEC-001..014) diagnosed the
intent-agent architecture itself as sound — it matches the industry-consensus hybrid (utility picks
goals, executors carry them out) — with the complaints tracing to MISSING LAYERS, not a wrong brain.

## Decision

Keep the intent agent (ADR-0036) as the deliberative brain and wrap it into a **layered agent** — the
"Lively Bots" stack — additive at the existing seams, all under the same input-pipeline invariant
(bots are players; every layer emits through the `BotInput` queued-input factories; no direct
game-state mutation anywhere):

1. **Stimulus system** (`packages/server/src/ai/stimulus/`, DEC-002): the server's own domain-event
   stream fans out to bots within per-type hearing radii (explosion 1400px, attack 900px, chest 700px,
   zone telegraph global, …) into bounded per-bot queues (≤8 entries, 150-tick decay). One spatial-grid
   range query per event; RNG-free, event-order-deterministic.
2. **Believed-state world model** (`belief/`, DEC-003): per-enemy last-known position/velocity/
   confidence (seen|heard|damage) with decay and convergence; damage-direction estimates instead of
   attacker-truth; search-failure forgetfulness; foveation-lite precision scaled by facing, distance,
   and difficulty. The GDD §14.2 detection ranges and the LOS-halving rule became belief-CONFIDENCE
   modifiers, not vision walls.
3. **Reactor** (`reactor/`, DEC-004/007): a prioritized five-reaction interrupt layer (imminent death →
   incoming projectile → took-damage startle → explosion heard → enemy windup) evaluated every tick
   above all deliberation, with FIXED per-archetype reaction styles (learnable) and ex-Gaussian latency
   (the GDD §14.2 reaction times as distribution MEANS). Every fired reaction must emit an observable
   input.
4. **Anti-stuck overhaul** (`BotNavigationBlend.ts`, `navigation/StuckLadder.ts`, DEC-005): final-angle
   wall validation (no emitted angle may point into a wall), a human-legible five-rung stuck ladder
   (sidestep → back up facing the obstacle → replan → SMASH the blocker → relocate), progress defined
   as displacement/pickups/kills only, navigated break-line retreats, and a retryable A*-cap sentinel.
5. **Macro-goal generator** (`goal/`, DEC-008): scored, COMMITTED goals (loot clusters, quiet-side
   rotations off stimulus fight density, unexplored sectors, next-zone pre-position, hotspot-edge
   stalk) replace wander noise; rotation timing `timeUntilShrink < travel × personalityMargin`;
   never-lethal zone-as-cost shortcuts.
6. **Personality & skill realism** (`skill/`, `intent/PersonalityProfile.ts`, DEC-009): signed ±0.12
   weight jitter (variance restored); archetype signature MOVEMENT; per-bot difficulty from the GDD
   §14.6 MMR-weighted distributions; scoped incompetence per tier; three INDEPENDENT combat caps
   (accuracy / reaction / fire discipline).
7. **Combat believability** (`combat/`, DEC-010): sticky zigzag weave, universal windup dodges,
   engagement discretion, kill-feed awareness, real loot contests, and the restored GDD §14.8
   `recentDamage` targeting term.
8. **Match arc** (`arc/`, DEC-011): the GDD §14.3 phase-weight table (never implemented before)
   applied for real as intent-family score multipliers with per-archetype escalation slopes.
9. **AI LOD under an enforced budget** (`lod/`, DEC-012): T0/T1/T2 fidelity tiers assigned per tick
   from engagement + proximity (think cadence 1/3/9 ticks; Reactor, stimulus, hazard rescan, and input
   submission ALWAYS-ON at every tier) inside an actually-enforced global budget.
10. **Believability telemetry** (`BotBelievability*.ts`, DEC-013): reaction-latency histograms, stall
    counters, action diversity, per-archetype/per-difficulty cuts — observation-only, anchored by a
    committed pre-v2 baseline so every later change is a directional, auditable delta.

GDD §14 was rewritten as the design of record (DEC-014) and AGENTS.md's Bot AI section was rewritten to
the real module map. The stale GDD §14.7 `envThreatScore` formula is RETIRED with the Reactor's
prioritized reaction table cited as its semantic successor (typed, distance-scaled threat responses
with immediate overrides — semantics preserved, formula gone; Marcus's dissent recorded and addressed
in the decision log).

## Rejected Alternatives

- **Behavior-tree rebuild** (the stale GDD §14.1 text): BT composites/decorators re-derive what the
  intent layer already does (selection, cooldowns-as-commit-windows) with worse mixing across
  personalities. The GDD was rewritten instead of the architecture (DEC-001).
- **GOAP/HTN planner**: fixed tactical vocabulary, wasted CPU on a 63-bot 60Hz budget, and
  unpredictable behavior that reads as scripted (game-ai-architecture research §1.4 verdict).
- **ORCA/RVO crowd avoidance**: guaranteed collision-free local choreography is itself a robotic tell;
  the only borrowed concept is asymmetric yield. Wall-aware steering + the stuck ladder cover the real
  defects (DEC-005).
- **Learned/ML policies** (behavior cloning, RL): sensor ideas and evaluation methodology borrowed,
  models not — compute and iteration-cost mismatch for a server-tick-synchronous authoritative
  simulation; also unverifiable against the determinism contract (SPEC Out of Scope).
- **Market-style LOD arbitration (LOD Trader)**: deferred, not rejected — the static tier ladder +
  priority-ordered A* captures most of the value at a fraction of the complexity; revisit only if the
  static ladder cannot hold the 4 ms budget (DEC-012).
- **Artificial win cap for bots**: rejected — believability comes from flaws and variance, not
  throwing; the extraction fantasy requires credible loss threat (DEC-009, recorded open-question
  default).

## The Determinism Contract (unchanged, extended)

- **Per-bot RNG streams**: every stochastic draw in the AI (personality jitter, reaction latency,
  weave sides, stuck-ladder sides, movement-signature draws) routes through the per-bot `BotRNG`
  (mulberry32 seeded from `playerId`). Stimulus fan-out is RNG-free and event-order-deterministic.
  Same playerId + same seed + same tick stream → identical behavior.
- **Virtual-clock-safe budget guard**: the ≤4 ms guard reads ONLY `performance.now()` — the exact
  function the benchmark harness virtualizes — so under the fast-forward harness every within-tick
  delta is 0: relief never fires, behavior is a pure function of the tick stream, and same-seed runs
  stay byte-identical. In production the guard reads real time and actually enforces.
- **Byte-identity masks**: same-seed benchmark JSON is byte-identical modulo the wall-clock
  measurement fields — `timestamp`, `realDurationMs`, `speedup`, `tickBudget`, and since this effort
  `aiTime` + `aiBudget` (the metric-clock blocks measured on `process.hrtime`, never virtualized, never
  feeding behavior). The `believability` and `lod` blocks observe the deterministic stream and are NOT
  masked.

## The ≤4 ms Budget Contract

The Bot-AI share of the 16.67 ms server tick is ≤4 ms ACROSS ALL BOTS per tick (GDD §15.3.1b) — shared,
not per-bot; the historical "8 ms per-bot budget" claim described code that never existed. Enforcement
(`lod/AiBudgetGuard.ts`): guard-clock relief ladder suspends deliberation T2 at 3.2 ms → T1 at 3.6 ms →
non-combat T0 at 4.0 ms (combat-tier T0 never suspends; the Reactor, stimulus delivery, hazard rescan,
and physics/input submission are always-on at every tier — bots are players). Sustained metric-clock
overrun (60 consecutive over-target ticks) sets `sustainedOverrun` in the bench JSON — a FAIL gate, not
a silent degradation. The shared A* search cap is priority-ordered (T0 first) and its exhaustion
returns a retryable deferred sentinel, never a fake "unreachable".

## Consequences

- Bots react to the world with visible, archetype-consistent, human-timed reflexes in every intent
  state; act on beliefs that can be wrong; move with committed purpose; and vary within and across
  archetypes and difficulties.
- The intent layer's public seam (Intent/IntentSelector/IntentContext) remains THE decision point;
  reactions are deliberately NOT intents (commit windows and hysteresis are exactly what reflexes must
  bypass).
- The GDD §14.2/§14.3/§14.6 tables became real code pinned verbatim (ex-Gaussian means, belief fade,
  phase weights, MMR mixes) — changing those values now requires a GDD change first.
- AGENTS.md documents the real module map (partial-file structure under the 500-line gate, the layered
  subsystems, the enforced budget) — the stale claims (behavior tree, 8 ms, dead files) are gone.
- Open questions run with recorded defaults (`docs/design/bot-ai-v2/open_questions.md`): no win cap,
  tiredness off, no zone-flee flow field, no per-player intensity director, human-replay JSD/EMD
  deferred.

## References

- Decision log of record: `docs/design/bot-ai-v2/decision_log.md` (DEC-001..014).
- Spec: `docs/design/bot-ai-v2/SPEC.md`; open-question defaults: `docs/design/bot-ai-v2/open_questions.md`.
- Research: `docs/research/bot-ai-v2/current-state-audit.md` (ground truth),
  `br-bot-design-patterns.md`, `game-ai-architecture.md`.
- Implementation commits (bot-ai-v2 effort): `0a9c4598` (01 telemetry+baseline, DEC-013), `94de4ac4`
  (02 bug pack, DEC-006), `48bbabf9` (03 stimulus, DEC-002), `d49cf09a` (04 Reactor, DEC-004/007),
  `90690482` (05 beliefs, DEC-003), `8f46aae8` (06 navigation anti-stuck, DEC-005), `d02b55f1`
  (07 macro-goals, DEC-008), `a58a1078` (08 personality & skill, DEC-009), `186d2a92` (09 combat
  believability, DEC-010), `57ecbcba` (10 match arc, DEC-011), `a2ff7c74` (11 LOD + budget, DEC-012),
  plus this docs-reconciliation commit (12, DEC-014).
- Related ADRs: [0036](./0036-bot-ai-intent-layer-canonical.md) (intent layer canonical),
  [0035](./0035-determinism-contract.md) (determinism discipline),
  [0031](./0031-bot-difficulty-as-repertoire-not-handicap.md) (difficulty as repertoire).
