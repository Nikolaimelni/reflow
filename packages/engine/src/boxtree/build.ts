import type { StyleMap } from '../cascade/cascade.js';
import {
  type ComputedStyle,
  initialStyle,
  type PropertyName,
  properties,
  propertyNames,
} from '../cascade/properties.js';
import { ZERO } from '../cascade/values.js';
import { type DomNode, type ElementNode, elementChildren } from '../dom/node.js';
import {
  type BlockBox,
  type Box,
  type IdSource,
  idSource,
  isBlock,
  isCollapsibleWhitespace,
  isWhitespaceText,
  type TextBox,
} from './box.js';

export function buildBoxTree(root: ElementNode, styles: StyleMap): BlockBox | null {
  const ids = idSource();
  const box = buildBox(root, styles, ids);
  if (box === null) return null;

  if (box.kind === 'block') return box;

  // The root always lays out as a block, whatever display it was given.
  return { kind: 'block', id: ids(), element: root, style: box.style, children: [box] };
}

function buildBox(node: ElementNode, styles: StyleMap, ids: IdSource): Box | null {
  const style = styles.get(node);
  if (style === undefined || style.display === 'none') return null;

  const children = buildChildren(node, style, styles, ids);

  // A marker inside the item is the first thing on its first line. One outside it takes no
  // room in the box at all, and layout gives it a line only if nothing else does.
  if (
    style.display === 'list-item' &&
    style.listStylePosition === 'inside' &&
    style.listStyleType !== 'none'
  ) {
    children.unshift(insideMarker(node, style, styles, ids));
  }

  // An out of flow box is always block-level, whatever display the author asked for.
  if (style.position === 'absolute' && style.display !== 'flex') {
    return {
      kind: 'block',
      id: ids(),
      element: node,
      style,
      children: organise(children, style, ids),
    };
  }

  if (style.display === 'inline') {
    return { kind: 'inline', id: ids(), element: node, style, atomic: false, children };
  }

  if (style.display === 'inline-block') {
    return {
      kind: 'inline',
      id: ids(),
      element: node,
      style,
      atomic: true,
      children: organise(children, style, ids),
    };
  }

  return {
    kind: 'block',
    id: ids(),
    element: node,
    style,
    children:
      style.display === 'flex' ? flexItems(children, style, ids) : organise(children, style, ids),
  };
}

/**
 * The text of a marker inside its item. A number is text like any other, and its trailing
 * space is kept: the marker is `white-space: pre` in the browser's own stylesheet. A symbol
 * stands in as one character whose room layout works out from the font.
 */
function insideMarker(
  node: ElementNode,
  style: ComputedStyle,
  styles: StyleMap,
  ids: IdSource,
): TextBox {
  const marker = { ...style, whiteSpace: 'pre' as const };
  if (style.listStyleType !== 'decimal') {
    return { kind: 'text', id: ids(), text: '•', style: marker, listMarker: 'symbol' };
  }

  // Counted among the element's siblings that are list items, which is what the counter the
  // browser keeps comes to while nothing resets or sets it.
  const siblings = node.parent === null ? [node] : elementChildren(node.parent);
  const before = siblings.slice(0, siblings.indexOf(node) + 1);
  const ordinal = before.filter((one) => styles.get(one)?.display === 'list-item').length;
  return { kind: 'text', id: ids(), text: `${ordinal}. `, style: marker, listMarker: 'counter' };
}

/**
 * Every child of a flex container becomes a block-level flex item: an inline box is
 * blockified, and a run of text gets an anonymous block of its own. A run of nothing but
 * whitespace is not rendered at all, and `white-space: pre` does not save it: a flex container
 * has no inline content of its own for the property to preserve anything in.
 */
function flexItems(children: Box[], parentStyle: ComputedStyle, ids: IdSource): Box[] {
  const items: Box[] = [];
  let run: Box[] = [];

  const flush = () => {
    if (run.length > 0 && !run.every(isWhitespaceText)) {
      items.push({
        kind: 'block',
        id: ids(),
        element: null,
        style: anonymousStyle(parentStyle),
        children: run,
      });
    }
    run = [];
  };

  for (const child of children) {
    if (child.kind === 'text') {
      run.push(child);
      continue;
    }

    flush();

    items.push(
      child.kind === 'block'
        ? child
        : {
            kind: 'block',
            id: child.id,
            element: child.element,
            style: child.style,
            children: organise(child.children, child.style, ids),
          },
    );
  }

  flush();
  return items;
}

function buildChildren(
  node: ElementNode,
  style: ComputedStyle,
  styles: StyleMap,
  ids: IdSource,
): Box[] {
  const boxes: Box[] = [];

  for (const child of node.children) {
    const box = buildChildBox(child, style, styles, ids);
    if (box !== null) boxes.push(box);
  }

  return boxes;
}

