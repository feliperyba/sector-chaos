import { vi } from 'vitest';

vi.stubGlobal('performance', {
  now: vi.fn(() => Date.now()),
});
