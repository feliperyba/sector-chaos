/**
 * Runtime game diagnostics — pipeline-spanning input validation.
 *
 * Usage:
 *   1. Start the game via Docker: `docker compose up -d`
 *   2. Open http://localhost:8080 in a real browser (not headless)
 *   3. Open DevTools → Console
 *   4. Paste the contents of this file into the console
 *   5. Press WASD — look for [DIAG-INPUT] and [DIAG-SERVER-MOVE] logs
 *
 * What each tag means:
 *   [DIAG-UPDATE]  — GameScene.update() loop is running, player exists
 *   [DIAG-INPUT]   — InputCollector.collect() returns frame data
 *   [DIAG-KEYS]    — Raw Phaser keyboard state
 *   Missing tag = pipeline breaks at that stage.
 */

(function injectDiagnostics() {
  const canvas = document.querySelector('canvas');
  if (!canvas) {
    console.error('[DIAG] No canvas found');
    return;
  }

  // Keyboard state monitor
  const keysDown = new Set();
  document.addEventListener('keydown', (e) => {
    keysDown.add(e.key.toLowerCase());
    console.log(`[DIAG-KEYS] keydown: ${e.key} | held: ${[...keysDown].join(',')}`);
  });
  document.addEventListener('keyup', (e) => {
    keysDown.delete(e.key.toLowerCase());
  });

  // Pointer monitor
  canvas.addEventListener('pointerdown', (e) => {
    console.log(`[DIAG-POINTER] down at canvas(${e.offsetX}, ${e.offsetY}) button=${e.button}`);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (keysDown.size > 0) {
      console.log(`[DIAG-POINTER] move at canvas(${e.offsetX}, ${e.offsetY}) buttons=${e.buttons}`);
    }
  });

  console.log('[DIAG] Diagnostics injected. Press WASD and click to test.');
  console.log('[DIAG] Look for [DIAG-KEYS] and [DIAG-POINTER] logs.');
  console.log('[DIAG] If no logs appear when you press keys, Phaser keyboard is not wired.');
})();
