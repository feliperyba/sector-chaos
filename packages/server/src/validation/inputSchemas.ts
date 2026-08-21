import { z } from 'zod';
import { InputAction } from '@sector-battle/shared';

const sequenceField = z.number().int().nonnegative();
const aimAngleField = z
  .number()
  .min(-Math.PI)
  .max(Math.PI * 2);

export const MoveInputSchema = z.object({
  action: z.literal(InputAction.MOVE),
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
  aimAngle: aimAngleField.optional(),
  sequence: sequenceField,
});

export const AttackInputSchema = z.object({
  action: z.literal(InputAction.ATTACK),
  aimAngle: aimAngleField.optional(),
  sequence: sequenceField,
});

export const ThrowInputSchema = z.object({
  action: z.literal(InputAction.THROW),
  aimAngle: aimAngleField.optional(),
  sequence: sequenceField,
});

export const PickupInputSchema = z.object({
  action: z.literal(InputAction.PICKUP),
  targetId: z.string().optional().default(''),
  sequence: sequenceField,
});

export const SwitchSlotInputSchema = z.object({
  action: z.literal(InputAction.SWITCH_SLOT),
  slotIndex: z.number().int().min(0).max(3),
  sequence: sequenceField,
});

export const DashInputSchema = z.object({
  action: z.literal(InputAction.DASH),
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
  sequence: sequenceField,
});

export type MoveInput = z.infer<typeof MoveInputSchema>;
export type AttackInput = z.infer<typeof AttackInputSchema>;
export type ThrowInput = z.infer<typeof ThrowInputSchema>;
export type PickupInput = z.infer<typeof PickupInputSchema>;
export type SwitchSlotInput = z.infer<typeof SwitchSlotInputSchema>;
export type DashInput = z.infer<typeof DashInputSchema>;

export const InputSchemaByAction = {
  [InputAction.MOVE]: MoveInputSchema,
  [InputAction.ATTACK]: AttackInputSchema,
  [InputAction.THROW]: ThrowInputSchema,
  [InputAction.PICKUP]: PickupInputSchema,
  [InputAction.SWITCH_SLOT]: SwitchSlotInputSchema,
  [InputAction.DASH]: DashInputSchema,
} as const;

export function validateInput<T extends z.ZodType>(schema: T, data: unknown) {
  return schema.safeParse(data);
}

export const ChatInputSchema = z
  .object({
    text: z.string().min(1).max(200),
  })
  .strict();

export const SelectNameInputSchema = z
  .object({
    name: z.string().min(1).max(20),
  })
  .strict();

export const SelectColorInputSchema = z
  .object({
    colorIndex: z.number().int().min(0).max(63),
  })
  .strict();

export const SelectMapInputSchema = z
  .object({
    mapId: z.string().min(1).max(64),
  })
  .strict();

export const KickPlayerInputSchema = z
  .object({
    playerId: z.string().min(1),
  })
  .strict();

export function validateChatInput(data: unknown) {
  return ChatInputSchema.safeParse(data);
}

export function validateSelectNameInput(data: unknown) {
  return SelectNameInputSchema.safeParse(data);
}

export function validateSelectColorInput(data: unknown) {
  return SelectColorInputSchema.safeParse(data);
}

export function validateSelectMapInput(data: unknown) {
  return SelectMapInputSchema.safeParse(data);
}

export function validateKickPlayerInput(data: unknown) {
  return KickPlayerInputSchema.safeParse(data);
}
