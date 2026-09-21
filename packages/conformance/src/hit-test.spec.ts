import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, test } from '@playwright/test';
import {
  type Box,
  type BoxId,
  buildBoxTree,
  buildDisplayList,
  computeStyles,
  type DomNode,
  hitTest,
  layoutDocument,
  type Rect,
} from '@reflow/engine';
import { buildTree, COMPARED_PROPERTIES } from './compare.js';
import { extractPage, hitTestInPage, measureInPage } from './extract.js';
import { measurementRequests, tableMeasurer } from './measurer.js';

/**
 * The paint order has no geometry to compare, but it does decide what the pointer lands on,
 * and `document.elementFromPoint` asks the browser the same question. Sampling points and
 * comparing the answers checks the display list against Chromium without drawing anything.
 */
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
      const list = buildDisplayList(boxTree);

      const indexOf = new Map<DomNode, number>();
      nodes.forEach((node, index) => {
        indexOf.set(node, index);
      });

      // Every box answers with the nearest element that owns it, which covers text runs,
      // anonymous boxes, and content that overflows its block such as a nowrap line poking
      // out the side.
      const elementOf = new Map<BoxId, number>();
      const claim = (box: Box, owner: number | null): void => {
        const own =
          box.kind !== 'text' && box.element !== null ? (indexOf.get(box.element) ?? owner) : owner;
        if (own !== null) elementOf.set(box.id, own);
        if (box.kind === 'text') return;
        for (const child of box.children) claim(child, own);
      };
      claim(boxTree, null);

      const points = samplePoints(layout, extracted.viewport, elementOf);
      const theirs = await page.evaluate(hitTestInPage, points);

      let matched = 0;
      const misses: string[] = [];

      points.forEach((point, i) => {
        const hit = hitTest(list, layout, point.x, point.y, (box) => elementOf.has(box));
        // Below the root element's own box the browser still answers with the root, because
        // the root paints the whole canvas. Nothing else fills that space, so nothing found
        // means the root.
        const ours = hit === null ? 0 : (elementOf.get(hit) ?? -1);
        const expected = theirs[i] ?? -1;

        if (ours === expected) {
          matched++;
        } else {
          misses.push(
            `(${point.x}, ${point.y}): engine ${describe(extracted, ours)},` +
              ` chromium ${describe(extracted, expected)}`,
          );
        }
      });

      results.set(fixture, { matched, compared: points.length });
      expect(points.length, 'nothing was sampled').toBeGreaterThan(0);
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

/**
 * Quarter points of every box, where overlaps actually decide something, plus a coarse grid
 * to catch the gaps between them. Two kinds of point are dropped: anything below the fold,
 * because `elementFromPoint` works in viewport coordinates and would answer null, and
 * anything within a pixel of a box edge, because Chromium rounds an inline box to whole
 * pixels and the engine does not. A hit exactly on an edge is decided by that rounding, not
 * by the paint order this is meant to check.
 */
function samplePoints(
  geometry: {
    fragments: ReadonlyMap<BoxId, { rect: Rect }>;
    pieces: ReadonlyMap<BoxId, readonly Rect[]>;
    lineBoxes: ReadonlyMap<BoxId, readonly Rect[]>;
  },
  viewport: { width: number; height: number },
  elementOf: ReadonlyMap<BoxId, number>,
): { x: number; y: number }[] {
  const rects: Rect[] = [];
  for (const box of elementOf.keys()) {
    const pieces = geometry.pieces.get(box);
    if (pieces !== undefined) rects.push(...pieces);
    const lineBoxes = geometry.lineBoxes.get(box);
    if (lineBoxes !== undefined) rects.push(...lineBoxes);
    const fragment = geometry.fragments.get(box);
    if (fragment !== undefined) rects.push(fragment.rect);
  }

  const nearEdge = (x: number, y: number) =>
    rects.some(
      (rect) =>
        Math.abs(x - rect.x) <= 1 ||
        Math.abs(x - (rect.x + rect.width)) <= 1 ||
        Math.abs(y - rect.y) <= 1 ||
        Math.abs(y - (rect.y + rect.height)) <= 1,
    );

  const points: { x: number; y: number }[] = [];
  const seen = new Set<string>();

  const add = (x: number, y: number) => {
    const key = `${x},${y}`;
    if (seen.has(key)) return;
    if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return;
    if (nearEdge(x, y)) return;
    seen.add(key);
    points.push({ x, y });
  };

  for (const rect of rects) {
    if (rect.width <= 2 || rect.height <= 2) continue;
    for (const fx of [0.25, 0.5, 0.75]) {
      for (const fy of [0.25, 0.5, 0.75]) {
        add(Math.round(rect.x + rect.width * fx), Math.round(rect.y + rect.height * fy));
      }
    }
  }

  for (let y = 5; y < viewport.height; y += 37) {
    for (let x = 5; x < viewport.width; x += 53) add(x, y);
  }

  return points;
}

function describe(
  extracted: {
    nodes: readonly ({ kind: 'element'; tag: string; classes: string[] } | { kind: 'text' })[];
  },
  index: number,
): string {
  if (index < 0) return 'nothing';
  const node = extracted.nodes[index];
  if (node === undefined || node.kind !== 'element') return `#${index}`;
  const classes = node.classes.length === 0 ? '' : `.${node.classes.join('.')}`;
  return `<${node.tag}${classes}>`;
}
