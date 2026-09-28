import type { Page } from '@playwright/test';
import {
  type BlockBox,
  type Box,
  type BoxId,
  buildDisplayList,
  type DomNode,
  hitTest,
  type LayoutResult,
  type Rect,
} from '@reflow/engine';
import { type ExtractedNode, hitTestInPage } from './extract.js';

export type Hits = { compared: number; matched: number; misses: string[] };

/**
 * The paint order has no geometry to compare, but it does decide what the pointer lands on,
 * and `document.elementFromPoint` asks the browser the same question. Sampling points and
 * comparing the answers checks the display list against Chromium without drawing anything.
 *
 * `margin` is how close to a box edge a point may come. Chromium rounds an inline box to
 * whole pixels and the engine does not, so a hit right on an edge is decided by rounding
 * rather than by the paint order, and where the boxes themselves may be a little apart it has
 * to be wider than that.
 */
export async function compareHits(
  page: Page,
  boxTree: BlockBox,
  layout: LayoutResult,
  nodes: readonly DomNode[],
  extracted: readonly ExtractedNode[],
  viewport: { width: number; height: number },
  margin: number,
): Promise<Hits> {
  const list = buildDisplayList(boxTree);
  const elementOf = elementsOf(boxTree, nodes);
  const points = samplePoints(layout, viewport, elementOf, margin);
  const theirs = await page.evaluate(hitTestInPage, points);

  let matched = 0;
  const misses: string[] = [];

  points.forEach((point, i) => {
    const hit = hitTest(list, layout, point.x, point.y, (box) => elementOf.has(box));
    // Below the root element's own box the browser still answers with the root, because the
    // root paints the whole canvas. Nothing else fills that space, so nothing found means the
    // root.
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

  return { compared: points.length, matched, misses };
}

/**
 * Every box answers with the nearest element that owns it, which covers text runs, anonymous
 * boxes, and content that overflows its block such as a nowrap line poking out the side.
 */
function elementsOf(boxTree: Box, nodes: readonly DomNode[]): Map<BoxId, number> {
  const indexOf = new Map<DomNode, number>();
  nodes.forEach((node, index) => {
    indexOf.set(node, index);
  });

  const elementOf = new Map<BoxId, number>();
  const claim = (box: Box, owner: number | null): void => {
    const own =
      box.kind !== 'text' && box.element !== null ? (indexOf.get(box.element) ?? owner) : owner;
    if (own !== null) elementOf.set(box.id, own);
    if (box.kind === 'text') return;
    for (const child of box.children) claim(child, own);
  };
  claim(boxTree, null);

  return elementOf;
}

/**
 * Quarter points of every box, where overlaps actually decide something, plus a coarse grid
 * to catch the gaps between them. Anything below the fold is dropped, because
 * `elementFromPoint` works in viewport coordinates and would answer null, and so is anything
 * within the margin of a box edge.
 */
function samplePoints(
  geometry: {
    fragments: ReadonlyMap<BoxId, { rect: Rect }>;
    pieces: ReadonlyMap<BoxId, readonly Rect[]>;
    lineBoxes: ReadonlyMap<BoxId, readonly Rect[]>;
  },
  viewport: { width: number; height: number },
  elementOf: ReadonlyMap<BoxId, number>,
  margin: number,
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
        Math.abs(x - rect.x) <= margin ||
        Math.abs(x - (rect.x + rect.width)) <= margin ||
        Math.abs(y - rect.y) <= margin ||
        Math.abs(y - (rect.y + rect.height)) <= margin,
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

function describe(extracted: readonly ExtractedNode[], index: number): string {
  if (index < 0) return 'nothing';
  const node = extracted[index];
  if (node === undefined || node.kind !== 'element') return `#${index}`;
  const classes = node.classes.length === 0 ? '' : `.${node.classes.join('.')}`;
  return `<${node.tag}${classes}>`;
}
