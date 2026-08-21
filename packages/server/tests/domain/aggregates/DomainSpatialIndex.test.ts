import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  TileType,
  PlayerStatus,
  COMBAT,
  COLLISION,
  BARREL,
  NETWORK,
  SeededRNG,
  type GameConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { GameMatch } from '../../../src/domain/aggregates/GameMatch.ts';
import {
  DomainSpatialIndex,
  createSpatialQueryResult,
  type DomainSpatialQueryResult,
} from '../../../src/domain/aggregates/DomainSpatialIndex.ts';
import { Destructible } from '../../../src/domain/entities/Destructible.ts';
import { Position } from '../../../src/domain/value-objects/Position.ts';
import { gatherHurtboxEntities } from '../../../src/domain/handlers/HurtboxGathering.ts';
import {
  collectPlayersInMapOrder,
  collectDestructiblesInMapOrder,
} from '../../../src/domain/handlers/CombatSpatialQueries.ts';
import { PLAYER_HIT_RADIUS } from '../../../src/domain/handlers/ThrowHandlerTypes.ts';
import {
  createMatchServices,
  createMatchPools,
} from '../../../src/domain/aggregates/createMatchServices.ts';
import { createTestServer, cleanup, createRoom } from '../../helpers/test-server.ts';
import type { GameRoom } from '../../../src/room/GameRoom.ts';

