export interface NextPhasePreview {
  centerX: number;
  centerY: number;
  radius: number;
}

export interface ZoneState {
  currentPhase: number;
  centerX: number;
  centerY: number;
  targetCenterX: number;
  targetCenterY: number;
  isTransitioningCenter: boolean;
  currentRadius: number;
  targetRadius: number;
  shrinkSpeed: number;
  damagePerTick: number;
  nextShrinkTick: number;
  phaseStartTime: number;
  phaseEndTime: number;
  nextPhasePreview: NextPhasePreview | null;
}
