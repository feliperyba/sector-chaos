# Codebase navigation — the tour

Where to start reading, grouped by architectural role rather than directory order. Symbol names are greppable — search them instead of following links (links go stale, grep doesn't). The terse 98-entry agent file map lives in [AGENTS.md](../AGENTS.md); system deep-dives in [`architecture/`](README.md).

## The five-minute orientation

1. **Follow one input around the loop** — [`architecture/netcode.md`](architecture/netcode.md)'s round trip is the fastest way to see all three packages cooperate.
2. **Read one server tick** — `GameSimulation.step()` top-to-bottom ([`architecture/simulation.md`](architecture/simulation.md)).
3. **Skim the codemap** — [`architecture.md`](architecture.md) for packages + invariants.

## Entry points

| Want to understand… | Start at | Then |
| --- | --- | --- |
| The authoritative loop | `packages/server/src/application/simulation/GameSimulation.ts` | its `…Input/Combat/Loot/Walkovers` partials |
| Room + transport | `packages/server/src/room/GameRoom.ts` + `GameRoomLifecycle.ts` | `handlers/input.ts`, `GameRoomMapBuilder.ts` |
| Match lifecycle | `application/services/GameOrchestrator.ts` (+ `…Init/Phases/Eliminations`) | `MatchFlowService`, `SuddenDeathService` |
| The client boot | `packages/client-v3/src/main.ts` → `GameScene.ts` + `GameSceneSetup.ts` | `GameSceneUpdate/Helpers` partials |
| Map generation | `packages/shared/src/map/MapGenerator.ts` | `SectorDistributor`, `MacroFeaturePass`, `lootTiers` |
| Bot minds | `packages/server/src/ai/BotSystem.ts` + `BotTickDriver.ts` | [`architecture/bot-ai.md`](architecture/bot-ai.md) |
| The wire contract | `packages/server/src/infrastructure/schemas/GameStateSchema.ts` | `StateMapper.ts`, `StateMapperSync.ts` |

## By architectural role

### Server domain — the rules of the game

`domain/entities/Player.ts` (+ `PlayerCombat`/movement partials — `canPickup`, `isInWindup`, dash/stagger state) and `domain/services/`: `MovementService`, `CollisionService` (SAT + spatial), `DamagePipeline`, `ZoneService` (+ center selection), `MapSiegeService`/`MapSiegeCascade`/`SiegeService` (the closing coffin), `LootService`, `SpawnService`, `EliminationService`, `DeathResolutionService`, `SuddenDeathService`, `ReconnectionManager`. Pure logic, no Colyseus types — `infrastructure/` is where domain meets the wire (`StateMapper`, `EventMapperHandlers`, the schemas).

### Server simulation + orchestration — the clock

`GameSimulation.step()` is the 60Hz tick; `TickProfiler`/`TickTimer` guard its budget; `InputQueue` is where human and bot inputs merge. `GameOrchestrator` wraps it with phase transitions, siege wiring, stimulus ingestion, eliminations.

### Bot AI — the layered agent

`ai/BotSystem.ts` (global passes + per-bot loop), `BotTickDriver.ts` (the load-bearing phase order), then the layers by directory: `stimulus/`, `belief/`, `reactor/`, `intent/` (+ `PersonalityProfile`), `goal/`, `arc/`, `skill/`, `combat/`, `lod/` (incl. `AiBudgetGuard` — the ≤4ms contract). Executors + perception sit at `ai/` root (`BotCombatExecutors`, `BotNavigation` + `BotNavigationBlend`, `BotPerception`, `BotTargeting`, `BotInput`). `WorldSnapshot.ts` is the shared read-only view. Start with [`architecture/bot-ai.md`](architecture/bot-ai.md) — the map is dense.

### Client rendering — the picture

`rendering/MapRenderer.ts` (tile bake + `isWalkable`), `PlayerRenderer.ts` (+Factory/Update/Reactions partials — sprites, IK arms, attack visuals), `EntityRenderer.ts` (+7 partials — destructibles, chests, pickups, traps, projectiles, VFX), `ZoneRenderer`/`ZoneTelegraph`, `DamageNumberRenderer`, `CameraService`, `rendering/vfx/*`, and `rendering/lighting/` — the deferred pipeline ([`architecture/client.md`](architecture/client.md#the-deferred-lighting-pipeline)).

### Client state + bridges — the truth handlers

`network/` (`Connection`, `StateSync`, `EventRouter`, `SchemaConverters`, `MessageBuffer`) → `bridges/state-sync/` (`ClientStateBridge`, `PlayerReconciler`, `RemotePlayerInterpolator`, `PlayerVisualSync`) + `bridges/event-handlers/` (one handler per event) → `controllers/GameState.ts` (the only authoritative client state) + `controllers/` (Prediction, Spectator, InteractionDetector, HUDUpdateService). `prediction/` holds the primitives (`Reconciler`, `InputBuffer`, `EntityInterpolator`).

### Shared — the contract

`constants/` (numbers), `enums/` (wire contracts), `network/InputRingBuffer.ts` (stride 21), `map/` (the generator), `animation/` (the deterministic pose sim + `IKArmSolver`), `collision/` + `math/` (SAT, sector polygons, DDA), `weapons/` (registry + tier scaling), `loot/`.

## Tests + tooling

- `packages/server/tests/` — suites + `helpers/bot-benchmark-harness.ts` (the fast-forward benchmark) + `helpers/game-room-helper.ts` (`advanceTicks`, `forceActive`).
- `packages/client-v3/src/**/__tests__/` — colocated suites (renderers, prediction, bridges, lighting).
- `scripts/bench-bot-ai.ts` (CLI benchmark), `scripts/check-file-length.ts` (the 500-line gate).
- `debug/DebugBridge.ts` + `controllers/RuntimeGameController.ts` — the dev-console surface (ADR-0034).
