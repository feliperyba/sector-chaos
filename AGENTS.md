# AGENTS.md — Sector Chaos Neo

## Project Overview

Top-down 64-player battle royale (Bomberman meets Tarkov extraction). Server-authoritative with Colyseus, client prediction/reconciliation, Phaser 4 rendering.

## Architecture

```
packages/
  shared/    — Constants, enums, types, configs (shared between server+client)
  server/    — Colyseus room, domain logic, simulation, state mapping
  client-v3/ — Phaser 4 game scene, rendering, input, network, HUD, audio
```

## Critical Rules

1. **CONTEXT.md is project state source of truth** — `./CONTEXT.md `.
2. **GDD is business rules source of truth** — `docs/GDD.md`. Every feature must match exact specs (pixel sizes, durations, damage values).
3. **End-to-end verification required** — A feature is NOT done until verified from input → network → server → network → client visual.
4. **No guessing** — If you don't know how something works, read the code. Trace the full path.
5. **Wiring is implementation** — Writing a renderer that's never called is NOT implementing a feature.
6. **Server authoritative** — Client NEVER overrides server state. Client prediction for movement only.

## Tech Stack

- **Server**: Colyseus 0.17, TypeScript, pnpm monorepo
- **Client**: Phaser 4, TypeScript, Vite bundler
- **Network**: Colyseus Schema (state sync), Colyseus messages (events)
- **Shared**: Zod validation, constant enums

## Key File Map

### Server (packages/server/src/)

- `room/GameRoom.ts` — Colyseus room, onCreate/onJoin/onLeave, message handlers
- `room/handlers/input.ts` — Input message handler, CLIENT_ACTION_TO_SHARED mapping
- `application/simulation/GameSimulation.ts` — Main game loop, all InputAction cases
- `application/services/GameOrchestrator.ts` — Simulation lifecycle
- `domain/entities/Player.ts` — Player entity, canPickup/canSwitch/isInWindup etc.
- `infrastructure/mappers/EventMapperHandlers.ts` — Domain events → network messages
- `infrastructure/mappers/StateMapper.ts` — Domain state → Colyseus schema (`StateMapperSync.ts` is the batched sync helper)
- `infrastructure/schemas/` — Colyseus Schema classes (GameStateSchema, PlayerSchema, etc.)
- `application/simulation/GameSimulationCombat.ts` / `GameSimulationInput.ts` / `GameSimulationLoot.ts` / `GameSimulationWalkovers.ts` — GameSimulation partials (combat resolution, input processing, loot pickup, walkover end conditions)
- `application/services/GameOrchestrator.ts` (+ `GameOrchestratorInit.ts` / `GameOrchestratorPhases.ts` / `GameOrchestratorEliminations.ts`) — Simulation lifecycle split into partials
- `domain/services/MapSiegeService.ts` (+ `MapSiegeCascade.ts` / `SiegeService.ts`) — Zone siege cascade + overtime logic
- `domain/services/` — `MovementService`, `CollisionService`, `DamagePipeline`, `LootService`, `SpawnService`, `ZoneService`, `MatchFlowService`, `EliminationService`, `SuddenDeathService`, etc.

### Bot AI (packages/server/src/ai/)

The bot AI is a **layered agent** (bot-ai-v2 "Lively Bots", DEC-001..014, ADR-0039): Stimulus (hearing) → Perception → Beliefs (believed state) → Reactor (reflex interrupts) → Intent selection (deliberation × personality) → Executors (tactical execution) → Skill scoring/telemetry. Every layer emits through the queued-input pipeline (`BotInput` factories) — bots are players on the same input path and never mutate game state directly. GDD §14 documents this architecture as the design of record.

**Driver + tick pipeline (60Hz, `GameSimulation.step10_BotAI`):**

