# Bot AI: Full State Machine Rewrite

**Status:** Superseded by [ADR-0036](./0036-bot-ai-intent-layer-canonical.md) (2026-07-21) — the intent-agent architecture (ADR-0030/0031) shipped instead; this single-file rewrite was never implemented.

The bot AI has 15+ subsystems and 8,500+ lines but produces dumb, glitchy behavior. Two movement authorities fight each other (CombatMovementAI vs legacy setMovementGoal). Rich tactical data (CombatTracker) is computed but consumed in only 2 places. The 8ms shared budget causes bots to freeze mid-think. CombatBehavior is 1,430 lines — bigger than the 1,101 ADR-0030 promised to shrink.

## Decision

Replace the entire bot AI with a single-file state machine. One difficulty level (all "hard"). Direct movement in combat (no pathfinding delegation). Scored target selection. Benchmark-validated.

## State Machine

```
Priority (evaluated every tick, first match wins):

1. FLEE_ZONE     — zone damage active or siege wall imminent → pathfind to zone center
2. SEEK_WEAPON   — unarmed AND no enemy within 3 tiles → pathfind to nearest weapon
3. ENGAGE        — enemy visible → direct movement approach + spacing + attack + dash
4. RETREAT       — HP < 30% AND losing matchup → flee from enemy, dash if available
5. LOOT          — item within pickup range AND no enemy visible → pathfind + pickup
6. HUNT          — armed, no enemy visible, game > 30s → move toward map center
7. WANDER        — default → pathfind to random reachable point
```

### ENGAGE state internals (the combat core)

```
ENGAGE:
  if enemy in range AND cooldown ready:
    stop, face target, ATTACK
  elif just attacked (within 15 ticks):
    back off from target (dash if available)
  elif enemy whiffed (cooldown remaining > 4 ticks):
    dash in, attack
  elif at weapon range (85%-100%):
    strafe perpendicular (prefer side with more open space)
  elif too close (< 85% range):
    back off slightly
  else (too far):
    move toward target with slight curve (not beeline)
```

### Aim prediction

1. Track enemy position history (last 5 ticks)
2. Predict position at `windupTicks + 2` ticks ahead using velocity
3. If enemy changed direction in last 3 ticks: reduce prediction confidence (aim closer to current position)
4. Clamp predicted position to nearest walkable tile (don't aim at walls)
5. Add small fixed aim error (±2 degrees, difficulty-scaled later)

### Target scoring

```
score = distanceWeight * (1 / distance)
      + hpWeight * (1 / enemyHP)
      + matchupWeight * (ourRange / theirRange)
      + threatWeight * (1 / enemyWeaponTier)
```

Lock target for 2 seconds minimum (120 ticks) to prevent target-flipping.

## File Structure

### New files (~1,500-2,000 lines total)
```
packages/server/src/ai/
  BotController.ts     — Main controller: state machine, tick(), InputFrame output
  BotStates.ts         — State enum + transition conditions
  BotCombat.ts         — ENGAGE/RETREAT movement + aim + attack logic
  BotNavigation.ts     — Pathfinding wrapper for macro states (FLEE_ZONE, SEEK_WEAPON, LOOT, HUNT, WANDER)
  BotTargeting.ts      — Scored target selection + target lock
  BotPerception.ts     — World scan: nearby players, items, dangers (simplified Perception)
```

### Kept (modified)
- `BotManager.ts` — spawning/lifecycle (swap BotSystem → BotController)
- `WorldSnapshot.ts` — read-only world state (unchanged)
- `navigation/Pathfinder.ts` — A* pathfinding (unchanged)
- `diagnostics/BotSkillTracker.ts` — skill tracking for benchmark (adapted)
- `diagnostics/BotTelemetry.ts` — telemetry (simplified)

### Deleted (~8,500 lines → 0)
- `BotSystem.ts` (1,445 lines)
- `BotExecution.ts` (1,174 lines)
- `BotInputConverter.ts` (140 lines)
- `Personality.ts` (188 lines)
- `EntitySpatialGrid.ts` (57 lines)
- `bt/` entire directory (BotContext, types, BehaviorTree, Selector, Sequence, decorators, nodes)
- `behaviors/` entire directory (CombatBehavior, SurvivalBehavior, LootingBehavior, ExploreBehavior, GamePhaseSystem, GameState, CombatEvasion, ShieldCombat, CoverBehavior, PositioningBehavior, WeaponArchetypes, WeaponTactics, CombatTargetSelection)
- `subsystems/` entire directory (CombatMovementAI, CombatTracker, CombatAI, EngagementEvaluator, StrategicEvaluator, StrategicAI, ThreatMatrix, ThreatAssessment, AgentMemory, HealthManager, RecoveryManager, LootManager, DemolitionEvaluator, TerrainAnalysis, ReactionDelay, Navigation, Perception)
- `navigation/ContextSteering.ts`

## Implementation Order

1. Build new BotController + states (combat first, macro second)
2. Wire BotManager to use BotController
3. Run benchmark — compare to current baseline (49 kills, combat=60.5, economy=21.5)
4. Delete old files
5. Browser playtest

## Validation Criteria

- Benchmark: kills ≥ 40, combat score ≥ 50, no crashes
- No pathfinding stuck instances > 3s
- No idle bots (always has a state)
- Bots face correct direction in combat
- Bots pick up weapons
- Lint + typecheck pass

## Difficulty (deferred)

All bots use "hard" parameters. Difficulty scaling is a separate concern after the rewrite proves stable. Will be implemented as parameter sets per state, not as behavioral repertoire (simpler than ADR-0031).
