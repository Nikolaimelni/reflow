import {
  type BlockBox,
  type Box,
  type BoxId,
  buildBoxTree,
  buildDisplayList,
  computeStyles,
  type DisplayList,
  describeBox,
  type ElementNode,
  type LayoutResult,
  layoutDocument,
  walkBoxes,
} from '@reflow/engine';
import { canvasMeasurer } from '../host/canvas-measurer.js';
import { parseHtml } from '../host/parse-html.js';

export type Viewport = { width: number; height: number };

export type Run =
  | {
      status: 'ok';
      boxTree: BlockBox;
      layout: LayoutResult;
      display: DisplayList;
      labels: Map<BoxId, string>;
      boxes: Map<BoxId, Box>;
      root: ElementNode;
      boxOf: Map<ElementNode, BoxId>;
    }
  | { status: 'empty' }
  | { status: 'failed'; message: string };

const measurer = canvasMeasurer();

/**
 * The whole pipeline, from two strings to geometry and a trace. Anything thrown on the way
 * is caught here, because this is the boundary that can do something about it: show the
 * message instead of blanking the page.
 */
export function run(html: string, css: string, viewport: Viewport, devicePixelRatio: number): Run {
  try {
    const root = parseHtml(html);
    if (root === null) return { status: 'empty' };

    // The browser snaps border widths to the screen grid, so the engine is told what screen
    // it is on and does the same. Moving a window between displays changes the answer, which
    // is why the ratio is an input here and not read from the global.
    const boxTree = buildBoxTree(root, computeStyles(root, css, devicePixelRatio));
    if (boxTree === null) return { status: 'empty' };

    const layout = layoutDocument(boxTree, viewport, measurer);
    const display = buildDisplayList(boxTree);

    const labels = new Map<BoxId, string>();
    const boxes = new Map<BoxId, Box>();
    const boxOf = new Map<ElementNode, BoxId>();

    walkBoxes(boxTree, (box) => {
      labels.set(box.id, describeBox(box));
      boxes.set(box.id, box);
      if (box.kind !== 'text' && box.element !== null && !boxOf.has(box.element)) {
        boxOf.set(box.element, box.id);
      }
    });

    return { status: 'ok', boxTree, layout, display, labels, boxes, root, boxOf };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
