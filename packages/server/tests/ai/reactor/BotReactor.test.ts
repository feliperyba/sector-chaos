import { describe, it, expect } from 'vitest';
import { InputAction } from '@sector-battle/shared';
import { BotContext, BotState } from '../../../src/ai/BotContext.ts';
import type { EnemyInfo, ProjectileInfo } from '../../../src/ai/BotContext.ts';
import {
  PersonalityProfile,
  PersonalityArchetype,
  type PersonalityWeights,
  type SkillKnobs,
} from '../../../src/ai/intent/PersonalityProfile.ts';
import { BotBelievabilityCounters } from '../../../src/ai/BotBelievability.ts';
import type { StimulusScanView } from '../../../src/ai/stimulus/StimulusScan.ts';
import { BotReactor, type BotReactorDeps } from '../../../src/ai/reactor/BotReactor.ts';
import { Pathfinder } from '../../../src/ai/navigation/Pathfinder.ts';
import { isAngleWalkable } from '../../../src/ai/BotNavigationBlend.ts';
import {
  REACTION_MAX_WINDOW_TICKS,
  REACTION_REFRACTORY_TICKS,
  STARTLE_ACCURACY_TICKS,
  STARTLE_AIM_PENALTY,
  STARTLE_CONFUSION_TAIL_TICKS,
} from '../../../src/ai/reactor/ReactorConfig.ts';
import { createReactorBotState } from '../../../src/ai/reactor/ReactorTypes.ts';
import { runIntentSelection } from '../../../src/ai/BotTickPhases.ts';
import { IntentSelector } from '../../../src/ai/intent/IntentSelector.ts';
import { buildPhase2Intents } from '../../../src/ai/intent/intents.ts';
import { createTickBlackboard } from '../../../src/ai/TickBlackboard.ts';
import type { PlayerDTO } from '../../../src/ai/WorldSnapshot.ts';

/**
 * BotReactor seam tests (DEC-004/DEC-007): the interrupt layer's window
 * semantics at the pure seam — "given a context + stimuli, which reaction
 * fires and for how long". Everything runs WITHOUT a room: the reactor takes
 * structural deps (tracker map + tile size + map center).
 *
 * Timing note: reaction arming draws come from the per-bot BotRNG (seeded by
 * playerId), so every scenario below is byte-deterministic for its fixed bot
 * id. Assertions are written as BOUNDS that hold for ANY legal draw (≤ the
 * 90-tick latency cap, exact window lengths from the mix table) — a same-seed
 * run can never flake.
 */

const TILE = 128;
const MAP_CENTER = { x: 5120, y: 5120 };

/** Explicitly-typed archetype list (Object.values on a numeric enum widens to
 *  string|number, which breaks enum indexing in assertions). */
const ALL_ARCHETYPES: PersonalityArchetype[] = [
  PersonalityArchetype.AGGRESSOR,
  PersonalityArchetype.SCAVENGER,
  PersonalityArchetype.TRAPPER,
  PersonalityArchetype.DUELIST,
  PersonalityArchetype.SURVIVOR,
];

function dto(overrides: Partial<PlayerDTO> = {}): PlayerDTO {
  return {
    id: 'b1',
    x: 0,
    y: 0,
    velocityX: 0,
    velocityY: 0,
    facingAngle: 0,
    health: 100,
    maxHealth: 100,
    isAlive: true,
    isBot: true,
    weaponCount: 0,
    weapons: [],
    hasWeapon: false,
    weaponTier: 0,
    activeSlot: 0,
    isFreshSpawn: false,
    freshSpawnExpiryTick: 0,
    barrierActive: false,
    isInWindup: false,
    windupRemaining: 0,
    lastAttackTick: -9999,
    ...overrides,
  } as PlayerDTO;
}

function weights(w: Partial<PersonalityWeights> = {}): PersonalityWeights {
  return { aggression: 0.5, greed: 0.5, caution: 0.5, opportunism: 0.5, trapper: 0.5, ...w };
}

function skill(k: Partial<SkillKnobs> = {}): SkillKnobs {
  return { aimErrorMultiplier: 1.0, reactionLatencyTicks: 0, commitMultiplier: 1.0, ...k };
}

