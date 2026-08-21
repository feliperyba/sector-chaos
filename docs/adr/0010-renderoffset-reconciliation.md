# ADR 0010: RenderOffset Reconciliation

## Status

Proposed

## Context

The local player experiences heavy, laggy, and jittery movement caused by three interacting issues in the prediction-reconciliation pipeline:

1. **Stale speed in prediction** — Client predicts at `myPlayer.speed` from the last server patch (up to 33ms stale at 30Hz). When speed changes due to stagger (`STAGGER_MOVE_SPEED_PENALTY = 0.5`), blocking (`BLOCKING_SPEED_PENALTY = 0.5`), or speed boosts, prediction drifts 10–20px per correction. Example: client predicts at 325 but server computed at 162.5 (stagger just applied) → over 2 frames = 21px error.

2. **Hard snap below 64px threshold** — `Reconciler.ts` smoothstep-blends corrections above `RECONCILIATION_THRESHOLD = 64px` but hard-snaps anything below. Most corrections are 3–15px (not 64+), so the player gets hard-snapped ~30 times per second. This is the primary source of perceived jitter.

3. **Variable vs. fixed dt** — Client prediction uses Phaser's variable frame delta (16.2–17.5ms). Server and reconciler replay use fixed 1/60. Sub-pixel drift accumulates over long sessions.

ADR 0005 addressed the ordering bug (renderer seeing raw server position before reconciliation). That fix was necessary but insufficient — it prevented the renderer from seeing the *wrong* position, but didn't address the hard-snap problem for small corrections.

The movement model is **kinematic** (velocity is recalculated each frame via `applyAcceleration`, not simulated physics with inertia/mass/gravity). This is significant because:
- Snapping velocity is safe (next frame recalculates from input + acceleration anyway)
- No oscillation risk from velocity/position mismatch
- The renderOffset approach is simpler than for physics-based games

## Decision

### 1. Introduce renderOffset — separate visual from simulation position

Add a `renderOffset: {x: 0, y: 0}` to GameScene. The simulation position (`localPos`) remains the authoritative state for prediction, collision, and interaction. The visual position (`localPos + renderOffset`) is used only for rendering, camera, and aim direction.

**Decay model:** Exponential decay at rate 12/second. Each frame: `offset *= Math.exp(-12 * dt)`. At 60fps:
- 5px error → converges in ~4 frames (~67ms)
- 15px error → converges in ~8 frames (~133ms)

Most corrections finish blending before the next server patch arrives (33ms), preventing offset stacking.

**On new patch arrival:** `renderOffset = currentVisualPos - newReconciledSimPos` (recomputed, not additive). No stacking, no oscillation.

### 2. Lower reconciliation threshold from 64px to 4px

`RECONCILIATION_THRESHOLD` in `types.ts` changes from 64 to 4. Errors below 4px are absorbed by the renderOffset with no snap. Errors above 4px continue to use the existing smoothstep snap (100ms blend).

### 3. Only 3 consumers change to visual position

| Consumer | Position Source |
|----------|----------------|
| PlayerRenderer.updatePosition | `localPos + renderOffset` |
| CameraService.follow | `localPos + renderOffset` |
| Aim direction (4 call sites) | `localPos + renderOffset` |

All other consumers (prediction, collision, interaction, reconciliation, debug, HUD prompt) remain on `localPos` unchanged.

### 4. Fix prediction to use BASE_SPEED and fixed dt

Client prediction uses `PLAYER.BASE_SPEED` instead of `myPlayer.speed` (avoids stale speed drift). Prediction accumulates Phaser's variable delta and steps in fixed 1/60 increments (matches server). These changes reduce the *source* of reconciliation errors.

### Simulation vs. Visual contract

```
localPos (simulation)     → prediction, collision, interaction, reconciliation, debug, HUD prompt
localPos + renderOffset   → renderer, camera, aim direction
```

`localPos` is always the reconciled server-authoritative state. `renderOffset` is purely a visual smoothing layer that never feeds back into simulation.

## Consequences

### Positive

- **Eliminates perceived jitter** — Small corrections (3–15px) blend smoothly over 4–8 frames instead of hard-snapping 30 times per second
- **Minimal code change** — 3 consumer changes + one new offset field. No refactor of 58 localPos references.
- **Enables future features** — renderOffset can be extended for screen shake, hit flash, knockback visuals
- **Server authoritative** — Simulation position (`localPos`) is always server-reconciled. Visual position is a rendering concern only.
- **No oscillation risk** — Kinematic velocity model means velocity snapping is safe; renderOffset never feeds into simulation.
- **Performance** — Two additions per frame. Zero measurable cost.

### Negative

- **Visual position is slightly behind simulation** — renderOffset creates a visual delay of up to 4–8 frames for corrections. This is invisible to the player (sub-5px blend) but technically means the sprite is not exactly where the simulation thinks it is.
- **Aim direction uses visual position** — Aim is computed from `localPos + offset`, not pure simulation. The difference is sub-pixel during normal play. Acceptable trade-off for smooth aim feel.
- **Speed changes are not predicted** — Using BASE_SPEED means prediction is wrong during stagger/block/speed-boost until the next server patch corrects. The renderOffset absorbs this correction smoothly, but there's a 33ms window where prediction diverges.

### Risks

| Risk | Mitigation |
|------|------------|
| RenderOffset accumulates instead of decaying | Exponential decay guarantees convergence. Recomputation on new patch replaces (not adds to) offset. |
| Large corrections (>4px) still feel jarring | Existing smoothstep snap handles these (unchanged). Threshold lowered from 64 to 4, not removed. |
| Fixed timestep causes frame drops if accumulator overflows | Cap leftover time at 2 ticks (33ms). Drop frames rather than spiral. |
| BASE_SPEED prediction wrong during stagger | Reconciliation corrects within 1–2 patches (33–66ms). renderOffset absorbs correction visually. Future: predict speed changes from local input. |

## Supersedes

- [ADR 0005: Client Reconciliation Position Ordering Fix](./0005-client-reconciliation-fix.md) — ordering fix subsumed; this ADR addresses the broader snap/smooth problem.
- Relevant to [ADR 0009: Revert Windup, Fix Movement Pipeline](./0009-revert-windup-fix-movement.md) — ADR 0009 raised acceleration constants and fixed reconciler dt. This ADR adds the visual smoothing layer that ADR 0009's changes needed but didn't include.
