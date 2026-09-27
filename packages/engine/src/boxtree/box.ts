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
  /**
   * Set on the text standing in for a list marker inside its item. A symbol, the disc, circle
   * or square, takes the room Blink gives it rather than the width of the character. Either
   * kind can be broken after, and a space after it goes the way one at the start of a line
   * does.
   */
  listMarker: 'symbol' | 'counter' | null;
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

/**
 * Order-modified document order: what a flex container lays out and paints in. The sort is
 * stable, so items sharing an `order` keep the order they were written in.
 */
export function inFlexOrder<T extends { style: { order: number } }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.style.order - b.style.order);
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
export function boxesByElement(root: Box): Map<ElementNode, BoxId[]> {
  const found = new Map<ElementNode, BoxId[]>();

  walkBoxes(root, (box) => {
    if (box.kind === 'text' || box.element === null) return;

    const seen = found.get(box.element);
    if (seen === undefined) found.set(box.element, [box.id]);
    else seen.push(box.id);
  });

  return found;
}

/**
 * The rectangle a browser reports for an element, which is the union of the rects its boxes
 * made, taken in order the way Blink takes them: an empty rect is skipped, unless what has
 * been gathered so far is itself empty, in which case it replaces it. That is what decides
 * the odd cases. An inline that only opened or closed on a line adds nothing to a union that
 * already has a line of text in it, but it is the whole answer when there is nothing else,
 * and the same goes for the zero height block between the halves of a cut inline.
 *
 * An inline is read a line at a time rather than as the one rect it was laid out into, and
 * an element with no box that was laid out at all has no rectangle.
 */
export function reportedRect(
  boxes: readonly BoxId[],
  fragments: ReadonlyMap<BoxId, { rect: Rect }>,
  lines: ReadonlyMap<BoxId, readonly Rect[]>,
): Rect | null {
  const rects = boxes.flatMap((id) => {
    const perLine = lines.get(id);
    if (perLine !== undefined && perLine.length > 0) return [...perLine];

    const rect = fragments.get(id)?.rect;
    return rect === undefined ? [] : [rect];
  });

  return reportedUnion(rects);
}

/** The union Blink takes, in which an empty rect only counts while nothing else has. */
export function reportedUnion(rects: readonly Rect[]): Rect | null {
  let union: Rect | null = null;

  for (const rect of rects) {
    if (union === null || isEmptyRect(union)) union = rect;
    else if (!isEmptyRect(rect)) union = unite(union, rect);
  }

  return union;
}

function isEmptyRect(rect: Rect): boolean {
  return rect.width <= 0 || rect.height <= 0;
}

function unite(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);

  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function walkBoxes(box: Box, visit: (box: Box) => void): void {
  visit(box);
  if (box.kind === 'text') return;
  for (const child of box.children) walkBoxes(child, visit);
}
