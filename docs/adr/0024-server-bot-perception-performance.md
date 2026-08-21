# Server Bot Perception Performance Architecture

Accepted — Resolves server tick overruns at 63 bots + 1 player caused by O(N²) perception scanning.

Bot perception was the #1 server hotspot: all 63 bots independently rebuilt the full world view every tick (63× redundant entity array allocations + per-player object construction), each scanning all 64 players with distance filtering + Bresenham LOS raycasts per nearby player (~1,260 grid marches/tick). This consumed the majority of the 16.67ms tick budget, causing tick overruns, catch-up storms (MAX_STEPS=5), and irregular state patch delivery — perceived by players as choppy, jittery gameplay that improved as bots died.

Four-part architecture, implemented together:

1. **Pooled Shared World Snapshot** — `BotSystem` owns a persistent `WorldSnapshot` (pre-allocated slots + `Int32Array` active index list + `Map<id,slot>` lookup). Synced once per tick before the bot loop (mutate DTO fields in place, zero allocation). Frozen read-only during bot execution. Replaces 63× per-bot `BotGameStateView` rebuilds with 1× shared build. Position fields flattened (`dto.x`, `dto.y` instead of `dto.position.x`). Weapon arrays pre-allocated to `INVENTORY_SIZE`, mutated in place.

2. **Global LOS Cache** — `Pathfinder` maintains a `Map<number, boolean>` keyed by normalized grid-cell pair (symmetric: `min(a,b)`, `max(a,b)`, packed into 32-bit int). Lazy population: first query runs DDA, stores result; subsequent queries are O(1) Map lookups. Invalidation is event-driven only — `invalidateLOSCache()` called when tile grid changes (siege wall solidification, destructible destroyed). Between grid changes, results are permanently valid. Turns ~1,260 DDA marches/tick into ~1,260 Map lookups/tick after warmup.

3. **Staggered Perception at 20Hz** — `BOT_PERCEPTION_INTERVAL_TICKS = 3` (tunable). Each bot assigned `perceptionPhase = deterministicHash(botId) % interval`. On tick T, only bots where `T % interval === perceptionPhase` scan (~21 bots/tick instead of 63). Between scans, bots carry forward last results from pooled arrays. Tracked target positions remain real-time (read from shared snapshot, updated every tick). Only new-threat discovery is delayed ≤50ms — still 4× faster than human reaction time (~200ms).

4. **Event-Driven Pathfinder Grid Sync** — Replaces timer-driven `syncPathfinderGrid` every 3 ticks (which called `pf.cache.clear()` defeating A* caching). Grid sync + cache invalidation fire only on actual tile changes (same triggers as LOS cache invalidation).

**Considered options:**
- Per-bot LOS cache with TTL (rejected: 63 separate caches, low hit rate, bots near each other don't share results)
- Perception at 60Hz with spatial index (rejected: unnecessary at N=64 — remaining O(N²) collision is ~0.003% CPU after allocation elimination. See ADR-0027)
- Worker thread offloading via BeeThreads (rejected: bottleneck is algorithmic not parallelization; cross-thread serialization adds tick latency; Colyseus not cluster-safe per research archive)
- Swap-remove dense arrays for snapshot lifecycle (rejected: breaks reference stability for bots holding entity references during tick)
- Handle-based generation tracking (rejected: adds indirection per field access in hot loop; unnecessary since snapshot is frozen during bot loop)

**Consequences:** Bot perception reaction latency increases from 0ms to ≤50ms (imperceptible — bots still react 4× faster than humans). Memory: LOS cache grows with unique cell pairs queried (bounded by gameplay paths, typically <50K entries). The shared snapshot couples all bots to the same world view — acceptable since they share the same server-authoritative state. Pathfinder cache survives indefinitely between grid changes, dramatically improving A* hit rate. Total perception cost reduced by ~60× (63× snapshot sharing + LOS cache + 3× throttling).
