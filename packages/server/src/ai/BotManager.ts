import type { GameOrchestrator } from '../application/services/GameOrchestrator.ts';
import type { BotSystem } from './BotSystem.ts';
import { simRandom } from '../domain/shared/SimRandom.ts';
import {
  drawDifficultyFromMix,
  mmrBandFromAverage,
  MMR_DIFFICULTY_MIX,
  type DifficultyWeight,
} from './skill/BotDifficultyTables.ts';

export type DifficultyLevel = 'easy' | 'normal' | 'medium' | 'hard' | 'elite';

interface Delayed {
  clear(): void;
}

interface RoomClock {
  setInterval(callback: () => void, ms: number): Delayed;
}

export class BotManager {
  private botIds: Set<string> = new Set();
  private botNames: Map<string, string> = new Map();
  private usedNames: Set<string> = new Set();
  private botSystem: BotSystem | null = null;
  private namePool: string[];

  private defaultDifficulty: DifficultyLevel = 'medium';
  private averageMmr: number | undefined;
  /** Bench-only pinned mix (see setDifficultyMixOverride). Null = production. */
  private difficultyMixOverride: readonly DifficultyWeight[] | null = null;
  private spawnTimers: Array<{ ref: unknown; clear: () => void }> = [];

  constructor() {
    this.namePool = shuffleArray([...BOT_NAMES]);
  }

  setBotSystem(botSystem: BotSystem): void {
    this.botSystem = botSystem;
    // Forward the current difficulty so newly-registered bots get the right
    // personality skill knobs. BotSystem.setDefaultDifficulty is the long-dead
    // plumbing finally made live by the intent layer.
    botSystem.setDefaultDifficulty(this.defaultDifficulty);
  }

  getBotCount(): number {
    return this.botIds.size;
  }

  hasBot(playerId: string): boolean {
    return this.botIds.has(playerId);
  }

  /** Returns the set of all bot session IDs for fast membership checks. */
  getBotSessionIds(): Set<string> {
    return this.botIds;
  }

  setDifficulty(difficulty: DifficultyLevel): void {
    this.defaultDifficulty = difficulty;
    // Forward live so difficulty changes mid-room (e.g. dev/test) apply to
    // subsequently-spawned bots. Already-registered bots keep their original
    // profile (deterministic from spawn-time difficulty by design).
    this.botSystem?.setDefaultDifficulty(difficulty);
  }

  setAverageMmr(mmr: number | undefined): void {
    this.averageMmr = mmr;
  }

  /**
   * Pin the difficulty MIX for subsequently spawned bots (bot-ai-v2 ticket
   * 08, DEC-009.1). The benchmark harness pins {@linkcode BENCH_WIDE_MIX} on
   * all-bot lobbies so believability is measured across the full tier range;
   * `null` restores the production path (MMR distribution → room-wide
   * default). Never called by production code.
   */
  setDifficultyMixOverride(mix: readonly DifficultyWeight[] | null): void {
    this.difficultyMixOverride = mix;
  }

  /**
   * PER-BOT DIFFICULTY ASSIGNMENT (bot-ai-v2 ticket 08 — the GDD §14.6
   * implementation; `averageMmr` finally READ, AUDIT §9.13):
   *  - mix override (bench only) → weighted draw from the pinned mix;
   *  - lobby MMR present → the band's GDD §14.6 distribution (low 70/20/10,
   *    mid 20/60/20, high 10/20/70 Easy/Medium/Hard);
   *  - no MMR data → `null` — the caller falls back to the room-wide
   *    defaultDifficulty (the GDD "all bots receive `normal`" default, an
   *    explicit setter that remains the fallback) WITHOUT drawing.
   *
   * The roll comes from the ROOM'S seeded stream (`simRandom`, site tag
   * 'bot-difficulty' — the same stream convention as the bot-name pool):
   * Math.random in production, deterministic under the benchmark's seeded
   * override, one draw per assigned bot in spawn order.
   */
  private drawBotDifficulty(): DifficultyLevel | null {
    if (this.difficultyMixOverride) {
      return drawDifficultyFromMix(this.difficultyMixOverride, simRandom('bot-difficulty'));
    }
    const band = mmrBandFromAverage(this.averageMmr);
    if (band !== null) {
      return drawDifficultyFromMix(MMR_DIFFICULTY_MIX[band], simRandom('bot-difficulty'));
    }
    return null;
  }

