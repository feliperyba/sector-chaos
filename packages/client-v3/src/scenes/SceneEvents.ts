// Phaser scene event constants
export const SceneEvents = {
  GAME_STARTED: 'game_started',
  GAME_ENDED: 'game_ended',
  TICK_UPDATED: 'tick_updated',
} as const;

// Type safe event names
export type SceneEventName = (typeof SceneEvents)[keyof typeof SceneEvents];
