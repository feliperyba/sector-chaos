import { WeaponType } from '../src/ai/_shared.js';
import { buildPhase2Intents } from '../src/ai/intent/intents.ts';
import type { IntentContext } from '../src/ai/intent/Intent.ts';
import { PersonalityArchetype, PersonalityProfile } from '../src/ai/intent/PersonalityProfile.ts';

const ctx: any = {
  tick: 0,
  x: 0,
  y: 0,
  health: 100,
  maxHealth: 100,
  weapons: [{ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }],
  activeSlot: 0,
  nearestEnemy: {
    id: 'e1',
    x: 100,
    y: 0,
    distance: 100,
    health: 100,
    maxHealth: 100,
    weaponType: WeaponType.FISTS,
    weaponTier: 0,
    barrierActive: false,
    isFreshSpawn: false,
  },
  nearestHealth: null,
  nearestBarrier: null,
  nearestSpeedBoost: null,
  nearestWeapon: null,
  zoneRadius: 500,
  zoneCenterX: 0,
  zoneCenterY: 0,
  zoneIsShrinking: false,
  siegeWarnings: [],
  selfBarrierActive: false,
  hasRealWeapon: () => true,
  getActiveWeapon: () => ({ weaponType: WeaponType.DAGGER, tier: 1, durability: 10, ammo: 10 }),
  getWeaponRange: () => 160,
};
const profile = new PersonalityProfile(
  PersonalityArchetype.DUELIST,
  { aggression: 0.9, greed: 0.3, caution: 0.2, opportunism: 0.5, trapper: 0.3 },
  { aimErrorMultiplier: 1, reactionLatencyTicks: 0, commitMultiplier: 1 },
);
const ic: IntentContext = { ctx, profile, aliveBotCount: 20, enemyInFightRange: false };
for (const intent of buildPhase2Intents()) {
  const valid = intent.isValid(ic);
  const score = intent.score(ic);
  console.log(`${intent.id}: valid=${valid} score=${score.toFixed(3)}`);
}
