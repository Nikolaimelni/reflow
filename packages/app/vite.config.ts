import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// GitHub Pages sends no headers of its own, so the policy goes in the page. A shared link
// carries someone else's HTML, and the comparison iframe inherits this policy too.
const CSP =
  "default-src 'self'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'";

export default defineConfig({
  // Relative, so the bundle works under /reflow/ on Pages as well as at a root.
  base: './',
  plugins: [
    svelte(),
    {
      name: 'security-meta',
      apply: 'build',
      transformIndexHtml: () => [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP },
          injectTo: 'head-prepend',
        },
        {
          tag: 'meta',
          attrs: { name: 'referrer', content: 'no-referrer' },
          injectTo: 'head-prepend',
        },
      ],
    },
  ],
  // The bundle carries CodeMirror, Svelte and Zod, whose MIT licenses ask for their notices to
  // travel with them, and minifying strips every one out of the code.
  build: { target: 'es2023', license: { fileName: 'licenses.md' } },
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