/**
 * Regression harness for the domain-side spatial hash
 * (`DomainSpatialIndex`, ticket 17 — server-domain-spatial-hash).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE AUDIT — what each O(n) linear scan site sees today, and whether the
 * iteration ORDER of its results affects outcomes (the index returns id-sorted
 * results; the scans iterate the players/destructibles Maps in insertion
 * order — these are NOT the same order, so every site must be classified).
 * ══════════════════════════════════════════════════════════════════════════
 *
 * S1. RANGED arrow vs DESTRUCTIBLES — `RangedHandler.updateArrow`
 *     (src/domain/handlers/RangedHandler.ts:122-143).
 *     Set: all destructibles, filtered `!isDestroyed` (≡ the entity's
 *     `isActive` getter — Destructible.ts:69-71). Returns on FIRST hit.
 *     ORDER: geometrically immune — arrow HITBOX_RADIUS = HURTBOX/2 +
 *     ARROW/2 = 56px, and two distinct destructible centers are ≥ 1 tile
 *     (≥128px on real maps) apart, so two candidates within 56px of one
 *     point are impossible (56+56 < 128).
 *
 * S2. RANGED arrow vs PLAYERS — RangedHandler.ts:231-246 (pre-routing).
 *     Set: ALL players in the map minus the owner. NOTE: there is NO
 *     `isActive` filter — the `isDead` check on :233 was dead code (the
 *     owner was already skipped on :232). A DEAD player (corpse remains in
 *     the map after death; only disconnect removes it —
 *     GameMatchPlayers.ts:78) still absorbs arrows today: the arrow stops
 *     and `applyProjectileDamage` (GameMatchProjectileUpdater.ts:152-165)
 *     re-fetches the target with no liveness check; DamagePipeline then
 *     skips the inactive target (:53/:191/:317). RESOLVED (ticket 18): the
 *     players grid indexes ALL map members (alive + dead) so corpse
 *     candidates ARE returned; the routed scan applies the same owner-skip
 *     the linear scan did. The unit test "ranged player scan semantics"
 *     below pins the parity (arrows hit corpses = old behavior preserved),
 *     and the harness counts corpse candidates per run (report-only).
 *     ORDER: sensitive in principle — two live players can both be within
 *     56px of the arrow point (player centers can be ~96px apart), and the
 *     first in Map insertion order is returned as THE hit. The routed scan
 *     reproduces Map order via the parallel `seqs` column.
 *
 * S3. THROWN vs DESTRUCTIBLES — `ThrowHandlerCollision.checkDestructibleCollisions`
 *     (ThrowHandlerCollision.ts:133-216) and the tile-AABB loop inside
 *     `checkTileCollision` (:86-108).
 *     Set: all destructibles, filtered `!isDestroyed`. Breaks on FIRST hit.
 *     ORDER: POSSIBLY sensitive — PLAYER_HIT_RADIUS = 96/2 + 64/2 = 80px, and
 *     80+80 = 160 ≥ 128, so two adjacent-tile destructibles CAN both be
 *     within radius of one point (corner case). Consumers must use `seqs`.
 *
 * S4. THROWN vs PLAYERS — `checkPlayerCollisions`
 *     (ThrowHandlerCollision.ts:235-343).
 *     Set: players filtered `isActive` (:240) + owner/immunity rules
 *     (:236-239). Breaks on FIRST hit → ORDER-SENSITIVE (same geometry as
 *     S2). Consumers must use `seqs`.
 *
 * S5. MELEE broadphase — `gatherHurtboxEntities`
 *     (src/domain/handlers/HurtboxGathering.ts:27-48 players, :50-72
 *     destructibles), consumed by the swept-melee pipeline
 *     (MeleeSweepHandler.tick, step 3 — MeleeSweepHandler.ts:166-257) and
 *     the legacy instant-hit path (AttackExecutor.executeAttack, step 8
 *     windup completion — GameSimulationCombat.ts:278).
 *     Set: players `isActive` + ≠ attacker (:28-29); destructibles
 *     `isActive` (:51). Collects ALL candidates within broadRange (no early
 *     exit) in Map insertion order. ORDER-SENSITIVE: the sweep processes
 *     hitPlayers sequentially and (a) consumes weapon durability per hit —
 *     the weapon can BREAK mid-list (:226-230), (b) a shield BLOCK
 *     interrupts the swing (:231-235) — so which victim is processed first
 *     changes who else gets hit. Destructibles likewise: `handleDamage` +
 *     per-non-wall durability (:238-257). Consumers must use `seqs`.
 *     (`MeleeSweepHandler.findDestructibleAt` :322-334 is the same
 *     destructible set under a tile-containment predicate.)
 *
 * S6. BARREL explosion vs PLAYERS — `BarrelExplosionManager.resolveExplosion`
 *     (src/domain/aggregates/BarrelExplosionManager.ts).
 *     Set: players filtered `isActive`, tile-containment along 8 ray
 *     directions. Each victim gets an INDEPENDENT processDamage call
 *     (single-target) — but `alivePlayerCount` is read PER VICTIM, so when
 *     one explosion kills several players the ORDER decides which death sees
 *     which alive count (last-standing sequencing). Also destructibles are
 *     DELETED from the map mid-resolution — the index goes stale WITHIN one
 *     resolution chain. ORDER-SENSITIVE (edge); consumers must use `seqs` +
 *     re-check map membership per candidate.
 *     RESOLVED (ticket 19, server-barrel-spatial-query): the manager's
 *     per-ray-cell lookups are routed through the spatial index
 *     (`collectCellPlayers` / `findCellDestructible` on the manager —
 *     built on the collect*InMapOrder helpers). The harness's S6 ACTUAL
 *     side calls those REAL manager methods; the EXPECTED side is the
 *     pre-ticket-19 code (full player scan per cell; per-explosion rebuilt
 *     destructible grid Map with last-write-wins `${gx},${gy}` keys). The
 *     `!isDestroyed` re-check vs the stale index is exactly the
 *     recursion-consistency mechanism the routing must preserve.
 *
 * UNION semantics indexed by `DomainSpatialIndex.rebuildFrom`: ALL players
 * (alive + dead — S2's corpse set is the superset driver) + non-destroyed
 * destructibles. Every destructible site filters `!isDestroyed` itself; every
 * player site except S2 filters `isActive` itself. The grid is a candidate
 * superset for all five sites; liveness is a consumer concern (staleness
 * contract).
 *
 * ══════════════════════════════════════════════════════════════════════════
 * ROUTING (ticket 18) — which side of the comparison is "real" now
 * ══════════════════════════════════════════════════════════════════════════
 * The five sites' production code iterates candidates through
 * `collectPlayersInMapOrder` / `collectDestructiblesInMapOrder`
 * (domain/handlers/CombatSpatialQueries.ts — query + seq sort = Map order).
 * The harness's ACTUAL side calls those same production collectors and then
 * the site's own predicate (verbatim from the routed loops); the EXPECTED
 * side is the pre-ticket-18 linear scan (inline replicas, plus a verbatim
 * replica of the old gatherHurtboxEntities for S5 — the real gather is now
 * routed, so it is the ACTUAL side). S1-S4 comparisons assert ORDER equality
 * (both sides in Map order), which validates the seq mechanism end-to-end;
 * S5 compares the full ordered entity-id sequence of the REAL gather against
 * the old-gather replica. Ticket 19 (server-barrel-spatial-query) routed S6
 * the same way: the REAL `BarrelExplosionManager.collectCellPlayers` /
 * `findCellDestructible` are the ACTUAL side (see the S6 block below). The
 * production resolution code itself (takeDamage,
 * durability, bounce reflection) runs unmodified inside this fast-forward
 * match every tick — what this harness pins is that its candidate selection
 * is identical to the linear scans it replaced.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE DETERMINISM ARGUMENT (query ordering)
 * ══════════════════════════════════════════════════════════════════════════
 * Queries return results sorted by entity id via plain code-unit string
 * comparison. Ids are unique (they are Map keys), so the sort is a total
 * order: same rebuilt state + same query → the same ordered list, every
 * call, tick, seed and process. No `Math.random`, no `localeCompare` (ICU/
 * locale-dependent), no Set iteration in results; the row-major cell walk is
 * itself deterministic and the final sort makes even that irrelevant.
 *
 * Id-sorted is NOT Map insertion order — Map order is not reproducible from
 * positions. Because S2-S6 are order-sensitive (above), every result entry
 * carries its insertion rank (`seqs[i]` = slot assigned in source-Map
 * iteration order at rebuild time); sorting candidates by `seq` ascending
 * reconstructs the exact relative order the old linear scans visited.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * THE SNAPSHOT/STALENESS CONTRACT
 * ══════════════════════════════════════════════════════════════════════════
 * The index is rebuilt once per tick at the END of step2 (movement) —
 * GameSimulation.step2_ResolveMovement. Player positions are then stable for
 * the rest of the tick EXCEPT teleports (step 7) and dash-end overlap
 * resolution (step 8). Destructibles can be destroyed/deleted during steps
 * 3-8; player aliveness flips in step 9 and outside step(). THEREFORE every
 * consumer must treat query results as broadphase CANDIDATES and re-verify
 * per candidate: `player.isActive`, `destructible.isDestroyed` + live map
 * membership, and the entity's LIVE position for the exact hit-shape test.
 * The harness below encodes exactly that (predicates always re-read live
 * state) and asserts: spatialQuery ∩ sitePredicate == linearScan ∩
 * sitePredicate, per tick, over a real fast-forward bot match.
 */

