# ADR 0020: EntityInterpolator Velocity Extrapolation

## Status

Proposed

## Context

After doubling throw speeds (THROW_SPEED_BASE 1080→1400, per-weapon 400-550→650-1100) and increasing arrow speed to 1500, thrown weapons and arrows visibly jitter on screen.

EntityInterpolator does pure snapshot interpolation with a 67ms delay and a 64px snap threshold. At 1400 px/s, a projectile travels 93.8px in 67ms — exceeding the 64px snap threshold. The interpolator detects the interpolated position is too far behind the newest snapshot and hard-snaps, causing visible stuttering. At the old speeds (550 px/s), travel was 36.9px — safely within threshold.

The server already syncs `velocityX` and `velocityY` in ProjectileSchema. The client receives velocity data but only uses it for rotation, never for position prediction.

## Decision

Add velocity-based extrapolation to EntityInterpolator. When velocity data is available, the interpolator predicts position forward from the newest snapshot instead of interpolating between two stale snapshots.

### Two-path logic

`getInterpolatedPosition()` becomes a two-path method:

1. **Extrapolation path** (velocity available): `pos = newest.x + vx * elapsed`, capped at 100ms past the newest snapshot. After 100ms, the entity freezes until a new patch arrives or it is removed. The snap threshold does not apply — it was an interpolation artifact.
2. **Interpolation path** (no velocity): Existing 67ms delayed lerp between bracketing snapshots with 64px snap threshold. Unchanged behavior for remote players.

### API change

`push(id, x, y)` gains optional `vx`, `vy` parameters: `push(id, x, y, vx?, vy?)`. Callers with velocity data pass it; callers without (remote players) omit it.

### Correction model

Hard snap. On each new patch, the extrapolated position is replaced with the server position. For linear flight, extrapolation and server truth are sub-pixel identical (same velocity, same math). For bounces, one frame of overshoot is corrected instantly — acceptable because the bounce VFX fires simultaneously.

### Rotation ownership

`setProjectilePosition()` in EntityRendererLifecycle stops setting rotation. Rotation is owned by `updateProjectileVisuals()` which derives it from server-synced velocity. Position comes from the extrapolator, rotation comes from velocity. Clean separation.

## Alternatives Considered

1. **Increase SNAP_THRESHOLD_SQ** — Quick fix but band-aid. Doesn't address fundamental issue: interpolation can't keep up with high speeds regardless of threshold.
2. **Increase INTERPOLATION_DELAY_MS** — Adds visual lag for all entities. Bad for gameplay feel, especially at close range.
3. **Separate projectile-only interpolator** — Duplicates snapshot buffer logic. EntityInterpolator is shared infrastructure; extrapolation benefits any fast entity.

## Consequences

### Positive

- Eliminates projectile jitter at any speed without increasing visual latency.
- Extrapolation uses server-synced velocity — no client-side physics simulation needed.
- Remote players unaffected (no velocity pushed to their interpolator instance).
- Arrows (1500 px/s) automatically fixed — same pipeline.
- General capability: any future fast entity benefits automatically.

### Negative

- One frame of position correction on bounce events (overshoot then snap). Masked by bounce VFX.
- Boomerang return trajectory has 1-frame velocity lag (homing changes direction each tick). Imperceptible at 60Hz patches.
- EntityInterpolator internals become more complex (two code paths). Mitigated by clean separation.

### Risks

| Risk | Mitigation |
|------|------------|
| Extrapolation diverges during network spike | 100ms time cap prevents runaway extrapolation. Entity freezes rather than flying across the map. |
| Float precision drift over time | Hard snap on every patch resets accumulated error. No drift accumulation. |
| Remote players accidentally receive extrapolation | push() requires explicit vx/vy. Remote player push() calls omit them. |

## Supersedes

N/A. Extends (does not replace) the existing EntityInterpolator interpolation behavior for entities with velocity data.

## Related

- [ADR 0015: Extrapolation-Based Local Player Rendering](./0015-extrapolation-rendering.md) — Different mechanism (client prediction accumulator vs server velocity). Same conceptual approach.
