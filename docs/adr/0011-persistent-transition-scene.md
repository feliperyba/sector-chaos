# ADR 0011: Persistent Parallel TransitionScene

## Status

Accepted

## Context

The current `SketchWipeTransition.perform()` is a static utility that operates on the outgoing scene. It captures the scene to a RenderTexture, then calls `scene.start()` to switch to the new scene. This immediately stops the outgoing scene and destroys its tween manager, killing the reveal animation. The player sees a frozen screenshot of the old scene forever.

Additionally:
- No input blocking during transitions — players can click buttons mid-transition
- No audio fade coordination — the outgoing scene's AudioService is destroyed with it
- Per-frame `GeometryMask` allocation leaks GPU resources
- No handshake for the target scene to signal readiness (async setup hidden behind cover)

The angry-aliens reference project solves all of these with a dedicated `TransitionScene` that runs as a persistent parallel Phaser scene.

## Decision

Create a `TransitionScene` class that:

1. **Runs as a separate Phaser scene** — launched via `scene.launch()`, brought to top via `scene.bringToTop()`. Registered in `main.ts` scene array but never the initial scene.

2. **Manages a three-phase lifecycle**: `covering → holding → revealing → idle`. The tween manager belongs to TransitionScene, so it survives when other scenes are stopped.

3. **Blocks input** with a fullscreen `inputBlocker` rectangle at `DesignTokens.depth.overlay` with `setInteractive()`. Visible during covering + holding + revealing. Hidden when idle.

4. **Uses alpha-fade cover/reveal** (not per-frame GeometryMask). A fullscreen rectangle tweens alpha 0→1 (cover) then 1→0 (reveal). Zero per-frame allocation.

5. **requestReveal handshake** — target scenes call `requestReveal()` in their `create()`. TransitionScene starts reveal only when the target scene signals readiness. If the target calls before cover completes, the request is queued and executed when holding phase begins.

6. **SceneNavigator** — per-scene helper that abstracts `scene.get()` / `scene.launch()` / `startTransition()` into a single `transitionTo()` method. Every scene change goes through this.

7. **MenuDirector** — coordinates menu-specific concerns: sets `isInteractive = false`, calls `audio.stopMusic(500)`, then triggers `navigator.transitionTo()`. Owns choreography lifecycle.

## Consequences

### Positive

- Transition animations survive scene lifecycle changes (core bug fix)
- Input physically blocked during transitions (no spam-click, no accidental actions)
- Audio fade coordinated before transition starts (no jarring cut)
- Target scenes control reveal timing (async setup hidden behind cover)
- Zero per-frame allocation (no GeometryMask leak)
- Single entry point for navigation (SceneNavigator) — consistent behavior across all scenes
- Shader-based wipe can be added later by replacing the alpha-fade rectangle with a shader, without changing the lifecycle

### Negative

- TransitionScene must be registered in `main.ts` scene array (configuration requirement)
- Every scene that can be transitioned TO must call `requestReveal()` in its `create()` (convention requirement)
- One additional Phaser scene running in parallel (minimal performance impact — only active during transitions)

### Risks

- If a target scene forgets to call `requestReveal()`, the transition cover stays forever. Mitigation: TransitionScene could auto-reveal after a timeout (e.g., 5 seconds) as a safety net.
- Phaser 4's scene lifecycle may have edge cases with parallel scenes. Mitigation: the angry-aliens reference uses this pattern successfully with Phaser 3; Phaser 4's scene system is compatible.
