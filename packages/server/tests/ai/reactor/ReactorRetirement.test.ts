import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Retirement guard (bot-ai-v2 ticket 04, DEC-004): the three executor
 * under-fire special cases and the executor windup-dodge branch are GONE and
 * stay gone — the Reactor is the ONE place reactions happen (grep-proof in
 * CI: if anyone reintroduces an executor-side flinch/dodge, this fails).
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (p: string): string => readFileSync(join(HERE, '../../../src/ai', p), 'utf8');

const EXECUTOR_FILES = [
  'BotTickUtilities.ts',
  'BotRoamExecutors.ts',
  'BotEconomyExecutors.ts',
  'BotCombatShared.ts',
  'BotCombatEngage.ts',
  'BotCombat.ts',
];

describe('executor under-fire retirement (DEC-004)', () => {
  it('checkUnderFire no longer exists anywhere in the AI sources', () => {
    for (const file of EXECUTOR_FILES) {
      expect(src(file).includes('checkUnderFire'), `${file} still references checkUnderFire`).toBe(
        false,
      );
    }
  });

  it('shouldDodgeWindup moved out of the combat executors (Reactor priority 5 owns it)', () => {
    for (const file of EXECUTOR_FILES) {
      expect(
        src(file).includes('shouldDodgeWindup'),
        `${file} still references shouldDodgeWindup`,
      ).toBe(false);
    }
  });

  it('the windup reaction is UN-GATED: no caution threshold anywhere in the reactor', () => {
    const conditions = src('reactor/ReactorConditions.ts');
    const config = src('reactor/ReactorConfig.ts');
    // The retired personality gate (caution >= 0.55) must not reappear — the
    // detector reads only the skill knob, and no DODGE_CAUTION threshold
    // exists in the reactor's config tables.
    expect(conditions.includes('weights.caution')).toBe(false);
    expect(config.includes('DODGE_CAUTION_THRESHOLD')).toBe(false);
    // The skill gate that DID carry over is still the only profile read.
    expect(conditions.includes('profile.skill.reactionLatencyTicks')).toBe(true);
  });

  it('the Reactor is wired into the per-bot tick pipeline for ALL states', () => {
    // The interrupt sits after perception, before every deliberative phase —
    // reactions happen regardless of which executor would have run.
    const driver = src('BotTickDriver.ts');
    expect(driver.includes('runReactionTick')).toBe(true);
    // Before the demolition yield guard AND before intent selection — the
    // two early-return points that would otherwise swallow a reaction. (The
    // call forms are matched, not the import identifiers.)
    const reactorCall = driver.indexOf('system.reactor.runReactionTick');
    const guardCall = driver.indexOf('runDemolitionYieldGuard(system');
    const selectionCall = driver.indexOf('runIntentSelection(system');
    expect(reactorCall).toBeGreaterThanOrEqual(0);
    expect(guardCall).toBeGreaterThan(reactorCall);
    expect(selectionCall).toBeGreaterThan(reactorCall);
    // Lifecycle pairing: every registered bot gets reactor state.
    const system = src('BotSystem.ts');
    expect(system.includes('this.reactor.registerBot(playerId)')).toBe(true);
    expect(system.includes('this.reactor.unregisterBot(playerId)')).toBe(true);
  });

  it('the startle confusion hold gates the intent selector', () => {
    const phases = src('BotTickPhases.ts');
    expect(phases.includes('isConfused')).toBe(true);
  });
});
