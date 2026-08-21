# ADR 0034: RuntimeGameController Rewrite — Server-Authoritative Dev Console Tool

## Status: Accepted

Implementation verified in `debug/RuntimeGameController.ts`; status flipped because the rewrite shipped. This ticket (refactor #17) also closes an always-on production debug surface in `MainMenuScene.ts` — a security fix (the inline `window.__SECTO_DEBUG__` hook was installed unconditionally in prod).

## Context
The RuntimeGameController was built as a standalone mock that queues inputs into a local array, simulates state mutation, and runs its own game loop. This violates the project's server-authoritative architecture — the client must never hold state ownership.

## Decision
Rewrite RuntimeGameController as a thin, dependency-injected wrapper that:
1. Constructs InputFrame objects with correct fields
2. Sends them through `Connection.sendInput()` (the real Colyseus pipeline)
3. Reads state from `StateSync.getPlayer()` (server-authoritative room.state)
4. Does NOT run prediction, local state mutation, or its own game loop

Dependencies injected as functions, not class instances, for testability.

## Consequences

### Positive
- Maintains server authority — client is input sender + state reader
- Trivial to test (mock functions)
- ~150 lines instead of 582 — no dead code
- Works against live Docker environment via browser dev console

### Negative
- No client-side prediction for injected inputs (server response visible after round-trip)
- Sequence counter must be coordinated with InputCollector
- Convenience methods only handle single-action frames

### Risks
- **Sequence collision** if InputCollector and controller both active simultaneously
  - Mitigation: `getNextSeq()` dep points to same counter; document mutual exclusion
