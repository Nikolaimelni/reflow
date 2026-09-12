import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [svelte()],
  build: { target: 'es2023' },
  optimizeDeps: {
    // The engine is a workspace package. Pre-bundling it means a rebuild of its dist is not
    // picked up, and the app then runs an older engine than the tests do, which is a bad
    // afternoon to debug.
    exclude: ['@reflow/engine'],
  },
});
