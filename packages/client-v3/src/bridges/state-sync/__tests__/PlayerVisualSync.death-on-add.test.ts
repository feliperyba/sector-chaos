/**
 * Regression test — floating arms / lingering corpse (Bug 2).
 *
 * WHY THIS TEST EXISTS:
 * A player added to the client state already DEAD (reconnect-as-spectator,
 * mid-match join where a corpse is in the snapshot) was created with full
 * visuals + arms via `onPlayerAdd`, but `triggerDeath` only fires from
 * `onPlayerChange` → `handlePlayerChange` (status edge) or the KillFeed event —
 * NEITHER of which runs at add time for an already-dead player. With no
 * `triggerDeath`, the driver never entered DYING, the death fade never ran, and
 * the corpse's body + arms lingered at full alpha forever (the user-visible
 * "floating arms where a player died" / "detached arms" symptom — see
 * PlayerRendererUpdate.arms-linger.diag.test.ts S2).
 *
 * The fix extracts `ensureDeathFade(p, key)` on PlayerVisualSync (the death-edge
 * check, idempotent via `deathTriggered`) and calls it from BOTH
 * `handlePlayerChange` and `onPlayerAdd`, so a dead player fades regardless of
 * whether they were seen alive first.
 */
import { describe, it, expect, vi } from 'vitest';
import { PlayerStatus } from '@sector-battle/shared';
import { PlayerVisualSync } from '../PlayerVisualSync.js';
import type { PlayerState } from '../../../types.js';

/**
 * Stub: returns `spies[name]` if a spy is registered for that method, else a
 * no-op — so handlePlayerChange's full alive path (updateHealth/updateWeapon/
 * syncAnimPhase/...) doesn't crash while we only assert on triggerDeath +
 * statusEffects.removePlayer.
 */
function proxyStub(spies: Record<string, ReturnType<typeof vi.fn>>): never {
  return new Proxy(spies, {
    get(target, prop) {
      if (prop in target) return target[prop as string];
      return () => {};
    },
  }) as never;
}

function makeDeps() {
  const triggerDeath = vi.fn();
  const removePlayerStatus = vi.fn();
  const deps = {
    myId: { value: 'me' },
    playerRenderer: proxyStub({ triggerDeath }),
    statusEffects: proxyStub({ removePlayer: removePlayerStatus }),
    audio: proxyStub({}),
    getServerTick: () => 0,
  };
  return { deps, triggerDeath, removePlayerStatus };
}

function makePlayer(over: Partial<PlayerState> = {}): PlayerState {
  return {
    x: 0,
    y: 0,
    name: 'p',
    health: 100,
    maxHealth: 100,
    status: 0,
    ...over,
  } as PlayerState;
}

describe('PlayerVisualSync.ensureDeathFade — death fade on add (Bug 2 regression)', () => {
  it('fires triggerDeath for an ALREADY-DEAD player (the onPlayerAdd seam)', () => {
    const { deps, triggerDeath, removePlayerStatus } = makeDeps();
    const sync = new PlayerVisualSync(deps);
    const deadPlayer = makePlayer({ status: PlayerStatus.DEAD });

    sync.ensureDeathFade(deadPlayer, 'corpse1');

    expect(triggerDeath).toHaveBeenCalledTimes(1);
    expect(triggerDeath).toHaveBeenCalledWith('corpse1');
    expect(removePlayerStatus).toHaveBeenCalledWith('corpse1');
  });

  it('does NOT fire triggerDeath for an ALIVE player', () => {
    const { deps, triggerDeath } = makeDeps();
    const sync = new PlayerVisualSync(deps);
    const alivePlayer = makePlayer({ status: PlayerStatus.ALIVE });

    sync.ensureDeathFade(alivePlayer, 'alive1');

    expect(triggerDeath).not.toHaveBeenCalled();
  });

  it('is idempotent: a second call for the same dead player does not re-trigger', () => {
    const { deps, triggerDeath } = makeDeps();
    const sync = new PlayerVisualSync(deps);
    const deadPlayer = makePlayer({ status: PlayerStatus.DYING });

    sync.ensureDeathFade(deadPlayer, 'p');
    sync.ensureDeathFade(deadPlayer, 'p');

    expect(triggerDeath).toHaveBeenCalledTimes(1);
  });

  it('treats SPECTATING status as dead (reconnect-as-spectator)', () => {
    const { deps, triggerDeath } = makeDeps();
    const sync = new PlayerVisualSync(deps);
    sync.ensureDeathFade(makePlayer({ status: PlayerStatus.SPECTATING }), 'spec');
    expect(triggerDeath).toHaveBeenCalledWith('spec');
  });

  it('handlePlayerChange still fires triggerDeath for a dead player (refactor preserved)', () => {
    const { deps, triggerDeath } = makeDeps();
    const sync = new PlayerVisualSync(deps);
    sync.handlePlayerChange(makePlayer({ status: PlayerStatus.DEAD }), 'p');
    expect(triggerDeath).toHaveBeenCalledWith('p');
  });

  it('handlePlayerChange does NOT fire triggerDeath for an alive player', () => {
    const { deps, triggerDeath } = makeDeps();
    const sync = new PlayerVisualSync(deps);
    sync.handlePlayerChange(makePlayer({ status: PlayerStatus.ALIVE }), 'p');
    expect(triggerDeath).not.toHaveBeenCalled();
  });
});
