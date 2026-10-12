import {
  type BlockBox,
  type Box,
  type BoxId,
  boxesByElement,
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
      boxOf: Map<ElementNode, BoxId[]>;
    }
  | { status: 'empty' }
  | { status: 'failed'; message: string };

const measurer = canvasMeasurer();

// Anything thrown is caught here, so the page shows the message instead of going blank.
export function run(html: string, css: string, viewport: Viewport, devicePixelRatio: number): Run {
  try {
    const root = parseHtml(html);
    if (root === null) return { status: 'empty' };

    // Borders snap to device pixels, so the ratio is passed in rather than read from window.
    const boxTree = buildBoxTree(root, computeStyles(root, css, devicePixelRatio));
    if (boxTree === null) return { status: 'empty' };

    const layout = layoutDocument(boxTree, { ...viewport, devicePixelRatio }, measurer);
    const display = buildDisplayList(boxTree);

    const labels = new Map<BoxId, string>();
    const boxes = new Map<BoxId, Box>();
    const boxOf = boxesByElement(boxTree);

    walkBoxes(boxTree, (box) => {
      labels.set(box.id, describeBox(box));
      boxes.set(box.id, box);
    });

    return { status: 'ok', boxTree, layout, display, labels, boxes, root, boxOf };
  } catch (error) {
    return {
      status: 'failed',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