- `BotSystem.ts` — Per-tick global passes (snapshot sync, pathfinder grid swap, match-arc compute, per-bot loop) + public seams (`ingestStimulusEvents`, `stimulusRouter`, LOD/budget state). Partials: `BotSystemTick.ts` (tick body), `BotTickDriver.ts` (per-bot phase order — LOAD-BEARING: self-state → perception+beliefs → zone sync → Reactor → demolition guard → anti-stall → intent selection → executor), `BotTickPhases.ts` (named phase functions), `BotTickStall.ts`/`BotTickUtilities.ts`, `TickBlackboard.ts` (per-tick shared coordination state), `BotSystemConstants.ts`, `BotSystemRouterWiring.ts` (StimulusRouter deps adapter — belief/kill-feed hooks)
- `BotContext.ts` (+ `BotContextTypes/Rng/Slots/EnemyHistory` partials) — per-bot blackboard: state, weapons, perception refs, per-bot deterministic `BotRNG` (mulberry32 seeded from playerId), movement/stall/suspension lifecycle, and the `beliefs`/`combat`/`movement` sub-states

**Layered subsystems:**

- `stimulus/` — bot-ai-v2 (DEC-002): `StimulusRouter.ts` (domain-event → hearing-radius fan-out, one grid range query per event; fed by `GameOrchestrator.update` via `ingestStimulusEvents`), `StimulusConfig.ts` (hearing radii: explosion 1400 / attack 900 / thrownLanded+elimination 1000 / chest 700 / zoneTelegraph global / damage 900; queue cap 8, 150-tick decay), `StimulusQueue.ts`+`StimulusScan.ts` (per-bot bounded queues + the pure queue→per-scan-view merge), `StimulusFightMemory.ts` (the shared fight memory/hotspot — written ONLY by the router)
- `belief/` — bot-ai-v2 (DEC-003): believed-state world model. `BeliefTypes.ts`/`BeliefUpdate.ts` (per-enemy last-known position/velocity/confidence with seen|heard|damage sources, damage-direction estimates, search-failure drops, belief-gated pursuit), `BeliefMath.ts` (foveation-lite noise, GDD §14.2 detection-range confidence fade, §14.3 LOS-halving ×0.5, decay), `BeliefConfig.ts` (all belief tuning data)
- `reactor/` — bot-ai-v2 (DEC-004/007): `BotReactor.ts` (the prioritized interrupt layer — every tick, every LOD tier, after perception, before ALL deliberation; bypasses IntentSelector by construction), `ReactorConditions.ts` (5 detectors in priority order: imminent-death / incoming-projectile / took-damage startle / explosion-heard / enemy-windup), `ReactorConfig.ts` (per-archetype reaction mixes FIXED for learnability, ex-Gaussian latency table with GDD §14.2 reaction times as distribution means, suppression masks, ≤15-tick windows + refractory), `ReactorLatency.ts` (ex-Gaussian draws via per-bot RNG), `ReactorActions.ts` (visible reaction emitters — every reaction emits an observable input)
- `intent/` — the deliberative brain (ADR-0036 canonical): `Intent.ts` (`Intent` abstraction id/score/commitTicks/isValid/execute, `IntentId` — 11 intents, AMBUSH deferred), `IntentSelector.ts` (the SINGLE decision point — commit-window hysteresis, validity-gated preemption margin 0.18, goal suspension), `PersonalityProfile.ts` (5 archetypes AGGRESSOR/DUELIST/SURVIVOR/SCAVENGER/TRAPPER as continuous weights + signed ±0.12 jitter + per-difficulty skill knobs), `intents.ts` (+ `intentEngage/intentLoot/intentSurvival/intentHelpers`) + `intentIdToBotState`/`botStateToIntentFamily` mappers
- `goal/` — bot-ai-v2 (DEC-008) macro-goal generator: `GoalGenerator.ts` (re-score ~2-3s staggered, commit 3-6s, commit-sticky across intent churn), `GoalScoring.ts`+`GoalScoringLoot.ts` (candidates: loot cluster / quiet-side rotation off stimulus fight density / unexplored sector / next-zone pre-position / hotspot-edge stalk), `GoalTables.ts` (per-archetype rotation margins, zone-as-cost budgets, endgame edge bias), `ZoneTiming.ts` (rotation rule `timeUntilShrink < travel×margin`, never-lethal zone-shortcut evaluation, endgame hold points), `GoalBinding.ts` (goal→executor input binding), `GoalTypes.ts`
- `arc/` — bot-ai-v2 (DEC-011) match arc: `MatchArcTables.ts` (GDD §14.3 phase-weight table VERBATIM + per-archetype escalation slopes), `MatchArc.ts` (pure band/alive-ratio → effective mod application on intent scores)
- `skill/` — bot-ai-v2 (DEC-009): `BotDifficultyTables.ts` (GDD §14.6 MMR difficulty mixes VERBATIM + the benchmark wide mix), `MovementProfileTables.ts`+`BotMovementSignature.ts` (archetype signature movement — weave/arc/drift curves, loiter stops, zone-edge preference), `RestrictionTables.ts` (scoped incompetence per tier), `CombatCapTables.ts` (the THREE INDEPENDENT caps: accuracy+convergence / ex-Gaussian reaction / fire discipline)
- `combat/` — bot-ai-v2 (DEC-010): `BotCombatWeave.ts` (sticky 0.5-1s zigzag under projectile fire), `DiscretionTables.ts` (per-archetype disengage triggers: hp/supply/thirdParty/outnumbered), `BotKillFeedMemory.ts` (safe-loot windows + decaying sector-danger memory, fed by elimination stimuli), `ItemContests.ts` (persistent claims + intercept pathing + clean break-off), `BotRecentDamage.ts` (the restored GDD §14.8 recentDamage term), `WeaponBreakReaction.ts`, `BotCombatState/Telemetry`
- `lod/` — bot-ai-v2 (DEC-012): `LodTiers.ts` (T0/T1/T2 think cadences 1/3/9 + relief levels; pure functions), `LodAssignment.ts` (per-tick tier from engagement state + distance to nearest reference player; combat entry upgrades immediately), `AiBudgetGuard.ts` (the ENFORCED global budget — see below)

