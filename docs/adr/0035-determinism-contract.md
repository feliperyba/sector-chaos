# ADR 0035: Determinism Contract Lock (Server MovementService ↔ Client simulatePhysicsStepInto)

## Status

Accepted — Complements ADR-0008, ADR-0014, ADR-0016, ADR-0033.

## Context

The game runs two movement implementations that MUST agree on the should-agree
surface so that client-side prediction and reconciliation converge on the
server's authoritative state:

- **Server (authoritative):** `MovementService.validateAndMove` in
  `packages/server/src/domain/services/MovementService.ts`, invoked per
  player per tick via `MovePlayerCommand` with `dt = SIM_TICK_DT`.
- **Client (prediction + reconciliation):** `simulatePhysicsStepInto` in
  `packages/shared/src/simulation/simulatePhysicsStep.ts`, invoked by the
  prediction loop (`GameState.FIXED_DT`) and the `Reconciler`.

ADR-0014 (netcode overhaul) and ADR-0016 (client collision resolution)
deliberately accepted that these two implementations are NOT unified: the
server path is heavier (AABB+MTV `CollisionService`, separate dash lifecycle on
the `Player` aggregate via `resolveDashEndOverlap`, bounds clamping via
`clampToBounds`, and speed validation via `validateSpeed`). Unifying them would
change gameplay and is explicitly out of scope.

Before this ADR there was no machine-checked contract pinning the subset where
the two paths are supposed to agree. A silent drift in any of the shared
primitives (the dt value, the accel constants, the stagger penalty, the input
normalization) would corrupt prediction without failing a test. This ADR locks
that contract with three test files and a single derived dt constant.

## Decision

### 1. The shared primitive is `simulatePhysicsStepInto`

The client path is the canonical "lightweight" physics step. The server path is
deliberately heavier. Both consume the same accel core
(`applyAccelerationInto`) and the same movement constants
(`PLAYER.*`, `COMBAT.STAGGER_MOVE_SPEED_PENALTY`).

### 2. Parity surface (should-agree) — accel + integration + stagger only

The two implementations MUST produce identical `(x, y, vx, vy)` for:

- Input normalization `(ndx, ndy) = mag > 0 ? (dx/mag, dy/mag) : (0, 0)`.
- `applyAccelerationInto(vx, vy, ndx, ndy, effectiveMaxSpeed, ACCELERATION, DECELERATION, dt)`.
- Integration `pos += v * dt` (using the post-accel velocity).
- Stagger penalty applied to effective speed before the accel call
  (`effectiveSpeed *= STAGGER_MOVE_SPEED_PENALTY`).
- The dt value.

### 3. Deliberately divergent surface (do NOT unify — ADR-0014/0016)

- **Collision:** server AABB+MTV via `CollisionService.resolveTileCollision`;
  client `collisionFn` callback via `ClientCollisionService`.
- **Dash:** server applies the dash lifecycle separately on the `Player`
  aggregate (`startDash`/`endDash`/`resolveDashEndOverlap`) — `validateAndMove`
  does NOT touch `isDashing`. The client handles dash inline in
  `simulatePhysicsStepInto` (including the dash-end velocity reset to zero,
  historically broken per ADR-0033 and now pinned).
- **Bounds clamp:** server-only (`clampToBounds`).
- **Speed validation:** server-only (`validateSpeed`).

### 4. The dt contract is `SIM_TICK_DT`

`SIM_TICK_DT = NETWORK.TICK_INTERVAL / 1000` (derived, not a parallel constant)
in `packages/shared/src/constants/network.ts` is the single source of truth for
dt at every physics-relevant site. It replaces the six previously-sprinkled
`1 / 60` literals:

- `packages/server/src/application/commands/MovePlayerCommand.ts`
  (the `validateAndMove` dt argument)
- `packages/server/src/application/simulation/GameSimulationCombat.ts`
  (projectile integration via `updateProjectiles`; chest openings via
  `step8_TickChestOpenings`)
- `packages/server/src/application/simulation/GameSimulationWalkovers.ts`
  (knockback via `updateKnockback`)