function profile(
  archetype: PersonalityArchetype,
  difficulty: 'easy' | 'normal' | 'medium' | 'hard' | 'elite' = 'hard',
): PersonalityProfile {
  return new PersonalityProfile(archetype, weights(), skill(), difficulty);
}

function enemyAt(overrides: Partial<EnemyInfo> = {}): EnemyInfo {
  return {
    id: 'e1',
    // 100 px SOUTH of the bot (the bot sits at the origin in these rigs) and
    // facing +Y (π/2) — squarely aimed at us. The threat gate (facingDot ≥
    // WINDUP_THREAT_DOT) needs the enemy OFF the bot's own tile: a coincident
    // enemy makes toUs degenerate (dot 0) and the windup detector never fires.
    x: 0,
    y: -100,
    vx: 0,
    vy: 0,
    distance: 100,
    health: 100,
    maxHealth: 100,
    weaponType: 3, // WeaponType.LONG_SWORD (range 224, windup 200ms = 12t)
    weaponTier: 0,
    isInWindup: true,
    windupRemaining: 12,
    lastAttackTick: -9999,
    facingAngle: Math.PI / 2,
    barrierActive: false,
    isFreshSpawn: false,
    spawnInvulnTicksLeft: 0,
    isLooting: false,
    engagedTargetId: null,
    ...overrides,
  };
}

const PROJECTILE: ProjectileInfo = { id: 'p1', x: -200, y: 0, vx: 20, vy: 0, distance: 200 };

function scanWithExplosion(tick: number, strength = 0.9): StimulusScanView {
  const decayed = {
    type: 'explosion' as const,
    worldX: 300,
    worldY: 0,
    tick,
    strength,
    effectiveStrength: strength,
  };
  return {
    entries: [decayed],
    strongestByType: { explosion: decayed },
    heardFightX: 300,
    heardFightY: 0,
    heardFightTick: tick,
  };
}

const EMPTY_SCAN: StimulusScanView = {
  entries: [],
  strongestByType: {},
  heardFightX: 0,
  heardFightY: 0,
  heardFightTick: -9999,
};

/** A reactor + tracker pair over a fresh bot context. The pathfinder is a
 *  fully-walkable open grid (wall-probe always passes — reaction angles are
 *  exercised un-deflected; the WALL-VALIDATION cases build their own). */
function rig(playerId: string) {
  const believability = new BotBelievabilityCounters();
  const deps: BotReactorDeps = {
    skillTrackers: new Map([[playerId, { believability }]]),
    getTileSize: () => TILE,
    mapCenter: MAP_CENTER,
    pathfinder: new Pathfinder(
      Array.from({ length: 80 }, () => Array.from({ length: 80 }, () => true)),
      TILE,
    ),
  };
  const reactor = new BotReactor(deps);
  reactor.registerBot(playerId);
  const ctx = new BotContext(playerId);
  ctx.tick = 100;
  ctx.x = 0;
  ctx.y = 0;
  return { reactor, ctx, believability };
}

/** Drive the reactor for `ticks` ticks (mutating ctx.tick and optionally the
 *  world per tick). Returns the owned-run boundaries + every owned emission. */
function drive(
  reactor: BotReactor,
  ctx: BotContext,
  d: PlayerDTO,
  ticks: number,
  perTick?: (ctx: BotContext, tick: number) => StimulusScanView | undefined,
  zoneIsLethal = false,
  prof?: PersonalityProfile,
): { runs: Array<{ start: number; end: number; inputs: unknown[][] }>; emissions: unknown[][] } {
  const p = prof ?? profile(PersonalityArchetype.DUELIST);
  const runs: Array<{ start: number; end: number; inputs: unknown[][] }> = [];
  for (let i = 0; i < ticks; i++) {
    ctx.tick = 100 + i;
    const scan = perTick ? perTick(ctx, ctx.tick) : EMPTY_SCAN;
    const out = reactor.runReactionTick(ctx, d, scan, zoneIsLethal, p);
    if (out !== null) {
      const last = runs[runs.length - 1];
      if (last && last.end === ctx.tick - 1) {
        last.end = ctx.tick;
        last.inputs.push(out);
      } else {
        runs.push({ start: ctx.tick, end: ctx.tick, inputs: [out] });
      }
    }
  }
  const emissions = runs.flatMap((r) => r.inputs);
  return { runs, emissions };
}

