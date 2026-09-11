import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import { computeStyles } from '@reflow/engine';
import { buildTree, COMPARED_PROPERTIES, compareElement } from './compare.js';
import { extractPage } from './extract.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');
const reportDir = join(here, '..', 'report');

const fixtures = readdirSync(fixturesDir).filter((name) => name.endsWith('.html'));

const tally = new Map<string, { matched: number; compared: number }>();

function record(property: string, ok: boolean): void {
  const counts = tally.get(property) ?? { matched: 0, compared: 0 };
  counts.compared++;
  if (ok) counts.matched++;
  tally.set(property, counts);
}

test.describe('computed styles against Chromium', () => {
  for (const fixture of fixtures) {
    test(fixture, async ({ page }) => {
      await page.goto(pathToFileURL(join(fixturesDir, fixture)).href);
      const extracted = await page.evaluate(extractPage, COMPARED_PROPERTIES);

      const nodes = buildTree(extracted.elements);
      const root = nodes[0];
      expect(root, 'fixture has no elements').toBeDefined();
      if (root === undefined) return;

      const styles = computeStyles(root, extracted.css);
      const mismatches: string[] = [];

      extracted.elements.forEach((element, index) => {
        const node = nodes[index];
        const style = node === undefined ? undefined : styles.get(node);
        if (style === undefined) return;

        for (const comparison of compareElement(style, element.computed)) {
          record(comparison.property, comparison.ok);
          if (!comparison.ok) {
            mismatches.push(
              `${describe(element.tag, element.id, element.classes)} ${comparison.property}: ` +
                `engine ${comparison.ours}, chromium ${comparison.theirs}`,
            );
          }
        }
      });

      expect(mismatches).toEqual([]);
    });
  }

  test.afterAll(() => {
    const byProperty = Object.fromEntries(
      [...tally.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([property, counts]) => [property, counts]),
    );

    const compared = [...tally.values()].reduce((sum, counts) => sum + counts.compared, 0);
    const matched = [...tally.values()].reduce((sum, counts) => sum + counts.matched, 0);

    mkdirSync(reportDir, { recursive: true });
    writeFileSync(
      join(reportDir, 'computed-style.json'),
      `${JSON.stringify(
        {
          fixtures: fixtures.length,
          compared,
          matched,
          percent: compared === 0 ? 0 : Math.round((matched / compared) * 1000) / 10,
          byProperty,
        },
        null,
        2,
      )}\n`,
    );
  });
});

function describe(tag: string, id: string | null, classes: string[]): string {
  const idPart = id === null ? '' : `#${id}`;
  const classPart = classes.length === 0 ? '' : `.${classes.join('.')}`;
  return `<${tag}${idPart}${classPart}>`;
}
