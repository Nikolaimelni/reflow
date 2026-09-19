import type { ComputedStyle } from '../cascade/properties.js';
import type { ElementNode } from '../dom/node.js';
import type { Rect } from '../geometry.js';

export type BoxId = number & { readonly __brand: 'BoxId' };

export type BlockBox = {
  kind: 'block';
  id: BoxId;
  /** null for an anonymous block box, which no element asked for. */
  element: ElementNode | null;
  style: ComputedStyle;
  children: Box[];
};

export type InlineBox = {
  kind: 'inline';
  id: BoxId;
  element: ElementNode;
  style: ComputedStyle;
  /** An inline-block sits in a line like a word, but lays its own children out as blocks. */
  atomic: boolean;
  children: Box[];
};

export type TextBox = {
  kind: 'text';
  id: BoxId;
  text: string;
  style: ComputedStyle;
};

export type Box = BlockBox | InlineBox | TextBox;

export type IdSource = () => BoxId;

export function idSource(): IdSource {
  let next = 0;
  // why: a branded number has no runtime representation, so minting one needs the assertion.
  return () => next++ as BoxId;
}

export function isBlock(box: Box): box is BlockBox {
  return box.kind === 'block';
}

export function isAnonymous(box: Box): boolean {
  return box.kind === 'block' && box.element === null;
}

/** Text with nothing in it but whitespace, whether or not that whitespace is preserved. */
export function isWhitespaceText(box: Box): boolean {
  return box.kind === 'text' && box.text.trim() === '';
}

/** Under `pre` a run of whitespace is content. Everywhere else it collapses away to nothing. */
export function isCollapsibleWhitespace(box: Box): boolean {
  return isWhitespaceText(box) && box.style.whiteSpace !== 'pre';
}

export function describeBox(box: Box): string {
  switch (box.kind) {
    case 'text':
      return `text ${JSON.stringify(box.text.slice(0, 20))}`;
    case 'inline':
      return box.atomic ? `inline-block <${box.element.tag}>` : `inline <${box.element.tag}>`;
    case 'block':
      return box.element === null ? 'anonymous block' : `block <${box.element.tag}>`;
  }
}

/**
 * Which boxes belong to each element, in the sense a browser reports them. `own` is what the
 * element generated: an inline box cut in two by a block is two boxes. `span` covers the
 * block between those halves as well, because that is what the browser hands back for the
 * element, but only when the halves put something on a line in the first place.
 */
export function boxesByElement(root: Box): Map<ElementNode, { own: BoxId[]; span: BoxId[] }> {
  const order: (BlockBox | InlineBox)[] = [];
  walkBoxes(root, (box) => {
    if (box.kind !== 'text') order.push(box);
  });

  const found = new Map<ElementNode, { own: BoxId[]; span: BoxId[] }>();

  order.forEach((box, index) => {
    if (box.element === null) return;

    const seen = found.get(box.element);
    if (seen === undefined) {
      found.set(box.element, { own: [box.id], span: [box.id] });
      return;
    }

    // The anonymous blocks the halves sit in are nobody's: what the browser reports between
    // them is the block that did the cutting.
    const from = order.findIndex((one) => one.id === seen.own[0]);
    found.set(box.element, {
      own: [...seen.own, box.id],
      span: order
        .slice(from, index + 1)
        .filter((one) => one.element !== null)
        .map((one) => one.id),
    });
  });

  return found;
}

/**
 * The rectangle a browser reports for an element, which is the union of the boxes it made.
 * Two things about it are not obvious. An element whose own boxes came to nothing has no
 * rectangle at all, whatever sits between them. And a box with no height is left out of the
 * union: the block between the halves of a cut inline counts when it has one and not when it
 * does not, which is what `getBoundingClientRect` does.
 */
export function reportedRect(
  boxes: { own: readonly BoxId[]; span: readonly BoxId[] },
  fragments: ReadonlyMap<BoxId, { rect: Rect }>,
): Rect | null {
  const rectsOf = (ids: readonly BoxId[]) =>
    ids.map((id) => fragments.get(id)?.rect).filter((rect) => rect !== undefined);

  if (rectsOf(boxes.own).length === 0) return null;

  const all = rectsOf(boxes.span);
  const drawn = all.filter((rect) => rect.height > 0);
  const rects = drawn.length === 0 ? all : drawn;

  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function walkBoxes(box: Box, visit: (box: Box) => void): void {
  visit(box);
  if (box.kind === 'text') return;
  for (const child of box.children) walkBoxes(child, visit);
}
