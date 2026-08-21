# ADR 0015: Extrapolation-Based Local Player Rendering

## Status

Proposed

## Context

The local player character jitters during sustained movement. Remote players are smooth. A GRILL session identified two root causes:

1. **Input gate drops real time:** `InputCollector.collect()` gates on `INPUT_SEND_INTERVAL_MS = 16ms`. When Phaser's frame delta < 16ms (~50% of frames at 60fps), input is not collected, and the prediction accumulator does NOT advance. That frame's real time is lost. Prediction permanently drifts behind server time, causing constant reconciliation corrections.

2. **No visual extrapolation:** The prediction accumulator produces 0, 1, or 2 fixed-timestep steps per frame depending on timing jitter. The visual position (`localPos + renderOffset`) directly reflects these variable step counts. At `BASE_SPEED = 325 px/s`, that's 0px, 5.4px, or 10.8px of visual advancement per frame. The `PREDICTION_LERP = 0.5` in PlayerRenderer partially masks this but creates double-smoothing artifacts.

The existing renderOffset system (ADR-0010) was designed to smooth reconciliation corrections. It was not designed to handle the variable-step visual stutter, and it cannot compensate for time lost by the input gate.

## Decision

### 1. Remove input gate — always collect input every frame

Remove `INPUT_SEND_INTERVAL_MS` check from `InputCollector.collect()`. The server's existing `RateLimiter(100, 1000)` in `input.ts` handles abuse protection. The client-side gate is redundant and harmful — it creates a race condition between the 16ms gate and the ~16.67ms frame interval.

With the gate removed, `collect()` returns a frame every update. Sequence numbers increment at exactly 60/sec, matching the server's 60 tick/sec processing. This produces a cleaner 1:1 input-to-tick mapping than the current gated approach.

### 2. Replace renderOffset with velocity extrapolation

The visual position is computed as:

```
visual = localPos + localVelocity * predictionAccumulator
```

This is the Source engine approach for local player rendering. At steady state (velocity = 325 px/s), the extrapolation is at most `325 * 0.0167 = 5.4px` ahead of `localPos`. This eliminates visual stalls during 0-step frames because the extrapolation advances the visual by `velocity * accumulator` regardless of step count.

### 3. Remove renderOffset entirely

The renderOffset system (`renderOffset` field, `decayRenderOffset()`, `ERROR_DECAY_RATE`, `RENDER_OFFSET_SNAP_THRESHOLD`, `RENDER_OFFSET_DEAD_ZONE`) is removed. Extrapolation replaces its smoothing function. Reconciliation directly corrects `localPos`; the extrapolation naturally uses the corrected position next frame.

### 4. Direct-set body position for local player (no lerp)

Add `snapPosition(key, x, y)` to PlayerRenderer that sets `body.x = x` directly. The local player uses this method instead of `updatePosition()` with `PREDICTION_LERP = 0.5`. The extrapolation already provides smooth visuals; the renderer lerp was creating double-smoothing.

Remote players continue using `updatePosition()` with `PREDICTION_LERP = 0.5` as a safety net for EntityInterpolator discontinuities.

### 5. Reconciliation simplification

In `ClientStateBridge.onPlayerChange`, the reconciliation block no longer computes renderOffset. It corrects `localPos` and `localVelocity` when `posError >= RECONCILIATION_THRESHOLD`. The visual position catches up naturally via extrapolation on the next frame.

## Simulation vs. Visual contract

```
Before (ADR-0010):
  localPos (simulation)       → prediction, collision, interaction, reconciliation
  localPos + renderOffset     → renderer, camera, aim direction

After (this ADR):
  localPos (simulation)       → prediction, collision, interaction, reconciliation
  localPos + velocity * acc   → renderer, camera, aim direction
```

`localPos` remains the authoritative state. The extrapolated visual position is a rendering concern only — it never feeds back into simulation.

## Consequences

### Positive

- **Eliminates sustained movement jitter** — Extrapolation produces uniform visual advancement per frame regardless of accumulator step count.
- **Fixes animation flickering** — Walk/idle animation threshold sees consistent per-frame displacement instead of 0/5.4/10.8 variation.
- **Simpler architecture** — Removes renderOffset, decay logic, and 5 tuning constants. Replaces with one formula.
- **Industry standard** — Same approach as Source engine, Overwatch, Valorant for local player rendering.
- **Better input timing** — Removing the gate ensures prediction never falls behind server time.
- **1:1 input mapping** — 60 inputs/sec from client matches 60 ticks/sec on server.

### Negative

- **Extrapolation through walls** — When the player is against a wall and velocity points into it, the visual may extend up to 5.4px into the wall for one frame. Corrected next tick when prediction resolves collision. Acceptable for initial implementation.
- **Large corrections visible** — Without renderOffset decay, reconciliation corrections > 2px produce a visible visual shift in one frame. The current `RECONCILIATION_THRESHOLD = 0.3` means most corrections are small. For corrections > 8px, snap immediately (same as current behavior).
- **Extrapolation assumes constant velocity** — During acceleration (first ~6 ticks from standstill), the extrapolation slightly overshoots because it assumes constant velocity within a tick. The error is at most `ACCELERATION * accumulator² / 2 ≈ 0.5px`. Invisible in practice.

### Risks

| Risk | Mitigation |
|------|------------|
| Wall penetration visual during extrapolation | Clamp extrapolated position with `isWalkable()` if visible. Likely not needed — the 5.4px overshoot is corrected in one frame. |
| Server rate limiter insufficient for abuse | Server's `RateLimiter(100, 1000)` already caps at 100 inputs/sec. Client sends 60/sec. No risk. |
| Reconciliation produces visible snap | Most corrections < 1px at steady state. For large corrections, snap immediately — same as current adaptive snap. |
| Camera jitter from extrapolation | Camera lerp absorbs micro-variations. No change to CameraService. |

## Supersedes

- [ADR 0010: RenderOffset Reconciliation](./0010-renderoffset-reconciliation.md) — renderOffset approach replaced by extrapolation. ADR-0010's insights about kinematic velocity model and simulation/visual separation are preserved.
- Relevant to [ADR 0008: Movement Acceleration](./0008-movement-acceleration.md) — velocity tracking required by ADR-0008 is now used directly by the extrapolation formula.
