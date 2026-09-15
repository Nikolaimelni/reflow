import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: { target: 'es2023' },
  resolve: {
    alias: {
      // Straight at the engine's source rather than its dist. Through the dist the app runs
      // whatever was built last, and Vite does not watch inside node_modules, so a rebuild is
      // invisible until the server is restarted. Half an afternoon went into learning that
      // twice.
      '@reflow/engine': fileURLToPath(new URL('../engine/src/index.ts', import.meta.url)),
    },
  },
});