**Executors + perception:**

- `BotCombatExecutors.ts` — ENGAGE dispatch wrapper (stale-engagement detection, LOS routing, destructible-wedge guard); duel brain `BotCombatEngage.ts` (+`BotCombatEngageRanged.ts`), navigated break-line retreat `BotCombatRetreat.ts`, demolition `BotCombatDemolition.ts`, shared helpers `BotCombatShared.ts`. `BotCombat.ts` itself is an 18-line re-export hub
- `BotNavigation.ts` — `navigateTo` macro-mover (tiered planner: plain A\* then destructible-aware; unified nearest-walkable arrival model); local steering in `BotNavigationBlend.ts` (wall-slide hysteresis `resolveWallSlide`, separation, danger avoidance, `validateFinalAngle` — the DEC-005.1 no-emitted-angle-into-a-wall invariant)
- `navigation/StuckLadder.ts` — the DEC-005 human-legible stuck ladder (sidestep → back-up-facing → alternate-lane replan → SMASH the blocker → relocation as last resort)
- `BotPerception.ts` — `scanWorld()` per-scan view (enemies/items/dangers/projectiles/nearest\*); `BotSelfState.ts` — per-tick hazard rescan + self-state sync; `IntentSignals.ts` — pure moment flags (looters, spawn-prey timing, third-party engagement, hot barrels, vulnerability)
- `BotTargeting.ts` — `selectTarget()`: the implemented GDD §14.8 formula (incl. recentDamage ×2.0), 45-tick lock gated on belief freshness (6 ticks) and hunter spread, barrier/fresh-spawn skips
- `BotInput.ts` — QueuedInput factories (MOVE/ATTACK/DASH/THROW/PICKUP/SWITCH_SLOT) + geometry helpers
- `BotZoneSafety.ts` / `BotDestructibles.ts` / `BotLoadout.ts` / `BotSpatialIndex.ts` / `BotEnemyHistory.ts` — zone safe-point picks, destructible taxonomy, weapon lookups, density grids, enemy history rings

**Navigation infrastructure:**

- `navigation/Pathfinder.ts` (+ `PathfinderSearch.ts` / `PathfinderLOS.ts`) — 8-directional A\* with typed-array buffers, path/LOS caches (invalidated on grid mutation), destructible-aware pathing, priority-ordered shared search cap with a RETRYABLE deferred sentinel on exhaustion

**Telemetry + infrastructure:**

