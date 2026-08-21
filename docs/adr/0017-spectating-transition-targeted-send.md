# ADR 0017: SpectatingTransition Targeted Send

## Status

Accepted

## Context

When a player dies, the server emits a `SpectatingTransition` domain event from `DeathResolutionService`. This event is currently routed through `EventMapper.broadcastEvents()` which calls `ctx.broadcast()` — sending the camera zoom animation to ALL connected clients.

On the client side, `ClientEventBridge.onMatchStart` handles `SpectatingTransition` by calling `cameraService.zoomTo(...)` with NO guard on `data.playerId === deps.myId`. This causes every client to zoom their camera when any player dies.

Meanwhile, the kill-feed handler (`onKillFeed`) already correctly guards: `if (victimId === deps.myId) deps.cameraService.zoomDeath()`. So the dead player gets a DOUBLE zoom (once from kill-feed, once from broadcast), and all other players get a SPURIOUS zoom.

The server already correctly sends `SpectatorFollowTarget` as a targeted message to the specific killed client (via `killedClient.send()`). `SpectatingTransition` should follow the same pattern.

## Decision

Convert `SpectatingTransition` from a broadcast event to a targeted server-side send, identical to the `SpectatorFollowTarget` pattern:

1. Remove `SpectatingTransition` from `EventMapper.mapEvent()` switch statement (no longer broadcast).
2. Add `SpectatingTransition` handling to `GameRoomMessages.sendSpectatorFollowTargets()` (or a new parallel function). Use `ctx.clients.find()` to locate the dead player's client and call `client.send()` directly.
3. Remove the `SpectatingTransition` handler from `ClientEventBridge.onMatchStart` entirely. The kill-feed `zoomDeath()` already handles the death camera zoom correctly (guarded by `victimId === deps.myId`).

## Consequences

### Positive

- Only the dead player sees the death camera zoom — no visual glitch for other players
- No double zoom for the dead player
- Follows the established targeted-send pattern (`SpectatorFollowTarget`)
- Removes unnecessary network traffic (one fewer broadcast per death)

### Negative

- `SpectatingTransition` event still exists in the domain but is no longer broadcast via `EventMapper`. Future features that need all clients to know about a death transition would need a separate broadcast event.

### Risks

- If the dead player's client is not found in `ctx.clients` (e.g., already disconnected), the targeted send silently fails. This is acceptable — a disconnected client doesn't need a camera zoom.
