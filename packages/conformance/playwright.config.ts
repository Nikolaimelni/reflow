import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './src',
  reporter: 'list',
  workers: 1,
  use: { browserName: 'chromium' },
  globalTeardown: './src/summarise.ts',
});
