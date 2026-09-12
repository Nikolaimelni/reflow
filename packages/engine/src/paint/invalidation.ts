import { type BlockBox, type Box, type BoxId, isBlock } from '../boxtree/box.js';
import type { PropertyName } from '../cascade/properties.js';

export type Invalidation = 'layout' | 'paint' | 'composite';

/**
 * What changing one property costs. The type is a full `Record`, so adding a property to the
 * cascade without deciding this is a compile error rather than a quiet omission.
 *
 * Almost everything is layout, which is the honest answer for a subset made of the box model.
 * The interesting rows are the last four: a colour only repaints, and an opacity is handed to
 * the compositor, which is why fading something in is cheap and resizing it is not.
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
  justifyContent: 'layout',
  alignItems: 'layout',
  flexGrow: 'layout',
  flexShrink: 'layout',
  flexBasis: 'layout',

  // Nothing moves, the order things are drawn in changes.
  zIndex: 'paint',
  color: 'paint',
  backgroundColor: 'paint',
  visibility: 'paint',
  opacity: 'composite',
};

export type DirtyResult = {
  invalidation: Invalidation;
  /** Every box that has to be done again. */
  dirty: Set<BoxId>;
  /** The ancestors the change climbed to, nearest first. */
  climbs: BoxId[];
};

/**
 * What one declaration costs on one box. A composite change touches nothing but the box
 * itself. A paint change takes the subtree with it. A layout change also pushes everything
 * that comes after it in the flow, and climbs to any ancestor whose height was coming from
 * its content, which is how a single word can move the bottom of the page.
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
