import { PlayerStatus } from '@sector-battle/shared';
import type { GameState } from './controllers/GameState.js';
import type { StateSync } from './network/StateSync.js';
import type { EntityInterpolator } from './prediction/EntityInterpolator.js';

/**
 * Position helpers extracted from GameScene. Mechanical extraction — bodies
 * verbatim, `this.X` → parameter references.
 *
 * Ticket #42: the nearby-collision build is FUSED into this single pass. The
 * former third full iteration in GameScene.update walked the finished map and,
 * per remote, did a `stateSync.getPlayer(pid)` lookup (dead-status read) plus
 * an `interpolator.getLatestReceivedPosition(pid)` fetch. Here the same
 * inclusion test runs while the map entry is being constructed: the players-map
 * iteration value IS the object `getPlayer` returned (StateSync.getPlayer is
 * literally `entities.players.get(id)`), so the status read is free, and the
 * origin (local predicted position) is read once before the loop.
 */

/**
 * C5 nearby-collision cutoff: only remote players within 320px of the local
 * player can overlap the 96px hitbox. The comparison form is carried over
 * VERBATIM from the former third pass — squared components, strict less-than
 * (`ddx * ddx + ddy * ddy < 320 * 320`). Do not switch forms.
 */
export const NEARBY_PLAYER_RANGE_PX = 320;
/**
 * DEAD/DYING/SPECTATING bit — the server's resolvePlayerCollision skips
 * inactive players (isActive gate); the client matches that so it doesn't
 * shove against corpses. (Dashing bots aren't synced as a flag, so a dashing
 * bot is a brief residual edge case.)
 */
export const NEARBY_PLAYER_DEAD_MASK =
  PlayerStatus.DEAD | PlayerStatus.DYING | PlayerStatus.SPECTATING;

export interface PositionHelperDeps {
  state: GameState;
  stateSync: StateSync;
  interpolator: EntityInterpolator;
  playerPositionsMap: Map<string, { x: number; y: number }>;
  playerPositionsPool: { x: number; y: number }[];
  interpolatorOut: { x: number; y: number };
  /** Nearby-collision pool (ticket #37 view semantics: entries [0, count) live). */
  nearbyPool: { x: number; y: number }[];
  /** Single {x,y} scratch reused across the loop's latest-received fetches. */
  nearbyScratch: { x: number; y: number };
  /** Out-param: written every call with the live entry count of nearbyPool. */
  nearbyCountOut: { count: number };
}

export function getAllPlayerPositions(
  deps: PositionHelperDeps,
): Map<string, { x: number; y: number }> {
  deps.playerPositionsMap.clear();
  const entities = deps.stateSync.getEntities();
  const myId = deps.state.myId;
  // Origin for the nearby set = the local player's PREDICTED position. Same
  // values the former third pass read from state.localPos: predictionService
  // .step() runs before this pass, and the map consumers between the two
  // points (statusEffects / fire-dot positions) never write localPos.
  const lpx = deps.state.localPos.x;
  const lpy = deps.state.localPos.y;
  const deadMask = NEARBY_PLAYER_DEAD_MASK;
  const scratch = deps.nearbyScratch;
  const nearby = deps.nearbyPool;
  let nearbyCount = 0;
  let poolIdx = 0;
  for (const [id, player] of entities.players) {
    let entry = deps.playerPositionsPool[poolIdx];
    if (!entry) {
      entry = { x: 0, y: 0 };
      deps.playerPositionsPool[poolIdx] = entry;
    }
    if (id === myId) {
      entry.x = deps.state.localPos.x;
      entry.y = deps.state.localPos.y;
      deps.playerPositionsMap.set(id, entry);
      poolIdx++;
      // Self-skip from the former third pass is implicit: the local player
      // takes this branch and never reaches the nearby build below.
    } else if (deps.interpolator.getInterpolatedPosition(id, deps.interpolatorOut)) {
      entry.x = deps.interpolatorOut.x;
      entry.y = deps.interpolatorOut.y;
      deps.playerPositionsMap.set(id, entry);
      poolIdx++;
      // --- fused nearby-collision build (predicate verbatim from the former
      // third pass) --- `player` is the value the per-remote
      // `stateSync.getPlayer(pid)` lookup used to fetch, so `player.status`
      // is the identical read without the lookup. The old `p &&` guard was
      // dead there too (map keys always have values in the same map).
      if (!(player.status & deadMask)) {
        // Prefer the latest-received authoritative remote position (pre-
        // interpolation); fall back to the interpolated display position if no
        // snapshot exists yet (rare — getInterpolatedPosition just succeeded,
        // which requires count >= 1, the same condition latest-received
        // checks). NET-29 / ADR-0020 addendum: collision prediction reads the
        // most authoritative position; display stays interpolated.
        const src = deps.interpolator.getLatestReceivedPosition(id, scratch)
          ? scratch
          : entry;
        const ddx = src.x - lpx;
        const ddy = src.y - lpy;
        if (ddx * ddx + ddy * ddy < NEARBY_PLAYER_RANGE_PX * NEARBY_PLAYER_RANGE_PX) {
          let nearEntry = nearby[nearbyCount];
          if (!nearEntry) {
            nearEntry = { x: 0, y: 0 };
            nearby[nearbyCount] = nearEntry;
          }
          nearEntry.x = src.x;
          nearEntry.y = src.y;
          nearbyCount++;
        }
      }
    }
  }
  deps.nearbyCountOut.count = nearbyCount;
  return deps.playerPositionsMap;
}