- `BotBelievability.ts` (+ `BotBelievabilityFamilies/Summary`, `BotBeliefTelemetry`/`BotGoalTelemetry`/`BotMovementTelemetry`, `combat/BotCombatTelemetry`) — bot-ai-v2 (DEC-013) observation-only believability surface: reaction-latency histograms (incl. true stimulus→response channels), stall/ladder counters, action diversity, per-archetype/per-difficulty cuts. Never feeds decisions
- `BotSkillTracker.ts` — per-tick telemetry → 5 sub-scores (combat/survival/economy/positioning/decision) + tier (Rookie→Elite)
- `BotManager.ts` — bot session lifecycle: room fill (interval trickle or sync for benchmarks), AFK takeover, lobby-MMR → per-bot difficulty assignment
- `WorldSnapshot.ts` (+ `WorldSnapshotSync.ts`/`WorldSnapshotTypes.ts`) — per-tick read-only world view shared by all bots (DTOs + spatial range queries)

**AI budget (the real contract):** the Bot-AI share of the server tick is **≤4 ms across ALL bots per tick** (GDD §15.3.1b), enforced by `lod/AiBudgetGuard.ts` — guard clock is the harness-virtualizable `performance.now()`, relief ladder suspends deliberation T2 @3.2ms → T1 @3.6ms → non-combat T0 @4.0ms (combat-tier T0 never suspends; Reactor/stimulus/hazard rescan/input submission are always-on at every tier), and 60 consecutive metric-clock over-target ticks set `sustainedOverrun` = bench FAIL. There is NO per-bot 8 ms budget — that claim described code that no longer exists.

### Tests & Benchmarking (packages/server/tests/, scripts/)

- `tests/helpers/bot-benchmark-harness.ts` — **Fast-forward bot AI benchmark**. Runs a full match in-process in seconds via `@colyseus/testing` + synchronous `orchestrator.update()` + virtual clock. Primary tool for bot-AI verification/regression. See "Benchmarking Commands".
- `tests/helpers/game-room-helper.ts` — GameRoom test wrapper, `advanceTicks` (the fast-forward primitive), `forceActive` (spawn-timing workaround)
- `tests/helpers/test-server.ts` — `bootTestServer`/`createTestServer` (OS-assigned port), `createRoom`, `connectClient`, `cleanup`
- `scripts/bench-bot-ai.ts` — Standalone CLI runner for the benchmark (env-tunable, writes JSON to `bench-results/`)
- `tests/benchmark/bot-ai-fullgame.test.ts` — CI health-check (short fast-forward run, covered by `pnpm test`)

### Client (packages/client-v3/src/)