// ─── Unit-test fixture (real GameMatch, small grid) ─────────────────────────

function createTestConfig(overrides: Partial<GameConfig> = {}): GameConfig {
  return {
    player: {
      baseSpeed: 200,
      dashSpeedMultiplier: 2.0,
      dashDuration: 0.5,
      dashCooldown: 3.0,
      baseHealth: 100,
      maxHealth: 100,
      inventorySize: 4,
      hitboxWidth: 96,
      hitboxHeight: 96,
    },
    weapons: [],
    zone: {
      totalDuration: 36000,
      transitionDuration: 1800,
      tickInterval: 30,
      warningTime: 1800,
      phases: [],
    },
    match: {
      targetDuration: 36000,
      maxPlayers: 16,
      minPlayers: 2,
      countdownDuration: 300,
      overtimeStart: 36000,
    },
    map: {
      tileWidth: 64,
      tileHeight: 64,
      arenaWidth: 640,
      arenaHeight: 640,
      sectorSize: 320,
      corridorWidth: 2,
      destructibleDensity: 0.3,
      chestDensity: 0.1,
      exitCount: 1,
    },
    combat: {
      knockbackForce: 200,
      knockbackDecay: 0.9,
      throwRange: 300,
      bounceFactor: 0.5,
      maxBounces: 3,
      projectileSpeed: 400,
      friendlyFire: true,
    },
    network: {
      tickRate: 60,
      patchRate: 50,
      maxLatency: 200,
      inputBufferSize: 120,
      snapshotInterval: 0,
    },
    ...overrides,
  };
}

function makeEmptyGrid(rows: number, cols: number): TileType[][] {
  const grid: TileType[][] = [];
  for (let r = 0; r < rows; r++) grid.push(new Array<TileType>(cols).fill(TileType.EMPTY));
  return grid;
}

const defaultSpawnPoints: SpawnPoint[] = [
  { x: 64, y: 64, sectorCoord: { row: 0, col: 0 }, priority: 0 },
  { x: 128, y: 128, sectorCoord: { row: 0, col: 0 }, priority: 1 },
];

function createMatch(): GameMatch {
  const config = createTestConfig();
  return new GameMatch(
    'test-match',
    config,
    makeEmptyGrid(10, 10),
    defaultSpawnPoints,
    createMatchServices(config),
    createMatchPools(),
    new SeededRNG(12345),
  );
}

/** Arrow hit radius, mirroring RangedHandler's private HITBOX_RADIUS. */
const RANGED_HITBOX_RADIUS = COMBAT.HURTBOX_SIZE / 2 + COLLISION.ARROW_HITBOX_WIDTH / 2;
/** Melee gather padding, mirroring gatherHurtboxEntities' broadRange max(). */
const MELEE_HURTBOX_PAD = Math.max(COMBAT.HURTBOX_SIZE, COMBAT.DESTRUCTIBLE_HURTBOX_SIZE);

