export const PlayerStatus = {
  ALIVE: 1,
  DEAD: 2,
  SPECTATING: 4,
  INVINCIBLE: 8,
  STAGGERED: 16,
  FRESH_SPAWN: 32,
  DYING: 64,
} as const;

export type PlayerStatusType = (typeof PlayerStatus)[keyof typeof PlayerStatus];
