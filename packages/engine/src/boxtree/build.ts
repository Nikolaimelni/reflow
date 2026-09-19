import type { StyleMap } from '../cascade/cascade.js';
import {
  type ComputedStyle,
  initialStyle,
  type PropertyName,
  properties,
  propertyNames,
} from '../cascade/properties.js';
import { ZERO } from '../cascade/values.js';
import type { DomNode, ElementNode } from '../dom/node.js';
import {
  type BlockBox,
  type Box,
  type IdSource,
  idSource,
  isBlock,
  isCollapsibleWhitespace,
  isWhitespaceText,
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
    return { kind: 'text', id: ids(), text: child.text, style: parentStyle };
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

    // The spec cuts the box in two around the block even if either side is empty, and an
    // empty half is not nothing: it still carries the border on the side it kept.
    const flush = () => {
      pieces.push({ ...child, id: ids(), children: run });
      run = [];
    };

    for (const inner of inside) {
      if (splits(inner)) {
        flush();
        pieces.push(inner);
      } else {
        run.push(inner);
      }
    }

    flush();

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