describe('DomainSpatialIndex (unit)', () => {
  it('indexes ALL players (alive + dead) and non-destroyed destructibles only', () => {
    const match = createMatch();
    const a = match.addPlayer('pA', 'A');
    const b = match.addPlayer('pB', 'B');
    const corpse = match.addPlayer('pD', 'D');
    corpse.statusEffects.status = PlayerStatus.DEAD;

    const crate = Destructible.create('d1', 'crate', new Position(100, 100));
    const barrel = Destructible.create('d2', 'barrel', new Position(400, 400));
    const broken = Destructible.create('d3', 'crate', new Position(200, 200));
    broken.takeDamage({ source: 'other', rawDamage: 999 });
    match.destructibles.set(crate.id, crate);
    match.destructibles.set(barrel.id, barrel);
    match.destructibles.set(broken.id, broken);

    const index = match.rebuildSpatialIndex();
    // server-combat-spatial-queries: the players grid is a SUPERSET (all map
    // members) — S2's ranged arrow scan must still see corpses; the
    // isActive-filtering sites apply their own filter post-query.
    expect(index.playerCount).toBe(3); // corpse INCLUDED
    expect(index.destructibleCount).toBe(2); // destroyed excluded

    const pr = createSpatialQueryResult();
    index.queryPlayers(0, 0, 5000, pr);
    expect(pr.entities.map((p) => p.id)).toEqual(['pA', 'pB', 'pD']);

    const dr = createSpatialQueryResult();
    index.queryDestructibles(0, 0, 5000, dr);
    expect(dr.entities.map((d) => d.id)).toEqual(['d1', 'd2']);
  });

  it('returns id-sorted results regardless of insertion or cell layout', () => {
    const match = createMatch();
    // Insert in NON-id order and across different cells.
    match.addPlayer('zz', 'Z');
    match.addPlayer('aa', 'A');
    match.addPlayer('mm', 'M');
    match.getPlayer('zz')!.movement.position = new Position(10, 10);
    match.getPlayer('aa')!.movement.position = new Position(600, 600);
    match.getPlayer('mm')!.movement.position = new Position(10, 10);

    const index = match.rebuildSpatialIndex();
    const out = createSpatialQueryResult();
    index.queryPlayers(0, 0, 5000, out);
    expect(out.entities.map((p) => p.id)).toEqual(['aa', 'mm', 'zz']);

    // Determinism: same query again → identical entities AND seqs.
    const out2 = createSpatialQueryResult();
    index.queryPlayers(0, 0, 5000, out2);
    expect(out2.entities.map((p) => p.id)).toEqual(out.entities.map((p) => p.id));
    expect(out2.seqs).toEqual(out.seqs);
  });

  it('seq equals the players-Map insertion rank over ALL members (alive + dead)', () => {
    const match = createMatch();
    // Map insertion order: p2 → pDead → p1 → p3 (pDead stays in the map).
    match.addPlayer('p2', '2');
    const dead = match.addPlayer('pDead', 'x');
    match.addPlayer('p1', '1');
    match.addPlayer('p3', '3');
    dead.statusEffects.status = PlayerStatus.DEAD;

    const index = match.rebuildSpatialIndex();
    const out = createSpatialQueryResult();
    index.queryPlayers(0, 0, 5000, out);
    // id-sorted output: p1, p2, p3, pDead — but seqs must carry the FULL-Map
    // ranks: p2=0, pDead=1, p1=2, p3=3. Sorting by seq ascending recovers
    // exact Map iteration order (including the corpse, exactly where the
    // pre-index full-map scans visited it).
    expect(out.entities.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'pDead']);
    expect(out.seqs).toEqual([2, 0, 3, 1]);
    const byMapOrder = out.entities
      .map((e, i) => ({ id: e.id, seq: out.seqs[i]! }))
      .sort((x, y) => x.seq - y.seq)
      .map((e) => e.id);
    expect(byMapOrder).toEqual(['p2', 'pDead', 'p1', 'p3']);
    // The isActive-filtering sites see the same relative order within the
    // alive subset:
    const aliveMapOrder = byMapOrder.filter((id) => match.getPlayer(id)!.isActive);
    expect(aliveMapOrder).toEqual(['p2', 'p1', 'p3']);
  });

  it('clamps out-of-bounds coordinates and handles corner queries', () => {
    const match = createMatch();
    const corner = match.addPlayer('corner', 'C');
    corner.movement.position = new Position(0, 0);
    const far = match.addPlayer('far', 'F');
    far.movement.position = new Position(639, 639);

    const index = match.rebuildSpatialIndex();
    const out = createSpatialQueryResult();
    index.queryPlayers(0, 0, 1, out);
    expect(out.entities.map((p) => p.id)).toEqual(['corner']);
    index.queryPlayers(640, 640, 2, out);
    expect(out.entities.map((p) => p.id)).toEqual(['far']);
    // Radius spanning the whole world sees both, id-sorted.
    index.queryPlayers(-100, -100, 2000, out);
    expect(out.entities.map((p) => p.id)).toEqual(['corner', 'far']);
  });

  it('is a candidate superset: circle predicate on live state prunes to the exact scan set', () => {
    const match = createMatch();
    const a = match.addPlayer('a', 'A');
    a.movement.position = new Position(300, 300);
    const b = match.addPlayer('b', 'B');
    b.movement.position = new Position(300 + 50, 300); // within 56
    const c = match.addPlayer('c', 'C');
    c.movement.position = new Position(300 + 57, 300); // outside 56
    match.destructibles.set('d1', Destructible.create('d1', 'crate', new Position(300, 355)));

    const index = match.rebuildSpatialIndex();
    const out = createSpatialQueryResult();
    index.queryPlayers(300, 300, RANGED_HITBOX_RADIUS, out);
    // Broadphase returns ALL candidates whose cells overlap — predicate prunes.
    const hit = out.entities.filter(
      (p) => p.movement.position.distanceTo(new Position(300, 300)) < RANGED_HITBOX_RADIUS,
    );
    expect(hit.map((p) => p.id).sort()).toEqual(['a', 'b']);

    const dr = createSpatialQueryResult();
    index.queryDestructibles(300, 300, RANGED_HITBOX_RADIUS, dr);
    const dHit = dr.entities.filter(
      (d) => d.position.distanceTo(new Position(300, 300)) < RANGED_HITBOX_RADIUS,
    );
    expect(dHit.map((d) => d.id)).toEqual(['d1']);
  });

  it('pins S2 parity: the routed ranged player scan still sees corpses (all-players index)', () => {
    const match = createMatch();
    const shooter = match.addPlayer('shooter', 'S');
    shooter.movement.position = new Position(100, 100);
    const corpse = match.addPlayer('corpse', 'X');
    corpse.movement.position = new Position(200, 100);
    corpse.statusEffects.status = PlayerStatus.DEAD;

    const arrowPos = new Position(190, 100); // 10px from the corpse
    // The OLD linear scan (pre-ticket-18 RangedHandler.ts:231-246) — no
    // isActive filter, owner skip only:
    const oldScan: string[] = [];
    for (const [pid, p] of match.players) {
      if (pid === 'shooter') continue;
      if (arrowPos.distanceTo(p.movement.position) < RANGED_HITBOX_RADIUS) oldScan.push(pid);
    }
    expect(oldScan).toEqual(['corpse']); // the corpse absorbs the arrow today

    // The routed scan's candidate stream (ticket 18): the players grid
    // indexes ALL map members, so the corpse IS returned — the site's own
    // owner-skip + distance predicate then selects exactly the old set, in
    // the old order. Arrows still stop on corpses (DamagePipeline no-ops the
    // dead target downstream — behavior preserved, divergence resolved).
    const index = match.rebuildSpatialIndex();
    const routedCandidates = collectPlayersInMapOrder(
      index,
      match.players,
      arrowPos.x,
      arrowPos.y,
      RANGED_HITBOX_RADIUS,
      createSpatialQueryResult(),
    );
    const routedHit = routedCandidates
      .filter((p) => p.id !== 'shooter' && arrowPos.distanceTo(p.movement.position) < RANGED_HITBOX_RADIUS)
      .map((p) => p.id);
    expect(routedHit).toEqual(oldScan); // parity — corpse preserved
  });
});

