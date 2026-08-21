import { describe, it, expect } from 'vitest';
import {
  ARCHETYPE_REACTION_MIXES,
  REACTION_MAX_WINDOW_TICKS,
} from '../../../src/ai/reactor/ReactorConfig.ts';
import { PersonalityArchetype } from '../../../src/ai/intent/PersonalityProfile.ts';
import type { ReactionType } from '../../../src/ai/reactor/ReactorTypes.ts';

/**
 * Windup-dodge response patterns — the ticket-09 combat-side tuning
 * (DEC-010.2): every archetype DODGES (un-gated), and the response is one of
 * the three named flavors — tank-and-punish (perp, short, no dash),
 * sidestep-and-space (perpAway, no dash), early-dash (away + dash). The
 * per-archetype windup-reaction bench gate (> 0 for every archetype) rides
 * on every row existing and emitting a visible reaction.
 */

const WINDUP = ARCHETYPE_REACTION_MIXES.windup;
const ARCHETYPES = Object.values(PersonalityArchetype).filter(
  (a) => typeof a === 'number',
) as PersonalityArchetype[];
const REACTION_TYPE_KEYS: readonly ReactionType[] = [
  'imminentDeath',
  'projectile',
  'startle',
  'explosion',
  'windup',
];

describe('ARCHETYPE_REACTION_MIXES.windup — the three named patterns', () => {
  it('every archetype has a row within the DEC-004 window bound', () => {
    for (const a of ARCHETYPES) {
      const mix = WINDUP[a];
      expect(mix).toBeDefined();
      expect(mix.durationTicks).toBeLessThanOrEqual(REACTION_MAX_WINDOW_TICKS);
      expect(mix.durationTicks).toBeGreaterThan(0);
    }
  });

  it('AGGRESSOR: TANK-AND-PUNISH — minimal punish-ready sidestep, no dash', () => {
    const mix = WINDUP[PersonalityArchetype.AGGRESSOR];
    expect(mix.style).toBe('perp');
    expect(mix.dash).toBe(false);
    expect(mix.durationTicks).toBeLessThanOrEqual(6);
  });

  it('DUELIST and TRAPPER: SIDESTEP-AND-SPACE — diagonal, no dash', () => {
    for (const a of [PersonalityArchetype.DUELIST, PersonalityArchetype.TRAPPER]) {
      expect(WINDUP[a].style).toBe('perpAway');
      expect(WINDUP[a].dash).toBe(false);
    }
  });

  it('SCAVENGER and SURVIVOR: EARLY-DASH — evade dash on the first owned tick', () => {
    for (const a of [PersonalityArchetype.SCAVENGER, PersonalityArchetype.SURVIVOR]) {
      expect(WINDUP[a].dash).toBe(true);
      expect(WINDUP[a].style).toBe('away');
    }
  });

  it('the full table stays total over every reaction type × archetype', () => {
    for (const type of REACTION_TYPE_KEYS) {
      const row = ARCHETYPE_REACTION_MIXES[type];
      expect(row).toBeDefined();
      for (const a of ARCHETYPES) {
        expect(row[a]).toBeDefined();
      }
    }
  });
});
