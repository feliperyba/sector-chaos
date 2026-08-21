import { describe, it, expect } from 'vitest';
import {
  claimItem,
  itemClaimedBy,
  contestInterceptPoint,
  contestRaceLost,
  ITEM_CLAIM_TICKS,
  CONTEST_BREAK_OFF_FACTOR,
  CONTEST_BREAK_OFF_SLACK_PX,
  type ItemClaimStore,
} from '../../../src/ai/combat/ItemContests.ts';

/**
 * Real loot contests — the pure seam (DEC-010.5): persistent cross-tick
 * claims (no ping-pong), intercept pathing on the enemy's approach side,
 * and the decisive break-off predicate. The two-bot claim-exchange bound
 * (the harness gate's seam-level equivalent) runs the claim store across a
 * simulated race and asserts claim OWNERSHIP changes are bounded.
 */

describe('persistent claims', () => {
  it('a claim survives across ticks and expires after the window', () => {
    const store: ItemClaimStore = new Map();
    claimItem(store, 'item-1', 'botA', 100);
    // Same tick, another bot: blocked by botA's claim.
    expect(itemClaimedBy(store, 'item-1', 'botB', 100)).toBe('botA');
    // Ticks later (no refresh): still held inside the window...
    expect(itemClaimedBy(store, 'item-1', 'botB', 100 + ITEM_CLAIM_TICKS - 1)).toBe('botA');
    // ...and free after it (lazy expiry on read).
    expect(itemClaimedBy(store, 'item-1', 'botB', 100 + ITEM_CLAIM_TICKS)).toBeNull();
  });

  it("the claimant's own claim never blocks it (refresh path)", () => {
    const store: ItemClaimStore = new Map();
    claimItem(store, 'item-1', 'botA', 100);
    expect(itemClaimedBy(store, 'item-1', 'botA', 100)).toBeNull();
    claimItem(store, 'item-1', 'botA', 130); // refresh extends
    expect(store.get('item-1')!.untilTick).toBe(130 + ITEM_CLAIM_TICKS);
    expect(store.get('item-1')!.botId).toBe('botA');
  });

  it('two bots over a shared item: claim ownership changes are BOUNDED (no ping-pong)', () => {
    // The seam-level equivalent of the harness's two-bot race: botA is the
    // contesting bot (claims + refreshes every tick while en route); botB is
    // the legacy per-tick claimer. With the persistent store, botB NEVER
    // takes the item once botA holds it — ownership changes exactly once,
    // not once per tick (the audited alternation is structurally gone).
    const store: ItemClaimStore = new Map();
    let owner: string | null = null;
    let ownershipChanges = 0;
    for (let tick = 0; tick < 120; tick++) {
      if (itemClaimedBy(store, 'item-1', 'botA', tick) === null) {
        claimItem(store, 'item-1', 'botA', tick);
        if (owner !== 'botA') {
          owner = 'botA';
          ownershipChanges++;
        }
      }
      // botB only ever claims an UNCLAIMED item (the isClaimed gate).
      if (itemClaimedBy(store, 'item-1', 'botB', tick) === null && !store.has('item-1')) {
        claimItem(store, 'item-1', 'botB', tick);
        if (owner !== 'botB') {
          owner = 'botB';
          ownershipChanges++;
        }
      }
    }
    expect(ownershipChanges).toBe(1); // bounded — NOT one per tick
    expect(store.get('item-1')!.botId).toBe('botA'); // the persistent claimant won
  });
});

describe('contestInterceptPoint — the enemy-approach-side routing', () => {
  it('sits on the enemy→item line, inside the reach, toward the enemy', () => {
    const item = { x: 1000, y: 1000 };
    const enemy = { x: 1800, y: 1000 }; // approaching from the east
    const p = contestInterceptPoint(item.x, item.y, enemy.x, enemy.y, 192);
    expect(p.x).toBeGreaterThan(item.x); // enemy side (east) of the item
    expect(p.x).toBeLessThanOrEqual(item.x + 130); // INTERCEPT_MAX_OFFSET_PX cap
    expect(p.y).toBeCloseTo(1000, 6);
    // Still inside the chest's interaction reach.
    const dist = Math.hypot(p.x - item.x, p.y - item.y);
    expect(dist).toBeLessThanOrEqual(192);
  });

  it('respects the smaller weapon-pickup reach (offset ≤ reach − inset)', () => {
    const p = contestInterceptPoint(1000, 1000, 1800, 1000, 64);
    expect(p.x - 1000).toBeLessThanOrEqual(64 - 24); // PICKUP reach − inset
    expect(p.x).toBeGreaterThan(1000);
  });

  it('never steps past the enemy (clamped to half the enemy distance)', () => {
    const p = contestInterceptPoint(1000, 1000, 1060, 1000, 192); // enemy 60px away
    expect(p.x).toBeLessThanOrEqual(1030); // half of 60
  });

  it('degenerates to the item seat when the geometry collapses', () => {
    const p = contestInterceptPoint(1000, 1000, 1000, 1000, 192); // enemy ON the item
    expect(p.x).toBe(1000);
    expect(p.y).toBe(1000);
  });
});

describe('contestRaceLost — the clean break-off predicate', () => {
  it('lost only when decisively behind (factor + slack)', () => {
    // enemyDist 100: break when myDist > 100*1.6 + 120 = 280.
    expect(contestRaceLost(280, 100)).toBe(false); // exactly at the line
    expect(contestRaceLost(281, 100)).toBe(true);
    expect(contestRaceLost(150, 100)).toBe(false); // behind but winnable-ish
    expect(contestRaceLost(90, 100)).toBe(false); // winning
  });

  it('the margin constants are the tuned data (DEC-010.5)', () => {
    expect(CONTEST_BREAK_OFF_FACTOR).toBe(1.6);
    expect(CONTEST_BREAK_OFF_SLACK_PX).toBe(120);
  });
});

// Review m6 — live-claim takeover is IMPOSSIBLE: only expired entries are
// takeable; a foreign live claim reaching claimItem means a caller bypassed
// the itemClaimedBy gate and must fail loudly (not silently steal).
describe('claimItem: live-claim exclusivity (review m6)', () => {
  it('refreshing MY OWN live claim extends it', () => {
    const store: ItemClaimStore = new Map();
    claimItem(store, 'item-1', 'botA', 100);
    claimItem(store, 'item-1', 'botA', 150); // same owner — a refresh
    expect(store.get('item-1')!.botId).toBe('botA');
    expect(store.get('item-1')!.untilTick).toBe(150 + ITEM_CLAIM_TICKS);
  });

  it('a LIVE foreign claim throws instead of silently transferring ownership', () => {
    const store: ItemClaimStore = new Map();
    claimItem(store, 'item-1', 'botA', 100);
    expect(() => claimItem(store, 'item-1', 'botB', 120)).toThrow(/live-claim takeover/);
    expect(store.get('item-1')!.botId).toBe('botA'); // ownership intact
  });

  it('an EXPIRED claim is takeable by the next claimant (the gate-free path)', () => {
    const store: ItemClaimStore = new Map();
    claimItem(store, 'item-1', 'botA', 100);
    // At tick 100 + ITEM_CLAIM_TICKS the entry is expired (pruned on write).
    claimItem(store, 'item-1', 'botB', 100 + ITEM_CLAIM_TICKS);
    expect(store.get('item-1')!.botId).toBe('botB');
  });
});
