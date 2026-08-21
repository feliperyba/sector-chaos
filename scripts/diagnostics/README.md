# Game Runtime Diagnostics

Scripts for diagnosing live game issues without modifying source code.

## browser-input-test.js

Pipeline-spanning input validation. Paste into browser DevTools console.

**What it tests:**

- Raw keyboard events reaching the page (`[DIAG-KEYS]`)
- Pointer/click events on the canvas (`[DIAG-POINTER]`)

**How to use:**

1. Start game: `docker compose up -d`
2. Open http://localhost:8080 in your browser
3. Open DevTools (F12) → Console tab
4. Copy-paste the contents of `browser-input-test.js`
5. Press WASD and click — watch for diagnostic logs

**Interpreting results:**

- `[DIAG-KEYS]` appears when you press keys → DOM keyboard works
- `[DIAG-POINTER]` appears on click → DOM pointer works
- No `[DIAG-KEYS]` → Phaser keyboard plugin not capturing events
- No `[DIAG-POINTER]` → Canvas not receiving pointer events

## mapLoaded debugging pattern

If the game renders but the player can't move (the "Visual Success Trap"):

1. Check `GameScene.update()` for early returns — `mapLoaded` and `connection?.isConnected`
2. `mapLoaded` is set via `onMapLoaded` callback in `GameSceneSetup.ts` → fires when map data arrives
3. If `mapLoaded` stays `false`, the callback never fired — trace `onMapData` in the connection handler
4. Common cause: primitives copied by value from async callbacks (JS gotcha)

## Common issues

| Symptom                                | Likely cause                                          |
| -------------------------------------- | ----------------------------------------------------- |
| Game renders, player frozen, bots move | `mapLoaded` never set to `true`                       |
| "AFK WARNING" immediately              | Input pipeline broken somewhere                       |
| Music plays, no tick loop              | Room in FINISHED phase, new client joined zombie room |
| Map renders but no sprites             | Atlas/collision grid mismatch                         |
