import type { Client } from 'colyseus';
import type { GameOrchestrator } from '../../application/services/GameOrchestrator.ts';
import {
  InputAction,
  NETWORK,
  encodeInputAction,
  getSlotFromAction,
  type InputActionName,
  type InputMessage,
} from '@sector-battle/shared';
import { InputSchemaByAction, validateInput } from '../../validation/inputSchemas.ts';
import { RateLimiter } from '../../validation/RateLimiter.ts';
import { netLogger as logger } from '@sector-battle/shared';

interface InputHandlingRoom {
  onMessage(type: string, callback: (client: Client, data: InputMessage) => void): void;
  getOrchestrator(): GameOrchestrator;
  recordInputTime(playerId: string): void;
}

const rateLimiter = new RateLimiter(NETWORK.MAX_MESSAGES_PER_SECOND, 1000);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampDirection(value: number): number {
  return Math.max(-1, Math.min(1, value));
}

/** Decode a wire number, defaulting when the field is absent or non-number. */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/** Decode a wire string, defaulting to '' (PICKUP target fields). */
function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** Raw-message fields decoded exactly once per message, shared by every row. */
interface InputFrame {
  /** The raw wire message — per-action fields are bracket-read defensively. */
  raw: Record<string, unknown>;
  /** Movement axes, already clamped to [-1, 1]. */
  mx: number;
  my: number;
  /** Client sequence number (0 when absent or non-number). */
  sequence: number;
  /** Raw aim angle (undefined when absent or non-number). */
  aimAngle: number | undefined;
}

/**
 * One decoder row's output. `schemaData` feeds `validateInput`; `dispatchData`
 * is the exact `orchestrator.handleInput` payload. Building both in the same
 * expression is what prevents validation/dispatch drift — the double-switch
 * this table replaced validated PICKUP as `targetId: powerUpId || targetId`
 * but dispatched `{powerUpId, targetId}`, and SWITCH_SLOT validated
 * `slotIndex` but dispatched `slot`.
 *
 * Zod stays inside the rows: rejection semantics (and the `errors` payload of
 * every warn log) must remain exactly the schemas' — see inputSchemas.ts.
 */
interface DecodedAction {
  schema: (typeof InputSchemaByAction)[keyof typeof InputSchemaByAction];
  schemaData: Record<string, unknown>;
  dispatchData: Record<string, unknown>;
}

/**
 * Decode one action from the shared frame. `actionName` is the raw wire
 * string (the slot-index source for SWITCH_SLOT; unused by other rows).
 */
type ActionDecoder = (frame: InputFrame, actionName: string) => DecodedAction;

/**
 * Per-action decoder table — the single site where each action's raw fields
 * are decoded, validated, and shaped for dispatch. MOVE's row is used by the
 * MOVE branch below (MOVE-before-discrete ordering); the actions loop reaches
 * a row only after the integer guard below the `encodeInputAction` lookup —
 * that guard is the old switch's `default: continue` arm, absorbing
 * prototype-named wire strings the lookup does NOT return undefined for.
 */
const INPUT_DECODERS: Record<InputAction, ActionDecoder> = {
  [InputAction.MOVE]: ({ mx, my, aimAngle, sequence }) => ({
    schema: InputSchemaByAction[InputAction.MOVE],
    schemaData: { action: InputAction.MOVE, dx: mx, dy: my, aimAngle, sequence },
    dispatchData: { dx: mx, dy: my, aimAngle, tick: sequence },
  }),
  [InputAction.ATTACK]: ({ aimAngle, sequence }) => ({
    schema: InputSchemaByAction[InputAction.ATTACK],
    schemaData: { action: InputAction.ATTACK, aimAngle, sequence },
    dispatchData: { aimAngle, tick: sequence },
  }),
  [InputAction.THROW]: ({ aimAngle, sequence }) => ({
    schema: InputSchemaByAction[InputAction.THROW],
    schemaData: { action: InputAction.THROW, aimAngle, sequence },
    dispatchData: { aimAngle, tick: sequence },
  }),
  [InputAction.DASH]: ({ mx, my, sequence }) => ({
    schema: InputSchemaByAction[InputAction.DASH],
    schemaData: { action: InputAction.DASH, dx: mx, dy: my, sequence },
    dispatchData: { dx: mx, dy: my, tick: sequence },
  }),
  [InputAction.PICKUP]: ({ raw, sequence }) => {
    const powerUpId = readString(raw['powerUpId']);
    const targetId = readString(raw['targetId']);
    return {
      schema: InputSchemaByAction[InputAction.PICKUP],
      // Validation collapses to a single targetId (legacy powerUpId fallback).
      schemaData: { action: InputAction.PICKUP, targetId: powerUpId || targetId, sequence },
      // Dispatch passes both decoded fields through independently (pinned by
      // the wire-shape characterization test).
      dispatchData: { powerUpId, targetId, tick: sequence },
    };
  },
  [InputAction.SWITCH_SLOT]: ({ sequence }, actionName) => {
    const slotIndex = getSlotFromAction(actionName as InputActionName);
    return {
      schema: InputSchemaByAction[InputAction.SWITCH_SLOT],
      schemaData: { action: InputAction.SWITCH_SLOT, slotIndex, sequence },
      dispatchData: { slot: slotIndex, tick: sequence },
    };
  },
};

