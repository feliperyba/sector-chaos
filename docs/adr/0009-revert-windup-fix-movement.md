# ADR 0009: Revert Windup Compensation, Fix Movement Pipeline

## Status

Accepted — Supersedes ADR-0006

## Context

ADR-0006 introduced server-side timing compensation that shortens attack/throw windup based on player RTT. After deployment and testing, this approach caused a **fundamental desync**: the client renders the full windup animation (which it must, since it doesn't know the server reduced the windup), while the server fires the attack early. Players experience phantom hitboxes, stuttering attack animations, and unreliable hit timing.

Additionally, several movement pipeline bugs were discovered that independently contribute to sluggish feel:

- `ACCELERATION=1800` and `DECELERATION=1200` produce ~180ms time-to-full-speed — too slow for an action game
- `Reconciler` uses variable `rec.dt` for replay, diverging from the server's fixed 1/60s tick
- `INTERPOLATION_DELAY_MS=50` at `PATCH_RATE=30` (33.3ms patches) causes interpolator buffer starvation
- `calculateCompensation()` applies non-zero compensation even at <30ms RTT, creating phantom adjustments in solo/LAN

The compensation infrastructure itself (`PlayerRttTracker`, `PlayerPositionHistory`, `calculateCompensation()`) is well-built and will be preserved for future rollback hit validation.

## Decision

### 1. Revert windup compensation for ATTACK/THROW

Remove the `compensationTicks` → `compensatedTicks` logic in `AttackCommand.execute()`. Server always uses full `windupTicks`. Client and server agree on timing.

**Rationale:** Windup compensation was architecturally wrong for a non-rollback model. Without client awareness of the reduced windup, the two sides cannot agree on when the attack fires. The "fix" would require either (a) the server telling the client the reduced windup (extra round-trip, defeats the purpose) or (b) the client predicting the compensation (fragile, depends on RTT estimate accuracy). Reverting is simpler and correct.

### 2. Add RTT dead zone (<30ms → 0 compensation)

Modify `calculateCompensation()` to return 0 when `rttMs < 30`. This eliminates phantom compensation in solo play, LAN, and low-latency scenarios where the EMA-smoothed RTT oscillates around small values.

**Rationale:** At <30ms RTT, compensation provides no perceptible benefit but introduces non-deterministic timing jitter. 30ms covers the noise floor.

### 3. Raise acceleration and deceleration constants

| Constant | Old | New Range | Constraint |
|----------|-----|-----------|------------|
| `ACCELERATION` | 1800 | 3200–4000 | Hard cap at 5000 |
| `DECELERATION` | 1200 | 4800–6000 | Always > ACCELERATION |

**Rationale:** At `BASE_SPEED=325` and `ACCELERATION=1800`, time-to-full-speed is `325/1800 ≈ 180ms`. Raising to 3200+ targets ~80–100ms. Deceleration is set higher for snappy stop-on-release. Cap at 5000 prevents physics tunneling at 60Hz (`5000 * (1/60)² ≈ 1.39px/tick²`, which is fine; above that, collision detection can miss).

### 4. Fix reconciler to use fixed 1/60 dt

Replace `rec.dt` with `1/60` in the reconciliation replay loop.

**Rationale:** The server simulates at fixed `TICK_INTERVAL = 1000/60`. If the client replays at variable dt, it accumulates different positions than the server. This is a latent bug that causes growing drift over time, masked by reconciliation snapping. Fixed dt ensures bit-identical replay (modulo floating point).

### 5. Set interpolation delay to 67ms

Change `INTERPOLATION_DELAY_MS` from 50 to 67 (= `ceil(2 × 1000 / PATCH_RATE)`).

**Rationale:** At `PATCH_RATE=30`, patches arrive every 33.3ms. With a 50ms delay, the interpolator frequently has only one snapshot (not two), causing it to fall through to the "oldest" or "newer only" code paths — visible as micro-stutters. 67ms guarantees two snapshots in the buffer under normal conditions.

### 6. Remove dead PICKUP compensation path

Remove `overrideX`/`overrideY` from `PickupWeaponInput` and the `calculateCompensation` + `positionHistory.getPositionAtTick` wiring in `GameSimulation`. Pickups always use `player.position`.

**Rationale:** The position history lookup was a Category 2 compensation attempt from PRD-81, but at 30Hz patch rate the historical position is too coarse. No measurable improvement was observed; it's dead weight.

## Consequences

### Positive

- **Attack animations match hit timing** — client and server always agree on windup duration
- **Zero phantom compensation** — dead zone kills jitter at <30ms RTT
- **Snappy movement** — acceleration/deceleration tuning cuts time-to-full-speed from ~180ms to ~80–100ms
- **Accurate prediction** — reconciler replay matches server simulation tick-for-tick
- **Smooth remote players** — correct interpolation delay eliminates buffer starvation stutter
- **Clean codebase** — dead compensation paths removed, infrastructure preserved

### Negative

- **High-ping attack latency returns** — at 100ms RTT, attacks still feel ~50ms late. This is the baseline for a non-rollback model. Rollback hit validation (backlog) will address this.
- **PlayerRttTracker/PlayerPositionHistory become unused** — no consumers after this PR. They remain in the codebase as infrastructure for future rollback. Zero runtime cost (no calls = no overhead).

### Risks

| Risk | Mitigation |
|------|------------|
| Acceleration tuning changes game balance | Tunable constants. Can adjust in follow-up without code changes. Start at 3200/4800, playtest, adjust. |
| Players accustomed to "fast" windup feel it slow | Windup was never intentionally fast — it was a compensation artifact. True windup timing is what weapon definitions specify. |
| Future rollback needs to re-introduce compensation | `calculateCompensation()` is preserved with dead zone. `PlayerPositionHistory` is preserved. Re-introduction is additive. |
| 67ms interpolation adds visual latency for remote players | Standard for 30Hz patch rate. Only affects remote player rendering, not local prediction. Acceptable trade-off for smoothness. |

## Supersedes

- [ADR-0006: Server-Side Latency Compensation via Timing Compensation](./0006-server-latency-compensation.md) — windup compensation and pickup position lookup are reverted. Infrastructure kept.