- `main.ts` — Phaser game config
- `GameScene.ts` — Main orchestrator, wires all systems
- `GameSceneSetup.ts` — Scene boot wiring (systems, bridges, renderers)
- `GameSceneHelpers.ts` / `GameScenePositionHelpers.ts` — GameScene helpers (slot/world<->screen, lookup utils)
- `input/InputCollector.ts` — Keyboard/pointer → InputFrame
- `input/InputOrchestrator.ts` — Per-frame input pipeline: InputCollector + InteractionDetector → final InputFrame
- `controllers/GameState.ts` — Authoritative client-side mutable state (local player pos, slots, phase)
- `controllers/InteractionDetector.ts` — Proximity scan for chest prompts (`detect()` sets `nearestChestId`)
- `controllers/PlayerLifecycleController.ts` — Spawn/death/elimination client-side flow
- `controllers/SpectatorController.ts` — Spectator target selection + follow
- `controllers/PredictionController.ts` — Owns the client prediction loop (Reconciler + InputBuffer)
- `controllers/RuntimeGameController.ts` — Dev-console tool (server-authoritative, see ADR-0034)
- `controllers/HUDUpdateService.ts` — Per-frame HUD read model
- `bridges/ClientStateBridge.ts` — StateSync → GameState single source of truth (player/phase/slot sync)
- `bridges/handlers/PlayerReconciler.ts` — Server position → local prediction reconciliation
- `bridges/handlers/RemotePlayerInterpolator.ts` — Remote player smoothing/extrapolation
- `bridges/handlers/PlayerVisualSync.ts` — Visual state sync (weapon/skin/etc.)
- `bridges/handlers/` — Per-event handlers (Attack/Damage/Explosion/KillFeed/Match/Pickup/Zone)
- `collision/ClientCollisionService.ts` — Client-side collision prediction (4-corner hitbox)
- `network/Connection.ts` — Colyseus client, sendInput
- `network/StateSync.ts` — Room state subscriptions, entity maps
- `network/EventRouter.ts` — Room message subscriptions, event callbacks
- `network/SchemaConverters.ts` — Colyseus schema ↔ client view model conversions
- `rendering/MapRenderer.ts` — Tile grid rendering, isWalkable, getAtlasVisual
- `rendering/PlayerRenderer.ts` (+ `PlayerRendererFactory.ts` / `PlayerRendererUpdate.ts` / `PlayerRendererReactions.ts` / `PlayerRendererUpdateHelpers.ts` / `PlayerRendererTypes.ts`) — Player sprites, IK hands, attack visuals
- `rendering/EntityRenderer.ts` (+ partials: `EntityRendererProjectiles.ts` / `EntityRendererTraps.ts` / `EntityRendererItems.ts` / `EntityRendererExplosions.ts` / `EntityRendererVFX.ts` / `EntityRendererLifecycle.ts` / `EntityRendererWorld.ts`) — Destructibles, chests, pickups, traps, projectiles, VFX
- `rendering/vfx/` — VFX particles (`ExplosionVFX`, `DestructionVFX`, `PickupVFX`, `SiegeVFX`, `DamageParticleVFX`, `WeaponShatterVFX`, `ParticleVFX`)
- `rendering/DamageNumberRenderer.ts` — Floating damage numbers
- `rendering/ZoneRenderer.ts` — Zone circle rendering
- `rendering/StatusEffectRenderer.ts` — Fresh spawn, barrier, speed boost auras
- `rendering/AttackVFXRenderer.ts` / `WeaponTrailRenderer.ts` / `WeaponVisuals.ts` / `ArmRenderer.ts` / `PlayerAnimationController.ts` — Weapon/arm animation & visuals
- `rendering/CameraService.ts` — Camera follow, shake, zoom
- `debug/DebugBridge.ts` — Dev-console bridge (exposes runtime hooks; see ADR-0034)
- `debug/ReconciliationLog.ts` / `TelemetryRing.ts` / `TelemetrySampler.ts` — Debug telemetry capture
- `hud/HUDManager.ts` — Health, inventory, timer, phase, kill feed, interaction prompt
- `hud/` (`DeathScreen.ts`, `ResultsScreen.ts`, `SpectatorHUD.ts`, `KillFeedRenderer.ts`, `MinimapRenderer.ts`, `PowerUpIndicators.ts`, `HUDFactory.ts`) — HUD screens + widgets
- `audio/AudioService.ts` — SFX playback
- `assets/AssetManifest.ts` — Asset path registry
- `scenes/` — Boot/menu/matchmaking scenes (`MainMenuScene`, `MatchmakingScene`, `LobbyConnection`, etc.) + UI widgets (`PlayerListWidget`, `MatchmakingUI`)
- `ui/` — Reusable UI kit (Button/Label/Panel/ProgressBar components, animators, transitions)
- `types.ts` — Client-side type definitions
- `prediction/Reconciler.ts` — Client prediction reconciliation primitive
- `prediction/InputBuffer.ts` — Input history buffer
- `prediction/PredictionService.ts` — Prediction loop driver
- `prediction/EntityInterpolator.ts` / `InterpolationService.ts` — Remote entity interpolation

### Shared (packages/shared/src/)

- `constants/player.ts` — PLAYER config: `HITBOX_WIDTH=96`, `HITBOX_HEIGHT=96`, `PICKUP_RADIUS=72`, `ACCELERATION=4800`, `DECELERATION=6400`, `BASE_SPEED=430`, etc.
- `constants/combat.ts` — Combat constants
- `enums/AttackType.ts` — ARC, LINE, THROWN, RANGED, SHIELD
- `enums/InputAction.ts` — MOVE, ATTACK, DASH, THROW, PICKUP, SWITCH_SLOT
- `network/InputRingBuffer.ts` — Float64Array ring buffer (stride 21 = 13 base + 2×4 substep dirs) for input storage

## Input Flow (Critical Path)