export function registerInputHandler(room: InputHandlingRoom): void {
  room.onMessage('input', (client: Client, data: InputMessage) => {
    if (!rateLimiter.check(client.sessionId)) {
      logger.warn('Rate limit exceeded', { playerId: client.sessionId });
      return;
    }

    if (!isObject(data)) return;

    const frame: InputFrame = {
      raw: data,
      mx: clampDirection(readNumber(data['movementX'], 0)),
      my: clampDirection(readNumber(data['movementY'], 0)),
      sequence: readNumber(data['sequence'], 0),
      aimAngle: typeof data['aimAngle'] === 'number' ? data['aimAngle'] : undefined,
    };
    const { mx, my, sequence, aimAngle: rawAimAngle } = frame;
    const orchestrator = room.getOrchestrator();

    if (mx !== 0 || my !== 0 || (rawAimAngle !== undefined && Number.isFinite(rawAimAngle))) {
      const { schema, schemaData, dispatchData } = INPUT_DECODERS[InputAction.MOVE](frame, 'MOVE');
      const result = validateInput(schema, schemaData);
      if (!result.success) {
        logger.warn('Invalid move input', {
          playerId: client.sessionId,
          errors: result.error.issues,
        });
      } else {
        orchestrator.handleInput(client.sessionId, InputAction.MOVE, dispatchData, sequence);
        room.recordInputTime(client.sessionId);
      }
    }

    const actions = Array.isArray(data['actions']) ? (data['actions'] as string[]).slice(0, 3) : [];
    if (actions.length > 0 && process.env.LOG_INPUT_DIAG === 'true') {
      logger.info(
        `[DIAG-RECV] playerId=${client.sessionId} actions=${JSON.stringify(actions)} aimAngle=${rawAimAngle} seq=${sequence}`,
      );
    }

    for (const action of actions) {
      if (typeof action !== 'string') continue;

      const sharedAction = encodeInputAction(action as InputActionName);
      // Absorb prototype-named wire strings: `INPUT_ACTION_MAP` is a plain
      // object, so 'constructor'/'toString'/'__proto__' make the lookup
      // return inherited functions/objects — NOT undefined. Only true
      // InputAction integers (the map's own values) reach the decoder table
      // — exactly the case set the old switch's `default: continue` accepted.
      if (sharedAction === undefined || !Number.isInteger(sharedAction)) continue;

      const { schema, schemaData, dispatchData } = INPUT_DECODERS[sharedAction](frame, action);
      const result = validateInput(schema, schemaData);
      if (!result.success) {
        logger.warn(`Invalid ${InputAction[sharedAction]} input`, {
          playerId: client.sessionId,
          errors: result.error.issues,
        });
        if (process.env.LOG_INPUT_DIAG === 'true') {
          logger.info(
            `[DIAG-RECV-REJECTED] playerId=${client.sessionId} action=${sharedAction} errors=${JSON.stringify(result.error.issues)}`,
          );
        }
        continue;
      }
      if (process.env.LOG_INPUT_DIAG === 'true') {
        logger.info(
          `[DIAG-RECV-VALID] playerId=${client.sessionId} action=${sharedAction} inputData=${JSON.stringify(schemaData)}`,
        );
      }

      orchestrator.handleInput(client.sessionId, sharedAction, dispatchData, sequence);
      room.recordInputTime(client.sessionId);
    }
  });
}

export { rateLimiter };