- `packages/server/src/application/simulation/TickTimer.ts` (the `DT` static)
- `packages/client-v3/src/prediction/Reconciler.ts` (replay dt)
- `packages/client-v3/src/controllers/GameState.ts` (`FIXED_DT` initializer;
  the property NAME is unchanged — only the initializer)

Animation and first-frame dt literals are semantically unrelated and are
intentionally NOT touched (`AnimSimDriver.ts`, `stepAnimation.ts`,
`PlayerRenderer.ts`).

An exact-equality guard test asserts `SIM_TICK_DT === 1/60` so any future
change to the derivation chain that introduces IEEE-754 drift fails loud,
before any other code depends on it.

### 5. Enforcement is three test files

| File | Role |
| --- | --- |
| `packages/shared/src/constants/__tests__/network.test.ts` | Exact-equality guard: `SIM_TICK_DT === 1/60` and the `TICK_INTERVAL/1000` derivation chain. |
| `packages/shared/src/simulation/__tests__/simulatePhysicsStep.test.ts` | Characterization battery pinning today's output of the client primitive for: rest→accel, terminal velocity, decel-to-zero, decel-undershoot-snap, diagonal normalization, dash-start (normalized + zero-dir `(1,0)` default — load-bearing for the Reconciler), dash-mid, **dash-end velocity reset to zero** (ADR-0033 historical break), stagger-only, integration step, and collisionFn consultation. |
| `packages/server/tests/domain/services/MovementParity.test.ts` | Parity test (rigor tier 1) running the REAL `MovementService.validateAndMove` (pass-through stubbed `ICollisionService`, no-collision grid) against `simulatePhysicsStepInto` over identical inputs, asserting identical `(x, y, vx, vy)` on the should-agree surface only. |

The parity test reconstructs nothing from `validateAndMove` — it instantiates
the real service with a stubbed collision dependency. This is the strongest
available rigor and avoids any extraction of a production helper from
`validateAndMove` (which would itself be a behavior-bearing refactor).

## Consequences

**Positive:**

- A silent drift in dt, accel constants, stagger penalty, or input
  normalization between the two paths now fails a test, not a gameplay bug.
- The dash-end velocity reset (ADR-0033) is pinned against future regressions.
- The divergent surface (collision, dash, bounds, speed validation) is
  documented as deliberate, so future "why don't these match?" questions have a
  canonical answer.
- `SIM_TICK_DT` makes the tick rate a single editable point: changing
  `NETWORK.TICK_INTERVAL` propagates everywhere consistently (the exact-equality
  guard would need updating, which is the correct review gate).

**Negative:**

- The parity test lives in `packages/server`, not `packages/shared` as the
  originating ticket literally specified. The `shared` package cannot import
  `MovementService` (dependency direction is `server → shared`), so a
  shared-location parity test could only be tier-3 reconstruction-only theater,
  which the ticket explicitly rejects. Tier-1 rigor (real `MovementService`)
  requires the server-package location.
- The characterization battery pins two load-bearing quirks that a casual
  reader might consider "bugs": (a) `dashRemaining` is decremented on the
  dash-start tick, so it equals `dashDurationTicks - 1` after start; (b) a dash
  with no aligned movement input in the same tick has its freshly-assigned dash
  velocity eroded by the same-tick `applyAccelerationInto` decel call. These
  are current behavior, not desired behavior — changing them is a separate
  ticket, and the characterization tests exist precisely to make such a change
  visible.

## Alternatives Considered

1. **Unify the two implementations.** Rejected: ADR-0014/0016 accepted the
   divergence; unifying changes gameplay and is explicitly out of scope.
2. **Extract a shared helper from `validateAndMove`.** Rejected: that is a
   behavior-bearing refactor and an instant determinism-contract violation
   (prime directive). The parity test deliberately reconstructs nothing.
3. **Reconstruction-only parity test (tier 3, "theater").** Rejected by the
   ticket: it never exercises the real `MovementService`, so it cannot catch a
   drift inside `validateAndMove` itself. Tier 1 was achievable and is used.
4. **A parallel `TICK_DT` constant.** Rejected: would create a second source of
   truth that could drift from `NETWORK.TICK_INTERVAL`. `SIM_TICK_DT` is
   derived.