describe('BotReactor priority + window semantics', () => {
  it('projectile (priority 2) beats windup (priority 5); both eventually fire; windows exact', () => {
    const { reactor, ctx, believability } = rig('reactor-prio-a');
    ctx.projectiles = [{ ...PROJECTILE }];
    ctx.nearestEnemy = enemyAt();
    // Once the windup reaction has fired, the enemy stops winding up (a
    // perpetual windup would re-trigger on episode-cooldown expiry and add
    // extra runs beyond the two under test).
    const { runs } = drive(reactor, ctx, dto(), 600, (c) => {
      if ((believability.reactionsByType.windup ?? 0) > 0) c.nearestEnemy = null;
      return EMPTY_SCAN;
    });
    // Both reactions fired over the run.
    expect(believability.reactionsByType.projectile).toBe(1);
    expect(believability.reactionsByType.windup).toBe(1);
    expect(believability.reactionsTotal).toBe(2);
    // DUELIST projectile mix: exactly 10 owned ticks; windup mix: exactly 9
    // (bot-ai-v2 ticket 09 retuned the DUELIST windup to the perpAway
    // "sidestep-and-space" pattern — 9 ticks, not the ticket-04-era 8).
    expect(runs.length).toBe(2);
    expect(runs[0]!.end - runs[0]!.start + 1).toBe(10);
    expect(runs[1]!.end - runs[1]!.start + 1).toBe(9);
    // The higher-priority projectile reaction is the FIRST run.
    // (If windup had fired first, its window would be 9 — pinned by the
    // exact-length assertions above plus the priority ordering: run[0] must
    // be the 10-tick projectile window.)
    expect(runs[0]!.end - runs[0]!.start + 1).not.toBe(9);
    // No chaining: a refractory gap ≥ REACTION_REFRACTORY_TICKS separates runs.
    const gap = runs[1]!.start - runs[0]!.end - 1;
    expect(gap).toBeGreaterThanOrEqual(REACTION_REFRACTORY_TICKS);
  });

  it('imminent death fires with ZERO latency and preempts an active reaction (GDD §14.4)', () => {
    const { reactor, ctx, believability } = rig('reactor-death-a');
    ctx.zoneRadius = 500;
    ctx.zoneCenterX = 0;
    ctx.zoneCenterY = 0;
    ctx.zoneSafeX = 0;
    ctx.zoneSafeY = 0;
    ctx.x = 600; // outside a lethal zone → crossing edge
    ctx.tick = 100;
    // First call: fires IMMEDIATELY (no latency draw at priority 1).
    const out = reactor.runReactionTick(
      ctx,
      dto(),
      EMPTY_SCAN,
      true,
      profile(PersonalityArchetype.DUELIST),
    );
    expect(out).not.toBeNull();
    expect(out!.length).toBeGreaterThanOrEqual(1);
    expect(believability.reactionsByType.imminentDeath).toBe(1);
    // The escape is observable: a MOVE (and the mix's dash — ready at start).
    expect(out!.some((i) => i.action === InputAction.MOVE)).toBe(true);
    expect(out!.some((i) => i.action === InputAction.DASH)).toBe(true);
  });

  it('imminent death PREEMPTS an active projectile window mid-flight', () => {
    const { reactor, ctx, believability } = rig('reactor-preempt-a');
    ctx.projectiles = [{ ...PROJECTILE }];
    // Phase 1: drive to the start of the projectile window (≤ 90 latency + 1).
    let owned = false;
    for (let i = 0; i < 120 && !owned; i++) {
      ctx.tick = 100 + i;
      const out = reactor.runReactionTick(
        ctx,
        dto(),
        EMPTY_SCAN,
        false,
        profile(PersonalityArchetype.DUELIST),
      );
      if (out !== null) owned = true;
    }
    expect(owned).toBe(true);
    expect(believability.reactionsByType.projectile).toBe(1);
    // Phase 2: mid-window, the bot crosses into a lethal zone.
    ctx.zoneRadius = 500;
    ctx.zoneCenterX = 0;
    ctx.zoneCenterY = 0;
    ctx.x = 600;
    ctx.tick += 1;
    const out = reactor.runReactionTick(
      ctx,
      dto(),
      EMPTY_SCAN,
      true,
      profile(PersonalityArchetype.DUELIST),
    );
    expect(out).not.toBeNull();
    expect(believability.reactionsByType.imminentDeath).toBe(1);
  });
});

