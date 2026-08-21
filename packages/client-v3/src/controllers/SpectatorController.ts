import Phaser from 'phaser';
import { PlayerStatus, type SpectatorFollowTargetMessage } from '@sector-battle/shared';
import type { StateSync } from '../network/StateSync.js';
import type { MapRenderer } from '../rendering/MapRenderer.js';

export interface SpecKeys {
  Q: Phaser.Input.Keyboard.Key;
  E: Phaser.Input.Keyboard.Key;
  Space: Phaser.Input.Keyboard.Key;
  Esc: Phaser.Input.Keyboard.Key;
  W: Phaser.Input.Keyboard.Key;
  A: Phaser.Input.Keyboard.Key;
  S: Phaser.Input.Keyboard.Key;
  D: Phaser.Input.Keyboard.Key;
}

export class SpectatorController {
  spectateTarget = '';
  isSpectating = false;
  freeCamera = false;
  spectatedPlayers: string[] = [];
  spectateIndex = 0;

  constructor(private specKeys: SpecKeys) {}

  buildSpectatedPlayers(stateSync: StateSync): void {
    this.spectatedPlayers = [];
    for (const [id, p] of stateSync.getEntities().players) {
      // Must have ALIVE flag set — matches server's isActive getter.
      // Status is a direct assignment (not OR'd), so SPECTATING(4) or DYING(64)
      // do NOT include ALIVE(1). Only truly alive players are valid targets.
      if ((p.status & PlayerStatus.ALIVE) !== 0) {
        this.spectatedPlayers.push(id);
      }
    }
    this.spectatedPlayers.sort();
  }

  handleDeath(stateSync: StateSync): void {
    this.isSpectating = true;
    this.spectateIndex = 0;
    this.buildSpectatedPlayers(stateSync);
    // Immediately lock onto the first alive player so camera doesn't freeze
    // at death position while waiting for SpectatorFollowTarget from server.
    if (this.spectatedPlayers.length > 0) {
      this.spectateTarget = this.spectatedPlayers[0]!;
    } else {
      this.spectateTarget = '';
    }
  }

  handleRespawn(): void {
    this.isSpectating = false;
    this.freeCamera = false;
    this.spectatedPlayers = [];
    this.spectateIndex = 0;
    this.spectateTarget = '';
  }

  handleSpectatorFollow(data: SpectatorFollowTargetMessage, stateSync: StateSync): void {
    if (data?.targetId) {
      this.spectateTarget = data.targetId;
      this.buildSpectatedPlayers(stateSync);
      const idx = this.spectatedPlayers.indexOf(data.targetId);
      if (idx >= 0) this.spectateIndex = idx;
    }
  }

  update(
    dt: number,
    localX: number,
    localY: number,
    stateSync: StateSync,
    mapRenderer: MapRenderer,
  ): { x: number; y: number } {
    if (Phaser.Input.Keyboard.JustDown(this.specKeys.Q)) {
      this.buildSpectatedPlayers(stateSync);
      if (this.spectatedPlayers.length > 0) {
        this.spectateIndex =
          (this.spectateIndex - 1 + this.spectatedPlayers.length) % this.spectatedPlayers.length;
        this.spectateTarget = this.spectatedPlayers[this.spectateIndex]!;
        this.freeCamera = false;
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.specKeys.E)) {
      this.buildSpectatedPlayers(stateSync);
      if (this.spectatedPlayers.length > 0) {
        this.spectateIndex = (this.spectateIndex + 1) % this.spectatedPlayers.length;
        this.spectateTarget = this.spectatedPlayers[this.spectateIndex]!;
        this.freeCamera = false;
      }
    }
    if (Phaser.Input.Keyboard.JustDown(this.specKeys.Space)) {
      this.freeCamera = !this.freeCamera;
    }
    // ESC is no longer consumed here — GameScene owns the single ESC key and
    // routes it to the LeaveGameMenu (replaces the former instant-disconnect).

    // Follow chain: if current target died, auto-switch to next alive player.
    // Per GDD §12.7: "If the followed player dies, camera auto-switches to
    // the followed player's killer (follow chain)."
    // The server sends a new SpectatorFollowTarget for chain-following,
    // but we also handle it client-side to avoid camera freezing on death.
    if (this.spectateTarget && !this.freeCamera) {
      const target = stateSync.getPlayer(this.spectateTarget);
      if (!target || (target.status & PlayerStatus.ALIVE) === 0) {
        this.buildSpectatedPlayers(stateSync);
        if (this.spectatedPlayers.length > 0) {
          this.spectateTarget = this.spectatedPlayers[0]!;
          this.spectateIndex = 0;
        } else {
          this.spectateTarget = '';
        }
      }
    }

    if (this.freeCamera) {
      let fdx = 0,
        fdy = 0;
      if (this.specKeys.W.isDown) fdy -= 1;
      if (this.specKeys.S.isDown) fdy += 1;
      if (this.specKeys.A.isDown) fdx -= 1;
      if (this.specKeys.D.isDown) fdx += 1;
      const mapW = mapRenderer.getMapWidth();
      const mapH = mapRenderer.getMapHeight();
      localX = Phaser.Math.Clamp(localX + fdx * 500 * dt, 0, mapW);
      localY = Phaser.Math.Clamp(localY + fdy * 500 * dt, 0, mapH);
    } else if (this.spectateTarget) {
      const target = stateSync.getPlayer(this.spectateTarget);
      if (target) {
        localX = target.x;
        localY = target.y;
      }
    } else if (!this.spectateTarget && this.spectatedPlayers.length > 0) {
      this.spectateTarget = this.spectatedPlayers[0]!;
      this.spectateIndex = 0;
    }

    return { x: localX, y: localY };
  }
}
