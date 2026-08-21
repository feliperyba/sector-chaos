export const TRANSITION_DURATION = {
  COVER: 800,
  HOLD_BUFFER: 50,
  REVEAL: 800,
} as const;

export const SCENE_KEYS = {
  MAIN_MENU: 'MainMenuScene',
  MATCHMAKING: 'MatchmakingScene',
  GAME: 'GameScene',
  TRANSITION: 'TransitionScene',
} as const;

export type SceneKey = (typeof SCENE_KEYS)[keyof typeof SCENE_KEYS];