// ┐ ─── Fast-forward regression harness (real bot match) ──────────────────────

/** Ranged arrow hit radius — mirrors RangedHandler's HITBOX_RADIUS (=56). */
function arrowHitRadius(): number {
  return COMBAT.HURTBOX_SIZE / 2 + COLLISION.ARROW_HITBOX_WIDTH / 2;
}

/**
 * Verbatim replica of the PRE-ticket-18 gatherHurtboxEntities (full-map walks
 * + manual distance pre-filter, players-then-destructibles in Map order) —
 * the harness's EXPECTED side for S5. The production gather is now routed
 * through the spatial index, so it is the ACTUAL side (guardrail: the old
 * scan lives on behind the harness only).
 */
function oldGatherHurtboxEntitiesLinear(m: GameMatch, attackerId: string, range: number): string[] {
  const broadRange = range + Math.max(COMBAT.HURTBOX_SIZE, COMBAT.DESTRUCTIBLE_HURTBOX_SIZE);
  const ids: string[] = [];
  for (const [, p] of m.players) {
    if (p.id === attackerId) continue;
    if (!p.isActive) continue;
    const dx = p.movement.position.x - (m.getPlayer(attackerId)!.movement.position.x);
    const dy = p.movement.position.y - (m.getPlayer(attackerId)!.movement.position.y);
    if (dx * dx + dy * dy > broadRange * broadRange) continue;
    ids.push(p.id);
  }
  for (const [, d] of m.destructibles) {
    if (!d.isActive) continue;
    const dx = d.position.x - (m.getPlayer(attackerId)!.movement.position.x);
    const dy = d.position.y - (m.getPlayer(attackerId)!.movement.position.y);
    if (dx * dx + dy * dy > broadRange * broadRange) continue;
    ids.push(d.id);
  }
  return ids;
}

interface OrchestratorLike {
  getMatch(): GameMatch | undefined;
  setLastStandingThreshold(n: number): void;
  start(): void;
  update(deltaMs: number): unknown;
}

const realDateNow = Date.now;
const realPerfNow =
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now.bind(performance)
    : () => 0;

