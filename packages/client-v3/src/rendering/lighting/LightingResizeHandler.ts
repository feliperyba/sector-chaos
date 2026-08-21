/**
 * Resolution-resize handler for the lighting pipeline (extracted from
 * `LightingPipeline.ts` to respect the 450-line file-length lint cap).
 *
 * Ticket 08, hard constraint #4: on window/zoom resize the g-buffer + bloom RTs
 * are the wrong size; we destroy + recreate them (NOT in-place `setSize` — the
 * known prototype race where a resized RT's glTexture can briefly read null on
 * the next frame, breaking the Final filter's bloom sample). The scale manager
 * fires 'resize' once per settled size (debounced by Phaser), so the rebuild
 * runs at most ~once per user-initiated resize.
 *
 * ── Race-free ──
 *
 * The rebuild destroys + recreates the RT shaders in one synchronous pass
 * (between frames — Phaser's resize event never fires mid-render). The Final
 * controller's `bloomTexture` is reassigned on the NEXT `update()` call (the
 * very next frame); between the rebuild and that update, no `update()` runs,
 * so the stale glTexture references are never sampled. The rebuilt shader's
 * glTexture populates on its first display-list flush, which happens before
 * the next update. The Final controller's `useBloom` requires a non-null
 * `bloomTexture`, so a transiently-null texture simply disables bloom for zero
 * frames.
 *
 * The Final controller + camera setup are scene-scoped and survive the rebuild
 * (only the RT + shader stages are viewport-sized + need recreating).
 */
import Phaser from 'phaser';

/**
 * The RT + shader references the resize handler tears down. The pipeline
 * passes its live fields; this module never mutates them except to destroy
 * the objects they point at + null the fields.
 */
export interface ResizeStages {
  sobelShader: Phaser.GameObjects.Shader | undefined;
  hdrShader: Phaser.GameObjects.Shader | undefined;
  bloomBrightShader: Phaser.GameObjects.Shader | undefined;
  bloomHShader: Phaser.GameObjects.Shader | undefined;
  bloomVShader: Phaser.GameObjects.Shader | undefined;
  albedoRT: Phaser.GameObjects.RenderTexture | undefined;
}

/** The keys whose GL textures the rebuild must unregister before recreating. */
export const RESIZE_RT_KEYS = [
  '__albedoRT',
  '__normalsRT',
  '__litRT',
  '__bloomBright',
  '__bloomH',
  '__bloomVRT',
] as const;

/**
 * Tear down the RT + pipeline shader stages (NOT the Final controller, which
 * is owned by the camera's filter list, and NOT the camera setup). Best-effort
 * — cleanup errors are swallowed (a half-destroyed state still lets the
 * rebuild recreate fresh stages).
 */
export function destroyRtStages(scene: Phaser.Scene, stages: ResizeStages): void {
  stages.sobelShader?.destroy();
  stages.hdrShader?.destroy();
  stages.bloomBrightShader?.destroy();
  stages.bloomHShader?.destroy();
  stages.bloomVShader?.destroy();
  stages.albedoRT?.destroy();
  for (const k of RESIZE_RT_KEYS) {
    if (scene.textures.exists(k)) {
      try {
        scene.textures.remove(k);
      } catch {
        // best-effort cleanup
      }
    }
  }
}

/**
 * Bind the scale manager's resize event to `rebuild()` (a caller-supplied
 * callback that destroys + recreates the RT/shader stages). Returns an
 * `unbind()` that removes the listener (call on scene shutdown to prevent a
 * rebuild-after-shutdown leak).
 */
export function bindResize(scene: Phaser.Scene, rebuild: () => void): () => void {
  const onResize = (): void => {
    rebuild();
  };
  scene.scale.on('resize', onResize);
  const unbind = (): void => {
    scene.scale.off('resize', onResize);
  };
  // Auto-unbind on scene shutdown so a late resize event can't fire rebuild
  // after the pipeline is gone.
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, unbind);
  return unbind;
}