describe('BotReactor suppression masks (own attack windup)', () => {
  it('masked types never arm while in own windup (no self-stunlock)', () => {
    const { reactor, ctx, believability } = rig('reactor-suppress-a');
    ctx.projectiles = [{ ...PROJECTILE }];
    ctx.nearestEnemy = enemyAt();
    const { runs } = drive(reactor, ctx, dto({ isInWindup: true }), 300);
    expect(runs.length).toBe(0);
    expect(believability.reactionsByType.projectile ?? 0).toBe(0);
    expect(believability.reactionsByType.windup ?? 0).toBe(0);
  });

  it('imminent death is EXEMPT from the mask — and emits MOVE, no dead DASH', () => {
    const { reactor, ctx, believability } = rig('reactor-suppress-b');
    ctx.zoneRadius = 500;
    ctx.x = 600;
    ctx.tick = 100;
    const out = reactor.runReactionTick(
      ctx,
      dto({ isInWindup: true }),
      EMPTY_SCAN,
      true,
      profile(PersonalityArchetype.DUELIST),
    );
    expect(out).not.toBeNull();
    expect(believability.reactionsByType.imminentDeath).toBe(1);
    // Movement stays legal during own windup → the escape MOVE is the visible
    // reaction; the physically-dead DASH is masked (no invisible action).
    expect(out!.some((i) => i.action === InputAction.MOVE)).toBe(true);
    expect(out!.some((i) => i.action === InputAction.DASH)).toBe(false);
  });
});

describe('BotReactor bounded windows + no chaining', () => {
  it('repeated fresh explosions produce SPACED runs: ≤15 ticks each, refractory gaps', () => {
    const { reactor, ctx } = rig('reactor-chain-a');
    const { runs } = drive(
      reactor,
      ctx,
      dto(),
      400,
      (_c, tick) => scanWithExplosion(tick), // a fresh explosion every tick
    );
    // Explosions keep arriving → several reactions over 400 ticks (expected
    // ~400/(latency≈6 + window≈10 + refractory 10) ≈ 15; ≥3 is a safe floor
    // for any draw sequence).
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const run of runs) {
      const len = run.end - run.start + 1;
      expect(len).toBeLessThanOrEqual(REACTION_MAX_WINDOW_TICKS);
      // DUELIST explosion mix: exactly 10.
      expect(len).toBe(10);
    }
    for (let i = 1; i < runs.length; i++) {
      const gap = runs[i]!.start - runs[i - 1]!.end - 1;
      expect(gap).toBeGreaterThanOrEqual(REACTION_REFRACTORY_TICKS);
    }
  });
});