  spawnBots(
    orchestrator: GameOrchestrator,
    _realPlayerCount: number,
    maxPlayers: number,
    clock?: RoomClock,
  ): void {
    const botsNeeded = maxPlayers - this.botIds.size;
    if (botsNeeded <= 0) return;
    if (!this.botSystem) return;

    const spawnInterval = 5000 / botsNeeded;
    let spawned = 0;

    const entry: { ref: unknown; clear: () => void } = { ref: null, clear: () => {} };

    const spawnTick = () => {
      if (spawned >= botsNeeded) {
        entry.clear();
        const idx = this.spawnTimers.indexOf(entry);
        if (idx !== -1) this.spawnTimers.splice(idx, 1);
        return;
      }

      const index = Date.now();
      const sessionId = `bot_${index}_${spawned}`;
      const name = this.getNextBotName();

      const added = orchestrator.addPlayer(sessionId, name);
      if (!added) {
        this.releaseName(name);
        spawned++;
        return;
      }

      const player = orchestrator.getPlayer(sessionId);
      if (player) {
        player.isBot = true;
      }

      this.botSystem!.registerBot(sessionId, this.drawBotDifficulty() ?? undefined);

      this.botIds.add(sessionId);
      this.botNames.set(sessionId, name);
      spawned++;
    };

    if (clock) {
      entry.ref = clock.setInterval(spawnTick, spawnInterval);
      entry.clear = () => (entry.ref as Delayed).clear();
    } else {
      entry.ref = setInterval(spawnTick, spawnInterval);
      entry.clear = () => clearInterval(entry.ref as ReturnType<typeof setInterval>);
    }

    this.spawnTimers.push(entry);
  }

  /**
   * Synchronously spawn all bots in a single call (no setInterval trickle).
   * Used by the benchmark harness to eliminate spawn-timing non-determinism.
   * All bots are registered on the same tick with deterministic IDs based on
   * a provided base timestamp, producing reproducible benchmark results.
   *
   * If any bots were already partially spawned by the interval-based spawner
   * (which may fire once or twice during room creation before this method is
   * called), they are removed first to ensure a clean deterministic state.
   */
  spawnAllBotsSync(
    orchestrator: GameOrchestrator,
    maxPlayers: number,
    baseTimestamp: number,
  ): number {
    if (!this.botSystem) return 0;

    // Clear any pending interval-based spawns.
    for (const entry of this.spawnTimers) {
      entry.clear();
    }
    this.spawnTimers.length = 0;

    // Remove any bots that were already spawned by the interval before we got
    // here. This ensures ALL bots have deterministic IDs from baseTimestamp. We
    // HARD-remove them (not just soft-removePlayer) because GameMatch.removePlayer
    // leaves the player in the map for stats, which still counts toward the
    // MAX_PLAYERS join cap — without the hard purge, a full botFillTo ==
    // maxPlayers request can't fill every slot (the stale interval bot blocks it).
    const matchForPurge = (
      orchestrator as unknown as {
        getMatch?: () => { hardRemovePlayerForBenchmark?: (id: string) => void };
      }
    ).getMatch?.();
    for (const botId of this.botIds) {
      this.botSystem.unregisterBot(botId);
      orchestrator.removePlayer(botId);
      matchForPurge?.hardRemovePlayerForBenchmark?.(botId);
      this.botIds.delete(botId);
      const name = this.botNames.get(botId);
      this.botNames.delete(botId);
      if (name) this.releaseName(name);
    }

    let spawned = 0;
    for (let i = 0; i < maxPlayers; i++) {
      const sessionId = `bot_${baseTimestamp}_${i}`;
      const name = this.getNextBotName();

      const added = orchestrator.addPlayer(sessionId, name);
      if (!added) {
        this.releaseName(name);
        continue;
      }

      const player = orchestrator.getPlayer(sessionId);
      if (player) {
        player.isBot = true;
      }

      this.botSystem!.registerBot(sessionId, this.drawBotDifficulty() ?? undefined);
      this.botIds.add(sessionId);
      this.botNames.set(sessionId, name);
      spawned++;
    }
    return spawned;
  }

