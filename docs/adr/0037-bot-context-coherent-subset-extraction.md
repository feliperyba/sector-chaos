# ADR 0037: BotContext Coherent-Subset Extraction (Two-Gate Model)

## Status

Accepted — 2026-07-23. Companion to [Spec 36](../issues/36-architectural-god-object-untangling.md).

## Context

`BotContext` (`packages/server/src/ai/BotContext.ts`) is a 396-LOC flat
ephemeral-state blackboard with 67 instance fields — the bot's per-tick memory.
Tickets #19, #25, #33, #34 (the Architecture Deepening Pass) each investigated
extracting clusters from a god-object (BotContext, GameSimulation, GameState,
GameScene) and **deferred** them, proving via a "dispatcher test" that naive
field-clustering is incoherent: the per-tick dispatcher (`tickBot` /
`step()` / `PredictionService.step`) reads fields from all proposed clusters,
so clustering the storage moves the struct without reducing coupling.

Spec 36 re-examined BotContext under a sharper, two-gate version of that test.
The question: is there *any* subset of the 67 fields that forms a coherent
extraction, or does BotContext stay the flat blackboard #25 intended?

## Decision

### The two-gate model

A field cluster is a coherent extraction ONLY IF it passes BOTH gates:

1. **Dispatcher test (necessary).** The cluster is consumed by exactly one
   executor family / module, AND the per-tick dispatcher
   (`tickBot` in `BotTickDriver.ts`) reads none of its fields, AND the
   cross-cluster helper (`BotTickUtilities.ts`) reads none of its fields.
   Any cross-cluster read ⇒ the dispatcher IS the god-object's real owner;
   clustering is shallow indirection (the A/B/C trap documented in #19/#25).

2. **Deletion test (sufficient).** If you mentally delete the new module,
   does complexity concentrate back into one place (deep — it earned its
   existence) or does the codebase just get shorter (shallow — it relocated
   complexity)? A cluster can pass gate 1 yet fail gate 2 when its fields
   are raw values consumed mid-algorithm to drive control flow — hiding
   them behind a getter is pure indirection.

**A candidate that fails EITHER gate is rejected.** The dispatcher test
catches cross-cluster entanglement; the deletion test catches same-consumer
indirection. Both are required.

### Application to BotContext

| Candidate | Fields | Gate 1 (dispatcher) | Gate 2 (deletion) | Outcome |
|---|---|---|---|---|
| **LoSCache** | `losCacheTargetId`/`losCacheTick`/`losCacheResult` | PASS — sole consumer `executeEngageState` (`BotCombatExecutors.ts:50-61`); `tickBot`=0, `BotTickUtilities`=0 | PASS — the validity invariant (`targetId match + 3-tick TTL`) was re-derived inline at the call site; centralizing it + the write-back into `getCachedLOS`/`setCachedLOS` concentrates complexity | **EXTRACTED** |
| **WallSlideState** | `slideDir`/`slideCommitTick` | PASS — sole consumer `resolveWallSlide` (`BotNavigation.ts`); `tickBot`=0, `BotTickUtilities`=0 | FAIL — `slideDir` is a raw value consumed mid-algorithm at `BotNavigation.ts:338` (`ctx.slideDir >= 0 ? [1,-1] : [-1,1]`) to drive probe ordering; the commit invariant is a single boolean. Extraction = Option-C indirection | **REJECTED** |
| **StallWindow** | `stuckStartX/Y/Tick`, `stuckUnstuckTick`, `unstuckDir` | PASS — sole consumer `checkStuck`/`shouldUnstuck` (`BotNavigation.ts`); `tickBot`=0, `BotTickUtilities`=0 | PASS, but marginal — `checkStuck` is already an exported, unit-testable standalone function | **DEFERRED** (optional; not load-bearing) |
| **EnemyHistoryTracker** | `enemyHistory` Map + 3 methods | PASS (already encapsulated) | FAIL — already a `private` Map with 3 methods; moving it to its own file is Option-C. Ticket #25 itself said "not worth a standalone ticket" | **REJECTED** |
| **dead field** | `prevItemsCollected` | n/a — grep-verified zero live readers | n/a | **DELETED** |
| other ~10 clusters | DemolitionTarget, PathCache, ZoneInfo, WanderTarget, etc. | FAIL — `tickBot` reads across stall/combat/economy/zone/navigation boundaries (per #25) | not reached | **DEFERRED** |

### What shipped

Only LoSCache + the dead-field deletion. The 3 raw `losCache*` fields became
`private`, exposed through:

```ts
getCachedLOS(targetId: string, tick: number): boolean | undefined;
setCachedLOS(targetId: string, tick: number, result: boolean): void;
static readonly LOS_CACHE_TTL = 3;
```

The single consumer (`BotCombatExecutors.ts`) collapsed from a 12-line
inline invariant + write-back to a 7-line cache-or-compute. The validity
invariant now lives in exactly one place.

## Consequences

**Positive:**

- The LOS cache invariant (same-target + TTL) is named and localized — a
  future change to the TTL or the validity rule touches one method, not a
  re-derived inline check at a call site.
- `losCache*` is now `private`; no external code can desync the cache by
  writing the fields directly.
- The **two-gate model is the durable artifact.** It generalizes beyond
  BotContext: it is the test that rejected 4 god-objects in the deepening
  pass AND the test that found the one coherent BotContext subset. Any
  future "extract a cluster from X" proposal must be checked against both
  gates before dispatch — this ADR is the reference.

**Negative / honest:**

- The payoff is small. BotContext drops from 396 to ~385 LOC (still far
  under the 450 cap); 3 public fields become private + 2 methods. This does
  not unblock a named future feature. Its value is (a) the one real depth
  win (centralized invariant) and (b) the negative result — rigorously
  establishing that no deeper extraction is available, so the next session
  doesn't re-derive it.
- **Benchmark verification could NOT use byte-identity.** The harness's
  game-logic decisions are seed-deterministic, but its tick-budget
  measurements are wall-clock and machine-load-sensitive: when a tick
  exceeds 16ms under load, bots get AI-budget-skipped, changing kill
  counts — so `totalKills` is non-deterministic in practice. Verification
  used a clean-main control run instead: refactored code (47 kills / P99
  11.5ms) vs clean main back-to-back in the same environment (45 kills /
  P99 10.1ms) — within the environmental noise band, confirming
  behavior-neutrality. An earlier "48 kills / P99 5.61ms" snapshot was an
  idle-machine anomaly, not a valid baseline. (Recorded in Spec 36 §5.)
- StallWindow (Candidate C) was left unextracted despite passing both gates,
  because `checkStuck` is already unit-testable and the named-concept
  benefit is marginal. A future maintainer who wants it can extract it;
  both gates are satisfied.

## Alternatives Considered

1. **The handoff's "13 typed value objects."** Rejected: 10 of the 13 fail
   the dispatcher test (`tickBot` crosses their boundaries, per #25), and of
   the 3 that passed, 1 (WallSlideState) failed the deletion test. Forcing 13
   extractions would have shipped 12 shallow ones.
2. **Extract nothing (leave BotContext as #25 intended).** Nearly adopted.
   LoSCache earned its extraction on the deletion test (a re-derived inline
   invariant centralized into a method); the rest genuinely stay.
3. **Full orchestrator loop (grill→dispatch→judge per task).** Rejected as
   disproportionate for a ~30-LOC extraction + 1-line deletion. The two
   independent grilling rounds happened at the *spec* level, which is where
   the risk was; the implementation is a single focused PR.

## Application to GameState (Phase 3 — 2026-07-23)

The two-gate model generalizes beyond BotContext. When applied to the
client-side `GameState` (`packages/client-v3/src/controllers/GameState.ts`)
with the dispatcher = `PredictionService.step()` (the per-frame prediction
loop), it split ticket #33's deferral — which had treated all 8 prediction
fields as one inseparable block — into actionable and correctly-deferred
groups:

| Group | Fields | Gate 1 (dispatcher) | Gate 2 (deletion) | Outcome |
|---|---|---|---|---|
| **Pure prediction** | `predictionAccumulator`, `lastInputDirection` | PASS — sole consumer `PredictionService` (both `step()` and `getVisualPosition()` read the accumulator); GameScene.update never reads either; not boxed-ref-captured by GameSceneDeps/TelemetrySampler/DebugBridge | PASS — the fixed-timestep cap/drain + coast-direction memory are the prediction loop's internal scratch; moving them concentrates that logic into the one module that owns it | **MOVED** into PredictionService as private fields |
| **Fixed-timestep constant** | `FIXED_DT` (readonly = `SIM_TICK_DT`) | PASS — read only by PredictionService (8 sites) | PASS — leaving a single-consumer constant on the shared blackboard while moving its sole consumer's accumulator is incoherent | **DELETED** from GameState; `SIM_TICK_DT` imported directly (matches `Reconciler.ts`) |
| **Dead field** | `hasMovementInput` | n/a — grep-verified zero readers (write-only) | n/a | **DELETED** |
| **Dash state** | `localIsDashing`, `localDashRemaining` | FAIL — 2 consumers: PredictionService (copy-in/out at `runPredictionStep`) + PlayerLifecycleController (death→respawn reset) | FAIL — the copy-in/copy-out dance with `predState` is not eliminated by moving 2 of the 4 copied fields; the reset is a lifecycle concern, not prediction-internal | **STAY** on GameState |
| **Shared position** | `localPos`, `localVelocity`, `correctionOffset` | FAIL — 7-18 consumers incl. boxed-ref captures (ADR-0026 load-bearing) | not reached | **STAY** on GameState |

**What shipped (commit `f0e88e1`):** `predictionAccumulator` →
`private predictionAccumulator = 0`; `lastInputDirection` →
`private readonly lastInputDirection = {x:0,y:0}` (in-place mutation
preserved — zero-alloc per ADR-0026); `FIXED_DT` deleted, `SIM_TICK_DT`
imported directly; `hasMovementInput` write removed. The 5 PredictionService
characterization tests were rewritten to observe behavior through the public
surface (`step` + `getVisualPosition` + shared fields) rather than poking the
now-private internals — the regression guard is preserved because every
assertion still pins an observable consequence of the prediction loop.

**The model's value, reinforced:** the prior deferral's "8 inseparable fields"
diagnosis was wrong — it failed to per-field the two-gate analysis. The model
found 3 actionable extractions/deletions hiding inside a "deferred" cluster,
while correctly keeping the 5 genuinely-shared fields deferred (boxed-refs).
This is the same diagnostic that found LoSCache inside BotContext: apply both
gates per-field, not per-cluster, and the real seams emerge.

This satisfies ticket #33's own re-evaluation trigger (*"PredictionService is
refactored to own its field semantics internally"*) for the pure-prediction
subset, and partially unblocks #34 (GameScene — fewer fields in the
GameSceneDeps round-trip to evaluate).

## References

- [Spec 36](../issues/36-architectural-god-object-untangling.md) — full
  two-gate analysis + per-candidate evidence.
- [ADR-0036](./0036-bot-ai-intent-layer-canonical.md) — intent layer
  canonical; the `tickBot` entry throw-guard and `registerBot`/`unregisterBot`
  map-writer invariants this extraction stays below.
- [ADR-0026](./0026-client-zero-allocation-rendering.md) — zero-allocation
  hot path; the boxed-ref identity contract that keeps the shared-position
  fields on GameState (Phase 3).
- Tickets #19, #25, #33, #34 — the deferred god-object investigations whose
  dispatcher test this ADR sharpens into the two-gate model.
