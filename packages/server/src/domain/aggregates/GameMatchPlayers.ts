import {
  PLAYER,
  PlayerStatus,
  ASSIGNABLE_COLOR_INDICES,
  type GameConfig,
  type SpawnPoint,
} from '@sector-battle/shared';
import { Position } from '../value-objects/index.ts';
import { Player } from '../entities/index.ts';
import type { GameMatch } from './GameMatch.ts';

/**
 * Player-lifecycle operations for GameMatch. Mechanical extraction from the
 * original GameMatch class — bodies verbatim, `this.→match.` only.
 *
 * NOTE: the GameMatch class exposes `players`, `spawnPoints`, `nextSpawnIndex`,
 * `nextColorIndex`, `tick`, `config` as public so these helpers can read/write them.
 */

export function addPlayerAction(match: GameMatch, id: string, name: string): Player {
  const sp = match.spawnPoints[match.nextSpawnIndex % match.spawnPoints.length]!;
  match.nextSpawnIndex++;
  // Round-robin a usable skin color across all joiners (humans AND bots).
  // Skips `blue` (index 4) until its hand art is fixed — see ASSIGNABLE_COLOR_INDICES.
  const color = ASSIGNABLE_COLOR_INDICES[match.nextColorIndex % ASSIGNABLE_COLOR_INDICES.length]!;
  match.nextColorIndex++;
  const player = new Player(id, name, new Position(sp.x, sp.y), match.config.player, color);
  player.survivalStartTick = match.tick;
  player.spawnTick = match.tick;
  player.statusEffects.freshSpawnExpiryTick =
    match.tick + Math.ceil(PLAYER.SPAWN_INVINCIBILITY * 60);
  // server-alive-counter: a same-id re-add would orphan the old entry's count.
  // Un-count + detach the old player before the map overwrite keeps the
  // counter equal to the scan even under (currently unreachable) double-add.
  const existing = match.players.get(id);
  if (existing) {
    if (existing.isActive) match.adjustAliveCount(-1);
    existing.onAlivenessTransition = null;
  }
  match.players.set(id, player);
  // server-alive-counter: hook future ALIVE-bit flips (die/dieWithTick/
  // completeDeath/revive — see PlayerLifecycle), then count the new player
  // (Player constructor status = ALIVE|INVINCIBLE|FRESH_SPAWN).
  player.onAlivenessTransition = (isAlive) => match.adjustAliveCount(isAlive ? 1 : -1);
  if (player.isActive) match.adjustAliveCount(1);
  return player;
}

export function removePlayerAction(match: GameMatch, id: string): void {
  const player = match.players.get(id);
  if (player) {
    // server-alive-counter: the direct DEAD write below may flip the ALIVE bit.
    const wasAlive = player.isActive;
    player.connected = false;
    player.statusEffects.status = PlayerStatus.DEAD;
    if (wasAlive && !player.isActive) match.adjustAliveCount(-1);
  }
}

/**
 * HARD-remove a player from the match (delete from the player map entirely,
 * decrementing playersCount). Unlike removePlayerAction (which is soft
 * — the player stays for end-of-match stats), this fully purges the player.
 * Used ONLY by the benchmark harness's synchronous bot spawner to reset the
 * lobby to a clean deterministic state before spawning the real bot set —
 * the room's onCreate interval-spawner may have soft-added a bot that still
 * counts toward the MAX_PLAYERS cap, blocking a full 64-bot fill. Production
 * match flow never calls this (players persist for placement/scoring).
 */
export function hardRemovePlayerForBenchmarkAction(match: GameMatch, id: string): void {
  // server-alive-counter: un-count a live entry and detach its hook so a purged
  // player object can never affect the maintained count again.
  const player = match.players.get(id);
  if (player) {
    if (player.isActive) match.adjustAliveCount(-1);
    player.onAlivenessTransition = null;
  }
  match.players.delete(id);
}

export function getPlayerAction(match: GameMatch, id: string): Player | undefined {
  return match.players.get(id);
}

export function getPlayersAction(match: GameMatch): Player[] {
  return [...match.players.values()];
}

export function forEachAlivePlayerAction(
  match: GameMatch,
  callback: (player: Player) => void,
): void {
  for (const player of match.players.values()) {
    if (player.isActive) callback(player);
  }
}

export function getAlivePlayerCountAction(match: GameMatch): number {
  let c = 0;
  for (const p of match.players.values()) {
    if (p.isActive) c++;
  }
  return c;
}

export function getPlayersCountAction(match: GameMatch): number {
  return match.players.size;
}

// Re-export types that callers may have imported via this module path.
export type { GameConfig, SpawnPoint };
