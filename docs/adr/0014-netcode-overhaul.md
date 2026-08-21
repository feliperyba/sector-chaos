# Netcode Overhaul: PATCH_RATE, Collision, RenderOffset, Reconciler Fix

Accepted — Supersedes partial recommendations from ADR-0010 (renderOffset tuning).

Increase state sync from 30Hz to 60Hz (PATCH_RATE), fix a reconciler bug where dash replay uses BASE_SPEED instead of recorded speed (causing ~325px errors during stagger+dash), upgrade client collision from center-point to 4-corner hitbox check (reducing wall-slide drift from ~10px to ~2-3px), and add adaptive renderOffset decay (snap errors ≥8px, decay small errors at rate 60). Also expose RTT from server to client as observability (no behavior change). Audit's InputQueue rewrite is out of scope — ADR-0007's fixes already resolve the core sequencing issues for the current codebase.

**Implementation Status:**
- ✅ PATCH_RATE 30→60
- ✅ Reconciler dash+stagger fix (uses `rec.speed`)
- ✅ 4-corner hitbox collision
- ✅ Decay rate 30→60 (`ERROR_DECAY_RATE = 60`)
- ✅ RTT observability
- ✅ Adaptive renderOffset snap (≥8px magnitude-based snap, ERROR_DECAY_RATE=60)

**Considered options:**
- Full AABB collision unification (rejected: server's CollisionService too heavy for client, player-vs-player prediction impossible)
- InputQueue spreading mechanism (rejected: creates permanent tick-offset desync for bursting players)
- Single renderOffset decay rate (rejected: too slow for small errors at rate 30, too jerky for large errors at rate 60)

**Consequences:** Bandwidth per client increases roughly 2× at peak (all 64 players moving), but Colyseus delta encoding limits this to ~60-100 KB/s realistic. Server CPU for StateMapper doubles (every tick instead of every 2), but profiling required to confirm <10% increase.

---

## Revised tuning (post-acceptance)

The original "snap errors ≥8px, decay small errors at rate 60" tuning (commit `19331cd`, citing Overwatch/Valorant as industry standard) was **reverted after playtesting** revealed visible jitter at the 60Hz patch rate:

| Constant | 19331cd tuning | Revised (current) | Rationale |
|---|---|---|---|
| `RENDER_OFFSET_SNAP_THRESHOLD` | 8 | **16** | At 8px, corrections in the 8-16px band (common with even modest prediction drift at 60Hz) hard-snapped instead of gliding. 16px keeps the full drift band in the smooth tier; hard-snap reserved for genuine teleports (>16px). |
| `ERROR_DECAY_RATE` | 60 | **10** | Rate 60 absorbed ~63% of the error in ~16ms (one tick) — too fast to read as continuous motion; the correction vanished in a blink and read as a snap. Rate 10 absorbs in ~100ms, a smooth glide that reads as continuous motion. |

**Why the "industry standard" reference didn't hold:** Overwatch/Valorant run server-authoritative with much tighter prediction drift (sub-pixel typical). At 60Hz patch rate with this codebase's drift characteristics, 8-16px corrections are routine, and the faster decay made them visible rather than hiding them. The smoother glide (rate 10, threshold 16) is the correct trade-off for this codebase's actual drift profile. The single-decay-rate rejection above ("too slow at 30, too jerky at 60") was correct at rate 30 vs 60, but rate 10 — between the two — is the smooth-motion sweet spot.

**Reverted in:** the `fix/post-refactor-bugs-chest-shield-bots-room` branch. Characterization test `applyReconciledPosition.test.ts` "Case C regression guard" pins the 8px-correction-now-smooths behavior.

---

> **Erratum (2026-08-20, hygiene ticket 16):** the "Revised (current)" column above lists `ERROR_DECAY_RATE = 10`, but the constant of record was subsequently raised to **30** (`ERROR_DECAY_RATE = 30`, `packages/client-v3/src/types.ts`) — rate 10's slow glide accumulated a steady-state backward offset under continuous drift at the 60Hz patch rate (the "sluggish local player" failure mode; see the constant's header comment and `GameState.applyReconciledPosition`). The decision history above is preserved as written; this note is the correction of record.
