/**
 * Input wire (`room.send('input', frame)`) message types.
 *
 * Channel: input
 *
 * This is the single source of truth for the JSON shape the client sends to the
 * server each input tick. The bytes on the wire are unchanged (ADR-0014); these
 * types exist so client and server cannot drift on the wire contract. The drift
 * between this type and the actual client send is pinned by the characterization
 * test at `packages/server/tests/room/handlers/input-wire-shape.test.ts` (ticket #08).
 *
 * Per FILE_CONSTRAINTS #7, `packages/shared` has no runtime deps — these are
 * TS-only declarations. Zod validation stays server-side
 * (`packages/server/src/validation/inputSchemas.ts`).
 */

/**
 * The eight client action string literals. Step 0 of ticket #08 confirmed every
 * `actions.push(...)` call site in `packages/client-v3/src` pushes one of these
 * literals (the only dynamic form is `` `WEAPON_SLOT_${slot}` `` where `slot` is
 * constrained to 1..4). Any new literal must be added here AND to the shared
 * `INPUT_ACTION_MAP` in `packages/shared/src/network/inputActionMap.ts`.
 */
export type InputActionName =
  | 'ATTACK'
  | 'DASH'
  | 'THROW'
  | 'PICKUP'
  | 'WEAPON_SLOT_1'
  | 'WEAPON_SLOT_2'
  | 'WEAPON_SLOT_3'
  | 'WEAPON_SLOT_4';

/**
 * The four `WEAPON_SLOT_N` wire literals in slot order (slot 1 → index 0).
 * Used to build a slot action from a numeric slot without resorting to
 * `` `WEAPON_SLOT_${slot}` `` template strings, which would erase the
 * `InputActionName` narrowing. Wire bytes are unchanged: callers still emit
 * the same `'WEAPON_SLOT_1'`..'WEAPON_SLOT_4'` literals.
 */
export const WEAPON_SLOT_ACTIONS = [
  'WEAPON_SLOT_1',
  'WEAPON_SLOT_2',
  'WEAPON_SLOT_3',
  'WEAPON_SLOT_4',
] as const satisfies readonly InputActionName[];

/**
 * Map a 1-based slot number (1..4) to its `WEAPON_SLOT_N` wire literal.
 * Out-of-range slots wrap with the same `(((slot - 1) % 4) + 4) % 4` arithmetic
 * the client input collector historically used, preserving runtime behavior.
 */
export function weaponSlotAction(slot: number): InputActionName {
  const idx = (((slot - 1) % 4) + 4) % 4;
  return WEAPON_SLOT_ACTIONS[idx]!;
}

/**
 * Wire shape sent by the client via `room.send('input', frame)`. Mirrors the
 * historical `InputFrame` interface at `packages/client-v3/src/types.ts`.
 *
 * `powerUpId` is intentionally absent — Step 0 recon (`grep -rn "powerUpId"
 * packages/client-v3/src`) returned zero hits, so the client never puts it on
 * the wire. The server's PICKUP branch still reads `powerUpId` defensively,
 * but it is not part of the client-authoritative shape.
 */
export interface InputMessage {
  /** Clamped to [-1, 1] by the client. */
  movementX: number;
  /** Clamped to [-1, 1] by the client. */
  movementY: number;
  /** Radians. */
  aimAngle: number;
  /** Monotonically increasing sequence number. */
  sequence: number;
  /** At most 3 actions per tick (server-side clamp). */
  actions: InputActionName[];
  /** Optional PICKUP target (chest / trap / weapon pickup id). */
  targetId?: string;
}

/**
 * Discriminated union for `QueuedInput.data` — the per-action payload that
 * the server's input queue carries from `room.handleInput` through to
 * `GameSimulationInput`'s switch. The discriminator is the implicit
 * `action` field on the parent `QueuedInput` (not duplicated here).
 *
 * Fields are marked OPTIONAL where the three producers disagree on
 * presence:
 *   - `tick` (THROW/DASH/SWITCH_SLOT): Site A always includes; BotInput
 *     factories omit; Site B reads defensively with `?? 0`.
 *   - `powerUpId` (PICKUP): Site A and BotInput include; Site B unread.
 *   - `aimAngle` (MOVE/ATTACK/THROW): Site A passes `number | undefined`;
 *     Site B reads defensively with `isFinite` guard; BotInput always
 *     emits a finite number. The `undefined` case is pinned by #08's
 *     characterization test (tests 2/4/6).
 *
 * This union makes the existing runtime variance explicit — it is never
 * stricter, never looser than today's `data: unknown` + hand-cast.
 * Wire bytes are unchanged (ADR-0014). See ticket #08b.
 */
export interface MoveInputData {
  dx: number;
  dy: number;
  aimAngle?: number;
  tick: number;
}
export interface AttackInputData {
  aimAngle?: number;
  tick: number;
}
export interface ThrowInputData {
  aimAngle?: number;
  tick?: number;
}
export interface PickupInputData {
  powerUpId?: string;
  targetId: string;
  tick: number;
}
export interface SwitchSlotInputData {
  slot: number;
  tick?: number;
}
export interface DashInputData {
  dx: number;
  dy: number;
  tick?: number;
}
export type InputActionData =
  | MoveInputData
  | AttackInputData
  | ThrowInputData
  | PickupInputData
  | SwitchSlotInputData
  | DashInputData;
