import type { Page } from '@playwright/test';
import {
  boxesByElement,
  buildBoxTree,
  computeStyles,
  layoutDocument,
  reportedRect,
} from '@reflow/engine';
import { buildTree, COMPARED_PROPERTIES } from '../compare.js';
import { extractPage, measureInPage } from '../extract.js';
import { measurementRequests, tableMeasurer } from '../measurer.js';

export type Check = { compared: number; misses: string[] };

/**
 * One document, laid out twice. The browser gets it as a page, the engine gets the same two
 * strings, and every element's border box is compared. This is the same comparison the
 * geometry harness makes, run against something nobody wrote by hand.
 */
export async function checkDocument(
  page: Page,
  html: string,
  css: string,
  tolerance: number,
): Promise<Check> {
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style>${html}`);

  const extracted = await page.evaluate(extractPage, COMPARED_PROPERTIES);
  const nodes = buildTree(extracted.nodes);
  const root = nodes[0];
  if (root === undefined || root.kind !== 'element') return { compared: 0, misses: [] };

  const boxTree = buildBoxTree(root, computeStyles(root, extracted.css));
  if (boxTree === null) return { compared: 0, misses: [] };

  const measurements = await page.evaluate(measureInPage, measurementRequests(boxTree));
  const layout = layoutDocument(boxTree, extracted.viewport, tableMeasurer(measurements));

  const byElement = boxesByElement(boxTree);

  let compared = 0;
  const misses: string[] = [];

  extracted.nodes.forEach((element, index) => {
    if (element.kind !== 'element') return;

    const node = nodes[index];
    const boxes = node?.kind === 'element' ? byElement.get(node) : undefined;
    const rect = boxes === undefined ? null : reportedRect(boxes, layout.fragments);
    if (rect === null) return;

    for (const edge of ['x', 'y', 'width', 'height'] as const) {
      compared++;
      const ours = rect[edge];
      const theirs = element.rect[edge];
      if (Math.abs(ours - theirs) <= tolerance) continue;

      const classes = element.classes.length === 0 ? '' : `.${element.classes.join('.')}`;
      misses.push(`<${element.tag}${classes}> ${edge}: engine ${ours}, chromium ${theirs}`);
    }
  });

  return { compared, misses };
}
