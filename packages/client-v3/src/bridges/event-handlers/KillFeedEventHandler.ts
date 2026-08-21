import type { PlayerEliminatedMessage } from '@sector-battle/shared';
import type { AudioService } from '../../audio/AudioService.js';
import type { CameraService } from '../../rendering/CameraService.js';
import type { HUDManager } from '../../hud/HUDManager.js';
import type { PlayerRenderer } from '../../rendering/PlayerRenderer.js';
import type { StatusEffectRenderer } from '../../rendering/StatusEffectRenderer.js';
import type { StateSync } from '../../network/StateSync.js';

export class KillFeedEventHandler {
  constructor(
    private readonly myId: { value: string },
    private readonly freezeUntil: { value: number },
    private readonly onLocalKill: (() => void) | undefined,
    private readonly audio: AudioService,
    private readonly cameraService: CameraService,
    private readonly hud: HUDManager,
    private readonly playerRenderer: PlayerRenderer,
    private readonly statusEffects: StatusEffectRenderer,
    private readonly stateSync: StateSync,
    /**
     * Map-redesign ticket 03 (DEC-001) — resolves the victim's world
     * position to the server-authored POI name for the kill-feed location
     * tag ("eliminated at The Gilded Vault"). Optional (undefined on demo
     * maps / partial test harnesses) — entries simply omit the tag.
     */
    private readonly locatePoi?: (x: number, y: number) => string | undefined,
  ) {}

  handle(data: PlayerEliminatedMessage): void {
    const victimId = data.playerId ?? data.sessionId;
    const killerId = data.killedBy;
    const victimState = this.stateSync.getPlayer(victimId);
    const killerState = killerId ? this.stateSync.getPlayer(killerId) : undefined;
    this.playerRenderer.triggerDeath(victimId);
    this.statusEffects.removePlayer(victimId);
    // Elimination SFX — positional at the victim's location so nearby kills
    // are audible. The local killer/victim is at distance 0 → full volume.
    const vx = data.x ?? victimState?.x ?? 0;
    const vy = data.y ?? victimState?.y ?? 0;
    // Ticket 03 — kill-feed location tag: the victim's POI name, looked up
    // from the server-authored name grid (render-only; no text generation).
    this.hud.addKill({
      killerName: data.killerName ?? '???',
      victimName: data.playerName ?? '???',
      weaponType: typeof data.weapon === 'number' ? Math.max(0, data.weapon) : 0,
      timestamp: performance.now(),
      cause: data.cause ?? '',
      attackType: data.attackType,
      killerId,
      victimIsBot: !!victimState?.isBot,
      killerIsBot: !!killerState?.isBot,
      location: this.locatePoi?.(vx, vy),
    });
    if (data.killedBy === this.myId.value) {
      this.freezeUntil.value = performance.now() + 50;
      this.audio.playAt('player_kill', vx, vy);
      this.onLocalKill?.();
    } else {
      // Nearby remote kill — positional, quieter than the local killer cue.
      this.audio.playAt('player_kill', vx, vy, 0.3);
    }
    if (victimId === this.myId.value) {
      this.audio.playAt('player_death', vx, vy);
      this.cameraService.zoomDeath();
    }
  }
}
