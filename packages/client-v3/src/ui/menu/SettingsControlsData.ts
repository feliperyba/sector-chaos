/**
 * Controls-guide data — the single table the settings modal's controls grid
 * renders. Semantics verified against `input/InputCollector.ts`:
 *   - MOVE: WASD **or** cursor keys (`sampleLiveMovement` reads both)
 *   - ATTACK: pointer left button held (continuous, NOT an edge)
 *   - THROW: pointer right button edge (`pollEdgeActions` JustDown)
 *   - DASH: Space edge · PICKUP: E edge (chests + weapon pickups)
 *   - WEAPON_SLOT_1..4: keys 1-4 edges + mouse-wheel rotation
 *
 * `frames` reference the `prompts` atlas (Kenney Keyboard & Mouse prompts —
 * keys are the filenames sans extension, see
 * scripts/asset-pipeline/build-input-prompts.ts).
 */

export interface ControlRow {
  /** Action label (left column, uppercase). */
  action: string;
  /** Prompt atlas frames, right-aligned within the row. */
  frames: readonly string[];
}

export const CONTROLS_ATLAS = 'prompts';
/** On-screen display size of a 64px prompt sprite (downscale — crisp). */
export const PROMPT_SIZE = 48;
/** Horizontal gap between adjacent prompt sprites in a row. */
export const PROMPT_GAP = 8;
/** Vertical stride of a grid row. */
export const CONTROL_ROW_HEIGHT = 58;

export const CONTROL_ROWS: readonly ControlRow[] = [
  { action: 'MOVE', frames: ['keyboard_w', 'keyboard_a', 'keyboard_s', 'keyboard_d'] },
  { action: 'ATTACK (HOLD)', frames: ['mouse_left'] },
  { action: 'THROW', frames: ['mouse_right'] },
  { action: 'DASH', frames: ['keyboard_space'] },
  { action: 'PICK UP / CHEST', frames: ['keyboard_e'] },
  { action: 'WEAPON SLOTS', frames: ['keyboard_1', 'keyboard_2', 'keyboard_3', 'keyboard_4'] },
  { action: 'CYCLE WEAPON', frames: ['mouse_scroll'] },
];

/** Caption under the grid — the WASD alternative InputCollector also reads. */
export const CONTROLS_CAPTION = 'arrow keys also move';
