import { describe, it, expect } from 'vitest';
import { SceneEvents } from '../../src/scenes/SceneEvents.js';

describe('Runtime Debugger Types and Events', () => {
  it('should provide SceneEvents constants', () => {
    expect(SceneEvents.GAME_STARTED).toBe('game_started');
    expect(SceneEvents.GAME_ENDED).toBe('game_ended');
    expect(SceneEvents.TICK_UPDATED).toBe('tick_updated');
  });

  it('should have event values that are strings', () => {
    const eventValues = Object.values(SceneEvents);
    eventValues.forEach((value) => {
      expect(typeof value).toBe('string');
    });
    expect(eventValues).toHaveLength(3);
  });

  it('should have event keys that are strings', () => {
    const eventKeys = Object.keys(SceneEvents);
    expect(eventKeys).toContain('GAME_STARTED');
    expect(eventKeys).toContain('GAME_ENDED');
    expect(eventKeys).toContain('TICK_UPDATED');
  });
});

// Test that the debug module can be imported without errors
describe('Debug Module Imports', () => {
  it('should import SceneEvents without errors', () => {
    expect(SceneEvents).toBeDefined();
  });
});
