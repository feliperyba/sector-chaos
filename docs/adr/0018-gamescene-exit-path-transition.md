# ADR 0018: GameScene Exit Path — SceneNavigator Transition

## Status

Accepted

## Context

There are three exit paths from GameScene back to MainMenuScene:

1. **Spectator ESC** — `SpectatorController.update()` currently calls the `disconnect()` callback which drops the websocket via `room.leave()`. No scene transition occurs. The player is left staring at a frozen game scene.

2. **Results screen dismiss** — `ResultsScreen.dismiss()` calls `onDismiss` which is set by `ClientEventBridge.onMatchEnd` to `deps.hud.setStatusText('Returning to lobby...', true)`. No scene transition occurs. The player sees "Returning to lobby..." forever.

3. **Results screen ESC / RETURN TO MENU button** — Both call `dismiss()`, same do-nothing callback.

All three paths need to: (a) disconnect from the server, (b) transition to MainMenuScene.

The existing `SceneNavigator.transitionTo(targetKey, data, scenesToStop)` pattern is already used by `MainMenuScene` and `MatchmakingScene` for all scene navigation. `TransitionScene` handles the cover animation and stops old scenes, which triggers Phaser's `shutdown` event.

A shutdown handler already exists in `GameSceneSetup.ts:250` — it destroys playerRenderer, entityRenderer, zoneRenderer, hud, statusEffects, resultsScreen, connection, and audio. This handler fires when Phaser stops GameScene (which TransitionScene does via `this.scene.stop(key)`).

## Decision

Wire all three exit paths through a shared `returnToMenu()` method in `GameScene` that:

1. Disconnects from the server (via `connection.disconnect()` which calls `room.leave()`)
2. Transitions to `MainMenuScene` via `SceneNavigator.transitionTo(SCENE_KEYS.MAIN_MENU, {}, [SCENE_KEYS.GAME])`

The `SceneNavigator` instance is created in `GameScene.create()` and passed to `ClientEventBridge` via `EventBridgeDeps`.

Implementation changes:

- `SpectatorController.update()` — Remove the `disconnect` callback parameter. Return an action flag (`escPressed: boolean`) instead. `GameScene.update()` handles the flag by calling `returnToMenu()`.
- `ClientEventBridge.onMatchEnd` — Change the `onDismiss` callback to call a `returnToMenu` function passed via `EventBridgeDeps`.
- `EventBridgeDeps` — Add `returnToMenu: () => void` function reference.
- `GameScene` — Add `returnToMenu()` method that disconnects and transitions. Create `SceneNavigator` in `create()`.

## Consequences

### Positive

- All exit paths share one implementation — consistent behavior
- Uses existing `SceneNavigator`/`TransitionScene` infrastructure — smooth visual transition
- Existing shutdown handler fires automatically when `TransitionScene` stops `GameScene`
- No memory leaks — all subsystems destroyed via existing shutdown handler
- Follows the same pattern as `MatchmakingScene.returnToMenu()`

### Negative

- `SpectatorController` API changes from callback to return-value action flag (breaking change for callers)
- `EventBridgeDeps` gains a function reference (minor interface expansion)

### Risks

- If `SceneNavigator.transitionTo()` is called while the TransitionScene is already transitioning (e.g., double-ESC), it could conflict. Mitigation: `SceneNavigator` already handles re-entrant calls — if TransitionScene is active, it delegates to `startTransition()` directly.
- If the connection is already disconnected when `returnToMenu()` is called, `room.leave()` may throw. Mitigation: `Connection.disconnect()` already checks `if (this.room)` before calling `leave()`.
