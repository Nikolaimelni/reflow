import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  boxesByElement,
  buildBoxTree,
  computeStyles,
  layoutDocument,
  reportedRect,
} from '@reflow/engine';
import { buildTree, COMPARED_PROPERTIES } from './compare.js';
import { extractPage, measureInPage } from './extract.js';
import { measurementRequests, tableMeasurer } from './measurer.js';

/**
 * Chromium lays out in sixty-fourths of a pixel, so chasing an exact match on fractional
 * values is a waste of an evening. Half a pixel is the line.
 */
const TOLERANCE = 0.5;

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');
const reportDir = join(here, '..', 'report');

const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.html'));
const results = new Map<string, { matched: number; compared: number; misses: string[] }>();

function name(element: { tag: string; id: string | null; classes: string[] }): string {
  const id = element.id === null ? '' : `#${element.id}`;
  const classes = element.classes.length === 0 ? '' : `.${element.classes.join('.')}`;
  return `<${element.tag}${id}${classes}>`;
}

test.describe.configure({ mode: 'serial' });

test.describe('geometry against Chromium', () => {
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
      const byElement = boxesByElement(boxTree);

      let matched = 0;
      let compared = 0;
      const misses: string[] = [];

      extracted.nodes.forEach((element, index) => {
        if (element.kind !== 'element') return;
        const node = nodes[index];
        const boxes = node?.kind === 'element' ? byElement.get(node) : undefined;
        const rect = boxes === undefined ? null : reportedRect(boxes, layout.fragments);
        if (rect === null) return;
        const fragment = { rect };

        for (const edge of ['x', 'y', 'width', 'height'] as const) {
          compared++;
          const ours = fragment.rect[edge];
          const theirs = element.rect[edge];
          if (Math.abs(ours - theirs) <= TOLERANCE) {
            matched++;
          } else {
            misses.push(`${name(element)} ${edge}: engine ${ours}, chromium ${theirs}`);
          }
        }
      });

      results.set(fixture, { matched, compared, misses });
      expect(compared, 'nothing was compared').toBeGreaterThan(0);
      expect(misses).toEqual([]);
    });
  }

  test('writes the report', () => {
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

    expect(percent).toBe(100);
  });
});
