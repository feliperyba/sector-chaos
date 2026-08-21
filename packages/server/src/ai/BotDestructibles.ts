/**
 * BotDestructibles.ts — single source of truth for the bot-AI destructible
 * type taxonomy and the destructible-grid key packing.
 *
 * Consolidates the ad-hoc destructible-type string checks and the inlined
 * `gy*10000+gx` grid-key packing that were duplicated across the AI package
 * (BotPerception, BotSelfState, BotSpatialIndex, BotCombatShared,
 * BotNavigation, BotTelemetry, BotCombatExecutors, BotEconomyExecutors,
 * navigation/Pathfinder).
 *
 * TWO TYPE FORMS EXIST (the "dual-form" knowledge):
 *
 * 1. **Lowercase entity form** — `'crate' | 'barrel' | 'iron' | 'wall'` — the
 *    domain `DestructibleType` union (domain/entities/Destructible.ts:4).
 *    This is the ONLY form today's producers emit: every creation path
 *    (MapEntityFactory.populate:57-64, MapEntityHydrator.tileToDestructibleType,
 *    MapEntityFactory's leftover-tile pass:88) maps the numeric `TileType`
 *    enum to this lowercase union, and WorldSnapshotSync passes it through
 *    verbatim (`dto.type = d.type`, WorldSnapshotSync.ts:357). So
 *    `DestructibleDTO.type` is always lowercase in practice.
 * 2. **Uppercase enum-name form** — `'DESTRUCTIBLE_BARREL'` /
 *    `'DESTRUCTIBLE_CRATE'` / `'DESTRUCTIBLE_WALL'` — a defensive alias the
 *    historical checks also matched (e.g. if a destructible were ever built
 *    from a `TileType` enum KEY string instead of the entity union). No
 *    current producer emits it, but every pre-existing DTO check site matched
 *    both forms, so the predicates below preserve that superset exactly.
 *
 * NOTE: `'DESTRUCTIBLE_BARREL'` (the string) is NOT `TileType.DESTRUCTIBLE_BARREL`
 * (the numeric enum, = 7). Tile-grid code compares the numeric enum directly
 * (see PathfinderSearch's destructible-tile cut checks) — that is a separate
 * tile-level taxonomy and does not go through these string predicates.
 *
 * DANGER-LIST CONTRACT: `ctx.dangers` entries are NOT raw DTO types. The two
 * barrel producers normalize to the lowercase marker at push time
 * (`danger.type = 'barrel'`, BotPerception.ts / BotSelfState.ts), and trap
 * dangers carry `String(TrapType)` — i.e. `'0' | '1' | '2'` (TrapType is a
 * numeric enum). On that domain `isBarrel(t)` is exactly `t === 'barrel'`,
 * so the danger-flow checks that previously used the bare equality now use
 * `isBarrel` with identical behavior.
 *
 * Consolidation only — no predicate or key changes.
 */

/**
 * True for barrel destructibles. Barrels chain-explode on destruction
 * (BARREL.EXPLOSION_RADIUS blast, lethal) — every barrel-aware hazard scan,
 * barrel-density grid, and hot-barrel detection routes through this.
 * Accepts both the lowercase entity form and the uppercase enum-name form
 * (see the dual-form note in the module header).
 */
export function isBarrel(type: string): boolean {
  return type === 'barrel' || type === 'DESTRUCTIBLE_BARREL';
}

/**
 * True for crate destructibles. Crates are the ONLY destructibles that drop
 * weapons (SEEK_WEAPON's findNearestCrate filters on this). Accepts both the
 * lowercase entity form and the uppercase enum-name form.
 */
export function isCrate(type: string): boolean {
  return type === 'crate' || type === 'DESTRUCTIBLE_CRATE';
}

/**
 * True for wall destructibles (the breakable 10-HP kind — NOT `'iron'`, which
 * is unbreakable, and not solid map walls, which are `TileType` grid values,
 * not destructible entities). Accepts both the lowercase entity form and the
 * uppercase enum-name form. No AI check site currently branches on walls
 * (demolition targeting keys off the HP-keyed destructibleMap instead of the
 * type string), but the taxonomy member is defined here so the destructible
 * classification lives in exactly one place.
 */
export function isWall(type: string): boolean {
  return type === 'wall' || type === 'DESTRUCTIBLE_WALL';
}

/**
 * Pack a destructible-grid cell into the integer key used by
 * `destructibleMap` / `destructibleCentroidMap` (`Map<number, ...>`).
 *
 * The scheme is `gy * 10000 + gx` — Y is the high part, X the low part —
 * assuming grid coordinates < 10000 (the arena is far below that). Argument
 * order is (gx, gy) to read naturally; the multiplication order is preserved
 * from every former inline site, so keys are byte-identical. The inverse
 * (unpack) lives inline in PathfinderSearch.ts (`dKey % 10000`,
 * `(dKey / 10000) | 0`).
 */
export function packGridKey(gx: number, gy: number): number {
  return gy * 10000 + gx;
}
