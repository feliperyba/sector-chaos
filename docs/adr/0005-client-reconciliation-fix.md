# ADR 0005: Client Reconciliation Position Ordering Fix

## Status

Proposed

## Context

A rendering-order bug causes visible teleportation flicker for the local player on every server state update.

In `ClientStateBridge.ts` (line 72), the local player's renderer position is updated unconditionally:

```ts
playerRenderer.updatePosition(key, p.x, p.y); // line 72 — runs for ALL players including local
```

This call executes **before** the reconciliation block (lines 76–84), which adjusts the local player's position by replaying buffered inputs against the server-confirmed state. The result: on every server update the renderer briefly shows the raw server position, then `GameScene` (line 288) overwrites it with the reconciled position. Players perceive this as a momentary teleport / flicker each tick.

The local player is already correctly excluded from the network interpolator, so no additional interpolation logic is needed — only the ordering of the renderer update must be fixed.

## Decision

The local player's renderer update **must happen after** reconciliation, not before it. Two equivalent approaches:

1. **Move line 72 into the reconciliation path** — skip the local player in the unconditional loop, then call `playerRenderer.updatePosition` for the local player at the end of the reconciliation block using the reconciled position.
2. **Defer renderer updates to GameScene's update loop** — `ClientStateBridge` writes reconciled positions into a shared map; `GameScene.update()` reads from that map and calls the renderer. This is already how the reconciled position reaches line 288, so it naturally avoids the out-of-order update.

Either approach ensures the renderer never sees the raw server position for the local player.

## Consequences

### Positive
- Eliminates the teleportation flicker on every server update
- No interpolation needed for the local player (already excluded from the interpolator)
- Minimal code change — reordering existing logic, not adding new systems

### Negative
- Requires a conditional branch in the renderer-update loop (local vs. remote player)
- If deferred to GameScene, adds a frame of latency for remote player position updates unless the existing unconditional path is preserved for non-local players

### Risks
- Must verify that the reconciliation block always produces a valid position (edge case: no buffered inputs to replay)
