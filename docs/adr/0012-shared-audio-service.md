# ADR 0012: Shared Audio Service

## Status

Accepted

## Context

The current `AudioService` is constructed per-scene (`new AudioService(this)` in each scene's `create()`). This creates three problems:

1. **Hard-cut on transition**: When `scene.start()` stops the outgoing scene, its `cleanup handler` fires `audio.destroy()`, which immediately stops music with no fade. The player hears a jarring audio cut.

2. **Cannot fade across scene boundary**: Audio fade requires a tween running on the outgoing scene's tween manager. When the scene stops, the fade tween dies. There is no correct point in the current architecture to perform a cross-scene audio fade.

3. **Redundant loading**: Each scene calls `loadAll()` which re-queues audio files (even if cached). The `loaded` flag is set before files actually load, causing intermittent silence.

The angry-aliens reference uses a shared audio system resolved from a DI container, persisting across scene changes.

## Decision

Create a `SharedAudioService` that:

1. **Is constructed with the `Phaser.Game` instance** (not a scene). The game instance persists for the entire application lifetime.

2. **Persists across scene transitions**. Stored as a singleton accessible from any scene (via a module-level instance or attached to the game object).

3. **Supports fade-out via the game's tween manager**: `stopMusic(fadeMs)` uses `game.tweens` (not a scene's tween manager) to tween the music sound's volume to 0 over `fadeMs`, then stops and destroys the sound. This tween survives scene stops because it's on the game's global tween manager.

4. **Deferred play on context unlock**: Music plays only after the Web Audio context is unlocked (first user gesture). A flag tracks whether the context has been unlocked. If `playMusic()` is called before unlock, the request is queued and executed when the context becomes available.

5. **Scenes reference the shared instance**: Each scene gets the shared service via a module export or game registry, not by constructing a new one.

## Consequences

### Positive

- Music fades gracefully across scene boundaries (core UX fix)
- Audio lifecycle independent of scene lifecycle (architectural fix)
- No redundant loading (performance fix)
- Audio context unlock ensures reliable playback (reliability fix)

### Negative

- Scenes must access the shared instance via a known path (convention change)
- Game-level tweens for fade must be cleaned up on game destroy (lifecycle consideration)
- If multiple scenes try to play different music simultaneously, the shared service must handle stop-before-play correctly

### Risks

- Phaser 4's `game.tweens` may behave differently from scene-level tweens. Mitigation: test with 150ms+ simulated latency.
- The singleton pattern may complicate testing. Mitigation: the SharedAudioService interface is simple enough to mock.
