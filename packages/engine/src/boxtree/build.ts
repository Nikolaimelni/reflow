import type { StyleMap } from '../cascade/cascade.js';
import {
  type ComputedStyle,
  initialStyle,
  type PropertyName,
  properties,
  propertyNames,
} from '../cascade/properties.js';
import type { DomNode, ElementNode } from '../dom/node.js';
import {
  type BlockBox,
  type Box,
  type IdSource,
  idSource,
  isBlock,
  isCollapsibleWhitespace,
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

  // A block inside an inline is supposed to split the inline in two around it. Turning the
  // inline into a block container instead stacks the same boxes in the same places, and the
  // only thing given up is the split inline's own reported rectangle.
  if (style.display === 'inline' && children.some(isBlock)) {
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
 * blockified, and a run of text gets an anonymous block of its own.
 */
function flexItems(children: Box[], parentStyle: ComputedStyle, ids: IdSource): Box[] {
  const items: Box[] = [];
  let run: Box[] = [];

  const flush = () => {
    if (run.length > 0 && !run.every(isCollapsibleWhitespace)) {
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

/**
 * A block container holds either blocks or inlines, never a mix. When it has both, each run
 * of inline boxes is wrapped in an anonymous block. A run of nothing but whitespace is
 * dropped instead, which is why `<div><p>a</p>\n<p>b</p></div>` has two children and not five.
 */
function organise(children: Box[], parentStyle: ComputedStyle, ids: IdSource): Box[] {
  // An out of flow box is not part of the flow it sits in, so it does not split the inline
  // content around it. It keeps its place in the line, which is where its static position
  // comes from.
  const splits = (child: Box) => isBlock(child) && child.style.position !== 'absolute';
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
