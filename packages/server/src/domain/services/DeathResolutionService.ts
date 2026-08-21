import { COMBAT, WeaponType } from '@sector-battle/shared';
import type { Player, DamageSource } from '../entities/index.ts';
import type { GameEvent } from '../events/index.ts';

const TICKS_PER_SECOND = 60;
const DEATH_ANIMATION_TICKS = Math.round(COMBAT.DEATH_ANIMATION_DURATION * TICKS_PER_SECOND);

export interface DeathResolutionResult {
  eliminatedPlayerIds: string[];
  spectatingTransitions: Array<{ playerId: string; killerId: string | null }>;
}

export interface DeathResolutionContext {
  emitEvent(event: GameEvent): void;
  getPlayerName(id: string): string;
  getAliveCount(): number;
  hasPlayer(id: string): boolean;
  markPlayerDead(playerId: string): void;
}

export class DeathResolutionService {
  processDeaths(
    players: Map<string, Player>,
    currentTick: number,
    alreadyEliminated: ReadonlySet<string>,
    ctx: DeathResolutionContext,
  ): DeathResolutionResult {
    const eliminatedPlayerIds: string[] = [];
    const spectatingTransitions: Array<{ playerId: string; killerId: string | null }> = [];

    for (const player of players.values()) {
      if (player.health.isDead && !player.isDying() && player.isActive) {
        player.dieWithTick(currentTick);
        ctx.markPlayerDead(player.id);
        if (!alreadyEliminated.has(player.id)) {
          this.emitKillFeed(player, currentTick, ctx);
        }
        eliminatedPlayerIds.push(player.id);
      }
    }

    for (const player of players.values()) {
      if (
        player.isDying() &&
        player.statusEffects.deathTick >= 0 &&
        currentTick - player.statusEffects.deathTick >= DEATH_ANIMATION_TICKS
      ) {
        player.completeDeath();
        const killerId = this.resolveFollowTarget(
          player.statusEffects.lastDamageSource,
          player.id,
          ctx,
        );
        this.emitSpectatingTransition(player, killerId, currentTick, ctx);
        spectatingTransitions.push({ playerId: player.id, killerId });
      }
    }

    return { eliminatedPlayerIds, spectatingTransitions };
  }

  private emitKillFeed(player: Player, currentTick: number, ctx: DeathResolutionContext): void {
    const source = player.statusEffects.lastDamageSource;
    const cause = this.resolveCause(source, player.id, ctx);
    const killerId = this.resolveKillerId(source, ctx);
    const killerName = killerId ? ctx.getPlayerName(killerId) : '';
    const weapon = (source?.weaponType as unknown as WeaponType) ?? WeaponType.FISTS;

    ctx.emitEvent({
      type: 'PlayerEliminated',
      tick: currentTick,
      timestamp: Date.now(),
      playerId: player.id,
      playerName: player.name,
      killedBy: killerId,
      killerName,
      placement: ctx.getAliveCount(),
      weapon,
      x: player.movement.position.x,
      y: player.movement.position.y,
      cause,
    });
  }

  private resolveCause(
    source: DamageSource | null,
    playerId: string,
    ctx: DeathResolutionContext,
  ): string {
    if (!source) return 'unknown';
    if (source.playerId === playerId && source.weaponType) return 'self_thrown';
    if (source.playerId === 'zone') return 'zone';
    if (source.playerId && !ctx.hasPlayer(source.playerId)) return 'trap_damage';
    if (source.weaponType) return source.weaponType;
    return 'unknown';
  }

  private resolveKillerId(source: DamageSource | null, ctx: DeathResolutionContext): string {
    if (!source) return '';
    if (ctx.hasPlayer(source.playerId)) return source.playerId;
    return '';
  }

  private resolveFollowTarget(
    source: DamageSource | null,
    playerId: string,
    ctx: DeathResolutionContext,
  ): string | null {
    if (!source) return null;
    if (source.playerId === playerId) return null;
    if (ctx.hasPlayer(source.playerId)) return source.playerId;
    return null;
  }

  private emitSpectatingTransition(
    player: Player,
    killerId: string | null,
    currentTick: number,
    ctx: DeathResolutionContext,
  ): void {
    ctx.emitEvent({
      type: 'SpectatingTransition',
      tick: currentTick,
      timestamp: Date.now(),
      playerId: player.id,
      killerId,
      cameraZoomFactor: COMBAT.DEATH_CAMERA_ZOOM_FACTOR,
      cameraZoomDuration: COMBAT.DEATH_CAMERA_ZOOM,
    });
  }
}
