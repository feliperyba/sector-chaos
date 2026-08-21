# Server Tick Stability: MAX_STEPS=1 + Per-System Profiling

> **Status update (2026-08-16):** the `MAX_STEPS=1` value below is historical. Production has used `MAX_STEPS=4` with a 0.25s accumulator frame-time clamp since pre-branch commit `07c046c` (`packages/server/src/application/simulation/TickTimer.ts`, lines 18/25): Colyseus's `setSimulationInterval` drifts under event-loop load (~51Hz measured), and the cap of 1 left the sim running ~85% real time while clients predicted at true 60Hz, causing prediction drift and reconciliation stutter. The clamp preserves this ADR's spiral-of-death protection — only the specific step cap is superseded. Tests were updated to the real contract in commit `8614275`.

Accepted — Prevents spiral-of-death tick cascades and provides live visibility into per-system tick costs.

Two changes to the server simulation loop:

1. **MAX_STEPS reduced 5 → 1** (`TickTimer.ts:4`) — The TickTimer accumulates real frame time and consumes it in fixed 1/60s steps. Previously MAX_STEPS=5 allowed up to 5 simulation steps per frame to "catch up." With O(N²) algorithms at 64 players, one slow tick (e.g., 24ms) caused the accumulator to build up, triggering 2+ steps next frame — each also slow — cascading into a spiral of death (server freeze). With MAX_STEPS=1, a slow frame causes **time dilation** (simulation runs slower, fewer ticks per real second) but never spirals. The game is tick-based (dash cooldowns, zone timers count ticks), so time dilation slows gameplay proportionally without breaking correctness. The client's interpolation/reconciliation handles variable tick delivery naturally.

2. **Per-System Tick Profiling** — Each of the 11 simulation steps (`step1` through `step11` in `GameSimulation.step()`) wrapped with `performance.now()` deltas, accumulated into a per-system metrics object. Tick-overrun warning log (previously commented out at `GameSimulation.ts:362-366`) re-enabled. When any tick exceeds budget, logs: `tick 1234 took 24.3ms [perception=12.1 collision=0.3 schema=2.1 ...]`. Exposed via existing `/debug/tick-metrics` endpoint.

**Considered options:**
- MAX_STEPS=2 (rejected: still allows one level of catch-up cascade; GC pauses in Node.js typically cause single-frame hiccups that MAX_STEPS=1 absorbs naturally via time dilation)
- MAX_STEPS=0 / decouple simulation from real-time (rejected: game timers must approximate real-time for zone phases, siege intervals, match duration)
- External profiler (clinic.js, 0x) (rejected: per-system instrumentation is cheaper, always-on, and sufficient for identifying which system blows the budget; external profilers are for deep investigation, not daily monitoring)

**Consequences:** When the server is overloaded, the game runs in slow motion rather than freezing or jittering. This is strictly better for player experience — slow-motion is smooth and recoverable; spiraling is a freeze. After algorithmic fixes (ADR-0024), the server should sustain 60Hz consistently and MAX_STEPS=1 becomes a safety net for occasional GC pauses, not a regular occurrence. Per-system profiling adds <0.01ms/tick overhead (11 `performance.now()` calls) and provides permanent visibility into tick cost breakdown.
