export interface PlayerConfig {
  baseSpeed: number;
  dashSpeedMultiplier: number;
  dashDuration: number;
  dashCooldown: number;
  baseHealth: number;
  maxHealth: number;
  inventorySize: number;
  hitboxWidth: number;
  hitboxHeight: number;
}

export interface ZonePhase {
  readonly index: number;
  radiusRatio: number;
  duration: number;
  name: string;
}

export interface ZoneConfig {
  phases: ZonePhase[];
  totalDuration: number;
  transitionDuration: number;
  tickInterval: number;
  warningTime: number;
}

/** Match lifecycle configuration. */
export interface MatchConfig {
  targetDuration: number;
  maxPlayers: number;
  minPlayers: number;
  countdownDuration: number;
  overtimeStart: number;
  /**
   * Alive-player count at or below which the match ends (last player standing
   * wins). Set to `1` for standard battle-royale, `0` to end only when everyone
   * is dead, or `-1` to disable the alive-count check entirely (test scenes).
   * Defaults to `0` when omitted.
   */
  lastStandingThreshold?: number;
}

/** Map generation configuration. */
export interface MapConfig {
  tileWidth: number;
  tileHeight: number;
  arenaWidth: number;
  arenaHeight: number;
  sectorSize: number;
  corridorWidth: number;
  destructibleDensity: number;
  chestDensity: number;
  exitCount: number;
}

/** Combat system configuration. */
export interface CombatConfig {
  knockbackForce: number;
  knockbackDecay: number;
  throwRange: number;
  bounceFactor: number;
  maxBounces: number;
  friendlyFire: boolean;
}

/** Network sync configuration. */
export interface NetworkConfig {
  tickRate: number;
  patchRate: number;
  maxLatency: number;
  inputBufferSize: number;
  snapshotInterval: number;
}

export interface GameConfig {
  player: PlayerConfig;
  zone: ZoneConfig;
  match: MatchConfig;
  map: MapConfig;
  combat: CombatConfig;
  network: NetworkConfig;
}
