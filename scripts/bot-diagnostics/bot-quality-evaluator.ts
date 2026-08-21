// Battle Royale Bot AI Quality Evaluator
// Replaces the flawed benchmark with a proper AI quality assessment
// Focuses on decision quality, strategic behavior, and skill progression

import type { BotRoundResult, RoundResult } from './bot-benchmark';

// Game phases with approximate timings (seconds)
enum GamePhase {
  EARLY_GAME = 0, // 0-120 seconds (first 2 zones)
  MID_GAME = 1, // 120-300 seconds (zones 3-5)
  LATE_GAME = 2, // 300-600 seconds (final 3 zones)
  SUDDEN_DEATH = 3, // 600+ seconds (final ring)
}

// AI Quality Categories
interface QualityMetrics {
  // Strategic Intelligence (40% weight)
  zoneAwareness: number; // How well bots position relative to safe zone
  resourceManagement: number; // Efficiency in acquiring/using resources
  decisionTiming: number; // Right time to fight vs loot vs move

  // Combat Effectiveness (30% weight)
  combatSkill: number; // Quality of combat decisions and execution
  weaponMastery: number; // Effective weapon usage and switching
  tacticalPositioning: number; // Kiting, cover usage, flanking

  // Survival & Adaptation (20% weight)
  survivalSkill: number; // Health management, escape tactics
  adaptation: number; // Response to changing game state
  problemSolving: number; // Navigation, unstuck, overcome obstacles

  // Efficiency & Behavior (10% weight)
  behaviorDiversity: number; // Not stuck in one behavior
  activityLevel: number; // Appropriate level of engagement
  efficiency: number; // Resource use per action
}

interface AIQualityReport {
  overallScore: number;
  breakdown: QualityMetrics;
  phaseAnalysis: {
    early: QualityMetrics;
    mid: QualityMetrics;
    late: QualityMetrics;
    suddenDeath: QualityMetrics;
  };
  strengths: string[];
  weaknesses: string[];
  recommendations: string[];
}

/**
 * Convert game tick to game phase
 */
function getGamePhase(tick: number, totalTicks: number): GamePhase {
  const timeElapsed = (tick / totalTicks) * 600; // 600 seconds total match
  if (timeElapsed < 120) return GamePhase.EARLY_GAME;
  if (timeElapsed < 300) return GamePhase.MID_GAME;
  if (timeElapsed < 600) return GamePhase.LATE_GAME;
  return GamePhase.SUDDEN_DEATH;
}

/**
 * Calculate zone awareness score
 */