```
1. InputOrchestrator.collect() → InputFrame {movementX, movementY, aimAngle, sequence, actions[], targetId?} (delegates pointer/keyboard sampling to InputCollector)
2. InputOrchestrator.collect() → InteractionDetector.detect() adds targetId for nearby chest prompt if needed
3. Connection.sendInput(frame) → room.send('input', frame)
4. Server input.ts → CLIENT_ACTION_TO_SHARED maps string→InputAction enum
5. Server GameSimulation.ts → switch(action) processes each action
6. Server StateMapper.ts → domain state → Colyseus schema
7. Client StateSync.ts → schema changes → callbacks
8. Client EventRouter.ts → messages → event callbacks
9. Client GameScene.ts → update visual state
```

## Known Gotchas

- `PICKUP_BLOCKED_DURING_ATTACK` was removed (dead constant, never read). The real gate is `player.canPickup()` (`PlayerCombat.ts`) — returns false during dash/stagger/windup/attack-cooldown. Applies to WEAPON pickups only; power-up walk-over bypasses `canPickup()` entirely (auto-collects regardless of combat state).
- `PLAYER_RADIUS = 48` (half of 96x96 hitbox) for client collision prediction
- `INTERACTION_RADIUS = 32` for client pickup/chest detection prompt; server `PICKUP_RADIUS = 72` is the authoritative pickup distance (weapon pickup is proximity-based within this radius)
- Server weapon pickup is **proximity-based** (ignores targetId), chest is **targetId-based**
- `JustDown()` for discrete actions (E, Space, 1-4, F) — NOT `isDown`
- `isDown` for continuous actions (ATTACK via pointer, movement via WASD)
- Attack action = `pointer.isDown` (continuous) — fires every frame while held
- PICKUP/DASH/THROW/SWITCH_SLOT must use edge-triggered (JustDown)
- Local player renderer MUST update after reconciliation, never before (ADR-0005)
- Input compensation capped at 100ms max to prevent abuse (ADR-0006)
- Ring buffer reads require pointer arithmetic — use the debug view for inspection (ADR-0007)
- Movement acceleration is frame-rate independent (time-based, not frame-based). DASH is exempt (ADR-0008)
- **KEEP `PLAYER.BASE_SPEED` name** — do NOT rename to MAX_SPEED. 30+ references across codebase.
- `BotManager.spawnBots` is **async** — it trickles bots in via `clock.setInterval` over ~5s of wall-clock. Bots are NOT present immediately after `onCreate`. Tests must poll the player count (see `bot-benchmark-harness.ts`) or wait ~6s.
- `orchestrator.setLastStandingThreshold(-1)` (or 0) **disables** the alive-count end condition — use during bot-spawn in tests to prevent a premature ACTIVE→FINISHED while bots trickle in. `1` = last-man-standing (natural battle-royale end).
- `@colyseus/testing` 0.17 has **no accelerated-clock API** (`waitForNextSimulationTick` is real `setTimeout`). Fast-forward = driving `orchestrator.update(TICK_INTERVAL)` directly (blocks the event loop → the room's real interval can't interfere).

## Verification Checklist (per feature)

Before marking any feature done:

**All features:**

1. [ ] Typecheck passes: `npx tsc --noEmit -p packages/client-v3/tsconfig.json && npx tsc --noEmit -p packages/server/tsconfig.json`
2. [ ] Lint passes: `pnpm --filter @sector-battle/server run lint`
3. [ ] Server tests pass: `pnpm --filter @sector-battle/server test`

The pre-commit hook (`lint` + `typecheck` + `check:file-length`, 500-line gate) is enabled and green — client lint is also 0 errors.

**Server / bot-AI features** (no browser required): 4. [ ] Fast-forward benchmark runs a full match cleanly: `pnpm --filter @sector-battle/server run bench:bot-ai` (or the vitest wrapper). Verify bots fight/survive/navigate via the sampled metrics (alive-over-time, kills) and the JSON report under `packages/server/bench-results/`. 5. [ ] Docker build + boot: `docker compose build server && docker compose up -d server` — server reaches `healthy`, a match creates (REST `/matchmake/create/game`), no crashes/TypeErrors in logs.

**Client visual features** (browser still required for visual verification): 6. [ ] Build passes: `docker compose build` 7. [ ] Deploy passes: `docker compose up -d` 8. [ ] Runtime test: open browser at http://localhost:8080, verify the feature works with the browser console open. 9. [ ] Server logs confirm server-side processing. 10. [ ] No new console errors. 11. [ ] Reconciliation must not flash raw server position (verify with 150ms+ simulated latency). 12. [ ] Movement acceleration must match between client prediction and server simulation.

