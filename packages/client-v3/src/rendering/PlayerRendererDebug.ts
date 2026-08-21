/**
 * PlayerRendererDebug — the lingering-arms diagnostic dump (Bug 2).
 *
 * Mechanical extraction from PlayerRenderer.ts (max-lines cap): the
 * `__debugArmLeak` body is verbatim, `this.bundles` / `this.localPlayerId` →
 * parameters. The inline return type becomes the exported
 * {@link ArmLeakSnapshot} so the class delegate keeps an identical signature.
 */
import type Phaser from 'phaser';
import type { PlayerRenderBundle } from './PlayerRendererTypes.js';

export interface ArmLeakSnapshot {
  orphanArmKeys: string[];
  visualKeys: Array<{
    key: string;
    isLocal: boolean;
    bodyVisible: boolean;
    bodyAlpha: number;
    bodyX: number;
    bodyY: number;
    culled: boolean;
    phase: number | undefined;
    deathProgress: number | undefined;
  }>;
  armState: Array<{
    key: string;
    anyVisible: boolean;
    maxAlpha: number;
    segments: Array<{ x: number; y: number; visible: boolean; alpha: number }>;
  }>;
}

/**
 * DEBUG (Bug 2 — lingering arms): diagnose arm-sprite visibility state.
 * With the single-owner bundle, `orphanArmKeys` is structurally empty — arm
 * segments are fields of the same object as the body, so they cannot outlive
 * it. The field is kept (always []) so the `window.__SECTO_ARMS_DUMP` output
 * shape is unchanged for live captures; it now serves as the single
 * assertion of the bundle invariant.
 */
export function debugArmLeak(
  bundles: Map<string, PlayerRenderBundle>,
  localPlayerId: string | null,
): ArmLeakSnapshot {
  const visualKeys: Array<{
    key: string;
    isLocal: boolean;
    bodyVisible: boolean;
    bodyAlpha: number;
    bodyX: number;
    bodyY: number;
    culled: boolean;
    phase: number | undefined;
    deathProgress: number | undefined;
  }> = [];
  const armState: Array<{
    key: string;
    anyVisible: boolean;
    maxAlpha: number;
    segments: Array<{ x: number; y: number; visible: boolean; alpha: number }>;
  }> = [];
  for (const [key, bundle] of bundles) {
    const driver = bundle.driver;
    const v = bundle.visual;
    const body = v.body as unknown as { visible: boolean; alpha: number; x: number; y: number };
    visualKeys.push({
      key,
      isLocal: key === localPlayerId,
      bodyVisible: body.visible,
      bodyAlpha: body.alpha,
      bodyX: body.x,
      bodyY: body.y,
      culled: v.culled,
      phase: driver.phase,
      deathProgress: driver.deathProgress,
    });
    const segs = [
      bundle.arms.leftUpper,
      bundle.arms.leftForearm,
      bundle.arms.rightUpper,
      bundle.arms.rightForearm,
    ].map((g) => {
      const sprite = g as unknown as Phaser.GameObjects.Sprite & {
        visible: boolean;
        alpha: number;
        x: number;
        y: number;
      };
      return { x: sprite.x, y: sprite.y, visible: sprite.visible, alpha: sprite.alpha };
    });
    armState.push({
      key,
      anyVisible: segs.some((sg) => sg.visible),
      maxAlpha: Math.max(...segs.map((sg) => sg.alpha)),
      segments: segs,
    });
  }
  return { orphanArmKeys: [], visualKeys, armState };
}
