/**
 * Shared deterministic animation simulation.
 *
 * Runs identically on server (authoritative, drives the swept weapon hitbox)
 * and client (prediction for the local player, reconstruction for remotes).
 * One step = one 60Hz tick. See AnimTypes.ts for the determinism contract.
 */
export * from './AnimTypes.js';
export * from './DetSpring.js';
export * from './IKArmSolver.js';
export * from './AnimEasing.js';
export * from './WeaponPose.js';
export * from './AnimTiming.js';
export * from './poses/index.js';
export * from './stepAnimation.js';
export * from './reactions.js';
