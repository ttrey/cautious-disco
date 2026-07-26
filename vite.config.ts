import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        // The game, plus the asset turntable used to review models in isolation.
        main: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview.html'),
      },
      output: {
        // Three and Rapier are large and never change between builds; splitting
        // them out keeps the app chunk small enough to re-download cheaply.
        // Rapier's -compat build inlines its WASM as base64, which is most of
        // its weight.
        manualChunks: {
          three: ['three'],
          rapier: ['@dimforge/rapier3d-compat'],
        },
      },
    },
    chunkSizeWarningLimit: 2400,
  },
  server: {
    host: true,
    port: 5173,
  },
});
