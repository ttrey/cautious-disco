import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    rollupOptions: {
      input: {
        // The game, the asset turntable used to review models in isolation, the
        // two character harnesses used to review the zombie and the player
        // operators at fixed framings, and the first-person weapon harness.
        main: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview.html'),
        zlab: resolve(__dirname, 'zlab.html'),
        slab: resolve(__dirname, 'slab.html'),
        glab: resolve(__dirname, 'glab.html'),
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
    // PORT lets a second dev server (a parallel review session) come up on an
    // assigned port instead of silently drifting to 5174/5175 where nothing is
    // watching for it.
    port: Number(process.env.PORT) || 5173,
  },
});
