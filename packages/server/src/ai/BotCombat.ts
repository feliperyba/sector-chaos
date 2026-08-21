/**
 * BotCombat — public API re-export hub.
 *
 * The original monolithic file was split (pure mechanical extraction, zero
 * behavior changes) into focused partial modules:
 *   - BotCombatShared    constants + shared helpers (hazard blend, predictAim,
 *                        strafe selection)
 *   - BotCombatEngage    executeEngage + executeRanged
 *   - BotCombatRetreat   executeRetreat
 *   - BotCombatDemolition executeDemolition
 *
 * This file re-exports the original public surface so existing import paths
 * (`from './BotCombat.ts'`) continue to resolve unchanged. (The windup-dodge
 * check moved to the Reactor — ai/reactor/ReactorConditions.ts
 * detectWindupThreat — in bot-ai-v2 ticket 04: the windup reaction is a
 * Reactor priority, not an executor branch.)
 */
export { executeEngage } from './BotCombatEngage.ts';
export { executeRetreat } from './BotCombatRetreat.ts';
export { executeDemolition } from './BotCombatDemolition.ts';
