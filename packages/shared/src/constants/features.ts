/**
 * Feature flags shared by server and client.
 */
export const FEATURES = {
  /**
   * Swept melee: the animated weapon segment IS the hitbox, swept tick-by-tick
   * during the strike phase. When false, the legacy instant arc/line polygon
   * test at windup-end is used. Kept as a flag for A/B balance comparison
   * during the transition; the legacy path is removed once tuning settles.
   */
  SWEPT_MELEE: true,
} as const;
