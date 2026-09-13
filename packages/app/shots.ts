import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';

/**
 * The pictures in the README, taken from the running app rather than pasted in once and left
 * to rot. Start the app, run this, and the views come out at the same size every time.
 *
 *   pnpm -F @reflow/app dev
 *   pnpm -F @reflow/app shots
 */
const url = process.argv[2] ?? 'http://localhost:5173';
const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'docs');

/**
 * Heights differ because the views do: the boxes column is a page plus a trace plus an
 * inspector, and the layers stack is wider than it is tall whichever way you turn it.
 */
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

/** The trace player lives under the boxes canvas, so the cursor is always set from there. */
async function scrub(target: Page, fraction: number): Promise<void> {
  await target.getByRole('button', { name: 'boxes' }).click();
  await target.locator('input[type="range"]').evaluate((element: HTMLInputElement, part) => {
    element.value = String(Math.round(Number(element.max) * part));
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, fraction);
}

/** Puts a box under the cursor, which is what fills the inspector. */
async function hover(target: Page): Promise<void> {
  const box = await target.locator('canvas').first().boundingBox();
  if (box !== null) await target.mouse.move(box.x + 120, box.y + 40);
  await target.waitForTimeout(400);
}

// The whole window goes first: once the lab has run its wash follows the boxes view around,
// which is worth a picture of its own but not on the front page.
await scrub(page, 0.68);
await hover(page);
await page.screenshot({ path: join(out, 'app.png') });
process.stdout.write('docs/app.png\n');

for (const { name: view, height } of VIEWS) {
  await page.setViewportSize({ width: 1500, height });

  // The lab is about the finished layout, and its wash only covers boxes the frame has.
  await scrub(page, view === 'lab' ? 1 : 0.68);
  await page.getByRole('button', { name: view === 'lab' ? 'reflow lab' : view }).click();

  if (view === 'lab') {
    // It also needs a target and a property before it has anything to say.
    const canvas = page.locator('canvas').first();
    const box = await canvas.boundingBox();
    if (box !== null) await page.mouse.click(box.x + 40, box.y + 210);
    await page.getByRole('button', { name: 'height', exact: true }).click();
    await page.waitForTimeout(900);
  }

  if (view === 'boxes') await hover(page);

  await page.waitForTimeout(400);
  await page.locator('.result').screenshot({ path: join(out, `${view}.png`) });
  process.stdout.write(`docs/${view}.png\n`);
}

await browser.close();