describe('BotReactor VISIBILITY INVARIANT (every fired reaction emits ≥1 input)', () => {
  const CASES: Array<{
    type: string;
    apply: (ctx: BotContext) => void;
    perTick?: (ctx: BotContext, tick: number) => StimulusScanView | undefined;
    zoneIsLethal?: boolean;
  }> = [
    {
      type: 'imminentDeath',
      apply: (ctx) => {
        ctx.zoneRadius = 500;
        ctx.x = 600;
      },
      zoneIsLethal: true,
    },
    {
      type: 'projectile',
      apply: (ctx) => {
        ctx.projectiles = [{ ...PROJECTILE }];
      },
    },
    {
      type: 'startle',
      apply: (ctx) => {
        // TICKET-05 UPDATE (DEC-003): the startle origin is the damage-
        // direction BELIEF seam (ctx.lastDamageBelief*), which replaced the
        // removed nearest-enemy attribution (lastDamageFrom*).
        ctx.lastDamageBeliefX = 200;
        ctx.lastDamageBeliefY = 0;
        ctx.lastDamageBeliefTick = 100;
      },
      perTick: (ctx, tick) => {
        ctx.lastDamageTick = tick; // the damage edge stays fresh until armed
        ctx.lastDamageBeliefTick = tick; // keep the belief inside its window
        return EMPTY_SCAN;
      },
    },
    {
      type: 'explosion',
      apply: () => {},
      perTick: (_ctx, tick) => scanWithExplosion(tick),
    },
    {
      type: 'windup',
      apply: (ctx) => {
        ctx.nearestEnemy = enemyAt();
      },
    },
  ];

  // THE un-gating pin at the reactor seam: windup reactions occur for EVERY
  // archetype (the bench gate's unit proxy) — and every archetype × type mix
  // emits at least one observable input on every owned tick.
  it.each(ALL_ARCHETYPES)(
    'archetype %s: all five reaction types fire and emit ≥1 MOVE every owned tick',
    (archetype: PersonalityArchetype) => {
      for (const c of CASES) {
        const id = `reactor-vis-${PersonalityArchetype[archetype]}-${c.type}`;
        const { reactor, ctx, believability } = rig(id);
        ctx.tick = 100;
        c.apply(ctx);
        const { runs, emissions } = drive(
          reactor,
          ctx,
          dto(),
          400, // ≥ latency cap 90 + max window 15 + refractory 10, with slack
          c.perTick,
          c.zoneIsLethal ?? false,
          profile(archetype),
        );
        expect(
          runs.length,
          `${c.type} must fire for ${PersonalityArchetype[archetype]}`,
        ).toBeGreaterThanOrEqual(1);
        expect(believability.reactionsByType[c.type] ?? 0).toBeGreaterThanOrEqual(1);
        expect(emissions.length).toBeGreaterThan(0);
        for (const tickInputs of emissions) {
          expect(tickInputs.length).toBeGreaterThanOrEqual(1);
          const hasMove = (tickInputs as Array<{ action: InputAction }>).some(
            (i) => i.action === InputAction.MOVE,
          );
          expect(hasMove, `${c.type}: an owned tick with no MOVE input`).toBe(true);
        }
      }
    },
  );
});

