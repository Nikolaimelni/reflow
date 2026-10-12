import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

// Takes the README pictures from the running app. Start `pnpm -F @reflow/app dev` first.
const url = process.argv[2] ?? 'http://localhost:5173';
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'docs');

const VIEWS = [
  { name: 'boxes', height: 900 },
  { name: 'layers', height: 620 },
  { name: 'lab', height: 1060 },
] as const;

await mkdir(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1500, height: 900 },
  deviceScaleFactor: 2,
});

try {
  await page.goto(url, { waitUntil: 'networkidle' });
} catch {
  await browser.close();
  throw new Error(`nothing answering at ${url}. Start the app with: pnpm -F @reflow/app dev`);
}

await page.waitForSelector('.tabs button');

async function scrub(target: Page, fraction: number): Promise<void> {
  await target.getByRole('button', { name: 'boxes' }).click();
  await target.locator('input[type="range"]').evaluate((element: HTMLInputElement, part) => {
    element.value = String(Math.round(Number(element.max) * part));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);
}

async function hover(target: Page): Promise<void> {
  const box = await target.locator('canvas').first().boundingBox();
  if (box !== null) await target.mouse.move(box.x + 120, box.y + 40);
  await target.waitForTimeout(400);
}

// The whole window first: once the lab has run, its wash shows in the boxes view too.
await scrub(page, 0.68);
await hover(page);
await page.screenshot({ path: join(out, 'app.png') });
process.stdout.write('docs/app.png\n');

for (const { name: view, height } of VIEWS) {
  await page.setViewportSize({ width: 1500, height });

  await scrub(page, view === 'lab' ? 1 : 0.68);
  await page.getByRole('button', { name: view === 'lab' ? 'reflow lab' : view }).click();

  if (view === 'lab') {
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (box !== null) await page.mouse.click(box.x + 200, box.y + 352);
    await page.getByRole('button', { name: 'height', exact: true }).click();
    await page.waitForTimeout(900);
  }

  if (view === 'boxes') await hover(page);

  await page.waitForTimeout(400);
  await page.locator('.result').screenshot({ path: join(out, `${view}.png`) });
  process.stdout.write(`docs/${view}.png\n`);
}

await browser.close();
