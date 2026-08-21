import Phaser from 'phaser';
import { weaponRegistry } from '@sector-battle/shared';
import type { KillFeedEntry } from '../types.js';
import { DesignTokens } from '../ui/DesignTokens.js';
import { Label } from '../ui/components/Label.js';

const BOT_DEBUG_ENABLED =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('botDebug') === 'true';

const KILL_FEED_MAX = 5;
const KILL_FEED_START_Y = 220;
const KILL_FEED_ROW_GAP = 22;
const KILL_FEED_PANEL_W = 420;
const KILL_FEED_PANEL_PAD = DesignTokens.spacing.lg;

// ---------------------------------------------------------------------------

/**
 * A feed entry with its row text precomputed. Entry content is immutable once
 * added (audited: the only creation site is KillFeedEventHandler.handle, a
 * fresh object literal; no field is mutated afterwards — no "you" highlight or
 * async enrichment exists), so `formatKillEntry` runs exactly once at add time
 * and the per-frame update only calls `setText` when a row's assigned entry
 * changed (perf ticket 48 — kills avoid per-frame canvas re-renders).
 */
interface CachedKillFeedEntry extends KillFeedEntry {
  formattedText: string;
}

export class KillFeedRenderer {
  private scene: Phaser.Scene;
  private bgPanel!: Phaser.GameObjects.NineSlice;
  private killFeedLabels: Label[] = [];
  private killFeedEntries: CachedKillFeedEntry[] = [];
  /** Last text each row is displaying; index-aligned with killFeedLabels. */
  private rowTexts: string[] = Array.from({ length: KILL_FEED_MAX }, () => '');
  private panelVisible = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.create();
  }

  private create(): void {
    const { width } = this.scene.scale;

    const panelH = KILL_FEED_MAX * KILL_FEED_ROW_GAP + KILL_FEED_PANEL_PAD * 2;
    const panelX = width - DesignTokens.spacing.xl - KILL_FEED_PANEL_W / 2;
    const panelY = KILL_FEED_START_Y - KILL_FEED_PANEL_PAD + panelH / 2;

    this.bgPanel = this.scene.add.nineslice(
      panelX,
      panelY,
      'ui',
      'panel-transparent',
      KILL_FEED_PANEL_W,
      panelH,
      DesignTokens.nineSlice.panel.left,
      DesignTokens.nineSlice.panel.right,
      DesignTokens.nineSlice.panel.top,
      DesignTokens.nineSlice.panel.bottom,
    );
    this.bgPanel.setDepth(DesignTokens.depth.hudBg);
    this.bgPanel.setScrollFactor(0);
    this.bgPanel.setOrigin(0.5);
    this.bgPanel.setTint(DesignTokens.colors.nearBlack);
    this.bgPanel.setAlpha(0);

    for (let i = 0; i < KILL_FEED_MAX; i++) {
      const label = new Label(
        this.scene,
        width - DesignTokens.spacing.xl,
        KILL_FEED_START_Y + i * KILL_FEED_ROW_GAP,
        {
          text: '',
          variant: 'caption',
          color: DesignTokens.colors.amber,
          stroke: true,
        },
      );
      label.setDepth(DesignTokens.depth.hudContent);
      label.setScrollFactor(0);
      label.setAlpha(0);
      const t = label.getAt(0) as Phaser.GameObjects.Text;
      t.setOrigin(1, 0);
      this.killFeedLabels.push(label);
    }
  }

  // -----------------------------------------------------------------------
  // Entrance animation support
  // -----------------------------------------------------------------------

  getEntranceElements(): Label[] {
    return [...this.killFeedLabels];
  }

  // -----------------------------------------------------------------------
  // Kill Feed API
  // -----------------------------------------------------------------------

  addKill(entry: KillFeedEntry): void {
    // Format once at add time — the string is deterministic per entry (see
    // CachedKillFeedEntry audit note). The spread copy also shields the cache
    // from any external mutation of the caller's object.
    this.killFeedEntries.unshift({ ...entry, formattedText: this.formatKillEntry(entry) });
    if (this.killFeedEntries.length > KILL_FEED_MAX) this.killFeedEntries.pop();

    if (!this.panelVisible) {
      this.panelVisible = true;
      this.scene.tweens.add({
        targets: this.bgPanel,
        alpha: 0.7,
        duration: 300,
        ease: 'Quad.easeOut',
      });
    }
  }

  update(now: number): void {
    let anyVisible = false;
    for (let i = 0; i < KILL_FEED_MAX; i++) {
      const entry = this.killFeedEntries[i];
      const label = this.killFeedLabels[i]!;
      if (entry) {
        const alpha = Math.max(0, 1 - (now - entry.timestamp) / 5000);
        // setText only when this row's assigned entry changed — each call into
        // Phaser Text re-renders the canvas and re-uploads the texture, which
        // is wasted work when the string is identical frame over frame.
        if (this.rowTexts[i] !== entry.formattedText) {
          this.rowTexts[i] = entry.formattedText;
          label.setText(entry.formattedText);
        }
        label.setAlpha(alpha);
        if (alpha > 0) anyVisible = true;
      } else {
        label.setAlpha(0);
      }
    }

    if (!anyVisible && this.panelVisible) {
      this.panelVisible = false;
      this.scene.tweens.add({
        targets: this.bgPanel,
        alpha: 0,
        duration: 500,
        ease: 'Quad.easeOut',
      });
    }
  }

  private tagBot(name: string, isBot?: boolean): string {
    return BOT_DEBUG_ENABLED && isBot ? `[BOT] ${name}` : name;
  }

  private formatKillEntry(entry: KillFeedEntry): string {
    let weaponName = 'Unknown';
    try {
      weaponName = weaponRegistry.getDefinition(entry.weaponType).name;
    } catch {
      weaponName = entry.weaponType === 0 ? 'Fists' : 'Unknown';
    }
    const cause = entry.cause ?? '';
    const v = this.tagBot(entry.victimName, entry.victimIsBot);
    const k = this.tagBot(entry.killerName, entry.killerIsBot);
    // Ticket 03 — POI location tag (server-authored name; appended so deaths
    // communicate WHERE, per DEC-001).
    const at = entry.location ? ` at ${entry.location}` : '';
    if (cause === 'zone' || cause === 'zone_damage' || cause === 'sudden_death')
      return `${v} was eliminated by the zone${at}`;
    if (cause === 'trap_damage' || cause === 'trap') return `${v} was eliminated by a trap${at}`;
    if (cause === 'barrel_explosion' || cause === 'barrel')
      return `${v} was eliminated by a barrel explosion${at}`;
    if (cause === 'siege_crush' || cause === 'siege') return `${v} was crushed by the siege${at}`;
    if (cause === 'disconnect') return `${v} disconnected`;
    if (cause === 'self_thrown')
      return `${v} was eliminated by their own thrown ${weaponName}${at}`;
    if (!entry.killerId) return `${v} was eliminated${at}`;
    if (cause === 'thrown_hit' || entry.attackType === 'THROWN')
      return `${k} eliminated ${v} with thrown ${weaponName}${at}`;
    return `${k} eliminated ${v} with ${weaponName}${at}`;
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  destroy(): void {
    for (const label of this.killFeedLabels) label.destroy();
    this.killFeedLabels = [];
    this.bgPanel.destroy();
  }
}