describe('BotReactor STARTLE: confusion window + accuracy penalty (DEC-007)', () => {
  it('confusion outlasts the flinch by the tail; the penalty decays linearly to 0', () => {
    const { reactor, ctx, believability } = rig('reactor-startle-a');
    // TICKET-05 UPDATE (DEC-003): startle origin = the damage-direction
    // belief seam (lastDamageBelief*), kept fresh alongside the damage edge.
    ctx.lastDamageBeliefX = 200;
    ctx.lastDamageBeliefY = 0;
    // Drive to activation while keeping the damage edge fresh.
    let activationTick = -1;
    for (let i = 0; i < 200 && activationTick < 0; i++) {
      ctx.tick = 100 + i;
      ctx.lastDamageTick = ctx.tick;
      ctx.lastDamageBeliefTick = ctx.tick;
      const out = reactor.runReactionTick(
        ctx,
        dto(),
        EMPTY_SCAN,
        false,
        profile(PersonalityArchetype.SURVIVOR),
      );
      if (out !== null) activationTick = ctx.tick;
    }
    expect(activationTick).toBeGreaterThan(0);
    expect(believability.reactionsByType.startle).toBe(1);
    // SURVIVOR startle mix: 12-tick window.
    const duration = 12;
    // Confusion covers window + tail (ticks activation..activation+duration+5).
    expect(reactor.isConfused('reactor-startle-a', activationTick)).toBe(true);
    expect(
      reactor.isConfused(
        'reactor-startle-a',
        activationTick + duration + STARTLE_CONFUSION_TAIL_TICKS - 1,
      ),
    ).toBe(true);
    expect(
      reactor.isConfused(
        'reactor-startle-a',
        activationTick + duration + STARTLE_CONFUSION_TAIL_TICKS,
      ),
    ).toBe(false);
    // Accuracy penalty: full at activation, linear decay, zero at window end.
    expect(reactor.startleAimPenalty('reactor-startle-a', activationTick)).toBeCloseTo(
      STARTLE_AIM_PENALTY,
      10,
    );
    expect(
      reactor.startleAimPenalty('reactor-startle-a', activationTick + STARTLE_ACCURACY_TICKS / 2),
    ).toBeCloseTo(STARTLE_AIM_PENALTY / 2, 10);
    expect(
      reactor.startleAimPenalty('reactor-startle-a', activationTick + STARTLE_ACCURACY_TICKS),
    ).toBe(0);
    const p1 = reactor.startleAimPenalty('reactor-startle-a', activationTick + 5);
    const p2 = reactor.startleAimPenalty('reactor-startle-a', activationTick + 15);
    const p3 = reactor.startleAimPenalty('reactor-startle-a', activationTick + 25);
    expect(p1).toBeGreaterThan(p2);
    expect(p2).toBeGreaterThan(p3);
    expect(p3).toBeGreaterThan(0);
  });

  it('NO INTENT SWITCHING while startled: runIntentSelection holds the current intent', () => {
    const { reactor, ctx } = rig('reactor-confuse-a');
    ctx.state = BotState.LOOT;
    // TICKET-05 UPDATE (DEC-003): startle origin = the damage-direction
    // belief seam (lastDamageBelief*), kept fresh alongside the damage edge.
    ctx.lastDamageBeliefX = 200;
    ctx.lastDamageBeliefY = 0;
    // Startle the bot to open the confusion window.
    let activationTick = -1;
    for (let i = 0; i < 200 && activationTick < 0; i++) {
      ctx.tick = 100 + i;
      ctx.lastDamageTick = ctx.tick;
      ctx.lastDamageBeliefTick = ctx.tick;
      const out = reactor.runReactionTick(
        ctx,
        dto(),
        EMPTY_SCAN,
        false,
        profile(PersonalityArchetype.SURVIVOR),
      );
      if (out !== null) activationTick = ctx.tick;
    }
    expect(activationTick).toBeGreaterThan(0);
    // A tick inside the confusion tail (past the reaction window).
    const confusedTick = activationTick + 14; // window 12 → tail ticks 12..17
    expect(reactor.isConfused('reactor-confuse-a', confusedTick)).toBe(true);

    const systemStub = {
      reactor,
      selectors: new Map(),
      skillTrackers: new Map(),
      worldSnapshot: { aliveBotCount: 10 },
      pathfinder: { getTileSize: () => TILE },
      destructibleCentroidMap: new Map(),
      // Ticket 09 (DEC-010.3): intent selection reads the published stimulus
      // scan view off the router — the stub serves the empty view.
      stimulusRouter: { getState: () => ({ scan: EMPTY_SCAN }) },
      // Ticket 10 (DEC-011): the arc state is optional at the seam
      // (arcModFor: identity when absent) — omitted on purpose here.
    } as unknown as Parameters<typeof runIntentSelection>[0];
    const selector = new IntentSelector(buildPhase2Intents());
    const prof = profile(PersonalityArchetype.SURVIVOR);
    const bb = createTickBlackboard({ x: 0, y: 0, tick: -9999 });

    ctx.tick = confusedTick;
    ctx.state = BotState.LOOT;
    runIntentSelection(systemStub, ctx, bb, prof, selector, BotState.LOOT);
    // Confused: the selector was never consulted (fresh selector keeps a null
    // current intent) and the state held.
    expect(selector.currentIntentId).toBeNull();
    expect(ctx.state).toBe(BotState.LOOT);

    // Control — past the confusion window, selection resumes.
    const clearTick = activationTick + 30;
    expect(reactor.isConfused('reactor-confuse-a', clearTick)).toBe(false);
    ctx.tick = clearTick;
    runIntentSelection(systemStub, ctx, bb, prof, selector, BotState.LOOT);
    expect(selector.currentIntentId).not.toBeNull();
  });
});

