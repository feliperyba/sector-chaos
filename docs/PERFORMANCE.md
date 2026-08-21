# Performance Budget Reference

These targets are documentation-only reference budgets. They were once mirrored in `packages/shared/src/constants/performance.ts` as `PERFORMANCE_BUDGET`, but that file was removed as dead code (commit `1717531`, zero references) — no runtime code enforces these budgets.

## Budget Targets

| Constant | Value | Unit | Description |
|---|---|---|---|
| `DESKTOP_TARGET_FPS` | 60 | fps | Sustained frame rate on desktop |
| `MOBILE_MIN_FPS` | 30 | fps | Minimum frame rate on mobile |
| `SERVER_TICK_MAX_MS` | 0.3 | ms | Max server physics step time |
| `SERVER_TICK_MAX_BODIES` | 50 | bodies | Reference body count for tick budget |
| `STATE_PATCH_MAX_KB` | 5 | KB | Max state patch size per tick at 20 Hz |
| `MAX_DRAW_CALLS` | 100 | calls/frame | Max draw calls per rendered frame |
| `GC_PAUSES_ALLOWED` | 0 | pauses | GC pauses allowed during gameplay |
| `NETWORK_UPSTREAM_MAX_KBPS` | 50 | KB/s | Max upstream bandwidth per client |
| `NETWORK_DOWNSTREAM_MAX_KBPS` | 200 | KB/s | Max downstream bandwidth per client |
| `BUNDLE_MAX_MB` | 2 | MB | Max initial bundle size |
| `MEMORY_MAX_MB` | 200 | MB | Max heap memory after 30-minute session |
| `MEMORY_SESSION_MINUTES` | 30 | min | Session duration for memory budget |

## How to Measure Each Metric

### Desktop FPS (60 fps sustained)

Use the browser's Performance panel or `performance.now()` in the game loop. Record frame deltas over a 60-second gameplay session. Compute the 1st percentile (worst 1%) — it must remain above 60 fps.

### Mobile FPS (30 fps minimum)

Profile on target mobile devices using Chrome DevTools remote debugging. Frame time must stay below 33.3 ms. Use Phaser's built-in FPS counter as a quick check.

### Server Physics Step (< 0.3 ms per tick at 50 bodies)

Instrument `physicsStep()` with `performance.now()` at start and end. Log p99 latency over a 5-minute load test with 50 active physics bodies. If p99 exceeds 0.3 ms, reduce body count or simplify collision shapes.

### State Patch Size (< 5 KB per tick at 20 Hz)

Log `patch.bytes.length` from the Colyseus `onStateChange` handler. Compute rolling average over 100 ticks. Use `JSON.stringify(state).length` as a fallback. Optimize by removing unchanged fields from patches.

### Max Draw Calls (< 100 per frame)

Use Phaser's debug renderer or Chrome DevTools Rendering panel → "Draw calls" overlay. Count per frame during the busiest scene (full match with all entities). Reduce by batching sprites onto shared texture atlases.

### GC Pauses (0 during gameplay)

Open Chrome DevTools → Performance → record a session. Check for yellow "GC" markers during gameplay. Object pools must be used for all frequently allocated types (projectiles, particles, network messages). See Object Pool Pattern below.

### Network Upstream (< 50 KB/s per client)

Instrument the WebSocket `send()` path. Log total bytes sent per second during peak gameplay (combat + movement). If exceeded, reduce input packet frequency or compress payloads.

### Network Downstream (< 200 KB/s per client)

Instrument the WebSocket `onmessage` handler. Log total bytes received per second. Reduce by sending delta patches instead of full state, or throttling non-critical updates.

### Initial Bundle Load (< 2 MB)

Run `pnpm build` and check the `dist/` folder sizes. The `vite.config.ts` already splits chunks (phaser, colyseus, game, lobby, results). Monitor total initial load — lazy-load non-critical chunks if budget is exceeded.

### Memory (< 200 MB after 30 min, no leaks)

