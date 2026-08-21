import { vi } from 'vitest';
import { Encoder } from '@colyseus/schema';

Encoder.BUFFER_SIZE = 128 * 1024;

vi.stubGlobal('performance', {
  now: vi.fn(() => Date.now()),
});
