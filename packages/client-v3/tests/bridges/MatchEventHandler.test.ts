import { beforeEach, describe, expect, it, vi } from 'vitest';

// MatchEventHandler imports Phaser for type positions only; the module mock
// keeps the real bundle (and its canvas probes) out of jsdom entirely.
vi.mock('phaser', () => ({ default: {} }));

import type Phaser from 'phaser';
import { MatchEventHandler } from '../../src/bridges/event-handlers/MatchEventHandler.js';
import type { AudioService } from '../../src/audio/AudioService.js';
import type { HUDManager } from '../../src/hud/HUDManager.js';
import type { ResultsScreen } from '../../src/hud/ResultsScreen.js';
import type { StateSync } from '../../src/network/StateSync.js';
import type { MatchPhaseChangedMessage, MatchStartedMessage } from '@sector-battle/shared';

/**
 * Map-redesign ticket 03 REPAIR (judge finding F1 on d3ed814).
 *
 * The designation-at-match-start surface was dead code as committed: the
 * buffered MATCH_START `to:1` (countdown) is drained inside
 * `connectWithRoom`, which runs BEFORE the client sends `requestMapData` —
 * so `gameState.designation` is ALWAYS null when `handleMatchStart` fires
 * in production. The old `if (designation) this.showDesignation?.(...)`
 * guard therefore skipped the call, `MapBannerController.designationPending`
 * was never armed, and the mapData handler's `notifyMapData` flush was a
 * guaranteed no-op.
 *
 * Contract under test: on `to === 1` the handler must call `showDesignation`
 * UNCONDITIONALLY — with the current value, whatever it is (including
 * null) — so the controller arms the pending flag and the later mapData
 * flush actually shows the line.
 */

interface Deps {
  myId: { value: string };
  audio: Record<string, ReturnType<typeof vi.fn>>;
  hud: { setStatusText: ReturnType<typeof vi.fn> };
  stateSync: { getPlayer: ReturnType<typeof vi.fn> };
  scene: { time: { delayedCall: ReturnType<typeof vi.fn> } };
  playerNames: Map<string, string>;
  resultsScreen: { value: ResultsScreen | null };
  returnToMenu: ReturnType<typeof vi.fn>;
  showDesignation: ReturnType<typeof vi.fn>;
  mapDesignation: { value: string | null };
}

function createHandler(deps: Deps): MatchEventHandler {
  return new MatchEventHandler(
    deps.myId,
    deps.audio as unknown as AudioService,
    deps.hud as unknown as HUDManager,
    deps.stateSync as unknown as StateSync,
    deps.scene as unknown as Phaser.Scene,
    deps.playerNames,
    deps.resultsScreen,
    deps.returnToMenu,
    deps.showDesignation,
    deps.mapDesignation,
  );
}

function createDeps(designation: string | null): Deps {
  return {
    myId: { value: 'p1' },
    audio: {
      playCountdownBeep: vi.fn(),
      playCountdownGo: vi.fn(),
      playVoiceover: vi.fn(),
      playMatchStart: vi.fn(),
      playMusic: vi.fn(),
      playVictory: vi.fn(),
      playDefeat: vi.fn(),
    },
    hud: { setStatusText: vi.fn() },
    stateSync: { getPlayer: vi.fn().mockReturnValue(null) },
    scene: { time: { delayedCall: vi.fn() } },
    playerNames: new Map(),
    resultsScreen: { value: null },
    returnToMenu: vi.fn(),
    showDesignation: vi.fn(),
    mapDesignation: { value: designation },
  };
}

const COUNTDOWN: MatchPhaseChangedMessage = { from: 0, to: 1, tick: 100 };

describe('MatchEventHandler — designation at match start (ticket 03 race repair)', () => {
  let deps: Deps;
  let handler: MatchEventHandler;

  beforeEach(() => {
    deps = createDeps(null);
    handler = createHandler(deps);
  });

  it('THE RACE: to=1 with designation still null calls showDesignation(null) — unconditional', () => {
    // Production order: buffered `to:1` drains inside connectWithRoom,
    // BEFORE requestMapData/mapData — so the read-through box is null here.
    // The old `if (designation)` guard skipped the call entirely, leaving
    // the pending flag unarmed and notifyMapData dead (judge F1).
    handler.handleMatchStart(COUNTDOWN);

    // Sanity: we are inside the countdown branch (beeps scheduled).
    expect(deps.scene.time.delayedCall).toHaveBeenCalled();
    // The regression assertion: null must still reach the banner controller
    // so it arms designationPending for the mapData flush.
    expect(deps.showDesignation).toHaveBeenCalledTimes(1);
    expect(deps.showDesignation).toHaveBeenCalledWith(null);
  });

  it('to=1 with designation already present passes the string through', () => {
    deps = createDeps('RIDGELINE • RINGHOLD • 9IX');
    handler = createHandler(deps);
    handler.handleMatchStart(COUNTDOWN);

    expect(deps.showDesignation).toHaveBeenCalledTimes(1);
    expect(deps.showDesignation).toHaveBeenCalledWith('RIDGELINE • RINGHOLD • 9IX');
  });

  it('to=2 (fight start) never touches the designation surface', () => {
    handler.handleMatchStart({ from: 1, to: 2, tick: 200 });

    expect(deps.showDesignation).not.toHaveBeenCalled();
    expect(deps.hud.setStatusText).toHaveBeenCalledWith('FIGHT!', true);
  });

  it('absent `to` (MatchStartedMessage without phase) never touches the designation surface', () => {
    const msg: MatchStartedMessage = {
      eventType: 'MatchStarted',
      mapSeed: 12345,
      playerCount: 64,
      tick: 300,
    };
    handler.handleMatchStart(msg);

    expect(deps.showDesignation).not.toHaveBeenCalled();
  });
});