Open Chrome DevTools → Memory → take heap snapshots at start and after 30 minutes of gameplay. The delta must be near zero (no growing arrays, no detached DOM nodes, no unregistered event listeners). Use the "Comparison" view between snapshots.

## What to Do When a Budget Is Exceeded

1. **Add a runtime check** — Compare the measured metric against the corresponding `PERFORMANCE_BUDGET` constant. Log a warning or throw in development.
2. **Identify the cause** — Use the measurement techniques above to find the bottleneck.
3. **Fix and verify** — Apply the optimization, re-measure, confirm the metric is back within budget.
4. **File a regression test** — If a budget was silently exceeded, add a CI check or runtime assertion to prevent recurrence.

## Object Pool Pattern for GC Avoidance

Garbage collection pauses are caused by frequent short-lived allocations. The solution is to pre-allocate objects and reuse them.

### When to Use Object Pools

- Projectiles and projectiles-like entities created/destroyed every frame
- Particle effect instances
- Network message buffers
- Temporary math objects (Vector2, matrices)
- State diff objects

### Implementation Pattern

```typescript
class ObjectPool<T> {
  private readonly available: T[] = [];
  private readonly factory: () => T;
  private readonly reset: (obj: T) => void;

  constructor(factory: () => T, reset: (obj: T) => void, initialSize: number) {
    this.factory = factory;
    this.reset = reset;
    for (let i = 0; i < initialSize; i++) {
      this.available.push(factory());
    }
  }

  acquire(): T {
    return this.available.length > 0
      ? this.available.pop()!
      : this.factory();
  }

  release(obj: T): void {
    this.reset(obj);
    this.available.push(obj);
  }
}
```

### Usage Example

```typescript
const bulletPool = new ObjectPool(
  () => ({ x: 0, y: 0, vx: 0, vy: 0, active: false }),
  (b) => { b.x = 0; b.y = 0; b.vx = 0; b.vy = 0; b.active = false; },
  100,
);

const bullet = bulletPool.acquire();
bullet.active = true;
// ... use bullet ...
bulletPool.release(bullet);
```

### Anti-Pattern #26 — Allocating in the Game Loop

Never do this:

```typescript
function update() {
  const temp = new Phaser.Math.Vector2(player.x, player.y); // GC pressure!
  enemies.forEach((e) => {
    const dir = new Phaser.Math.Vector2(e.x, e.y).subtract(temp).normalize(); // GC pressure!
  });
}
```

Instead, pre-allocate and reuse:

```typescript
const _tempVec = new Phaser.Math.Vector2();
const _dirVec = new Phaser.Math.Vector2();

function update() {
  _tempVec.set(player.x, player.y);
  enemies.forEach((e) => {
    _dirVec.set(e.x, e.y).subtract(_tempVec).normalize();
  });
}
```

## 2026-08 optimization pass

A behavior-preserving optimization effort (54/54 tickets across server, bot AI, shared, and client) completed on branch `perf/optimization-queue`. No budget above was relaxed and no gameplay number changed. Highlights:

- **Server:** domain spatial-hash broadphase for combat scans, zero-alloc scratch buffers (movement/combat/animation), maintained alive-counter, table-driven damage/event/state mappers.
- **Bot AI:** pooled hazard scans, per-tick intent memos, path-cursor navigation (also fixed a latent pathfinder-cache poisoning bug), ring-buffer enemy history.
- **Client:** collision prediction delegated to shared pure primitives (parity proven against verbatim oracles), telemetry growth caps, GPU object pools (damage-number pool, texture-leak fixes, event-driven capture list).
- **Tooling:** `bench:bot-ai` is deterministic at fixed `BENCH_SEED` — same-seed JSON byte-identical modulo wall-clock fields — enabling bit-identity regression gates.

Full record: [perf-optimization/README.md](perf-optimization/README.md). Narrative write-up: [perf-optimization/CASE_STUDY.md](perf-optimization/CASE_STUDY.md).
