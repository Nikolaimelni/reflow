import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { buildBoxTree, computeStyles, layoutDocument } from '@reflow/engine';
import { buildTree, COMPARED_PROPERTIES } from './compare.js';
import { extractPage, measureInPage } from './extract.js';
import { compareHits } from './hit.js';
import { measurementRequests, tableMeasurer } from './measurer.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');
const reportDir = join(here, '..', 'report');

const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.html'));
const results = new Map<string, { matched: number; compared: number }>();

test.describe.configure({ mode: 'serial' });

test.describe('hit testing against Chromium', () => {
  for (const fixture of fixtures) {
    test(fixture, async ({ page }) => {
      await page.goto(pathToFileURL(join(fixturesDir, fixture)).href);
      const extracted = await page.evaluate(extractPage, COMPARED_PROPERTIES);

      const nodes = buildTree(extracted.nodes);
      const root = nodes[0];
      if (root === undefined || root.kind !== 'element') throw new Error(`${fixture} is empty`);

      const boxTree = buildBoxTree(root, computeStyles(root, extracted.css));
      if (boxTree === null) throw new Error(`${fixture} generated no boxes`);

      const measurements = await page.evaluate(measureInPage, measurementRequests(boxTree));
      const layout = layoutDocument(boxTree, extracted.viewport, tableMeasurer(measurements));

      // A pixel either side of every edge is left out: the fixtures are laid out to agree to
      // the half pixel, and it is the paint order in between that is being asked about.
      const { compared, matched, misses } = await compareHits(
        page,
        boxTree,
        layout,
        nodes,
        extracted.nodes,
        extracted.viewport,
        1,
      );

      results.set(fixture, { matched, compared });
      expect(compared, 'nothing was sampled').toBeGreaterThan(0);
      expect(misses).toEqual([]);
    });
  }

  test('writes the report', () => {
    const compared = [...results.values()].reduce((sum, one) => sum + one.compared, 0);
    const matched = [...results.values()].reduce((sum, one) => sum + one.matched, 0);

    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'hit-test.json'),
      `${JSON.stringify(
        {
          compared,
          matched,
          percent: compared === 0 ? 0 : Math.round((matched / compared) * 1000) / 10,
          byFixture: Object.fromEntries(results),
        },
        null,
        2,
      )}\n`,
    );

    expect(matched).toBe(compared);
  });
});
