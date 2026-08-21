import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5174,
  },
  base: './',
  build: {
    target: 'es2022',
    sourcemap: true,
    minify: 'esbuild',
    rollupOptions: {
      output: {
        manualChunks: {
          phaser: ['phaser'],
          colyseus: ['@colyseus/sdk'],
        },
      },
    },
  },
  define: {
    'process.env': {},
  },
});
