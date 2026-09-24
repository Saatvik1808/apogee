/**
 * LEARNING NOTE: Build configuration
 *
 * Vite serves our TypeScript as native ES modules during development (no bundling,
 * instant reloads) and bundles + minifies for production. Large binary assets
 * (planet textures, star catalogues) live in /public and are copied verbatim —
 * they are fetched at runtime rather than imported, so they never bloat the JS bundle.
 *
 * Key concepts: ES modules, dev server vs production bundle, static asset pipeline
 */
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
    sourcemap: false,
  },
  server: {
    port: 5190,
  },
});
