import type Phaser from 'phaser';
import type { SharedAudioService } from '../../audio/SharedAudioService.js';
import type { MenuEntranceChoreographer } from '../animations/MenuEntranceChoreographer.js';
import type { SceneNavigator } from '../transitions/SceneNavigator.js';

export class MenuDirector {
  private scene: Phaser.Scene;
  private audio: SharedAudioService;
  private choreographer: MenuEntranceChoreographer | null;
  private interactive = false;
  private destroyed = false;
  private onEntranceComplete: (() => void) | null;

  constructor(deps: {
    scene: Phaser.Scene;
    audio: SharedAudioService;
    choreographer: MenuEntranceChoreographer | null;
    onEntranceComplete?: () => void;
  }) {
    this.scene = deps.scene;
    this.audio = deps.audio;
    this.choreographer = deps.choreographer;
    this.onEntranceComplete = deps.onEntranceComplete ?? null;
  }

  start(): void {
    if (this.destroyed) return;

    this.audio.unlockAudioContext();
    this.audio.playMusic('menu');
    this.interactive = true;

    if (this.choreographer) {
      this.scheduleEntranceComplete();
    } else {
      this.onEntranceComplete?.();
    }
  }

  private scheduleEntranceComplete(): void {
    const totalMs = 2000;
    this.scene.time.delayedCall(totalMs, () => {
      if (!this.destroyed) {
        this.onEntranceComplete?.();
      }
    });
  }

  transitionToScene(sceneKey: string, navigator: SceneNavigator, data?: object): void {
    if (!this.interactive || this.destroyed) return;

    this.interactive = false;
    this.audio.stopMusic(500);

    this.scene.time.delayedCall(100, () => {
      navigator.transitionTo(sceneKey, data);
    });
  }

  isMenuInteractive(): boolean {
    return this.interactive;
  }

  update(time: number, delta: number): void {
    if (this.destroyed) return;
    this.choreographer?.update(time, delta);
  }

  destroy(): void {
    this.destroyed = true;
    this.interactive = false;
    this.choreographer?.dispose();
    this.choreographer = null;
    this.onEntranceComplete = null;
  }
}
