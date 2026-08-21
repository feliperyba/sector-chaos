# Known Gotchas

> Moved from `CONTEXT.md`. Known bugs and traps.

## mapLoaded Primitive-by-Value Bug

`mapLoaded` is a `boolean` primitive on `GameSceneDeps`. Setting `deps.mapLoaded = true` in `GameSceneSetup.ts` line 207 mutates the deps object, but **`this.mapLoaded` on GameScene is a separate copy** (assigned from `this.mapLoaded` into deps at create time). The fix: the `onMapLoaded` callback (`() => { this.mapLoaded = true; }`) is the authoritative setter. Both paths exist (direct mutation + callback) — the callback is the one GameScene reads in `update()`. When adding new scenes, use **callbacks only** for cross-system state flags, never primitive-by-reference.

## Visual Success Trap

Code compiles, renders something, and looks correct — but the underlying system is not wired. Examples:

- Renderer draws a sprite that's never updated from server state
- HUD shows a value from a local variable instead of schema state
- Animation plays but damage isn't applied server-side

**Rule:** A feature is NOT done until verified input → network → server → network → client visual. "It renders" ≠ "it works."

## Attack Is Continuous

ATTACK action fires every frame while pointer is down (`isDown`), not edge-triggered. PICKUP, DASH, THROW, SWITCH_SLOT must use `JustDown()` (edge-triggered).

## Server Weapon Pickup Is Proximity-Based

PICKUP ignores `targetId` — server uses `PICKUP_RADIUS = 72`. Chest interaction IS `targetId`-based.

## `damage` and `destructibleDamage` Are Independent

The PvP `damage` stat and the `destructibleDamage` stat are fully decoupled. `damage` scales with tier via `TIER_STAT_MULTIPLIER` (×1.0–2.0); `destructibleDamage` does not scale with tier. A Hammer deals 22 (COMMON) to 44 (LEGENDARY) to players but always 10 to walls. Do not assume weapons that hit players hard also hit walls hard — Spear (15 PvP dmg) deals only 4 to walls, while Crossbow (25 PvP dmg) deals 10.

## Durability Scales UP with Tier

`DURABILITY_BY_TIER` increases with rarity (COMMON 8 → LEGENDARY 20), deliberately flipped from the original design where rare weapons were fragile power weapons. Combined with `TIER_STAT_MULTIPLIER` (1.0/1.5/2.0/3.0), a LEGENDARY weapon has ~7.5× the lifetime output of a COMMON. Shields and bows use `durabilityMultiplier` (1.5×–2.0×) to boost their category baseline above standard melee.

## `damage` Is Scaled by Tier in `AttackExecutor`

PvP `damage`, `range`, and `knockback` are scaled by `TIER_STAT_MULTIPLIER[weapon.tier]` at the point of use in `AttackExecutor.executeAttack()`. Previously, damage was read from unscaled `definition.baseStats.damage` — a RARE Spear dealt the same 15 damage as a COMMON Spear. `destructibleDamage` is NOT scaled by tier (it encodes weapon-class identity, not progression).
