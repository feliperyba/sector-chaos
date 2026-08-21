import type Phaser from 'phaser';
import { SCENE_KEYS } from './TransitionConfig.js';
import type { TransitionScene } from './TransitionScene.js';

export class SceneNavigator {
  private scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  transitionTo(targetKey: string, data?: object, scenesToStop?: string[]): void {
    const ts = this.getTransitionScene();
    if (!ts) return;

    if (!this.scene.scene.isActive(SCENE_KEYS.TRANSITION)) {
      this.scene.scene.launch(SCENE_KEYS.TRANSITION);
      this.scene.time.delayedCall(1, () => {
        const launchedTs = this.getTransitionScene();
        if (launchedTs) {
          launchedTs.startTransition(targetKey, data, scenesToStop);
          this.scene.scene.bringToTop(SCENE_KEYS.TRANSITION);
        }
      });
    } else {
      ts.startTransition(targetKey, data, scenesToStop);
      this.scene.scene.bringToTop(SCENE_KEYS.TRANSITION);
    }
  }

  goBack(targetKey: string): void {
    this.scene.scene.start(targetKey);
  }

  private getTransitionScene(): TransitionScene | null {
    const scene = this.scene.scene.get(SCENE_KEYS.TRANSITION);
    if (scene && 'startTransition' in scene && 'requestReveal' in scene) {
      return scene as TransitionScene;
    }
    return null;
  }

  static requestReveal(scene: Phaser.Scene): void {
    const ts = scene.scene.get(SCENE_KEYS.TRANSITION);
    if (
      ts &&
      'requestReveal' in ts &&
      'isTransitioning' in ts &&
      typeof (ts as TransitionScene).isTransitioning === 'function' &&
      (ts as TransitionScene).isTransitioning()
    ) {
      (ts as TransitionScene).requestReveal();
    }
  }
}
