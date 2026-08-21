# ADR 0033: Prediction & Reconciliation Pipeline Fix

## Status

Accepted

## Context

The client-side prediction and reconciliation pipeline has 4 independent architectural bugs that compound into broken movement feel. Multiple previous fixes (#81 latency compensation, #114 regression, #123 fixed timestep) addressed symptoms but not root causes.

The prediction pipeline works as:
1. Client predicts movement locally at 60Hz fixed timestep
2. Server processes inputs and sends authoritative state back
3. Client reconciles: takes server position, replays unacked inputs, corrects local position

## Root Causes

### 1. Global `lastProcessedInput` (Critical)
Server tracks a single global counter for all players. Client uses this to determine which of ITS inputs were acknowledged. Cross-player contamination causes reconciliation to skip unacked inputs.

**Decision**: Per-player `lastProcessedInput` on `PlayerSchema`. Each player's client reads only its own ack counter.

### 2. Zero-Velocity Reconciliation Start (High)
Reconciler replays from `(0, 0)` velocity instead of server's actual velocity at the acked tick. `applyAcceleration` is frame-dependent, so starting from zero introduces velocity error proportional to `acceleration * dt²` per replayed tick.

**Decision**: Pass server velocity into reconciler. Start replay from `(serverVx, serverVy)`.

### 3. Hardcoded Base Speed (High)
Client predicts at `PLAYER.BASE_SPEED = 325` unconditionally. Server uses actual speed (boosted: 422.5, blocking: 162.5, staggered: 0). During speed boost, 30% velocity mismatch per tick.

**Decision**: Read `myPlayer.speed` from server state. Already exposed via `PlayerSchema.speed`.

### 4. Double Smoothing (Medium)
Snap animation (smoothstep 100ms) + renderOffset decay (`e^(-12dt)`) mask errors visually but allow underlying position drift to persist.

**Decision**: Remove snap animation entirely. Keep renderOffset with faster decay (`e^(-20dt)`) for visual smoothness.

## Decision

Fix all 4 bugs sequentially. Each fix is independent but must be applied in order (A→B→C→D) because later fixes expose issues that earlier ones masked.

## Consequences

**Positive**:
- Reconciliation becomes accurate — position error < 1px under normal conditions
- Speed boost and blocking feel correct — prediction matches server
- No more visual "stickiness" from double smoothing
- Per-player ack eliminates cross-player contamination in multiplayer

**Negative**:
- Removing snap animation means reconciliation corrections are instant — may feel "jarring" for large corrections (>100px). Mitigated by renderOffset smoothing.
- Server schema change requires bandwidth for additional `lastProcessedInput` per player (~4 bytes/player/tick)

## Alternatives Considered

1. **Keep global ack, fix client-side**: Impossible — the data is fundamentally wrong for multi-player.
2. **Interpolate reconciliation**: Adds latency to corrections. We want instant correction with visual smoothing.
3. **Server-side prediction**: Would require fundamental architecture change. Not viable.
