import Phaser from 'phaser';
import type { WeaponState } from '../types.js';
import { WEAPON_SPRITE_MAP } from '../types.js';
import { DesignTokens } from '../ui/DesignTokens.js';
import { ComponentConfig } from '../ui/ComponentConfig.js';
import { Label } from '../ui/components/Label.js';
import { ProgressBar } from '../ui/components/ProgressBar.js';
import { Panel } from '../ui/components/Panel.js';

// ---------------------------------------------------------------------------
// SpectatorHUD — Full spectator panel (health, weapons, controls)
// ---------------------------------------------------------------------------

export class SpectatorHUD {
  private scene: Phaser.Scene;
  private specPanel: Panel | null = null;
  private specLabel!: Label;
  private specNameLabel!: Label;
  private specHealthBar!: ProgressBar;
  private specHealthLabel!: Label;
  private specSlotBgs: Phaser.GameObjects.NineSlice[] = [];
  private specSlotIcons: (Phaser.GameObjects.Sprite | null)[] = [null, null, null, null];
  private specControlsLabel!: Label;
  private specVisible = false;
  /** Slot row Y — captured in create() so show() can place lazily-created icons. */
  private _slotY = 0;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.create();
  }

  private create(): void {
    const { width, height } = this.scene.scale;
    const spc = ComponentConfig.spectator;

    // Bottom-anchored layout. The personal HUD widgets the spectator HUD
    // replaces (health/dash/inventory) live at bottom-center and are hidden
    // during spectate (HUDManager.setSpectating), so this is a symmetric swap.
    // Top-center is occupied by the match-state widgets (timer/phase/alive)
    // which stay visible while spectating — placing the spectator HUD there
    // caused a vertical collision with the timer (issue: HUD overlap).
    const panelY = height - 80; // panel center → spans height-120..height-40
    const labelY = panelY - spc.height / 2 - DesignTokens.spacing.sm; // caption above panel
    const nameY = panelY - spc.height / 2 + DesignTokens.spacing.md; // top row inside panel
    const healthY = panelY; // middle row inside panel
    const slotY = panelY + spc.height / 2 - DesignTokens.spacing.md; // bottom row inside panel
    const controlsY = height - DesignTokens.spacing.md; // hint pinned to bottom edge
    this._slotY = slotY;

    this.specPanel = new Panel(this.scene, width / 2, panelY, {
      width: spc.width,
      height: spc.height,
      variant: 'transparent',
    });
    this.specPanel.setDepth(DesignTokens.depth.spectatorBg);
    this.specPanel.setScrollFactor(0);
    this.specPanel.setVisible(false);

    this.specLabel = new Label(this.scene, width / 2, labelY, {
      text: 'SPECTATING',
      variant: 'caption',
      color: DesignTokens.colors.amber,
      align: 'center',
      stroke: true,
    });
    this.specLabel.setDepth(DesignTokens.depth.spectatorContent);
    this.specLabel.setScrollFactor(0);
    this.specLabel.setVisible(false);
    const sLabel = this.specLabel.getAt(0) as Phaser.GameObjects.Text;
    sLabel.setOrigin(0.5, 0.5);

    this.specNameLabel = new Label(this.scene, width / 2, nameY, {
      text: '',
      variant: 'body',
      color: DesignTokens.colors.ink,
      align: 'center',
      stroke: true,
    });
    this.specNameLabel.setDepth(DesignTokens.depth.spectatorContent);
    this.specNameLabel.setScrollFactor(0);
    this.specNameLabel.setVisible(false);
    const sName = this.specNameLabel.getAt(0) as Phaser.GameObjects.Text;
    sName.setOrigin(0.5, 0.5);

    this.specHealthBar = new ProgressBar(this.scene, width / 2 - spc.healthBar.width / 2, healthY, {
      width: spc.healthBar.width,
      height: spc.healthBar.height,
      fillColor: DesignTokens.colors.positive,
      trackColor: DesignTokens.colors.surfaceDark,
      animated: false,
      gradient: true,
    });
    this.specHealthBar.setDepth(DesignTokens.depth.spectatorContent);
    this.specHealthBar.setScrollFactor(0);
    this.specHealthBar.setVisible(false);

    this.specHealthLabel = new Label(this.scene, width / 2, healthY, {
      text: '',
      variant: 'caption',
      color: DesignTokens.colors.ink,
      align: 'center',
      stroke: true,
    });
    this.specHealthLabel.setDepth(DesignTokens.depth.spectatorContent + 1);
    this.specHealthLabel.setScrollFactor(0);
    this.specHealthLabel.setVisible(false);
    const shLabel = this.specHealthLabel.getAt(0) as Phaser.GameObjects.Text;
    shLabel.setOrigin(0.5, 0.5);

    const slotStartX = width / 2 - ((4 - 1) * spc.slotGap) / 2;
    const slotInset = DesignTokens.nineSlice.panel;
    for (let i = 0; i < 4; i++) {
      const slot = this.scene.add.nineslice(
        slotStartX + i * spc.slotGap,
        slotY,
        'ui',
        'panel',
        spc.slotSize,
        spc.slotSize,
        slotInset.left,
        slotInset.right,
        slotInset.top,
        slotInset.bottom,
      );
      slot.setTint(DesignTokens.colors.darkestGray);
      slot.setDepth(DesignTokens.depth.spectatorContent);
      slot.setScrollFactor(0);
      slot.setOrigin(0.5);
      slot.setVisible(false);
      this.specSlotBgs.push(slot);
    }

    this.specControlsLabel = new Label(this.scene, width / 2, controlsY, {
      text: 'Q/E: Switch Player | SPACE: Free Camera | ESC: Menu',
      variant: 'caption',
      color: DesignTokens.colors.lighterGray,
      align: 'center',
      stroke: true,
    });
    this.specControlsLabel.setDepth(DesignTokens.depth.spectatorContent);
    this.specControlsLabel.setScrollFactor(0);
    this.specControlsLabel.setVisible(false);
    const scLabel = this.specControlsLabel.getAt(0) as Phaser.GameObjects.Text;
    scLabel.setOrigin(0.5, 0.5);
  }

  // -----------------------------------------------------------------------
  // Spectator HUD API
  // -----------------------------------------------------------------------

  show(
    playerName: string,
    health: number,
    maxHealth: number,
    weapons: WeaponState[],
    activeSlot: number,
    barrierActive = false,
    speedBoostActive = false,
  ): void {
    this.specVisible = true;
    this.specPanel?.setVisible(true);
    this.specLabel.setVisible(true);
    this.specControlsLabel.setVisible(true);

    if (playerName === 'FREE CAMERA') {
      this.specNameLabel.setText('FREE CAMERA');
      this.specNameLabel.setVisible(true);
      this.specHealthBar.setVisible(false);
      this.specHealthLabel.setVisible(false);
      for (const bg of this.specSlotBgs) bg.setVisible(false);
      for (const icon of this.specSlotIcons) {
        if (icon) icon.setVisible(false);
      }
      return;
    }

    this.specNameLabel.setText(
      playerName + (barrierActive ? ' [BARRIER]' : '') + (speedBoostActive ? ' [SPEED]' : ''),
    );
    this.specNameLabel.setVisible(true);
    const pct = maxHealth > 0 ? health / maxHealth : 0;
    this.specHealthBar.setVisible(true).setRatio(pct, false);
    this.specHealthLabel.setText(`${health}/${maxHealth}`);
    this.specHealthLabel.setVisible(true);

    const spc = ComponentConfig.spectator;
    const slotStartX = this.scene.scale.width / 2 - ((4 - 1) * spc.slotGap) / 2;
    for (let i = 0; i < 4; i++) {
      const weapon = weapons?.[i];
      const hasWeapon = weapon != null && weapon.weaponType > 0;
      this.specSlotBgs[i]!.setVisible(true);
      this.specSlotBgs[i]!.setTint(
        i === activeSlot
          ? DesignTokens.colors.paleGray
          : hasWeapon
            ? DesignTokens.colors.darkestGray
            : DesignTokens.colors.nearBlack,
      );
      if (hasWeapon) {
        const sk = WEAPON_SPRITE_MAP[weapon.weaponType] ?? 'weapon_dagger';
        if (!this.specSlotIcons[i]) {
          this.specSlotIcons[i] = this.scene.add
            .sprite(slotStartX + i * spc.slotGap, this._slotY, 'game', sk)
            .setOrigin(0.5)
            .setDisplaySize(24, 24)
            .setDepth(DesignTokens.depth.spectatorContent + 1)
            .setScrollFactor(0);
        } else {
          this.specSlotIcons[i]!.setTexture('game', sk);
        }
        this.specSlotIcons[i]!.setVisible(this.scene.textures.get('game').has(sk));
      } else {
        if (this.specSlotIcons[i]) this.specSlotIcons[i]!.setVisible(false);
      }
    }
  }

  hide(): void {
    if (!this.specVisible) return;
    this.specVisible = false;
    this.specPanel?.setVisible(false);
    this.specLabel.setVisible(false);
    this.specNameLabel.setVisible(false);
    this.specHealthBar.setVisible(false);
    this.specHealthLabel.setVisible(false);
    for (const bg of this.specSlotBgs) bg.setVisible(false);
    for (const icon of this.specSlotIcons) {
      if (icon) icon.setVisible(false);
    }
    this.specControlsLabel.setVisible(false);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  destroy(): void {
    const components: (Phaser.GameObjects.GameObject | null)[] = [
      this.specPanel,
      this.specLabel,
      this.specNameLabel,
      this.specHealthBar,
      this.specHealthLabel,
      this.specControlsLabel,
      ...this.specSlotBgs,
    ];
    for (const icon of this.specSlotIcons) {
      if (icon) components.push(icon);
    }
    for (const obj of components) {
      if (obj) obj.destroy();
    }
    this.specSlotBgs = [];
    this.specSlotIcons = [];
  }
}
