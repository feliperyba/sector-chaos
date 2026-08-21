import type { InputFrame } from '../types.js';
import type { PlayerState, WeaponState } from '../types.js';
import type { InputCollector } from '../input/InputCollector.js';
import { MatchPhase, weaponSlotAction } from '@sector-battle/shared';

export interface RuntimeGameControllerDeps {
  sendInput: (frame: InputFrame) => void;
  getPlayerState: () => PlayerState | undefined;
  getNextSeq: () => number;
  isConnected: () => boolean;
  inputCollector: InputCollector;
  getPhase: () => number;
}

export class RuntimeGameController {
  private seq: number;

  constructor(private deps: RuntimeGameControllerDeps) {
    this.seq = 0;
  }

  sendDirect(frame: InputFrame): InputFrame {
    const seq = this.deps.getNextSeq();
    const sent: InputFrame = { ...frame, sequence: seq };
    this.seq = seq;
    this.deps.sendInput(sent);
    return sent;
  }

  move(movementX: number, movementY: number, aimAngle: number): void {
    this.deps.inputCollector.injectFrame({
      movementX,
      movementY,
      aimAngle,
      sequence: 0,
      actions: [],
    });
  }

  attack(aimAngle: number, targetId?: string): void {
    this.deps.inputCollector.injectFrame({
      movementX: 0,
      movementY: 0,
      aimAngle,
      sequence: 0,
      actions: ['ATTACK'],
      targetId,
    });
  }

  dash(aimAngle?: number): void {
    this.deps.inputCollector.injectFrame({
      movementX: 0,
      movementY: 0,
      aimAngle: aimAngle ?? 0,
      sequence: 0,
      actions: ['DASH'],
    });
  }

  pickup(targetId?: string): void {
    this.deps.inputCollector.injectFrame({
      movementX: 0,
      movementY: 0,
      aimAngle: 0,
      sequence: 0,
      actions: ['PICKUP'],
      targetId,
    });
  }

  switchWeapon(slot: number): void {
    this.deps.inputCollector.injectFrame({
      movementX: 0,
      movementY: 0,
      aimAngle: 0,
      sequence: 0,
      actions: [weaponSlotAction(slot)],
    });
  }

  throwWeapon(aimAngle?: number): void {
    this.deps.inputCollector.injectFrame({
      movementX: 0,
      movementY: 0,
      aimAngle: aimAngle ?? 0,
      sequence: 0,
      actions: ['THROW'],
    });
  }

  moveContinuous(dx: number, dy: number, aimAngle: number, durationMs: number): void {
    this.deps.inputCollector.injectContinuous(
      {
        movementX: dx,
        movementY: dy,
        aimAngle,
        sequence: 0,
        actions: [],
      },
      durationMs,
    );
  }

  getPlayerState(): PlayerState | undefined {
    return this.deps.getPlayerState();
  }

  getPhase(): number {
    return this.deps.getPhase();
  }

  async waitForActive(timeoutMs: number = 15000): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (this.deps.getPhase() >= MatchPhase.ACTIVE) return true;
      await new Promise<void>((r) => setTimeout(r, 100));
    }
    return false;
  }

  getHealth(): number {
    return this.deps.getPlayerState()?.health ?? 0;
  }

  getPosition(): { x: number; y: number } {
    const p = this.deps.getPlayerState();
    return p ? { x: p.x, y: p.y } : { x: 0, y: 0 };
  }

  getWeapons(): WeaponState[] {
    return this.deps.getPlayerState()?.weapons ?? [];
  }

  async waitFor(
    predicate: (player: PlayerState) => boolean,
    timeoutMs: number = 5000,
  ): Promise<boolean> {
    const start = Date.now();
    let undefinedSince = start;

    while (Date.now() - start < timeoutMs) {
      const player = this.deps.getPlayerState();
      if (player === undefined) {
        if (Date.now() - undefinedSince > 1000) {
          throw new Error('Player not found (undefined for >1s)');
        }
      } else {
        undefinedSince = Infinity;
        if (predicate(player)) return true;
      }
      await new Promise<void>((r) => setTimeout(r, 50));
    }
    return false;
  }

  getStatus(): { seq: number; connected: boolean } {
    return { seq: this.seq, connected: this.deps.isConnected() };
  }
}
