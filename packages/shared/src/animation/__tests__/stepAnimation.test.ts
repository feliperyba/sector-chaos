import { describe, it, expect } from 'vitest';
import { WeaponType } from '../../enums/WeaponType.js';
import { AttackType } from '../../enums/AttackType.js';
import { AnimPhase, type AnimSimState, type AnimStepInput } from '../AnimTypes.js';
import {
  createAnimSimState,
  stepAnimation,
  startAttack,
  startStagger,
  setAnimPhase,
  getPhaseDurationTicks,
} from '../stepAnimation.js';
import { getWindupTicks, getCooldownTicks } from '../AnimTiming.js';
import { WEAPON_MOTIONS } from '../poses/index.js';
import { applyArmImpulses, computeHitFlinch, worldToLocalVec } from '../reactions.js';

function makeInput(tick: number, overrides: Partial<AnimStepInput> = {}): AnimStepInput {
  return {
    tick,
    facingAngle: 0,
    bodyX: 1000,
    bodyY: 1000,
    bodyVelX: 0,
    bodyVelY: 0,
    isMoving: false,
    blockHeld: false,
    weaponType: WeaponType.LONG_SWORD,
    ...overrides,
  };
}

/** Scripted 600-tick scenario: walk, attack, get hit, stagger, attack again. */
function runScenario(): { states: AnimSimState; trace: number[] } {
  const state = createAnimSimState(WeaponType.LONG_SWORD, 0);
  const trace: number[] = [];
  for (let tick = 0; tick < 600; tick++) {
    const moving = tick > 50 && tick < 200;
    if (tick === 100) startAttack(state, tick, WeaponType.LONG_SWORD, AttackType.ARC);
    if (tick === 300) {
      const local = worldToLocalVec(0.3, 250, -120);
      applyArmImpulses(state, computeHitFlinch(local.x, local.y, 2));
      startStagger(state, tick, 20);
    }
    if (tick === 400) startAttack(state, tick, WeaponType.LONG_SWORD, AttackType.ARC);
    const result = stepAnimation(
      state,
      makeInput(tick, {
        isMoving: moving,
        bodyVelX: moving ? 250 : 0,
        bodyVelY: moving ? 60 : 0,
        facingAngle: 0.3 + tick * 0.001,
      }),
    );
    if (tick % 7 === 0) {
      trace.push(result.tip.x, result.tip.y, result.leftArm.hand.x, result.rightArm.hand.y);
    }
  }
  return { states: state, trace };
}

describe('stepAnimation determinism', () => {
  it('two identical runs produce bit-identical state and trajectories', () => {
    const a = runScenario();
    const b = runScenario();
    expect(a.trace).toEqual(b.trace);
    expect(a.states).toEqual(b.states);
  });

  it('state survives JSON serialization round-trip mid-run', () => {
    const state = createAnimSimState(WeaponType.HAMMER, 0);
    for (let tick = 0; tick < 100; tick++) {
      if (tick === 40) startAttack(state, tick, WeaponType.HAMMER, AttackType.ARC);
      stepAnimation(state, makeInput(tick, { weaponType: WeaponType.HAMMER }));
    }
    const restored = JSON.parse(JSON.stringify(state)) as AnimSimState;
    for (let tick = 100; tick < 200; tick++) {
      const r1 = stepAnimation(state, makeInput(tick, { weaponType: WeaponType.HAMMER }));
      const r2 = stepAnimation(restored, makeInput(tick, { weaponType: WeaponType.HAMMER }));
      expect(r2.tip.x).toBe(r1.tip.x);
      expect(r2.tip.y).toBe(r1.tip.y);
      expect(r2.rightArm.hand.x).toBe(r1.rightArm.hand.x);
    }
    expect(restored).toEqual(state);
  });
});

