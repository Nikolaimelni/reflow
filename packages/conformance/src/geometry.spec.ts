import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import type { ElementNode } from '@reflow/engine';
import {
  type Box,
  type BoxId,
  buildBoxTree,
  computeStyles,
  layoutDocument,
  walkBoxes,
} from '@reflow/engine';
import { buildTree, COMPARED_PROPERTIES } from './compare.js';
import { extractPage } from './extract.js';

/**
 * Chromium lays out in sixty-fourths of a pixel, so chasing an exact match on fractional
 * values is a waste of an evening. Half a pixel is the line.
 */
const TOLERANCE = 0.5;

/**
 * The share of box edges that currently match. It only goes up. Inline layout does not
 * exist yet, so every box holding text reads zero height here and drags the figure down.
 */
const FLOOR = 92;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');
const reportDir = join(here, '..', 'report');

const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.html'));
const results = new Map<string, { matched: number; compared: number; misses: string[] }>();

test.describe.configure({ mode: 'serial' });

test.describe('geometry against Chromium', () => {
  for (const fixture of fixtures) {
    test(fixture, async ({ page }) => {
      await page.goto(pathToFileURL(join(fixturesDir, fixture)).href);
      const extracted = await page.evaluate(extractPage, COMPARED_PROPERTIES);

      const nodes = buildTree(extracted.elements);
      const root = nodes[0];
      if (root === undefined) throw new Error(`${fixture} has no elements`);

      const boxTree = buildBoxTree(root, computeStyles(root, extracted.css));
      if (boxTree === null) throw new Error(`${fixture} generated no boxes`);

      const layout = layoutDocument(boxTree, extracted.viewport);
      const byElement = new Map<ElementNode, BoxId>();
      walkBoxes(boxTree, (box: Box) => {
        if (box.kind === 'block' && box.element !== null) byElement.set(box.element, box.id);
      });

      let matched = 0;
      let compared = 0;
      const misses: string[] = [];

      extracted.elements.forEach((element, index) => {
        const node = nodes[index];
        const id = node === undefined ? undefined : byElement.get(node);
        const fragment = id === undefined ? undefined : layout.fragments.get(id);
        if (fragment === undefined) return;

        for (const edge of ['x', 'y', 'width', 'height'] as const) {
          compared++;
          const ours = fragment.rect[edge];
          const theirs = element.rect[edge];
          if (Math.abs(ours - theirs) <= TOLERANCE) {
            matched++;
          } else {
            misses.push(`<${element.tag}> ${edge}: engine ${ours}, chromium ${theirs}`);
          }
        }
      });

      results.set(fixture, { matched, compared, misses });
      expect(compared, 'nothing was compared').toBeGreaterThan(0);
    });
  }

  test('does not regress', () => {
    const compared = [...results.values()].reduce((sum, one) => sum + one.compared, 0);
    const matched = [...results.values()].reduce((sum, one) => sum + one.matched, 0);
    const percent = compared === 0 ? 0 : Math.round((matched / compared) * 1000) / 10;

    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'geometry.json'),
      `${JSON.stringify(
        {
          tolerance: TOLERANCE,
          compared,
          matched,
          percent,
          byFixture: Object.fromEntries(
            [...results.entries()].map(([fixture, one]) => [
              fixture,
              { matched: one.matched, compared: one.compared, misses: one.misses },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
    );

    expect(percent, `geometry fell below the recorded floor of ${FLOOR}%`).toBeGreaterThanOrEqual(
      FLOOR,
    );
  });
});
