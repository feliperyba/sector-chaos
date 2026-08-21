# ADR 0008: Movement Acceleration (Velocity Ramp-Up)

## Status

Approved

## Context

Current movement uses instant velocity — the player reaches full speed on the very first frame of input. This causes jarring position corrections during client-server reconciliation:

1. Player holds W for 3 frames before server state arrives
2. Client prediction moves at `MAX_SPEED` for 3 frames → position delta = `3 × MAX_SPEED`
3. Server state arrives — server also applied `MAX_SPEED` for 3 frames, but due to timing differences (input arrived 2 frames late), the position diverges by `2 × MAX_SPEED`
4. Reconciler replays buffered inputs, but the correction is large and visually jarring

With instant velocity, even a 1-frame timing difference produces a `MAX_SPEED`-sized position delta. At typical network jitter (±30ms), this means visible stuttering every few seconds.

Adding acceleration (velocity ramp-up over ~3–5 frames / ~50–80ms at 60Hz) means the first few frames of movement contribute smaller position deltas. A 1-frame timing error with acceleration produces a much smaller correction than with instant velocity, because both client and server are still in the low-speed portion of the ramp-up curve.

The ramp-up also naturally absorbs some latency — the player's brain attributes the ~80ms startup to "accelerating from standstill" rather than "network delay."

## Decision

Add configurable acceleration constants to `packages/shared/src/constants/player.ts`:

```ts
export const PLAYER = {
  // ... existing constants ...
  MAX_SPEED: 300,          // units/second (existing, unchanged)
  ACCELERATION: 1800,      // units/second² (new) — reaches MAX_SPEED in ~167ms (~10 frames)
  DECELERATION: 2400,      // units/second² (new) — stops faster than it starts
};
```

### Movement model

- **Input active**: `velocity += ACCELERATION × deltaTime`, clamped to `MAX_SPEED` in the input direction
- **Input released**: `velocity -= DECELERATION × deltaTime`, clamped to 0
- **Direction change**: Decelerate to 0 first, then accelerate in new direction (no instant 180° reversal)

Both client prediction and server simulation use the **same acceleration curve** — the constants are in the shared package. The reconciler replays buffered inputs with acceleration applied, so replayed positions match what the server computed.

### Dash remains instant

The existing `DASH` action (a separate `InputAction`) applies instant velocity for a fixed duration and then decelerates. Dash is **not** affected by the acceleration curve — it preserves its instant-dodge feel for combat responsiveness.

### Files affected

- `packages/shared/src/constants/player.ts` — new acceleration constants
- `packages/server/src/application/simulation/GameSimulation.ts` — apply acceleration in movement simulation
- `packages/client-v3/src/prediction/Reconciler.ts` — replay inputs with acceleration
- `packages/client-v3/src/prediction/InputBuffer.ts` (or `InputRingBuffer` post-ADR-0007) — store velocity alongside position for accurate replay

## Consequences

### Positive
- **Smoother movement**: Players accelerate naturally rather than snapping to full speed
- **Smaller reconciliation errors**: Timing mismatches during ramp-up produce small deltas (fraction of MAX_SPEED) instead of full MAX_SPEED jumps
- **Better game feel**: ~167ms startup feels like "building momentum" rather than lag
- **Dash preserved**: Separate DASH action retains instant-dodge combat responsiveness

### Negative
- **More complex prediction**: Client must track velocity (not just position) and replay acceleration during reconciliation — the `InputBuffer`/`InputRingBuffer` must store per-frame velocity or the reconciler must re-derive it
- **Tuning sensitivity**: ACCELERATION and DECELERATION values must be tuned for game feel — too slow feels sluggish, too fast negates the reconciliation benefit
- **Direction-change penalty**: Decelerate-then-accelerate on direction change adds input latency perception for rapid direction changes (this is intentional — it makes movement more deliberate)

### Risks
- If ACCELERATION is set too high (approaching instant), the reconciliation benefit disappears — must be tuned to keep the ~3–5 frame ramp-up window
- Reconciler must correctly handle the case where buffered inputs span a velocity direction change — replaying with acceleration is more complex than replaying with constant speed
