import { describe, it, expect } from 'vitest';
import { ZoneSchema } from '../../../src/infrastructure/schemas/ZoneSchema.ts';
import { EliminationRecordSchema } from '../../../src/infrastructure/schemas/EliminationRecordSchema.ts';
import type { ZoneData } from '../../../src/domain/services/ZoneService.ts';

describe('ZoneSchema', () => {
  it('has correct default values', () => {
    const schema = new ZoneSchema();

    expect(schema.centerX).toBe(0);
    expect(schema.centerY).toBe(0);
    expect(schema.targetCenterX).toBe(0);
    expect(schema.targetCenterY).toBe(0);
    expect(schema.isTransitioningCenter).toBe(false);
    expect(schema.currentRadius).toBe(0);
    expect(schema.targetRadius).toBe(0);
    expect(schema.phase).toBe(0);
    expect(schema.phaseStartTime).toBe(0);
    expect(schema.phaseEndTime).toBe(0);
  });

  it('syncFrom copies all ZoneData fields into schema', () => {
    const schema = new ZoneSchema();
    const zoneData: ZoneData = {
      centerX: 100.5,
      centerY: 200.3,
      targetCenterX: 150.0,
      targetCenterY: 180.0,
      isTransitioningCenter: true,
      currentRadius: 500,
      targetRadius: 300,
      phase: 3,
      phaseStartTime: 1000000,
      phaseEndTime: 1120000,
    };

    schema.syncFrom(zoneData);

    expect(schema.centerX).toBe(100.5);
    expect(schema.centerY).toBe(200.3);
    expect(schema.targetCenterX).toBe(150.0);
    expect(schema.targetCenterY).toBe(180.0);
    expect(schema.isTransitioningCenter).toBe(true);
    expect(schema.currentRadius).toBe(500);
    expect(schema.targetRadius).toBe(300);
    expect(schema.phase).toBe(3);
    expect(schema.phaseStartTime).toBe(1000000);
    expect(schema.phaseEndTime).toBe(1120000);
  });
});

describe('EliminationRecordSchema', () => {
  it('has correct default values', () => {
    const schema = new EliminationRecordSchema();

    expect(schema.order).toBe(0);
    expect(schema.playerId).toBe('');
    expect(schema.killerId).toBe('');
    expect(schema.weaponType).toBe(0);
    expect(schema.timestamp).toBe(0);
  });
});
