import { Schema, type } from '@colyseus/schema';
import type { ZoneData } from '../../domain/services/ZoneService.ts';

export class ZoneSchema extends Schema {
  @type('float32') centerX: number = 0;
  @type('float32') centerY: number = 0;
  @type('float32') targetCenterX: number = 0;
  @type('float32') targetCenterY: number = 0;
  @type('boolean') isTransitioningCenter: boolean = false;
  @type('float32') currentRadius: number = 0;
  @type('float32') targetRadius: number = 0;
  @type('uint8') phase: number = 0;
  @type('float64') phaseStartTime: number = 0;
  @type('float64') phaseEndTime: number = 0;
  @type('boolean') hasNextPhasePreview: boolean = false;
  @type('float32') nextPhaseCenterX: number = 0;
  @type('float32') nextPhaseCenterY: number = 0;
  @type('float32') nextPhaseRadius: number = 0;

  syncFrom(zoneData: ZoneData): void {
    this.centerX = zoneData.centerX;
    this.centerY = zoneData.centerY;
    this.targetCenterX = zoneData.targetCenterX;
    this.targetCenterY = zoneData.targetCenterY;
    this.isTransitioningCenter = zoneData.isTransitioningCenter;
    this.currentRadius = zoneData.currentRadius;
    this.targetRadius = zoneData.targetRadius;
    this.phase = zoneData.phase;
    this.phaseStartTime = zoneData.phaseStartTime;
    this.phaseEndTime = zoneData.phaseEndTime;
  }
}
