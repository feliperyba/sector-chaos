import { PlayerStatus } from '@sector-battle/shared';
import type { MatchStartChannelMessage, MatchEndMessage } from '@sector-battle/shared';
import Phaser from 'phaser';
import type { AudioService } from '../../audio/AudioService.js';
import type { HUDManager } from '../../hud/HUDManager.js';
import type { ResultsScreen } from '../../hud/ResultsScreen.js';
import type { StateSync } from '../../network/StateSync.js';

export class MatchEventHandler {
  constructor(
    private readonly myId: { value: string },
    private readonly audio: AudioService,
    private readonly hud: HUDManager,
    private readonly stateSync: StateSync,
    private readonly scene: Phaser.Scene,
    private readonly playerNames: Map<string, string>,
    private readonly resultsScreen: { value: ResultsScreen | null },
    private readonly returnToMenu: () => void,
    /**
     * Map-redesign ticket 03 (DEC-010) — shows the map designation line at
     * match start (phase-banner area). Accepts null/undefined (mapData may
     * still be in flight — the banner controller holds it pending and the
     * mapData handler flushes it). Optional so partial test harnesses keep
     * working.
     */
    private readonly showDesignation?: (text: string | null | undefined) => void,
    /** Map designation read-through for the results screen (ticket 03). */
    private readonly mapDesignation?: { value: string | null },
  ) {}

  handleMatchStart(data: MatchStartChannelMessage): void {
    const toPhase = data.to;
    if (toPhase != null && toPhase === 1) {
      // Ticket 03 — the map designation rides the countdown (the phase
      // banner area's natural quiet window; one line, transient).
      // UNCONDITIONAL on purpose: the buffered `to:1` is drained inside
      // connectWithRoom, BEFORE the client sends `requestMapData`, so the
      // designation read-through is null in every production flow at this
      // point. Passing the null through (not skipping the call) arms
      // `designationPending` in MapBannerController; the mapData handler's
      // notifyMapData flush then shows the line the moment the data lands.
      // A truthiness guard here was dead code (judge finding F1, d3ed814).
      this.showDesignation?.(this.mapDesignation?.value);
      for (let i = 5; i >= 1; i--) {
        this.scene.time.delayedCall((5 - i) * 1000, () => {
          this.audio.playCountdownBeep();
        });
      }
      this.scene.time.delayedCall(5000, () => {
        this.audio.playCountdownGo();
        this.audio.playVoiceover('go');
      });
    }
    if (toPhase != null && toPhase >= 2) {
      this.hud.setStatusText('FIGHT!', true);
      this.scene.time.delayedCall(1500, () => this.hud.setStatusText('', false));
      this.audio.playMatchStart();
      this.audio.playMusic('gameplay');
    }
  }

  handleMatchEnd(data: MatchEndMessage): void {
    this.scene.events.emit('game_ended');
    this.hud.setStatusText('MATCH OVER', true);
    this.audio.playMusic('results');
    const myPlayer = this.stateSync.getPlayer(this.myId.value);
    const isAlive = myPlayer ? (myPlayer.status & PlayerStatus.DEAD) === 0 : false;
    if (isAlive) this.audio.playVictory();
    else this.audio.playDefeat();
    const placements = (data.placements ?? []).map((p) => ({
      ...p,
      name: this.playerNames.get(p.playerId) ?? p.playerId.substring(0, 8),
    }));
    const winnerName = this.playerNames.get(data.winnerId) ?? (data.winnerId ?? '').substring(0, 8);
    this.resultsScreen.value?.show(
      placements,
      winnerName,
      () => {
        this.returnToMenu();
      },
      // Ticket 03 — the designation line on the results screen.
      this.mapDesignation?.value ?? undefined,
    );
  }
}