describe('BotReactor determinism', () => {
  it('same bot id + same stimulus sequence → byte-identical reaction input stream', () => {
    /** Deterministic projection of an input batch — strips the QueuedInput's
     *  `receivedAt` wall-clock stamp (a transport field, not behavior). */
    const project = (out: ReturnType<BotReactor['runReactionTick']>): string =>
      out === null
        ? 'null'
        : JSON.stringify(out.map((i) => ({ action: i.action, data: i.data, tick: i.clientTick })));
    const runOnce = (): string => {
      const { reactor } = rig('reactor-det-a');
      const ctx = new BotContext('reactor-det-a');
      ctx.tick = 100;
      const collected: string[] = [];
      for (let i = 0; i < 250; i++) {
        ctx.tick = 100 + i;
        if (i % 7 === 0) ctx.projectiles = [{ ...PROJECTILE, id: `p${i}` }];
        else ctx.projectiles = [];
        const out = reactor.runReactionTick(
          ctx,
          dto(),
          scanWithExplosion(ctx.tick, 0.9),
          false,
          profile(PersonalityArchetype.DUELIST),
        );
        collected.push(project(out));
      }
      return collected.join('|');
    };
    expect(runOnce()).toBe(runOnce());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Review M3 — imminent-death refractory exemption + the every-tick lethal-edge
// memory. Pre-fix defects: (a) the refractory early-return barred imminent
// death during the post-window gap (a lethal crossing waited ~166ms — the
// spike, delayed, while dying); (b) the edge memory froze during an active
// imminent-death window (the one branch that skips the detector), so a
// re-entry + second crossing inside the window was silently swallowed.
// ─────────────────────────────────────────────────────────────────────────────

describe('BotReactor review-M3: imminent-death refractory exemption + live edge memory', () => {
  /** Zone geometry: center (0,0), radius 500 — outside when |x| > 500. */
  function zoneCtx(ctx: BotContext): void {
    ctx.zoneRadius = 500;
    ctx.zoneCenterX = 0;
    ctx.zoneCenterY = 0;
    ctx.zoneSafeX = 0;
    ctx.zoneSafeY = 0;
  }

  function wallRig(playerId: string, walls: Array<[number, number]>) {
    const grid = Array.from({ length: 40 }, () => Array.from({ length: 40 }, () => true));
    for (const [gx, gy] of walls) grid[gy]![gx] = false;
    const pf = new Pathfinder(grid, TILE);
    const believability = new BotBelievabilityCounters();
    const reactor = new BotReactor({
      skillTrackers: new Map([[playerId, { believability }]]),
      getTileSize: () => TILE,
      mapCenter: MAP_CENTER,
      pathfinder: pf,
    });
    reactor.registerBot(playerId);
    const ctx = new BotContext(playerId);
    ctx.tick = 100;
    return { reactor, ctx, believability, pf };
  }

  it('a lethal crossing DURING the refractory gap fires immediately (no ~166ms delay)', () => {
    const { reactor, ctx, believability } = rig('reactor-m3-refrac');
    const p = profile(PersonalityArchetype.DUELIST);
    // Phase 1: a startle (damage) reaction arms (possibly after its latency
    // draw) and fires — its window + refractory then follow.
    ctx.lastDamageTick = 100;
    ctx.lastDamageBeliefTick = 100;
    ctx.lastDamageBeliefX = 50;
    ctx.lastDamageBeliefY = 0;
    let out = reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, false, p);
    let guard = 0;
    while (out === null && guard++ < 100) {
      ctx.tick += 1;
      out = reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, false, p);
    }
    expect(out).not.toBeNull(); // the startle fired (zero- or drawn-latency)
    expect(believability.reactionsByType.startle).toBe(1);
    const fireTick = ctx.tick;
    // Phase 2: past the startle window (10 ticks), INSIDE the refractory
    // (window end + 10) — the bot crosses into the lethal zone.
    zoneCtx(ctx);
    ctx.x = 600;
    ctx.tick = fireTick + 12; // window covered fireTick..fireTick+9; gap now
    out = reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, true, p);
    // M3: the crossing OWNS this very tick — no waiting out the gap.
    expect(out).not.toBeNull();
    expect(believability.reactionsByType.imminentDeath).toBe(1);
  });

  it('continuous exposure does NOT chain windows (rising edge, not per-tick)', () => {
    const { reactor, ctx, believability } = rig('reactor-m3-steady');
    zoneCtx(ctx);
    ctx.x = 600; // outside, stays outside
    for (let i = 0; i < 120; i++) {
      ctx.tick = 100 + i;
      reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, true, profile(PersonalityArchetype.DUELIST));
    }
    // One crossing → one reflex spike. Steady-state fleeing is SURVIVE_ZONE's
    // job; the refractory exemption must not turn it into per-tick panic.
    expect(believability.reactionsByType.imminentDeath).toBe(1);
  });

  it('a re-entry DURING the imminent-death window leaves a fresh edge: the second crossing fires', () => {
    const { reactor, ctx, believability } = rig('reactor-m3-edge');
    const p = profile(PersonalityArchetype.DUELIST);
    zoneCtx(ctx);
    // Crossing 1 → window arms (imminent death, zero latency).
    ctx.x = 600;
    ctx.tick = 100;
    expect(reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, true, p)).not.toBeNull();
    expect(believability.reactionsByType.imminentDeath).toBe(1);
    // Mid-window: the bot re-enters safety (the every-tick edge write flips
    // the memory — pre-fix it froze at the arming tick's `true`).
    ctx.x = 0;
    ctx.tick = 103;
    reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, true, p); // owns the tick (window)
    // Window ends, refractory begins — crossing 2 must STILL fire (M3 both
    // halves: fresh edge memory + the refractory exemption).
    ctx.x = 600;
    ctx.tick = 118; // past a 10-tick window from 100, inside the gap
    const out = reactor.runReactionTick(ctx, dto(), EMPTY_SCAN, true, p);
    expect(out).not.toBeNull();
    expect(believability.reactionsByType.imminentDeath).toBe(2);
  });

  it('review M1: a panic run aimed at a wall never emits a wall-pointing angle (DEC-005.1)', () => {
    // Bot in tile (10,10); the safe point is EAST beyond a wall at gx=11 —
    // the raw 'safe'-style panic angle points straight into it, and the
    // 0.6-tile probe (76.8px from the tile center) lands ON the wall tile.
    const { reactor, ctx, pf } = wallRig('reactor-m1-wall', [[11, 10]]);
    ctx.x = 10 * TILE + TILE / 2;
    ctx.y = 10 * TILE + TILE / 2;
    ctx.zoneSafeX = 20 * TILE; // far east → the panic run heads east
    ctx.zoneSafeY = ctx.y;
    ctx.zoneRadius = 500;
    ctx.zoneCenterX = ctx.x; // not outside — force the trigger via siege tile
    ctx.zoneCenterY = ctx.y;
    ctx.siegeWarnings = [{ x: 10, y: 10 }]; // imminent death on the bot's tile
    ctx.tick = 100;
    const out = reactor.runReactionTick(
      ctx,
      dto(),
      EMPTY_SCAN,
      true,
      profile(PersonalityArchetype.DUELIST),
    );
    expect(out).not.toBeNull();
    // Both the MOVE and the first-tick DASH carry a movement angle — every
    // one of them must probe a walkable tile (THE invariant).
    const directional = out!.filter((i) => 'dx' in (i.data as object));
    expect(directional.length).toBeGreaterThanOrEqual(1);
    for (const m of directional) {
      const d = m.data as { dx: number; dy: number };
      const a = Math.atan2(d.dy, d.dx);
      expect(isAngleWalkable(ctx, a, pf), `emitted angle ${a} must be wall-safe`).toBe(true);
    }
    // And the raw un-validated angle would have failed (the premise).
    const raw = Math.atan2(ctx.zoneSafeY - ctx.y, ctx.zoneSafeX - ctx.x);
    expect(isAngleWalkable(ctx, raw, pf)).toBe(false);
  });
});
