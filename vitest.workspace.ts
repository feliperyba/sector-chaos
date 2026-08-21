import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  'packages/shared/vitest.config.ts',
  'packages/server/vitest.config.ts',
  'packages/client-v3/vitest.config.ts',
  {
    test: {
      name: 'root',
      include: [],
    },
  },
]);