  removeBotForRealPlayer(orchestrator: GameOrchestrator): void {
    if (this.botIds.size === 0) return;

    const matchState = orchestrator.getMatchState();
    let targetId: string | null = null;

    const realPlayers = [...matchState.players.entries()].filter(([id]) => !this.botIds.has(id));

    if (realPlayers.length > 0) {
      let maxMinDist = -Infinity;
      for (const botId of this.botIds) {
        const botPlayer = matchState.players.get(botId);
        if (!botPlayer) continue;

        let minDist = Infinity;
        for (const [, real] of realPlayers) {
          const dx = botPlayer.movement.position.x - real.movement.position.x;
          const dy = botPlayer.movement.position.y - real.movement.position.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < minDist) minDist = dist;
        }

        if (minDist > maxMinDist) {
          maxMinDist = minDist;
          targetId = botId;
        }
      }
    }

    if (targetId === null) {
      for (const id of this.botIds) {
        targetId = id;
        break;
      }
    }

    if (targetId === null) return;

    this.botSystem?.unregisterBot(targetId);
    orchestrator.removePlayer(targetId);

    this.botIds.delete(targetId);

    const botName = this.botNames.get(targetId);
    this.botNames.delete(targetId);
    if (botName) {
      this.releaseName(botName);
    }
  }

  takeoverPlayer(orchestrator: GameOrchestrator, playerId: string): void {
    const player = orchestrator.getPlayer(playerId);
    if (!player || !player.isActive) return;

    if (!this.botSystem) return;

    player.isBot = true;
    this.botSystem.registerBot(playerId, this.drawBotDifficulty() ?? undefined);

    this.botIds.add(playerId);
    const name = player.name;
    this.botNames.set(playerId, name);
    this.usedNames.add(name);
  }

  dispose(): void {
    for (const entry of this.spawnTimers) {
      entry.clear();
    }
    this.spawnTimers = [];

    if (this.botSystem) {
      this.botSystem.dispose();
    }
    this.botIds.clear();
    this.botNames.clear();
    this.usedNames.clear();
  }

  private getNextBotName(): string {
    if (this.namePool.length === 0) {
      this.namePool = shuffleArray([...BOT_NAMES]);
    }
    let name: string;
    do {
      name = this.namePool.pop()!;
    } while (this.usedNames.has(name) && this.namePool.length > 0);
    if (this.usedNames.has(name)) {
      name = `Player_${Math.floor(simRandom('bot-name-fallback') * 9999)
        .toString()
        .padStart(4, '0')}`;
    }
    this.usedNames.add(name);
    return name;
  }

  private releaseName(name: string): void {
    this.usedNames.delete(name);
  }
}

const BOT_NAMES = [
  'xXDarkSlayer99Xx',
  'SniperWolf_',
  'NoobMaster69',
  'x_Shadow_x',
  'NightHawk',
  'PixelStorm',
  'VoidWalker_',
  'BlazeFury',
  'IronClad_',
  'GhostRider',
  'ThunderBolt_',
  'StormBreaker',
  'PhantomAce',
  'CyberNinja_',
  'FrostByte',
  'DragonFist_',
  'NovaStar',
  'SilverBullet',
  'RapidFire_',
  'SteelNerve',
  'ArcticWolf_',
  'VenomStrike',
  'EchoChamber',
  'TitanForge_',
  'MaverickX',
  'ZeroGravity_',
  'CrimsonBlade',
  'NeonPulse_',
  'QuantumLeap',
  'WarpDrive_',
  'ShadowStrike_',
  'BlitzKrieg',
  'OmegaForce_',
  'Predator_X',
  'LaserHawk_',
  'StealthMode_',
  'ChaosEngine',
  'VortexKing_',
  'PyroManiac',
  'IceBreaker_',
  'RogueAgent_',
  'BattleMage',
  'DeathWish_',
  'SonicBoom',
  'HyperDrive_',
  'Crosshair_',
  'WarMachine',
  'FatalError_',
  'ToxicRain',
  'Blackout__',
  'Reaper_Grim',
  'SkyRider_',
  'BoneCrusher',
  'WildFire_',
  'DeepFreeze_',
  'NuclearWinter',
  'MadMax___',
  'CherryBomb_',
  'SilentKill',
  'AlphaWolf_',
];

function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(simRandom('bot-name-shuffle') * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}