function calculateZoneAwareness(bot: BotRoundResult, allBots: BotRoundResult[]): number {
  // Measure how well bots position themselves for safe zone transitions
  // In a real implementation, this would need zone position data
  // For now, use proxy metrics:

  let score = 0.5; // Base score

  // Reward bots that survive longer (implying good positioning)
  if (bot.survivedTicks > 1800) score += 0.2; // > 30 seconds alive
  if (bot.survivedTicks > 3600) score += 0.2; // > 60 seconds alive
  if (bot.survivedTicks > 5400) score += 0.1; // > 90 seconds alive

  // Penalize bots that die quickly (poor positioning)
  if (bot.survivedTicks < 600) score -= 0.3;

  // Reward movement (exploring = finding better positions)
  if (bot.distanceMoved > 2000) score += 0.1;

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate resource management score
 */
function calculateResourceManagement(bot: BotRoundResult): number {
  let score = 0.5; // Base score

  // Reward acquiring weapons
  if (bot.realWeaponCount > 0) score += 0.2;
  if (bot.realWeaponCount > 1) score += 0.1;
  if (bot.realWeaponCount > 2) score += 0.1;

  // Reward weapon switching (strategic adaptation)
  if (bot.weaponSwitches > 0) score += 0.1;
  if (bot.weaponSwitches > 3) score += 0.1;

  // Reward efficiency: weapons per weapon switch
  if (bot.weaponSwitches > 0) {
    const weaponsPerSwitch = bot.maxWeaponsHeld / bot.weaponSwitches;
    if (weaponsPerSwitch > 2) score += 0.1;
  }

  // Penalize hoarding without using
  if (bot.realWeaponCount > 2 && bot.attacksCount === 0) {
    score -= 0.3;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate combat skill score
 */
function calculateCombatSkill(bot: BotRoundResult): number {
  let score = 0.5; // Base score

  // Reward dealing damage
  if (bot.damageDealt > 0) score += 0.2;
  if (bot.damageDealt > 50) score += 0.1;
  if (bot.damageDealt > 100) score += 0.1;

  // Reward efficient attacks (hitting vs missing)
  if (bot.attacksCount > 0) {
    const damagePerAttack = bot.damageDealt / bot.attacksCount;
    if (damagePerAttack > 5) score += 0.2; // Actually hitting
    if (damagePerAttack > 10) score += 0.1; // Good accuracy
  }

  // Reward tactical actions
  if (bot.blocksCount > 0) score += 0.1; // Defensive play
  if (bot.throwsCount > 0) score += 0.1; // Using special abilities

  // Penalize spammy behavior
  if (bot.attacksCount > 300) score -= 0.2; // Button mashing
  if (bot.dashesCount > 200) score -= 0.1; // Dashing too much

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate decision timing score
 */
function calculateDecisionTiming(bot: BotRoundResult, phase: GamePhase): number {
  let score = 0.5; // Base score

  // Phase-appropriate behavior scoring
  switch (phase) {
    case GamePhase.EARLY_GAME:
      // Early game: should focus on looting and exploration
      if (bot.realWeaponCount > 0) score += 0.2; // Found weapons quickly
      if (bot.behaviorCounts.looting > bot.behaviorCounts.combat) score += 0.2;
      if (bot.distanceMoved > 1000) score += 0.1; // Exploring
      break;

    case GamePhase.MID_GAME:
      // Mid game: should start engaging enemies
      if (bot.combatEngagements > 0) score += 0.2;
      if (bot.attacksCount > 10) score += 0.1;
      if (bot.realWeaponCount > 0) score += 0.1;
      break;

    case GamePhase.LATE_GAME:
      // Late game: should be aggressive and survival-focused
      if (bot.damageDealt > 20) score += 0.2;
      if (bot.health > 20) score += 0.1; // Good health management
      if (bot.combatEngagements > 2) score += 0.1;
      break;

    case GamePhase.SUDDEN_DEATH:
      // Sudden death: fight to survive
      if (bot.damageDealt > 10) score += 0.2;
      if (bot.alive) score += 0.2;
      break;
  }

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate survival skill score
 */
function calculateSurvivalSkill(bot: BotRoundResult): number {
  let score = 0.5; // Base score

  // Reward staying alive longer
  if (bot.survivedTicks > 3600) score += 0.3; // > 60 seconds
  if (bot.survivedTicks > 5400) score += 0.2; // > 90 seconds

  // Reward good final health
  if (bot.finalHealth > 50) score += 0.2;
  if (bot.finalHealth > 80) score += 0.1;

  // Reward escape tactics
  if (bot.dashesCount > 0 && bot.dashesCount < 100) score += 0.1; // Used dash strategically

  // Penalize taking too much damage
  if (bot.damageTaken < 50) score += 0.1; // Low damage taken
  if (bot.damageTaken > 200) score -= 0.2; // Too much damage

  return Math.max(0, Math.min(1, score));
}

/**
 * Calculate behavior diversity score
 */
function calculateBehaviorDiversity(bot: BotRoundResult): number {
  const behaviors = Object.keys(bot.behaviorCounts);
  const totalTicks = Object.values(bot.behaviorCounts).reduce((a, b) => a + b, 0);

  if (totalTicks === 0) return 0;

  // Count behaviors that represent >5% of time
  const significantBehaviors = behaviors.filter(
    (beh) => bot.behaviorCounts[beh] > totalTicks * 0.05,
  );

  // Reward having 3+ different significant behaviors
  if (significantBehaviors.length >= 3) return 1.0;
  if (significantBehaviors.length >= 2) return 0.7;
  if (significantBehaviors.length >= 1) return 0.3;

  return 0.1; // Stuck in one behavior
}

/**
 * Evaluate AI quality for a single bot
 */
function evaluateBot(bot: BotRoundResult, allBots: BotRoundResult[]): QualityMetrics {
  return {
    zoneAwareness: calculateZoneAwareness(bot, allBots),
    resourceManagement: calculateResourceManagement(bot),
    decisionTiming: calculateDecisionTiming(bot, getGamePhase(bot.ticks, bot.ticks)),
    combatSkill: calculateCombatSkill(bot),
    weaponMastery: Math.min(1, bot.realWeaponCount / 3 + bot.weaponSwitches / 10),
    tacticalPositioning: 0.5, // Would need more detailed position data
    survivalSkill: calculateSurvivalSkill(bot),
    adaptation: 0.5, // Would need behavior change over time
    problemSolving: 0.5, // Would need navigation success metrics
    behaviorDiversity: calculateBehaviorDiversity(bot),
    activityLevel: Math.min(1, bot.activeRate * 2),
    efficiency: Math.min(1, (bot.damageDealt + bot.survivedTicks) / (bot.attacksCount + 100)),
  };
}

/**
 * Evaluate AI quality for all bots in a round
 */
function evaluateRoundQuality(roundResults: RoundResult): AIQualityReport {
  const allBots = roundResults.bots;

  // Evaluate each bot
  const botEvaluations = allBots.map((bot) => evaluateBot(bot, allBots));

  // Calculate average metrics
  const avgMetrics = botEvaluations.reduce(
    (acc, eval) => {
      return {
        zoneAwareness: acc.zoneAwareness + eval.zoneAwareness,
        resourceManagement: acc.resourceManagement + eval.resourceManagement,
        decisionTiming: acc.decisionTiming + eval.decisionTiming,
        combatSkill: acc.combatSkill + eval.combatSkill,
        weaponMastery: acc.weaponMastery + eval.weaponMastery,
        tacticalPositioning: acc.tacticalPositioning + eval.tacticalPositioning,
        survivalSkill: acc.survivalSkill + eval.survivalSkill,
        adaptation: acc.adaptation + eval.adaptation,
        problemSolving: acc.problemSolving + eval.problemSolving,
        behaviorDiversity: acc.behaviorDiversity + eval.behaviorDiversity,
        activityLevel: acc.activityLevel + eval.activityLevel,
        efficiency: acc.efficiency + eval.efficiency,
      };
    },
    {
      zoneAwareness: 0,
      resourceManagement: 0,
      decisionTiming: 0,
      combatSkill: 0,
      weaponMastery: 0,
      tacticalPositioning: 0,
      survivalSkill: 0,
      adaptation: 0,
      problemSolving: 0,
      behaviorDiversity: 0,
      activityLevel: 0,
      efficiency: 0,
    },
  );

  // Normalize by number of bots
  const numBots = allBots.length;
  const breakdown: QualityMetrics = {
    zoneAwareness: avgMetrics.zoneAwareness / numBots,
    resourceManagement: avgMetrics.resourceManagement / numBots,
    decisionTiming: avgMetrics.decisionTiming / numBots,
    combatSkill: avgMetrics.combatSkill / numBots,
    weaponMastery: avgMetrics.weaponMastery / numBots,
    tacticalPositioning: avgMetrics.tacticalPositioning / numBots,
    survivalSkill: avgMetrics.survivalSkill / numBots,
    adaptation: avgMetrics.adaptation / numBots,
    problemSolving: avgMetrics.problemSolving / numBots,
    behaviorDiversity: avgMetrics.behaviorDiversity / numBots,
    activityLevel: avgMetrics.activityLevel / numBots,
    efficiency: avgMetrics.efficiency / numBots,
  };

  // Calculate weighted overall score
  const weights = {
    zoneAwareness: 0.1,
    resourceManagement: 0.1,
    decisionTiming: 0.1,
    combatSkill: 0.15,
    weaponMastery: 0.05,
    tacticalPositioning: 0.1,
    survivalSkill: 0.1,
    adaptation: 0.1,
    problemSolving: 0.05,
    behaviorDiversity: 0.05,
    activityLevel: 0.05,
    efficiency: 0.05,
  };

  const overallScore = Object.entries(breakdown).reduce((sum, [key, value]) => {
    const weight = weights[key as keyof typeof weights];
    return sum + value * weight * 100;
  }, 0);

  return {
    overallScore: Math.round(overallScore),
    breakdown,
    phaseAnalysis: {
      early: breakdown, // Placeholder - would need phase-specific data
      mid: breakdown,
      late: breakdown,
      suddenDeath: breakdown,
    },
    strengths: [],
    weaknesses: [],
    recommendations: [],
  };
}

/**
 * Generate improvement recommendations
 */
function generateRecommendations(report: AIQualityReport): string[] {
  const recommendations: string[] = [];
  const breakdown = report.breakdown;

  // Analyze weaknesses and generate specific recommendations
  if (breakdown.zoneAwareness < 0.4) {
    recommendations.push('Improve zone positioning - bots should prioritize safe zone movement');
  }

  if (breakdown.resourceManagement < 0.4) {
    recommendations.push('Enhance looting efficiency - better weapon acquisition and switching');
  }

  if (breakdown.decisionTiming < 0.4) {
    recommendations.push(
      'Improve phase-appropriate decisions - loot early, fight mid, survive late',
    );
  }

  if (breakdown.combatSkill < 0.4) {
    recommendations.push('Enhance combat tactics - better aiming, positioning, and targeting');
  }

  if (breakdown.weaponMastery < 0.4) {
    recommendations.push('Improve weapon selection and switching strategies');
  }

  if (breakdown.behaviorDiversity < 0.4) {
    recommendations.push('Reduce repetitive behavior - add more decision variety');
  }

  if (breakdown.activityLevel < 0.4) {
    recommendations.push('Increase bot activity - reduce idle time');
  }

  if (breakdown.efficiency < 0.4) {
    recommendations.push('Improve action efficiency - reduce wasted movements and attacks');
  }

  return recommendations;
}

export {
  type AIQualityReport,
  type QualityMetrics,
  GamePhase,
  evaluateRoundQuality,
  generateRecommendations,
};