function buildChildBox(
  child: DomNode,
  parentStyle: ComputedStyle,
  styles: StyleMap,
  ids: IdSource,
): Box | null {
  if (child.kind === 'text') {
    return { kind: 'text', id: ids(), text: child.text, style: parentStyle, listMarker: null };
  }
  return buildBox(child, styles, ids);
}

/** An out of flow box is not part of the flow it sits in, so it splits nothing. */
function splits(child: Box): boolean {
  return isBlock(child) && child.style.position !== 'absolute';
}

/**
 * A block inside an inline box cuts it in two. What came before the block is one box, what
 * comes after is another, and the block is their sibling rather than their child. Both halves
 * are the same element, and the side that was cut carries no border or padding, because the
 * box does not end there.
 */
function cutAroundBlocks(children: Box[], ids: IdSource): Box[] {
  return children.flatMap((child) => {
    if (child.kind !== 'inline' || child.atomic) return [child];

    const inside = cutAroundBlocks(child.children, ids);
    if (!inside.some(splits)) return [{ ...child, children: inside }];

    const pieces: Box[] = [];
    let run: Box[] = [];
    let cut: Box[] = [];

    // The spec cuts the box in two around the block even if either side is empty, and an
    // empty half is not nothing: it still carries the border on the side it kept.
    const flushHalf = () => {
      pieces.push({ ...child, id: ids(), children: run });
      run = [];
    };

    // A run of blocks that did the cutting gets a block of its own around it. The style is
    // anonymous but the box belongs to the inline, which is what a browser reports between
    // the halves and what it answers with when the point is over it.
    const flushCut = () => {
      if (cut.length === 0) return;

      pieces.push({
        kind: 'block',
        id: ids(),
        element: child.element,
        style: anonymousStyle(child.style),
        children: cut,
      });
      cut = [];
    };

    // Whitespace that collapses away between two of those blocks is not a half of its own:
    // the blocks share one box around them, the way they would with nothing between them,
    // which matters to where a block whose margins collapse through it ends up.
    let between: Box[] = [];

    for (const inner of inside) {
      if (splits(inner)) {
        if (cut.length === 0) flushHalf();
        between = [];
        cut.push(inner);
      } else if (cut.length > 0 && isCollapsibleWhitespace(inner)) {
        between.push(inner);
      } else {
        flushCut();
        run.push(...between, inner);
        between = [];
      }
    }

    flushCut();
    run.push(...between);
    flushHalf();

    const halves = pieces.filter((piece) => piece.kind === 'inline');
    return pieces.map((piece) =>
      piece.kind === 'inline'
        ? { ...piece, style: cutStyle(piece.style, piece === halves[0], piece === halves.at(-1)) }
        : piece,
    );
  });
}

function cutStyle(style: ComputedStyle, opens: boolean, closes: boolean): ComputedStyle {
  return {
    ...style,
    ...(opens
      ? {}
      : { marginLeft: ZERO, paddingLeft: ZERO, borderLeftWidth: ZERO, borderLeftStyle: 'none' }),
    ...(closes
      ? {}
      : {
          marginRight: ZERO,
          paddingRight: ZERO,
          borderRightWidth: ZERO,
          borderRightStyle: 'none',
        }),
  };
}

/**
 * A block container holds either blocks or inlines, never a mix. When it has both, each run
 * of inline boxes is wrapped in an anonymous block. A run of nothing but whitespace is
 * dropped instead, which is why `<div><p>a</p>\n<p>b</p></div>` has two children and not five.
 */
function organise(original: Box[], parentStyle: ComputedStyle, ids: IdSource): Box[] {
  const children = cutAroundBlocks(original, ids);
  if (!children.some(splits)) return children;

  const organised: Box[] = [];
  let run: Box[] = [];

  const flush = () => {
    if (run.length > 0 && !run.every(isCollapsibleWhitespace)) {
      organised.push({
        kind: 'block',
        id: ids(),
        element: null,
        style: anonymousStyle(parentStyle),
        children: run,
      });
    }
    run = [];
  };

  for (const child of children) {
    if (splits(child)) {
      flush();
      organised.push(child);
    } else {
      run.push(child);
    }
  }

  flush();
  return organised;
}

/** An anonymous box inherits what is inheritable and takes the initial value for the rest. */
export function anonymousStyle(parent: ComputedStyle): ComputedStyle {
  const style = { ...initialStyle };

  for (const name of propertyNames) {
    if (properties[name].inherited) inherit(style, name, parent);
  }

  style.display = 'block';
  return style;
}

function inherit<K extends PropertyName>(
  style: ComputedStyle,
  name: K,
  parent: ComputedStyle,
): void {
  style[name] = parent[name];
}