describe('phase machine', () => {
  it('attack cycle: WINDUP → STRIKE → RECOVER → IDLE with server timing', () => {
    const state = createAnimSimState(WeaponType.LONG_SWORD, 0);
    const windupTicks = getWindupTicks(WeaponType.LONG_SWORD);
    const strikeTicks = WEAPON_MOTIONS[WeaponType.LONG_SWORD].strike.ticks;
    const cooldownTicks = getCooldownTicks(WeaponType.LONG_SWORD);

    startAttack(state, 10, WeaponType.LONG_SWORD, AttackType.ARC);
    expect(state.phase).toBe(AnimPhase.WINDUP);

    let tick = 10;
    // step until just before windup completes
    for (; tick < 10 + windupTicks; tick++) stepAnimation(state, makeInput(tick));
    expect(state.phase).toBe(AnimPhase.WINDUP);
    stepAnimation(state, makeInput(tick++));
    expect(state.phase).toBe(AnimPhase.STRIKE);

    for (let i = 0; i < strikeTicks; i++) stepAnimation(state, makeInput(tick++));
    expect(state.phase).toBe(AnimPhase.RECOVER);

    for (let i = 0; i < cooldownTicks - strikeTicks; i++) stepAnimation(state, makeInput(tick++));
    expect(state.phase).toBe(AnimPhase.IDLE);
    expect(state.attackWeaponType).toBe(-1);
  });

  it('interrupted strike exits early to RECOVER', () => {
    const state = createAnimSimState(WeaponType.LONG_SWORD, 0);
    startAttack(state, 0, WeaponType.LONG_SWORD, AttackType.ARC);
    let tick = 0;
    while (state.phase !== AnimPhase.STRIKE) stepAnimation(state, makeInput(tick++));
    state.swingInterrupted = true;
    stepAnimation(state, makeInput(tick++));
    expect(state.phase).toBe(AnimPhase.RECOVER);
  });

  it('walk/idle transitions follow isMoving; block holds while held', () => {
    const state = createAnimSimState(WeaponType.SMALL_SHIELD, 0);
    stepAnimation(state, makeInput(0, { isMoving: true, bodyVelX: 200 }));
    expect(state.phase).toBe(AnimPhase.WALK);
    stepAnimation(state, makeInput(1, { blockHeld: true }));
    expect(state.phase).toBe(AnimPhase.BLOCK);
    stepAnimation(state, makeInput(2, { blockHeld: true }));
    expect(state.phase).toBe(AnimPhase.BLOCK);
    stepAnimation(state, makeInput(3));
    expect(state.phase).toBe(AnimPhase.IDLE);
  });

  it('stagger lasts the externally-set duration', () => {
    const state = createAnimSimState(WeaponType.FISTS, 0);
    startStagger(state, 0, 20);
    expect(getPhaseDurationTicks(state)).toBe(20);
    for (let tick = 0; tick < 20; tick++) {
      stepAnimation(state, makeInput(tick));
      expect(state.phase).toBe(AnimPhase.STAGGER);
    }
    stepAnimation(state, makeInput(20));
    expect(state.phase).toBe(AnimPhase.IDLE);
  });

  it('DYING is terminal and goes floppy without exploding', () => {
    const state = createAnimSimState(WeaponType.FISTS, 0);
    setAnimPhase(state, AnimPhase.DYING, 0);
    for (let tick = 0; tick < 120; tick++) {
      const r = stepAnimation(state, makeInput(tick, { weaponType: WeaponType.FISTS }));
      expect(Number.isFinite(r.leftArm.hand.x)).toBe(true);
    }
    expect(state.phase).toBe(AnimPhase.DYING);
  });

  it('fists alternate punch hands via comboIndex', () => {
    const state = createAnimSimState(WeaponType.FISTS, 0);
    const fistsInput = (tick: number) => makeInput(tick, { weaponType: WeaponType.FISTS });

    // Run one full attack cycle, tracking each hand's max forward reach
    const runPunch = (startTick: number): { tick: number; maxLeft: number; maxRight: number } => {
      startAttack(state, startTick, WeaponType.FISTS, AttackType.ARC);
      let tick = startTick;
      let maxLeft = -Infinity;
      let maxRight = -Infinity;
      while ((state.phase as AnimPhase) !== AnimPhase.IDLE) {
        const r = stepAnimation(state, fistsInput(tick++));
        maxLeft = Math.max(maxLeft, r.leftArm.hand.x);
        maxRight = Math.max(maxRight, r.rightArm.hand.x);
      }
      return { tick, maxLeft, maxRight };
    };

    // First punch (comboIndex 1 → right hand strikes forward)
    const p1 = runPunch(0);
    expect(p1.maxRight).toBeGreaterThan(p1.maxLeft);
    // Second punch (comboIndex 2 → mirrored, left hand strikes forward)
    const p2 = runPunch(p1.tick);
    expect(p2.maxLeft).toBeGreaterThan(p2.maxRight);
  });
});

describe('weapon segment output', () => {
  it('sword tip sweeps and reaches near gameplay range at apex', () => {
    const state = createAnimSimState(WeaponType.LONG_SWORD, 0);
    startAttack(state, 0, WeaponType.LONG_SWORD, AttackType.ARC);
    let tick = 0;
    let maxTipRadius = 0;
    const angles: number[] = [];
    for (; tick < 60; tick++) {
      const r = stepAnimation(state, makeInput(tick));
      if (state.phase === AnimPhase.STRIKE) {
        const dx = r.tip.x - 1000;
        const dy = r.tip.y - 1000;
        maxTipRadius = Math.max(maxTipRadius, Math.sqrt(dx * dx + dy * dy));
        angles.push(Math.atan2(dy, dx));
      }
    }
    // Springs may not fully reach the keyframe apex in a fast strike, but the
    // sweep must cover a meaningful arc and most of the range.
    expect(maxTipRadius).toBeGreaterThan(224 * 0.7);
    const span = Math.max(...angles) - Math.min(...angles);
    expect(span).toBeGreaterThan(Math.PI / 4);
  });

  it('reaction impulses visibly deflect the pose', () => {
    const a = createAnimSimState(WeaponType.LONG_SWORD, 0);
    const b = createAnimSimState(WeaponType.LONG_SWORD, 0);
    for (let tick = 0; tick < 30; tick++) {
      stepAnimation(a, makeInput(tick));
      stepAnimation(b, makeInput(tick));
    }
    const local = worldToLocalVec(0, 300, 0);
    applyArmImpulses(b, computeHitFlinch(local.x, local.y, 0));
    const ra = stepAnimation(a, makeInput(30));
    const rb = stepAnimation(b, makeInput(30));
    const dist = Math.hypot(
      ra.rightArm.hand.x - rb.rightArm.hand.x,
      ra.rightArm.hand.y - rb.rightArm.hand.y,
    );
    expect(dist).toBeGreaterThan(0.5);
  });
});
