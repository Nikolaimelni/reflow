import { type BlockBox, type Box, type BoxId, isBlock } from '../boxtree/box.js';
import type { PropertyName } from '../cascade/properties.js';

export type Invalidation = 'layout' | 'paint' | 'composite';

/**
 * A full Record, so a new property without a cost here is a compile error. Nearly all of them
 * are layout; colour only repaints and opacity goes to the compositor.
 */
export const INVALIDATION: Record<PropertyName, Invalidation> = {
  display: 'layout',
  position: 'layout',
  boxSizing: 'layout',
  overflow: 'layout',

  width: 'layout',
  height: 'layout',
  minWidth: 'layout',
  minHeight: 'layout',
  maxWidth: 'layout',
  maxHeight: 'layout',

  marginTop: 'layout',
  marginRight: 'layout',
  marginBottom: 'layout',
  marginLeft: 'layout',

  paddingTop: 'layout',
  paddingRight: 'layout',
  paddingBottom: 'layout',
  paddingLeft: 'layout',

  borderTopWidth: 'layout',
  borderRightWidth: 'layout',
  borderBottomWidth: 'layout',
  borderLeftWidth: 'layout',

  // A style of `none` makes the used width zero, so even this reaches layout.
  borderTopStyle: 'layout',
  borderRightStyle: 'layout',
  borderBottomStyle: 'layout',
  borderLeftStyle: 'layout',

  top: 'layout',
  right: 'layout',
  bottom: 'layout',
  left: 'layout',

  fontSize: 'layout',
  fontFamily: 'layout',
  fontWeight: 'layout',
  fontStyle: 'layout',
  lineHeight: 'layout',
  textAlign: 'layout',
  whiteSpace: 'layout',

  flexDirection: 'layout',
  flexWrap: 'layout',
  justifyContent: 'layout',
  alignItems: 'layout',
  alignSelf: 'layout',
  alignContent: 'layout',
  flexGrow: 'layout',
  flexShrink: 'layout',
  flexBasis: 'layout',
  // `order` moves the item as well as reordering what paints over what.
  order: 'layout',
  rowGap: 'layout',
  columnGap: 'layout',

  // A marker inside the box takes room on the first line, and one outside it can make that
  // line in a box with nothing else in it.
  listStyleType: 'layout',
  listStylePosition: 'layout',

  // Nothing moves, the order things are drawn in changes.
  zIndex: 'paint',
  color: 'paint',
  backgroundColor: 'paint',
  visibility: 'paint',
  opacity: 'composite',
};

export type DirtyResult = {
  invalidation: Invalidation;
  dirty: Set<BoxId>;
  /** The ancestors the change climbed to, nearest first. */
  climbs: BoxId[];
};

/**
 * Composite touches the box, paint its subtree, and layout also what follows it in the flow and
 * every ancestor whose height came from its content.
 */
export function dirtyBoxes(root: BlockBox, target: BoxId, property: PropertyName): DirtyResult {
  const invalidation = INVALIDATION[property];
  const dirty = new Set<BoxId>();
  const climbs: BoxId[] = [];

  const box = find(root, target);
  if (box === null) return { invalidation, dirty, climbs };

  if (invalidation === 'composite') {
    dirty.add(target);
    return { invalidation, dirty, climbs };
  }

  addSubtree(box, dirty);
  if (invalidation === 'paint') return { invalidation, dirty, climbs };

  let current = box;
  for (;;) {
    const parent = parentOf(root, current.id);
    if (parent === null) break;

    for (const sibling of after(parent, current.id)) addSubtree(sibling, dirty);

    dirty.add(parent.id);
    climbs.push(parent.id);

    // A parent with a height of its own absorbs the change. One taking its height from the
    // content has to be measured again, and so does whatever follows it.
    if (parent.style.height.kind !== 'auto') break;
    current = parent;
  }

  return { invalidation, dirty, climbs };
}

function addSubtree(box: Box, dirty: Set<BoxId>): void {
  dirty.add(box.id);
  if (box.kind === 'text') return;
  for (const child of box.children) addSubtree(child, dirty);
}

function find(box: Box, id: BoxId): Box | null {
  if (box.id === id) return box;
  if (box.kind === 'text') return null;

  for (const child of box.children) {
    const found = find(child, id);
    if (found !== null) return found;
  }

  return null;
}

function parentOf(box: Box, id: BoxId): BlockBox | null {
  if (box.kind === 'text') return null;

  for (const child of box.children) {
    if (child.id === id) return isBlock(box) ? box : null;
    const found = parentOf(child, id);
    if (found !== null) return found;
  }

  return null;
}

function after(parent: BlockBox, id: BoxId): Box[] {
  const index = parent.children.findIndex((child) => child.id === id);
  return index === -1 ? [] : parent.children.slice(index + 1);
}
