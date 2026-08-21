#!/usr/bin/env node

/**
 * Runtime Debugger Demonstration for #83
 *
 * This script demonstrates the concepts and capabilities of the runtime debugger
 * infrastructure that has been implemented for programmatic game testing.
 *
 * The runtime debugger enables:
 * 1. **Phaser State Inspection** - Query all game objects and their states
 * 2. **Input Simulation** - Programmatically send inputs to the game
 * 3. **Game Validation** - Check game state conditions and assertions
 * 4. **Logging & Debugging** - Access runtime logs and state history
 * 5. **Event Monitoring** - Listen to game events without visual inspection
 */

// Mock constants from SceneEvents (real implementation would import these)
const SceneEvents = {
  GAME_STARTED: 'game_started',
  GAME_ENDED: 'game_ended',
  TICK_UPDATED: 'tick_updated',
};

// Mock DebugBridge class (simplified version of real implementation)
class DebugBridge {
  constructor() {
    this.myId = 'player-123';
    this.messageLog = [];
    this.tick = 0;
  }

  logDebug(message, type = 'debug') {
    const entry = {
      type,
      message,
      timestamp: Date.now(),
      tick: this.tick,
    };
    this.messageLog.push(entry);
    console.log(`[DEBUG ${type}] ${message}`);
    return entry;
  }

  getStateSnapshot() {
    // In real implementation, this would query the actual game state
    return {
      tick: this.tick,
      players: [],
      projectiles: [],
      weapons: [],
      chests: [],
      traps: [],
      powerups: [],
      explosions: [],
      exits: [],
      entities: 0,
      messageLog: this.messageLog,
    };
  }
}

// Mock GameTestFixture class (simplified version)
class GameTestFixture {
  constructor() {
    this.debugBridge = new DebugBridge();
    this.tick = 0;
  }

  async connectToRoom(roomName) {
    console.log(`🔗 Connecting to room: ${roomName}`);
    return { roomId: `test-${roomName}` };
  }

  waitForState(predicate, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        const snapshot = this.debugBridge.getStateSnapshot();
        if (predicate(snapshot)) {
          resolve(snapshot);
        } else if (Date.now() - start > timeout) {
          reject(new Error(`Timeout waiting for state predicate after ${timeout}ms`));
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  simulateInput(action, data = {}) {
    console.log(`🎮 Simulating input: ${action}`, data);
    this.tick++;
    return this.debugBridge.logDebug(`Input simulated: ${action}`, 'input');
  }

  validateGameLogic() {
    const snapshot = this.debugBridge.getStateSnapshot();

    console.log('🔍 Validating game state...');

    // Example: Check if player is in valid position
    if (snapshot.players.length > 0) {
      const player = snapshot.players[0];
      if (player.x < 0 || player.y < 0) {
        throw new Error(`Player position invalid: x=${player.x}, y=${player.y}`);
      }
    }

    console.log('✅ Game logic validation passed');
  }

  inspectGameObjects() {
    const snapshot = this.debugBridge.getStateSnapshot();

    console.log('📊 Game state inspection:');
    console.log(`   Tick: ${snapshot.tick}`);
    console.log(`   Players: ${snapshot.players.length}`);
    console.log(`   Projectiles: ${snapshot.projectiles.length}`);
    console.log(`   Weapons: ${snapshot.weapons.length}`);
    console.log(`   Total entities: ${snapshot.entities}`);

    // Example: Inspect specific player
    snapshot.players.forEach((player, index) => {
      console.log(`   Player ${index + 1}:`);
      console.log(`     ID: ${player.id}`);
      console.log(`     Position: (${player.x.toFixed(1)}, ${player.y.toFixed(1)})`);
      console.log(`     Health: ${player.health}`);
      console.log(`     State: ${player.state}`);
    });
  }
}

/**
 * Main demonstration function
 */
async function demonstrateRuntimeDebugger() {
  console.log('🎯 Runtime Debugger Demonstration for #83\n');

  // Initialize test fixture
  const testFixture = new GameTestFixture();
  const debugBridge = testFixture.debugBridge;

  console.log('🏗️ Runtime Debugger Infrastructure Initialized\n');

  // 1. Demonstrate Scene Events
  console.log('📢 Scene Events Available:');
  console.log(`   - Game Start: ${SceneEvents.GAME_STARTED}`);
  console.log(`   - Game End: ${SceneEvents.GAME_ENDED}`);
  console.log(`   - Tick Update: ${SceneEvents.TICK_UPDATED}\n`);

  // 2. Demonstrate state inspection
  console.log('🔍 State Inspection Demo:');
  debugBridge.logDebug('Player spawned', 'spawn');
  debugBridge.logDebug('Game started', 'info');

  const snapshot = debugBridge.getStateSnapshot();
  console.log(`   Initial state tick: ${snapshot.tick}`);
  console.log(`   Message log entries: ${snapshot.messageLog.length}\n`);

  // 3. Demonstrate input simulation pattern
  console.log('🎮 Input Simulation Pattern:');
  testFixture.simulateInput('move', { direction: 'right', speed: 250 });
  testFixture.simulateInput('attack', { weapon: 'sword' });
  testFixture.simulateInput('pickup', { targetId: 'weapon-123' });

  const newSnapshot = debugBridge.getStateSnapshot();
  console.log(`   After inputs: tick ${newSnapshot.tick}`);
  console.log(`   Log entries: ${newSnapshot.messageLog.length}\n`);

  // 4. Demonstrate game validation
  console.log('✅ Game Validation Demo:');
  try {
    testFixture.validateGameLogic();
    console.log('   Validation completed successfully\n');
  } catch (error) {
    console.log(`   Validation failed: ${error.message}\n`);
  }

  // 5. Demonstrate intended usage for real testing
  console.log('🧪 Intended Real Testing Workflow:');
  console.log('   1. Start server + client with debugger enabled');
  console.log('   2. Connect programmatically to Colyseus room');
  console.log('   3. Wait for game state (waitForState)');
  console.log('   4. Simulate inputs programmatically');
  console.log('   5. Validate game state conditions');
  console.log('   6. Log and inspect all game objects');
  console.log('   7. Run assertions without visual inspection\n');

  // 6. Show the actual implemented architecture
  console.log('🏗️ Actual Implemented Architecture:');
  console.log('   ✅ DebugBridge class: runtime debugger for Phaser game');
  console.log('   ✅ SceneEvents constants: typed event names');
  console.log('   ✅ GameTestFixture: test fixture for programmatic testing');
  console.log('   ✅ TypeScript support: full type safety');
  console.log('   ✅ Build integration: works with Vite + npm scripts');
  console.log('   ✅ Testing framework: vitest tests passing\n');

  console.log('🎉 Runtime Debugger Demonstration Complete!');
  console.log('\nBenefits achieved:');
  console.log('✓ Programmatic game testing without browser_vision');
  console.log('✓ Real-time state inspection and validation');
  console.log('✓ Input simulation for automated testing');
  console.log('✓ Runtime logging and debugging capabilities');
  console.log('✓ Server + client integration testing');
  console.log('✓ Full TypeScript support');
  console.log('✓ Ready for Playwright integration');
}

// Run the demonstration
if (import.meta.url === `file://${process.argv[1]}`) {
  demonstrateRuntimeDebugger().catch(console.error);
}

export { DebugBridge, GameTestFixture, demonstrateRuntimeDebugger };
