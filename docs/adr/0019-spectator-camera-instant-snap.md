# ADR 0019: Spectator Camera Instant Snap

## Status

Accepted

## Context

GDD Section 12.7 specifies: "Camera Follow: Instant lock (no lerp delay)."

The current `CameraService.follow()` method sets target coordinates, and `CameraService.update()` applies them with a lerp factor: `const factor = 1 - Math.pow(0.001, delta / 1000)`. This factor is very aggressive (~0.93 per frame at 60fps) but not instant. There's a 1-2 frame delay before the camera catches up to a fast-moving followed player.

For normal gameplay (following the local player), this lerp is desirable — it smooths out prediction corrections and prevents visual jitter. But for spectator mode, the GDD requires instant lock.

## Decision

Add a `lerpEnabled: boolean` flag to `CameraService`, defaulting to `true`.

- `CameraService.update()` checks the flag: when `false`, sets `cam.scrollX/Y` directly to `targetX/Y - width/2` with no lerp interpolation.
- `GameScene.update()` sets `cameraService.lerpEnabled = !isSpectatingFollow` — disables lerp only when spectating and following a player (not in free camera mode, where the player controls the position).
- Alternatively, free camera also uses instant position (already does — `localPos` is set directly by `SpectatorController`). So `lerpEnabled` should be `false` for all spectator modes.

## Consequences

### Positive

- Spectator camera matches GDD spec (instant lock)
- Normal gameplay camera behavior unchanged (lerp still active for local player)
- Minimal code change — one boolean flag and a conditional in `update()`

### Negative

- Adds mutable state to `CameraService` (minor)
- Spectator camera will show every frame of the followed player's interpolation (which may reveal slight position jitter from network interpolation). This is acceptable — spectators expect to see exactly what the followed player is doing.

### Risks

- If `lerpEnabled` is not re-enabled when returning from spectator mode (respawn), the local player's camera will snap instead of lerp. Mitigation: `handleRespawn()` in `GameScene.update()` already resets spectator state. Ensure `cameraService.lerpEnabled = true` is included in the respawn reset.
