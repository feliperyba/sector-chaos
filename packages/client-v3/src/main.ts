import Phaser from 'phaser';
import { MainMenuScene } from './scenes/MainMenuScene.js';
import { MatchmakingScene } from './scenes/MatchmakingScene.js';
import { GameScene } from './GameScene.js';
import { TransitionScene } from './ui/transitions/TransitionScene.js';
import { Logger } from '@sector-battle/shared';
import { FpsOverlay } from './debug/FpsOverlay.js';
import { applySoundSetting } from './settings/SettingsStore.js';

// Install window-level error/rejection capture before the game boots so
// errors during scene load are caught. Idempotent + server-safe.
Logger.installGlobalErrorCapture();

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1920,
  height: 1080,
  parent: 'game-container',
  backgroundColor: '#000814',
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
  // `preserveDrawingBuffer` is a significant per-frame render cost (it blocks
  // GPU buffer-discard optimizations — enough to drop a 60fps build toward
  // ~30fps on a mid machine; C5 frame-pacing root cause). It is ONLY needed
  // for canvas pixel readback (DebugBridge.captureScreenshot / headless
  // automation via toDataURL), so default it OFF and opt in with ?screenshot=1.
  // Live play never needs it.
  // render: {
  //   preserveDrawingBuffer: new URLSearchParams(window.location.search).get('screenshot') === '1',
  //   smoothPixelArt: true,
  //   roundPixels: true,
  // },
  // No fps cap — render at the display's native refresh rate. The fixed-timestep
  // prediction loop (PredictionService) accumulates real dt and runs SIM_TICK_DT
  // substeps, so it handles any render rate correctly (verified by the e2e
  // reconciliation loop at 60/150Hz — both produce ~BASE_SPEED with zero
  // snapbacks). Sub-tick interpolation (getVisualPosition = localPos +
  // velocity*accumulator) makes higher refresh rates SMOOTHER, not worse.
  // fps: {
  //   target: 60,
  //   limit: 60,
  // },
  disableContextMenu: true,
  scene: [MainMenuScene, MatchmakingScene, GameScene, TransitionScene],
};

const game = new Phaser.Game(config);

// Apply the persisted sound setting before any scene can start music. The
// READY event covers the DOM-not-yet-ready boot path; setMute is idempotent.
game.events.once(Phaser.Core.Events.READY, () => applySoundSetting(game));

// On-screen FPS / frame-pacing overlay (C5 diagnosis). Auto-on in DEV so it's
// visible while iterating; `?fps=0` disables, `?fps=1` forces on (e.g. prod).
// const fpsParam = new URLSearchParams(window.location.search).get('fps');
// const fpsEnabled = fpsParam === null ? import.meta.env.DEV : fpsParam !== '0';
// if (fpsEnabled) {
//   new FpsOverlay(game);
// }

// Expose for Playwright automation (headless testing)
(window as unknown as Record<string, unknown>).__PHASER_GAME__ = game;