## Benchmarking Commands (Bot AI)

The fast-forward harness runs a COMPLETE bot match in-process — no browser, no real-time wait for the game itself (only ~5s for bot spawns). A 600s game finishes in ~15–30s wall-clock.

```bash
# Full standalone benchmark (63 bots, 600s; writes JSON to packages/server/bench-results/)
pnpm --filter @sector-battle/server run bench:bot-ai

# Tunable via env (all optional):
BENCH_BOTS=63 BENCH_DURATION=600 BENCH_SAMPLE=30 BENCH_SEED=12345 \
BENCH_DIFFICULTY=hard BENCH_MAP=demo BENCH_LAST_STANDING=1 \
  pnpm --filter @sector-battle/server run bench:bot-ai

# Reproducible run — fixed seed gives byte-identical JSON (mask wall-clock fields)
BENCH_SEED=12345 pnpm --filter @sector-battle/server run bench:bot-ai

# CI health-check (short fast-forward run, also covered by `pnpm test`)
pnpm --filter @sector-battle/server exec vitest run tests/benchmark/bot-ai-fullgame.test.ts
```

`BENCH_LAST_STANDING=1` ends at last man standing (natural finish). Use `-1` to disable the alive-count end condition so the game runs into late zone/siege/overtime phases (useful for stress-testing siege avoidance — otherwise 63 hard bots can kill down to 1 before zone-shrink begins).

**Determinism (fixed seed):** since commit `45027e4` the benchmark is deterministic at fixed `BENCH_SEED`. The five previously unseeded `Math.random` sim sites (spawn jitter in `SpawnService`, ground-weapon rolls in `MapEntityHydrator`, teleport destination in `TeleportService`, bot names + shuffle in `BotManager`) route through a server-side `SimRandom` swap-in (`packages/server/src/domain/shared/SimRandom.ts`); the production default is a literal `Math.random()` passthrough — the override is never installed by the production server. The harness also holds the room's real simulation interval before the loop (zero pre-loop real ticks) and anchors the virtual clock at `1700000000000 + seed`. Same-seed runs produce **byte-identical JSON modulo the wall-clock measurement fields** (`timestamp`/`realDurationMs`/`speedup`/`tickBudget`/`aiTime`/`aiBudget`) — mask those fields when using JSON equality as a regression gate. The `believability` and `lod` blocks are pure observation of the deterministic tick stream and are NOT masked.

**How it works:** `@colyseus/testing` instantiates the real `GameRoom`; `room.autoDispose = false` keeps it alive without a client; the harness drives `orchestrator.update(TICK_INTERVAL)` synchronously (blocking the event loop so the room's real-time interval cannot interfere). A **virtual clock** advances `Date.now()`/`performance.now()` by exactly one tick per step so siege/zone timing (which read wall-clock) stay faithful to game-tick time.

**Known trade-off (AI budget under the harness):** the budget guard's clock is `performance.now()` — the same function the harness virtualizes — so under the fast-forward harness every within-tick delta is exactly 0: the guard (and LOD relief) deterministically NEVER fires and bot behavior is a pure function of the tick stream (this is load-bearing for byte-identity; documented in the harness header). Budget REALISM is measured separately on the metric clock (`process.hrtime`, never virtualized, never feeds behavior): the `aiTime` percentiles and the `aiBudget` block (overrun counters, relief tallies, the `sustainedOverrun` FAIL gate at 60 consecutive over-target ticks) report real elapsed time even under the harness. Both blocks are wall-clock fields and belong to the masked set; the `lod` block (tier shares, think-ticks executed/skipped, combat-tier upgrades) is deterministic observation and is not masked. Use the Docker server for end-to-end budget realism; use the harness for AI-quality regression (survival, combat, navigation, siege avoidance).

## Docker Commands

```bash
docker compose build --no-cache   # Full rebuild
docker compose build client       # Rebuild client only
docker compose build server       # Rebuild server only
docker compose up -d              # Start services
docker compose down               # Stop services
docker logs sector-chaos-neo-server-1  # Server logs
```

## URLs

- Client: http://localhost:8080
- Server: ws://localhost:2567
