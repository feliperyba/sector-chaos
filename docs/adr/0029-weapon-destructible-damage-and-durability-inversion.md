# Per-Weapon Destructible Damage & Durability Inversion Fix

Weapons now deal differentiated damage to destructibles via a new per-weapon `destructibleDamage` field (2–10), replacing the flat 1-HP-per-hit rule. Destructible HP values are doubled (crate 1→2, barrel 2→4, wall 5→10) to stay in integer space. `destructibleDamage` is independent of the PvP `damage` stat and is NOT scaled by weapon tier — it encodes weapon-class identity (Hammer = wall-breaker, Spear = anti-personnel), not progression. Simultaneously, `DURABILITY_BY_TIER` was flipped from decreasing (20/15/10/8) to increasing (8/10/15/20) with rarity, and the flat `durabilityOverride` field was replaced with a `durabilityMultiplier` that scales the tier base for shields (1.5–2.0×) and bows (1.5×).

## Considered Options

**Destructible damage axis:**
- (a) Reuse existing `weightTier` (0–3) via lookup table — rejected: only 4 buckets, insufficient granularity for 16 weapons
- (b) New per-weapon `destructibleDamage` field — **chosen**: full per-weapon tuning, decoupled from PvP balance
- (c) Derive from PvP `damage` via formula — rejected: couples two independent balance axes

**Integer scaling:**
- Native floats (Fists=0.5, Hammer=5) — rejected: floating-point drift, fractional damage popups, schema overhead
- ×2 scaling (Fists=2, Hammer=10, wall HP=10) — **chosen**: identical gameplay, integer-only, clean rendering

**Tier scaling of destructibleDamage:**
- Scale with `TIER_STAT_MULTIPLIER` — rejected: produces overkill at high tiers (wall HP=10, Legendary Hammer=20 = wasted), compresses low-tier utility
- Do not scale — **chosen**: anti-material power is weapon-class identity, not progression

**Durability inversion:**
- The original `DURABILITY_BY_TIER` (COMMON 20 → LEGENDARY 8) was a deliberate "glass cannon" trade-off that made LEGENDARY weapons deal LESS lifetime damage than COMMON — a broken reward signal. Flipped to COMMON 8 → LEGENDARY 20.

**`durabilityOverride` → `durabilityMultiplier`:**
- Keep flat override — rejected: shields/bows wouldn't scale with tier, inconsistent with the inversion fix
- Per-tier explicit tables — rejected: verbose, DRY violation
- Multiplier on `DURABILITY_BY_TIER` — **chosen**: one multiplier per category, always tier-scaled

## Consequences

- Four weapons one-shot walls (Hammer, Double Axe, Crossbow, Large Shield). Crossbow can breach from range; Large Shield is now a dual-purpose breacher/defender. Both are intentional design choices to be validated in playtesting.
- The `damage` ↔ `destructibleDamage` decoupling means retuning one never affects the other. Future weapons must author both values independently.
- `DURABILITY_BY_TIER` increasing with rarity means LEGENDARY weapons are strictly better (more damage AND more durability). This is a deliberate shift from "fragile power weapon" to "pure upgrade" — the battle royale reward signal.
- Fists define the `destructibleDamage` floor at 2. No picked-up weapon may tie or fall below this. New weapons must use `destructibleDamage ≥ 3`.

## PvP Damage Tier Scaling Fix

`AttackExecutor.executeAttack()` was reading damage from `definition.baseStats.damage` (unscaled), completely ignoring `weapon.tier`. A COMMON Spear and LEGENDARY Spear both dealt the base 15 damage — `TIER_STAT_MULTIPLIER` existed but was never applied by any production server code path. Fixed by scaling `damage`, `range`, and `knockback` by `TIER_STAT_MULTIPLIER[weapon.tier]` at the point of use in `AttackExecutor`.

Additionally, `TIER_STAT_MULTIPLIER` was increased from (1.0/1.2/1.5/2.0) to **(1.0/1.5/2.0/3.0)** for more drastic tier differentiation. A LEGENDARY weapon now has ~7.5× the lifetime damage output of a COMMON (3× per-hit × 2.5× durability), making rare weapons transformative finds in the battle royale.
