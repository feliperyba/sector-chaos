import { vi } from 'vitest';

// Mock Phaser for client tests
vi.stubGlobal('Phaser', {
  Scene: class {
    constructor() {
      this.events = {
        on: vi.fn(),
        emit: vi.fn(),
      };
    }
  },
  Physics: {
    Arcade: {
      Sprite: class {},
      Group: class {},
    },
  },
  Geom: {
    Rectangle: class {},
  },
  Input: {
    Keyboard: {
      Key: class {
        constructor() {
          this.isDown = false;
        }
      },
    },
    Pointer: class {
      constructor() {
        this.x = 0;
        this.y = 0;
        this.isDown = false;
      }
    },
  },
});

// Mock @colyseus/sdk (the actual client dependency — colyseus.js was a stale
// root dep that pulled in an incompatible @colyseus/schema@3.x alongside the
// server's @colyseus/schema@4.x. Tests mock @colyseus/sdk to match the real
// client-v3 source imports.)
vi.mock('@colyseus/sdk', () => ({
  Client: class {
    url: string;
    constructor(url: string) {
      this.url = url;
    }
    joinOrCreate(roomName: string) {
      return Promise.resolve({
        roomId: 'test-room',
        send: vi.fn(),
        leave: vi.fn(),
        onMessage: vi.fn(),
      });
    }
  },
}));
