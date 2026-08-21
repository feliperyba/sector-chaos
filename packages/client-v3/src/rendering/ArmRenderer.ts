import type { Vec2 } from '@sector-battle/shared';

export interface ArmJoints {
  leftShoulder: Vec2;
  leftElbow: Vec2;
  leftHand: Vec2;
  rightShoulder: Vec2;
  rightElbow: Vec2;
  rightHand: Vec2;
}

const ARM_THICKNESS = 6;
const ARM_OVERLAP = 2;
const ARM_DEPTH = 9;
const ARM_TEXTURE_W = 4;
const ARM_TEXTURE_H = 1;

/**
 * The 4 IK arm-segment sprites for ONE player. Owned by that player's
 * `PlayerRenderBundle` — created in `createPlayerRenderBundle`, destroyed in
 * `PlayerRenderer.destroyBundle`, both as part of the whole bundle. The
 * `ArmRenderer` itself keeps NO per-player map: it is a stateless geometry
 * helper operating on a sprite set, so an arm segment can never outlive the
 * bundle (and thus the body/hands/weapon/label) it belongs to.
 */
export interface PlayerArmSprites {
  leftUpper: Phaser.GameObjects.Sprite;
  leftForearm: Phaser.GameObjects.Sprite;
  rightUpper: Phaser.GameObjects.Sprite;
  rightForearm: Phaser.GameObjects.Sprite;
}

export class ArmRenderer {
  private scene: Phaser.Scene;
  private armTextureKey: string;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.armTextureKey = '__arm_segment';
    this.ensureTexture();
  }

  private ensureTexture(): void {
    if (!this.scene.textures.exists(this.armTextureKey)) {
      const canvas = this.scene.textures.createCanvas(
        this.armTextureKey,
        ARM_TEXTURE_W,
        ARM_TEXTURE_H,
      )!;
      const ctx = canvas.getContext();
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, ARM_TEXTURE_W, ARM_TEXTURE_H);
      canvas.refresh();
    }
  }

  /** Create the 4 arm-segment sprites for a NEW bundle (single-owner add path). */
  createArms(color: number): PlayerArmSprites {
    const create = (): Phaser.GameObjects.Sprite => {
      const sprite = this.scene.add.sprite(0, 0, this.armTextureKey);
      sprite.setOrigin(0.5, 0.5);
      sprite.setDepth(ARM_DEPTH);
      sprite.setTint(color);
      sprite.setVisible(true);
      return sprite;
    };

    return {
      leftUpper: create(),
      leftForearm: create(),
      rightUpper: create(),
      rightForearm: create(),
    };
  }

  /** Destroy the 4 arm-segment sprites (single-owner teardown path). */
  destroyArms(arms: PlayerArmSprites): void {
    arms.leftUpper.destroy();
    arms.leftForearm.destroy();
    arms.rightUpper.destroy();
    arms.rightForearm.destroy();
  }

  updateArms(arms: PlayerArmSprites, joints: ArmJoints): void {
    this.positionSegment(arms.leftUpper, joints.leftShoulder, joints.leftElbow);
    this.positionSegment(arms.leftForearm, joints.leftElbow, joints.leftHand);
    this.positionSegment(arms.rightUpper, joints.rightShoulder, joints.rightElbow);
    this.positionSegment(arms.rightForearm, joints.rightElbow, joints.rightHand);
  }

  setAlpha(arms: PlayerArmSprites, alpha: number): void {
    arms.leftUpper.setAlpha(alpha);
    arms.leftForearm.setAlpha(alpha);
    arms.rightUpper.setAlpha(alpha);
    arms.rightForearm.setAlpha(alpha);
  }

  setVisible(arms: PlayerArmSprites, visible: boolean): void {
    arms.leftUpper.setVisible(visible);
    arms.leftForearm.setVisible(visible);
    arms.rightUpper.setVisible(visible);
    arms.rightForearm.setVisible(visible);
  }

  /**
   * Collapse all arm segments onto a single point WITHOUT running the IK pose.
   *
   * The arm sprites are independent scene-root objects (NOT children of the
   * body), so when a player is view-culled their arms freeze at whatever world
   * coord `updateArms` last wrote — which, after a teleport, is the trap they
   * just left. Hiding them (`setVisible(false)`) makes that stale geometry
   * invisible, but any frame where the hide is missed (a re-show race, a stale
   * build, a one-shot writer) lets the frozen arms flash at the old spot.
   *
   * Pinning the segments to the live body every culled frame is defence-in-depth:
   * even if a hide is dropped, the arms sit on the body, never at a stale
   * location. Cheap — 4 `setPosition` calls, no atan2/sqrt/pose — so it does
   * not reintroduce the O(N) IK cost the cull exists to avoid. This is the
   * "UPDATE the arms position" half of the fix; the caller still hides them and
   * still skips the IK pose computation.
   */
  positionAtBody(arms: PlayerArmSprites, x: number, y: number): void {
    arms.leftUpper.setPosition(x, y);
    arms.leftForearm.setPosition(x, y);
    arms.rightUpper.setPosition(x, y);
    arms.rightForearm.setPosition(x, y);
  }

  setTint(arms: PlayerArmSprites, color: number): void {
    arms.leftUpper.setTint(color);
    arms.leftForearm.setTint(color);
    arms.rightUpper.setTint(color);
    arms.rightForearm.setTint(color);
  }

  private positionSegment(sprite: Phaser.GameObjects.Sprite, start: Vec2, end: Vec2): void {
    const midX = (start.x + end.x) / 2;
    const midY = (start.y + end.y) / 2;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = Math.atan2(dy, dx);
    const length = Math.sqrt(dx * dx + dy * dy);

    sprite.setPosition(midX, midY);
    sprite.setRotation(angle);
    sprite.setDisplaySize(length + ARM_OVERLAP, ARM_THICKNESS);
  }
}
