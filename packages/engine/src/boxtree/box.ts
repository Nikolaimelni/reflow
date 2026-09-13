import type { ComputedStyle } from '../cascade/properties.js';
import type { ElementNode } from '../dom/node.js';

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

/** Under `pre` a run of whitespace is content. Everywhere else it collapses away to nothing. */
export function isCollapsibleWhitespace(box: Box): boolean {
  return box.kind === 'text' && box.text.trim() === '' && box.style.whiteSpace !== 'pre';
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

export function walkBoxes(box: Box, visit: (box: Box) => void): void {
  visit(box);
  if (box.kind === 'text') return;
  for (const child of box.children) walkBoxes(child, visit);
}
