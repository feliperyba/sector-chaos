import { DesignTokens } from './DesignTokens.js';

export const TweenPresets = {
  buttonHover: {
    scaleX: 1.05,
    scaleY: 1.05,
    duration: DesignTokens.duration.instant,
    ease: DesignTokens.easing.snappy,
  },

  buttonPress: {
    scaleX: 0.95,
    scaleY: 0.95,
    duration: DesignTokens.duration.instant,
    ease: DesignTokens.easing.snappy,
  },

  buttonRelease: {
    scaleX: 1.0,
    scaleY: 1.0,
    duration: DesignTokens.duration.quick,
    ease: DesignTokens.easing.backOut,
  },

  buttonReset: {
    scaleX: 1.0,
    scaleY: 1.0,
    duration: DesignTokens.duration.fast,
    ease: DesignTokens.easing.snappy,
  },
} as const;
