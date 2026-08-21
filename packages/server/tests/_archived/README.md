# Archived Tests

This directory contains test files that were archived because they use mocking anti-patterns for Colyseus framework internals.

## Why were these files archived?

These tests used `vi.spyOn()` to mock Colyseus Room methods (`setState`, `setSimulationInterval`, `broadcast`, `onMessage`) instead of using the official `@colyseus/testing` utilities.

### Anti-pattern (what NOT to do)

```ts
vi.spyOn(GameRoom.prototype, 'setState').mockImplementation(function (this: GameRoom, state) {
  this.state = state;
});
vi.spyOn(GameRoom.prototype, 'setSimulationInterval').mockImplementation(() => {});
vi.spyOn(GameRoom.prototype, 'broadcast').mockImplementation(() => {});
vi.spyOn(GameRoom.prototype, 'onMessage').mockImplementation(function (...) { ... });
```

This approach mocks framework internals, making tests brittle and disconnected from real Colyseus behavior.

### Correct pattern (use `@colyseus/testing`)

```ts
import { boot } from '@colyseus/testing';

const colyseus = await boot(server);
const room = await colyseus.createRoom('game', options);
const client = await colyseus.connectTo(room, clientOptions);
```

See `tests/rooms/LobbyRoom.test.ts` for a reference implementation using `@colyseus/testing`.

## Archived files

| File               | Original location              | Reason                                                                                          |
| ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------- |
| `GameRoom.test.ts` | `tests/rooms/GameRoom.test.ts` | Mocked `setState`, `setSimulationInterval`, `broadcast`, `onMessage` on Colyseus Room prototype |

## Notes

- These files are **archived**, not deleted, to preserve test intent and git history.
- They should be **rewritten** using `@colyseus/testing` in a future task.
- The vitest config (`vitest.config.ts`) excludes `tests/_archived/**` from test runs.
