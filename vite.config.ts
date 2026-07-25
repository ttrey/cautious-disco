import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2400,
  },
  server: {
    host: true,
    port: 5173,
  },
  // Rapier ships as WASM; the -compat build inlines it as base64 so no
  // special asset handling or COOP/COEP headers are required.
  optimizeDeps: {
    exclude: [],
  },
});
