# Client Zero-Allocation Rendering Pipeline

Accepted — Eliminates ~300,000 short-lived object allocations/second at 64 players that caused V8 GC pauses and frame-time spikes.

The client generated ~5,000 short-lived objects per frame at 64 players (~300K/sec), triggering frequent V8 minor GC pauses (1-5ms each) that caused frame-time spikes perceived as choppiness. This was independent of server performance — it occurred whenever 64 players were being rendered and animated. The animation pipeline alone accounted for 85% (~4,700 objects/frame).

Three levels of allocation elimination:

**Level 1 — Rebuild Elimination (~260 allocs/frame killed):**
- `getAllPlayerPositions()` (`GameScene.ts:401-413`): pre-allocated `Map` + reusable `{x,y}` entries, cleared and refilled each frame. No new Map, no new objects.
- `drawAttacks` Map rebuild (`PlayerRenderer.ts:364-372`): pass `this.visuals` directly to VFX renderer. Kill the intermediate Map + `Array.from` + `.map()` chain.
- `EntityInterpolator.getInterpolatedPosition()` (`EntityInterpolator.ts`, 8 return points): out-parameter pattern — accept a reusable `{x,y}` target, write in place, never allocate. Returns `void`.
- `worldToScreen()`, `minimapAdapter.assemble()`: same out-parameter / pre-allocated array pattern.

**Level 2 — Animation Pipeline Pooling (~4,700 allocs/frame killed):**
- `stepAnimation()` and `lerpResult()` (`AnimSimDriver.ts`, `stepAnimation.ts`): rewrite to write into pre-allocated `AnimStepResult` / `ArmPose` / `Vec2` objects stored per-player. Each `AnimSimDriver` owns its own output scratch space (one result object + nested arm/vec children, allocated once at init, mutated every frame).
- `armRenderer.updateArms()` (`PlayerRendererUpdate.ts:234-244`): accept a reusable `ArmJoints` object per player, mutate in place. No new `ArmJoints` + 6 `Vec2` children per call.
- `DriverFrameInput` (`PlayerRendererUpdate.ts:143-152`): pre-allocated per player, fields mutated each frame.
- `PredictionService.step()` (`PredictionService.ts:124-165`): eliminate closure-per-substep (`line 154`), pool `PhysicsState`/`PhysicsInput` objects.

**Level 3 — StateSync onChange Optimization (~1,280 heavy rebuilds/sec reduced):**
- `toPlayerState()` (`SchemaConverters.ts:275-351`): field-level dirty checking. Track a per-player schema version counter; only reconstruct `PlayerState` + weapons/items arrays when the schema version changes. For position-only updates (the common case — 64 players moving every patch), read `schema.x`/`schema.y` directly into the interpolator, bypassing full `PlayerState` construction.
- `InputBuffer.getUnacknowledged()` (`InputBuffer.ts:35-81`): pre-allocated result array + reusable `InputRecord` objects. The `Float64Array` slice remains (necessary for range copy), but the per-iteration `InputFrame` + `actions[]` + `InputRecord` allocations are replaced with pooled objects.

**Considered options:**
- Structure of Arrays (SoA) with flat `Float64Array` for entity positions (rejected: cache-efficiency gain negligible at N=64; massive refactor cost; AoS with pooled objects achieves zero-alloc without the complexity)
- Object pool framework / generic pool library (rejected: overkill — per-owner scratch space is simpler and sufficient; each system owns its own pre-allocated objects)
- Immutable per-snapshot rendering (rejected: creates exactly the allocation problem we're eliminating)

**Consequences:** All client hot-path systems transition from "allocate per frame/entity" to "mutate pre-allocated objects in place." This is a significant pattern change — every new rendering or prediction feature must follow the zero-alloc convention (pre-allocate at init, mutate per frame, never `new` in update loops). Code becomes slightly more verbose (explicit object ownership, out-parameter patterns) but GC pressure drops from ~300K/sec to near-zero. Frame time variance from GC pauses should be eliminated, enabling consistent 59-60fps at 64 players.