describe('DomainSpatialIndex regression harness (fast-forward bot match)', () => {
  let server: Awaited<ReturnType<typeof createTestServer>>;

  beforeAll(async () => {
    server = await createTestServer();
  });

  afterAll(async () => {
    await cleanup(server);
  });

  it(
    'spatial queries equal the old linear scans for every audited site, every tick',
    async () => {
      const BOTS = Number(process.env.SPATIAL_HARNESS_BOTS ?? 16);
      const DURATION_SECONDS = Number(process.env.SPATIAL_HARNESS_DURATION ?? 90);
      const SEED = Number(process.env.SPATIAL_HARNESS_SEED ?? 4242);
      const MELEE_TEST_RANGE = 192;

      const room = await createRoom(server, {
        botFillTo: BOTS,
        botDifficulty: 'hard',
        mapType: 'procedural',
        seed: SEED,
      });
      room.autoDispose = false;

      const gameRoom = room as unknown as GameRoom;
      const orch = gameRoom.getOrchestrator() as unknown as OrchestratorLike;
      orch.setLastStandingThreshold(-1); // keep entities flowing; no early finish

      // Synchronous deterministic bot spawn (same access path as the bot
      // benchmark harness — see tests/helpers/bot-benchmark-harness.ts).
      const botManager = (
        gameRoom as unknown as {
          botManager: {
            spawnAllBotsSync: (orch: unknown, max: number, baseTs: number) => number;
            dispose: () => void;
          };
        }
      ).botManager;
      const seedBaseTime = 1700000000000 + SEED;
      const spawned = botManager.spawnAllBotsSync(orch, BOTS, seedBaseTime);
      expect(spawned).toBe(BOTS);

      orch.start();
      const match = orch.getMatch();
      expect(match).toBeDefined();

      // Virtual clock (faithful siege/zone timing) — minimal copy of the
      // benchmark harness pattern.
      let virtualDate = realDateNow();
      let virtualPerf = realPerfNow();
      const savedDateNow = globalThis.Date.now;
      const savedPerfNow = globalThis.performance.now;
      globalThis.Date.now = () => virtualDate;
      const installPerfNow = (fn: () => number): void => {
        try {
          Object.defineProperty(globalThis.performance, 'now', {
            value: fn,
            writable: true,
            configurable: true,
          });
        } catch {
          (globalThis.performance as { now: () => number }).now = fn;
        }
      };
      installPerfNow(() => virtualPerf);

      const totalTicks = Math.ceil(DURATION_SECONDS * NETWORK.TICK_RATE);
      const playerOut = createSpatialQueryResult(); // reusable, test-owned
      const destructibleOut = createSpatialQueryResult();

      // Telemetry for the report.
      let ticksCompared = 0;
      let rangedChecks = 0;
      let thrownChecks = 0;
      let meleeChecks = 0;
      let barrelChecks = 0;
      let corpseCandidates = 0; // S2 divergence instances (report-only)
      let prevMatchTick = -1;
      // Direct wall-clock cost of the per-tick production rebuild call
      // (measured on real perf counters via process.hrtime, NOT the
      // virtualized performance.now — same technique as the bench harness).
      const hrtimeMs = (): number => {
        const [s, ns] = process.hrtime();
        return s * 1000 + ns / 1e6;
      };
      let rebuildTotalMs = 0;

      const fail = (ctx: string): string => `[tick ${match!.tick}] ${ctx}`;

      try {
        for (let i = 0; i < totalTicks; i++) {
          virtualDate += NETWORK.TICK_INTERVAL;
          virtualPerf += NETWORK.TICK_INTERVAL;
          orch.update(NETWORK.TICK_INTERVAL);
          const m = match!;
          if (m.tick === prevMatchTick) continue; // no step ran this update
          prevMatchTick = m.tick;
          ticksCompared++;

          // (a) The PRODUCTION rebuild ran during step2 of the last executed
          // step (before advanceTick), i.e. at tick m.tick - 1.
          expect(m.spatialIndex, fail('spatialIndex missing after first step')).toBeDefined();
          if (m.spatialIndex && ticksCompared > 1) {
            expect(
              m.spatialIndex.lastRebuildTick,
              fail('production step2 rebuild did not run this tick'),
            ).toBe(m.tick - 1);
          }

          // (b) Rebuild over the CURRENT post-tick state — this is exactly
          // the state the linear scans see when they run (same call path as
          // production: match.rebuildSpatialIndex). Both sides of every
          // comparison below now read identical live state. Timed so the
          // report can state the index's real per-tick build cost.
          const rebuildStart = hrtimeMs();
          const index = m.rebuildSpatialIndex();
          rebuildTotalMs += hrtimeMs() - rebuildStart;

          const arrowR = arrowHitRadius();

          // ── S1/S2: RANGED arrow semantics (per arrow in flight) ──
          // ACTUAL side = the production candidate collectors the routed
          // RangedHandler loops iterate (collect*InMapOrder = query + seq
          // sort = Map order) + the site predicates verbatim. EXPECTED side =
          // the pre-ticket-18 linear scans. ORDER equality (both Map order).
          for (const proj of m.projectiles.values()) {
            if (proj.bouncesRemaining >= 0) continue; // thrown, handled below
            const px = proj.position.x;
            const py = proj.position.y;

            // S1 destructibles: linear scan set (Map order)
            const scanDest: string[] = [];
            for (const [id, d] of m.destructibles) {
              if (d.isDestroyed) continue;
              if (proj.position.distanceTo(d.position) < arrowR) scanDest.push(id);
            }
            const routedDest = collectDestructiblesInMapOrder(
              index,
              m.destructibles,
              px,
              py,
              arrowR,
              destructibleOut,
            )
              .filter((d) => !d.isDestroyed && proj.position.distanceTo(d.position) < arrowR)
              .map((d) => d.id);
            expect(routedDest, fail('S1 arrow→destructible order mismatch')).toEqual(scanDest);
            rangedChecks++;

            // S2 players: NO isActive filter — corpses absorb arrows. The
            // all-players grid returns them; owner-skip + distance selects.
            const scanPlayers: string[] = [];
            let scanCorpse = 0;
            for (const [pid, p] of m.players) {
              if (pid === proj.ownerId) continue;
              const dist = proj.position.distanceTo(p.movement.position);
              if (dist >= arrowR) continue;
              if (!p.isActive) scanCorpse++;
              scanPlayers.push(pid);
            }
            corpseCandidates += scanCorpse;
            const routedPlayers = collectPlayersInMapOrder(
              index,
              m.players,
              px,
              py,
              arrowR,
              playerOut,
            )
              .filter(
                (p) =>
                  p.id !== proj.ownerId &&
                  proj.position.distanceTo(p.movement.position) < arrowR,
              )
              .map((p) => p.id);
            expect(routedPlayers, fail('S2 arrow→player order mismatch')).toEqual(scanPlayers);
          }

          // ── S3/S4: THROWN semantics (per thrown projectile in flight) ──
          // Same structure as S1/S2: production collectors + site predicates
          // vs the pre-ticket-18 linear scans, ORDER equality.
          for (const proj of m.projectiles.values()) {
            if (proj.bouncesRemaining < 0) continue;
            const px = proj.position.x;
            const py = proj.position.y;

            // S3 destructibles
            const scanDest: string[] = [];
            for (const [id, d] of m.destructibles) {
              if (d.isDestroyed) continue;
              if (proj.position.distanceTo(d.position) < PLAYER_HIT_RADIUS) scanDest.push(id);
            }
            const routedDest = collectDestructiblesInMapOrder(
              index,
              m.destructibles,
              px,
              py,
              PLAYER_HIT_RADIUS,
              destructibleOut,
            )
              .filter(
                (d) => !d.isDestroyed && proj.position.distanceTo(d.position) < PLAYER_HIT_RADIUS,
              )
              .map((d) => d.id);
            expect(routedDest, fail('S3 thrown→destructible order mismatch')).toEqual(scanDest);

            // S4 players (isActive — the site filters liveness itself)
            const scanPlayers: string[] = [];
            for (const [pid, p] of m.players) {
              if (!p.isActive) continue;
              if (proj.position.distanceTo(p.movement.position) < PLAYER_HIT_RADIUS)
                scanPlayers.push(pid);
            }
            const routedPlayers = collectPlayersInMapOrder(
              index,
              m.players,
              px,
              py,
              PLAYER_HIT_RADIUS,
              playerOut,
            )
              .filter(
                (p) =>
                  p.isActive &&
                  proj.position.distanceTo(p.movement.position) < PLAYER_HIT_RADIUS,
              )
              .map((p) => p.id);
            expect(routedPlayers, fail('S4 thrown→player order mismatch')).toEqual(scanPlayers);
            thrownChecks++;
          }

          // ── S5: MELEE gather semantics — ACTUAL side is the REAL routed
          // gatherHurtboxEntities (spatial query + old exact circle filter,
          // Map order per kind); EXPECTED side is the verbatim pre-ticket-18
          // linear replica. Full ORDERED sequence equality — this is the
          // order MeleeSweepHandler consumes victims in (weapon-break /
          // shield-block interruption depends on it). ──
          for (const attacker of m.players.values()) {
            if (!attacker.isActive) continue;
            const ax = attacker.movement.position.x;
            const ay = attacker.movement.position.y;
            const broadRange = MELEE_TEST_RANGE + MELEE_HURTBOX_PAD;

            const expectedIds = oldGatherHurtboxEntitiesLinear(m, attacker.id, MELEE_TEST_RANGE);
            const gathered = gatherHurtboxEntities(m, attacker, MELEE_TEST_RANGE);
            const routedIds = gathered.entities.map((e) => e.id);
            expect(routedIds, fail('S5 melee gather order mismatch')).toEqual(expectedIds);

            // Consistency: the routed candidate circle is a superset of the
            // old filter's survivor set at the same radius (query bbox ⊇
            // circle), re-verified per candidate on live state.
            index.queryPlayers(ax, ay, broadRange, playerOut);
            const queryPlayerIds = playerOut.entities
              .filter((p) => {
                if (p.id === attacker.id || !p.isActive) return false;
                const dx = p.movement.position.x - ax;
                const dy = p.movement.position.y - ay;
                return dx * dx + dy * dy <= broadRange * broadRange;
              })
              .map((p) => p.id);
            expect(
              queryPlayerIds.slice().sort(),
              fail('S5 melee gather→player set mismatch'),
            ).toEqual(expectedIds.filter((id) => m.players.get(id) !== undefined).sort());

            index.queryDestructibles(ax, ay, broadRange, destructibleOut);
            const queryDestIds = destructibleOut.entities
              .filter((d) => {
                if (d.isDestroyed) return false;
                const dx = d.position.x - ax;
                const dy = d.position.y - ay;
                return dx * dx + dy * dy <= broadRange * broadRange;
              })
              .map((d) => d.id);
            expect(
              queryDestIds.slice().sort(),
              fail('S5 melee gather→destructible set mismatch'),
            ).toEqual(expectedIds.filter((id) => m.destructibles.get(id) !== undefined).sort());
            meleeChecks++;
          }

          // ── S6: BARREL explosion semantics (per live explosion) ──
          // Ticket 19: the manager's per-ray-cell lookups run through the
          // spatial index. ACTUAL side = the REAL routed manager methods
          // (`collectCellPlayers` / `findCellDestructible`); EXPECTED side =
          // the pre-ticket-19 code — a full player scan per cell (isActive +
          // tile containment, Map order) and the per-explosion rebuilt
          // destructible grid Map (last-write-wins `${gx},${gy}` keys, built
          // from the live map). The walk mirror omits the siege guard (it
          // only shrinks the reachable cell set — a SUPERSET walk, which only
          // adds equality checks). The destructible equality check IS the
          // recursion-consistency gate: it asserts the stale-index lookup
          // with the live `isDestroyed` re-check selects exactly the occupant
          // the freshly rebuilt per-explosion Map selected, including for
          // barrels destroyed/deleted earlier in a chain (they persist as
          // stale index entries until the next step2 rebuild).
          const tw = m.config.map.tileWidth;
          const th = m.config.map.tileHeight;
          for (const explosion of m.explosions.values()) {
            const src = explosion.position;
            // (i) Circle broadphase equality at EXPLOSION_RADIUS.
            const scanInRadius: string[] = [];
            for (const [pid, p] of m.players) {
              if (!p.isActive) continue;
              if (src.distanceTo(p.movement.position) <= BARREL.EXPLOSION_RADIUS)
                scanInRadius.push(pid);
            }
            index.queryPlayers(src.x, src.y, BARREL.EXPLOSION_RADIUS, playerOut);
            const queryInRadius = playerOut.entities
              .filter(
                (p) => p.isActive && src.distanceTo(p.movement.position) <= BARREL.EXPLOSION_RADIUS,
              )
              .map((p) => p.id);
            expect(queryInRadius, fail('S6 barrel circle set mismatch')).toEqual(
              [...scanInRadius].sort(),
            );

            // (ii) Per-ray-cell equality: real routed lookups vs the old
            // per-cell full player scan + per-explosion rebuilt grid Map.
            const maxRay = Math.ceil(BARREL.EXPLOSION_RADIUS / tw);
            const gx = Math.floor(src.x / tw);
            const gy = Math.floor(src.y / th);
            const dirs = [
              [1, 0],
              [-1, 0],
              [0, 1],
              [0, -1],
              [1, 1],
              [-1, 1],
              [1, -1],
              [-1, -1],
            ];
            // The OLD destructible lookup structure, rebuilt per explosion
            // from the live map exactly like the pre-ticket-19 manager did.
            const oldOccupancy = new Map<string, Destructible>();
            for (const [, d] of m.destructibles) {
              oldOccupancy.set(`${Math.floor(d.position.x / tw)},${Math.floor(d.position.y / th)}`, d);
            }
            const grid = m.grid;
            const maxRows = grid.length;
            const maxCols = maxRows > 0 ? (grid[0]?.length ?? 0) : 0;
            for (const [stepX, stepY] of dirs) {
              for (let step = 1; step <= maxRay; step++) {
                const nx = gx + stepX * step;
                const ny = gy + stepY * step;
                if (ny < 0 || ny >= maxRows || nx < 0 || nx >= maxCols) break;
                const tile = grid[ny]![nx]!;
                if (tile === TileType.INDESTRUCTIBLE_WALL || tile === TileType.INDESTRUCTIBLE_CRATE)
                  break;

                // Players: old full scan vs the REAL routed candidate list
                // (order-sensitive — alivePlayerCount is read per victim).
                const scanVictims: string[] = [];
                for (const [pid, p] of m.players) {
                  if (!p.isActive) continue;
                  if (
                    Math.floor(p.movement.position.x / tw) === nx &&
                    Math.floor(p.movement.position.y / th) === ny
                  ) {
                    scanVictims.push(pid);
                  }
                }
                const routedVictims = m.barrelExplosionManager
                  .collectCellPlayers(nx, ny, tw, th)
                  .filter(
                    (p) =>
                      p.isActive &&
                      Math.floor(p.movement.position.x / tw) === nx &&
                      Math.floor(p.movement.position.y / th) === ny,
                  )
                  .map((p) => p.id);
                expect(routedVictims, fail('S6 barrel cell victim order mismatch')).toEqual(
                  scanVictims,
                );

                // Destructible: old rebuilt-map occupancy vs the REAL routed
                // lookup (stale index + live isDestroyed re-check upstream).
                // Same entry (including undefined/destroyed outcomes).
                const expectedOcc = oldOccupancy.get(`${nx},${ny}`);
                const routedOcc = m.barrelExplosionManager.findCellDestructible(nx, ny, tw, th);
                expect(routedOcc?.id ?? null, fail('S6 barrel cell occupant mismatch')).toBe(
                  expectedOcc?.id ?? null,
                );

                // Ray-stop guards, mirroring the manager's walk (post-check,
                // so the equality checks above see every reachable cell).
                if (expectedOcc && !expectedOcc.isDestroyed) break;
                if (tile === TileType.DESTRUCTIBLE_WALL || tile === TileType.DESTRUCTIBLE_BARREL)
                  break;
                barrelChecks++;
              }
            }
            // NOTE: ticket 17's original "broadened query covers ray victims"
            // coverage check is subsumed by (ii): the routed code queries per
            // CELL (half-tile-diagonal at the cell center), and (ii) asserts
            // ORDER-equality with the old full-map scan at EVERY reachable
            // cell — including beyond-radius diagonal cells — so no ray victim
            // can be missed by the real routed lookup.
          }
        }
      } finally {
        globalThis.Date.now = savedDateNow;
        installPerfNow(savedPerfNow);
      }

      // The harness must have actually exercised the sites.
      expect(ticksCompared).toBeGreaterThan(0);
      expect(meleeChecks).toBeGreaterThan(0);
      console.log(
        `[spatial-harness] ${ticksCompared} ticks compared — ` +
          `ranged-obj checks=${rangedChecks}, thrown-obj checks=${thrownChecks}, ` +
          `melee-attacker checks=${meleeChecks}, barrel checks=${barrelChecks}, ` +
          `S2 corpse candidates (all-players index returns them; arrows still absorb)=${corpseCandidates}, ` +
          `rebuild cost avg=${(rebuildTotalMs / ticksCompared).toFixed(4)}ms/tick ` +
          `(players=${match!.spatialIndex?.playerCount ?? 0}, ` +
          `destructibles=${match!.spatialIndex?.destructibleCount ?? 0} at final tick)`,
      );
    },
    240_000,
  );
});
