# Simulation — the 60Hz server tick

One authoritative tick, every 16.67ms, in a **fixed step order**. The order is load-bearing, not stylistic: the alive-set invariant (deaths flip only in step 9) and the spatial-index freshness contract (rebuilt right after movement) let later steps make unguarded assumptions.

## The tick pipeline

`GameSimulation.step()` — verified order, mirrored top-to-bottom in the code:

```mermaid
flowchart TB
    T0["trap-grid rebuild — only when trapVersion changed"] --> T1["hoist _alivePlayers array"]
    T1 --> S1["step1_ProcessInputs — InputAction switch"]
    S1 --> S2["step2_ResolveMovement + rebuildSpatialIndex"]
    T2["PlayerAnimationSystem.stepAll — deterministic anim sim (weapon segments = hitboxes)"]
    S2 --> T2 --> S3["step3_ResolveMeleeRanged"]
    S3 --> S4["step4_AdvanceProjectiles"]
    S4 --> S5["step5_PropagateBarrels"]
    S5 --> S6["step6_ProcessZone"]
    S6 --> S7["step7_ProcessTraps"]
    S7 --> S8["step8_ExpireTimers"]
    S8 --> S9["step9_ResolveDeaths — the only death flip"]
    S9 --> S10["step10_BotAI — emits QueuedInputs for tick+1"]
    S10 --> S11["step11_Snapshot → StateMapper/EventMapper"]
    S11 --> ADV["advanceTick + input-ring discard + drainEvents"]
```

Why the placements matter:

- **Spatial index rebuild after step 2** — the five combat scan sites in `CombatSpatialQueries` read the index unguarded; combat (steps 3–5) must see post-movement positions.
- **Animation between movement and combat** — `PlayerAnimationSystem.stepAll` runs the shared deterministic animation sim so melee hitboxes (weapon segments) are current for step 3 (see [client.md](client.md#the-deterministic-animation-sim--ik) for the sim itself).
- **Deaths only in step 9** — everything upstream can treat the alive set as constant for the whole tick; `DeathResolutionService.dieWithTick`/`completeDeath` + elimination fan-out happen once.
- **Bot AI last-but-one** — bots observe the fully-resolved tick and their inputs re-enqueue for `tick + 1`, exactly like queued human input arriving one tick late.
- **Profiling** — `TickProfiler` times each step against the ADR-0025-pinned label set; `TickTimer` governs the `MAX_STEPS = 1` no-spiral-of-death policy (slow down, never catch-up-storm).

The orchestrator wraps all of this: `GameOrchestrator.update` runs phase transitions, zone/siege wiring, stimulus ingestion for bots, and elimination processing around the simulation step. Game timers (cooldowns, zone phases) are tick-based, so time dilation under load slows gameplay proportionally instead of breaking correctness.

## Match phase machine

Phases are a server-owned state machine (`shared/src/enums/MatchPhase.ts` — note the non-sequential enum values; they're a frozen wire contract), driven once per tick by `tickPhaseTransitions` in `GameOrchestratorPhases.ts`:

```mermaid
stateDiagram-v2
    direction LR
    [*] --> WAITING
    WAITING --> COUNTDOWN: start (min players met)
    COUNTDOWN --> ACTIVE: countdown elapsed
    ACTIVE --> ZONE_SHRINKING: shrink schedule
    ZONE_SHRINKING --> OVERTIME: few alive + timeout
    ZONE_SHRINKING --> FINISHED: alive <= lastStandingThreshold
    OVERTIME --> FINAL_CLOSURE: sudden death cascade
    FINAL_CLOSURE --> FINISHED
    OVERTIME --> FINISHED: last standing
```

- **WAITING → COUNTDOWN** requires the minimum player count (`MIN_PLAYERS = 32`, humans + bots).
- **Late join** re-enters during ACTIVE..OVERTIME via `addPlayer` (revive path).
- **OVERTIME** engages `SuddenDeathService` (zone freeze at 8% radius, accelerated siege); **FINAL_CLOSURE** seals the arena.
- End conditions are gated by `setLastStandingThreshold` — `1` is natural battle-royale; `≤0` disables the alive-count end (used by tests/benchmarks to exercise late phases).
- The room loop: `GameRoomLifecycle` calls `setSimulationInterval(onSimulationTick, NETWORK.TICK_INTERVAL)`.

## Zone siege cascade

As the zone shrinks past sector rings, per-sector cascades progressively smash ring wall tiles on a telegraphed cadence — the "closing coffin" that forces engagement:

```mermaid
flowchart TB
    Z["ZoneService.update — phases 1..7 (center selection frozen at phase 5→6)"]
    G{"phase > 1?"}
    SS["SiegeService.checkSiegeStatus(center, radius) — which sectors are under siege"]
    MS["MapSiegeService.update — per-sector cascades"]
    CAS["MapSiegeCascade.continueCascade / dropCascadeTile"]
    MUT["grid mutation + markGridDirty"]
    CLI["client — SiegeVFX + ZoneTelegraph + siege-wall bake repaint"]
    RBLD["pickupGrid + pathfinder LOS-cache invalidation"]
    OT["OVERTIME — SuddenDeathService multiplier"]

    Z --> G
    G -- "no" --> Z
    G -- "yes" --> SS --> MS --> CAS --> MUT
    MUT --> CLI
    MUT --> RBLD
    OT -. "interval 1.5s + walls close into safe zone" .-> MS
```

- Only sectors whose center falls outside the zone circle are sieged; tiles drop furthest-from-center first, in rings.
- A **0.5s telegraph** precedes each drop; players standing on a solidifying tile take the invulnerability-bypassing siege crush.
- The orchestration gate lives in `GameOrchestrator.update` (phase > 1, overtime interval swap, `match.markGridDirty()`).
- Grid mutation is the invalidation event for the bot pathfinder LOS caches and pickup grids.

## Deaths and eliminations

Step 9 resolves HP=0 once: death animation state (0.5s, body keeps collision) → weapon drop ring → effect cancellation → `PLAYER_ELIMINATED` domain event. That event fans to three consumers — elimination records (schema → results screen), the bot stimulus router + kill-feed memory, and the client kill feed. The full flow is diagrammed in [combat-and-loot.md](combat-and-loot.md#eliminations--kill-feed).
