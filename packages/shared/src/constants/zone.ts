// ── ZONE PHASE PACING — SINGLE SOURCE OF TRUTH ─────────────────────────────
// The per-phase scalars below are THE tuning surface. The PHASES table at the
// bottom of ZONE derives from them 1:1, and every live reader (ZoneService,
// room configs, the MatchPhaseStateMachine band thresholds) consumes the
// table — a tuning pass edits ONLY these scalars. This structure exists
// because the table once duplicated the scalars as literals and drifted
// (PHASES stayed all-60s while a tuning pass moved the scalars to
// 60/45/45/45/30/30 — the tuned pacing silently never reached the game).
const ZONE_PHASE_1_RADIUS = 1.0;
const ZONE_PHASE_2_RADIUS = 0.6;
const ZONE_PHASE_3_RADIUS = 0.25;
const ZONE_PHASE_4_RADIUS = 0.15;
const ZONE_PHASE_5_RADIUS = 0.1;
const ZONE_PHASE_6_RADIUS = 0.08;
const ZONE_PHASE_1_DURATION = 60;
const ZONE_PHASE_2_DURATION = 45;
const ZONE_PHASE_3_DURATION = 45;
const ZONE_PHASE_4_DURATION = 45;
const ZONE_PHASE_5_DURATION = 30;
const ZONE_PHASE_6_DURATION = 30;

export const ZONE = {
  ZONE_CENTER_X: 5120,
  ZONE_CENTER_Y: 5120,
  INITIAL_ZONE_RADIUS: 5120,
  ZONE_TICK_INTERVAL: 0.5,
  ZONE_TICK_INTERVAL_MS: 500,
  ZONE_DAMAGE_PER_TICK: 8,
  ZONE_DAMAGE_SUDDEN_DEATH: 15,
  ZONE_WARNING_TIME: 10,
  ZONE_TRANSITION_DURATION: 30,
  SIEGE_WALL_DROP_INTERVAL: 3,
  SIEGE_WALL_DROP_INTERVAL_OT: 1.5,
  SIEGE_CRUSH_DAMAGE: 100,
  ZONE_PHASE_1_RADIUS,
  ZONE_PHASE_2_RADIUS,
  ZONE_PHASE_3_RADIUS,
  ZONE_PHASE_4_RADIUS,
  ZONE_PHASE_5_RADIUS,
  ZONE_PHASE_6_RADIUS,
  ZONE_PHASE_1_DURATION,
  ZONE_PHASE_2_DURATION,
  ZONE_PHASE_3_DURATION,
  ZONE_PHASE_4_DURATION,
  ZONE_PHASE_5_DURATION,
  ZONE_PHASE_6_DURATION,
  SIEGE_WALL_WARNING_DURATION: 0.5,
  SIEGE_CASCADE_TILE_DELAY: 0.08,
  SIEGE_CASCADE_AUDIO_INTERVAL: 8,
  SUDDEN_DEATH_SHRINK_RATE_MULTIPLIER: 2.0,
  SUDDEN_DEATH_ESCALATION_INTERVAL_MS: 30000,
  SUDDEN_DEATH_DAMAGE_PER_ESCALATION: 5,
  SUDDEN_DEATH_SHRINK_SPEED: 2.0,
  ZONE_CENTER_MIN_BOUNDARY_RATIO: 0.2,
  ZONE_CENTER_MAX_ATTEMPTS: 50,
  SIEGE_RING_WIDTH_TILES: 1,
  // Informational envelope only — nothing in the live pacing reads it
  // (ZoneService reads the PHASES table; the match cap is MATCH.MAX_DURATION).
  // Kept at the tuned 720 for the room-config surface that still surfaces it.
  TOTAL_DURATION: 720,
  PHASES: [
    { index: 1, radiusRatio: ZONE_PHASE_1_RADIUS, duration: ZONE_PHASE_1_DURATION, name: 'Drop' },
    {
      index: 2,
      radiusRatio: ZONE_PHASE_2_RADIUS,
      duration: ZONE_PHASE_2_DURATION,
      name: 'First Closure',
    },
    {
      index: 3,
      radiusRatio: ZONE_PHASE_3_RADIUS,
      duration: ZONE_PHASE_3_DURATION,
      name: 'Edge Closure',
    },
    {
      index: 4,
      radiusRatio: ZONE_PHASE_4_RADIUS,
      duration: ZONE_PHASE_4_DURATION,
      name: 'Final Ring',
    },
    {
      index: 5,
      radiusRatio: ZONE_PHASE_5_RADIUS,
      duration: ZONE_PHASE_5_DURATION,
      name: 'Last Sector',
    },
    {
      index: 6,
      radiusRatio: ZONE_PHASE_6_RADIUS,
      duration: ZONE_PHASE_6_DURATION,
      name: 'Final Closure',
    },
    // Sudden death holds the phase-6 radius (static — no further shrink).
    {
      index: 7,
      radiusRatio: ZONE_PHASE_6_RADIUS,
      duration: Number.MAX_SAFE_INTEGER / 1000,
      name: 'Sudden Death',
    },
  ] as const,
} as const;
