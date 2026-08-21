# ADR 0006: Server-Side Latency Compensation via Timing Compensation

## Status

Approved — Phase 1 (timing compensation, no re-simulation)

## Context

Without rollback netcode (rejected as too complex for Colyseus + 64 players), server-side latency compensation is needed for responsive gameplay. At 100ms RTT, an attack input arrives ~50ms late, meaning the server-side windup starts late and the attack completes later than the player expects.

## Decision

Implement **timing compensation** — adjust action timing at input processing time. No re-simulation of game state.

### Mechanism

1. Track per-player RTT from input timestamps (client tick vs server tick, smoothed with EMA)
2. When an input arrives, calculate compensation: `min(RTT/2, actionWarmupMs, 100ms)`
3. For ATTACK/THROW: Reduce `windupRemaining` by compensation ticks. The attack/throw completes sooner.
4. For PICKUP: Check proximity against player's historical position (from compensation ticks ago).
5. For DASH/SWITCH_SLOT/MOVE/knockback: No compensation.

### Key Design Choices (from grill session)

- **No re-simulation**: Full re-sim would require rebroadcasting state to 64 clients and break Colyseus's state model.
- **DASH gets no compensation**: No windup → `actionWarmup=0` → compensation=0. Position compensation rejected (causes teleportation).
- **`actionWarmup` caps compensation**: Fast weapons (50ms windup) can't get more compensation than 50ms, preventing zero-windup exploits.
- **Compensation helps fairness**: By reducing the attacker's windup, the server hit detection runs closer to when the attacker expected, converging aim and hitcheck.

## Consequences

### Positive
- Responsive attacks at high ping — warmup completes at the right time
- Zero re-simulation overhead — server tick rate unaffected
- Simple implementation — no state history (except per-player position for PICKUP)
- Fair across ping levels — compensation equalizes attacker experience

### Negative
- PICKUP position lookup is an approximation — bounded by MAX_COMPENSATION (100ms ≈ 32px)
- RTT estimation from tick deltas may be noisy — needs EMA smoothing
- No compensation for DASH (position-dependent) — inherent to this approach

### Risks
- If RTT estimation is inaccurate, compensation will be wrong — mitigated by EMA smoothing
- Compensation never exceeds 100ms (6 ticks) — hard cap prevents exploitation
