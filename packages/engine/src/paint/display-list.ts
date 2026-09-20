import {
  type BlockBox,
  type Box,
  type BoxId,
  type InlineBox,
  inFlexOrder,
} from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import type { Rect } from '../geometry.js';
import type { Fragment } from '../trace/events.js';

export type PaintItem = {
  box: BoxId;
  /** `visibility: hidden` keeps a box's space but takes it out of painting and hit testing. */
  visible: boolean;
  /** The nearest ancestor that clips its overflow, if there is one. */
  clippedBy: BoxId | null;
  /** Position in the flat list, which is the order a painter would draw in. */
  order: number;
  /** The stacking context this box paints inside. */
  context: BoxId;
  /** How deep that context sits, which is what the layers view spreads out. */
  depth: number;
};

export type StackingContext = {
  box: BoxId;
  zIndex: number | 'auto';
  parent: BoxId | null;
  depth: number;
};

export type DisplayList = {
  items: PaintItem[];
  contexts: StackingContext[];
};

/** One entry in a bucket: the box, and the clip it inherited on the way down. */
type Entry = { box: Box; clip: BoxId | null };

type Bucket = {
  negative: (Entry & { z: number })[];
  /** `own` marks a box that paints in its step as one unit rather than handing its
   * descendants to the buckets around it. */
  blocks: (Entry & { own: boolean })[];
  inlines: (Entry & { own: boolean })[];
  /** Positioned, but with no z-index of its own, so it paints on top of the plain content. */
  level: Entry[];
  positive: (Entry & { z: number })[];
};

type State = {
  items: PaintItem[];
  contexts: StackingContext[];
};

/**
 * Appendix E of CSS 2.1, in the order it lists: the context's own background and border, then
 * negative stacking contexts, then blocks, then inline content, then positioned boxes with no
 * z-index, then positive stacking contexts. Floats are not in the subset, so step four is
 * missing and nothing else moves.
 */
export function buildDisplayList(root: BlockBox): DisplayList {
  const state: State = { items: [], contexts: [] };

  state.contexts.push({ box: root.id, zIndex: 'auto', parent: null, depth: 0 });
  paint(root, state, root.id, 0, null);

  return state;
}

/**
 * A positioned box with a z-index makes one, and so does anything the compositor has to hand
 * separately, which in this subset means `opacity` below one.
 */
export function formsStackingContext(style: ComputedStyle): boolean {
  if (style.opacity < 1) return true;
  return style.position !== 'static' && style.zIndex.kind === 'integer';
}

function paint(box: Box, state: State, context: BoxId, depth: number, clip: BoxId | null): void {
  push(box, state, context, depth, clip);
  if (box.kind === 'text') return;

  // Anything but visible overflow clips what is inside it, and the clip travels down
  // the tree with the descendants rather than applying to the box itself.
  const inner = box.style.overflow === 'visible' ? clip : box.id;

  const bucket: Bucket = { negative: [], blocks: [], inlines: [], level: [], positive: [] };
  collect(painted(box), bucket, inner);

  for (const entry of [...bucket.negative].sort((a, b) => a.z - b.z)) {
    descend(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of bucket.blocks) {
    if (entry.own) descend(entry.box, state, context, depth, entry.clip);
    else push(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of bucket.inlines) {
    if (entry.own) descend(entry.box, state, context, depth, entry.clip);
    else push(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of bucket.level) {
    descend(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of [...bucket.positive].sort((a, b) => a.z - b.z)) {
    descend(entry.box, state, context, depth, entry.clip);
  }
}

function push(box: Box, state: State, context: BoxId, depth: number, clip: BoxId | null): void {
  state.items.push({
    box: box.id,
    visible: box.style.visibility === 'visible',
    clippedBy: clip,
    order: state.items.length,
    context,
    depth,
  });
}

/**
 * A positioned box with `z-index: auto` does not start a stacking context, but it does paint
 * as one piece, so it recurses without adding a level.
 */
function descend(box: Box, state: State, context: BoxId, depth: number, clip: BoxId | null): void {
  if (box.kind === 'text' || !formsStackingContext(box.style)) {
    paint(box, state, context, depth, clip);
    return;
  }

  const zIndex = box.style.zIndex.kind === 'integer' ? box.style.zIndex.value : 'auto';
  state.contexts.push({ box: box.id, zIndex, parent: context, depth: depth + 1 });
  paint(box, state, box.id, depth + 1, clip);
}

/**
 * Gathers what paints inside one stacking context. Non-positioned boxes hand their own
 * descendants over to the same buckets, which is why all the blocks come before all the
 * inline content rather than being interleaved per subtree.
 */
function collect(children: readonly Box[], bucket: Bucket, clip: BoxId | null): void {
  for (const child of children) {
    if (child.kind === 'text') {
      bucket.inlines.push({ box: child, own: false, clip });
      continue;
    }

    if (child.style.opacity < 1 && child.style.position === 'static') {
      // Transparent but not positioned. It keeps its place among the plain content, and it
      // paints as one unit, because the compositor needs the whole subtree before it can
      // fade it.
      bucket.blocks.push({ box: child, own: true, clip });
      continue;
    }

    if (child.style.position !== 'static') {
      positioned(child, bucket, clip);
      continue;
    }

    if (child.kind === 'inline') {
      // An atomic inline paints as one piece at the inline step. Handing its blocks to the
      // bucket above would paint them before it, which is to say underneath its own
      // background, and a pointer over them would find the atomic instead.
      const atomic = child.style.display !== 'inline';
      bucket.inlines.push({ box: child, own: atomic, clip });
      if (atomic) {
        // It paints as one piece, but a positioned descendant is not part of that piece: it
        // belongs to the stacking context, over the top of everything in the line.
        escapes(child.children, bucket, clip);
        continue;
      }
    } else {
      bucket.blocks.push({ box: child, own: false, clip });
    }

    // A box that clips its overflow clips its descendants, whether or not it happens to be
    // the root of a stacking context.
    collect(painted(child), bucket, child.style.overflow === 'visible' ? clip : child.id);
  }
}

/** Flex items paint in the order `order` puts them in, the way inline blocks would. */
function painted(box: BlockBox | InlineBox): readonly Box[] {
  return box.style.display === 'flex' ? inFlexOrder(box.children) : box.children;
}

function positioned(box: Box, bucket: Bucket, clip: BoxId | null): void {
  const zIndex = box.style.zIndex;

  if (zIndex.kind === 'integer' && zIndex.value < 0) {
    bucket.negative.push({ z: zIndex.value, box, clip });
  } else if (zIndex.kind === 'integer' && zIndex.value > 0) {
    bucket.positive.push({ z: zIndex.value, box, clip });
  } else {
    bucket.level.push({ box, clip });
  }
}

/** What comes out of a box that paints as one piece: its positioned descendants, and nothing else. */
function escapes(children: readonly Box[], bucket: Bucket, clip: BoxId | null): void {
  for (const child of children) {
    if (child.kind === 'text') continue;
    if (child.style.position === 'static') escapes(child.children, bucket, clip);
    else positioned(child, bucket, clip);
  }
}

/**
 * Hit testing is the paint order read backwards: whatever was drawn last at a point is what
 * the pointer lands on. Which also makes it a way to check the paint order against a real
 * browser, since `document.elementFromPoint` answers the same question.
 */
export function hitTest(
  list: DisplayList,
  geometry: {
    fragments: ReadonlyMap<BoxId, Fragment>;
    /** Per line rects, used in place of the union for anything that sits on several lines. */
    pieces: ReadonlyMap<BoxId, readonly Rect[]>;
  },
  x: number,
  y: number,
  accept: (box: BoxId) => boolean = () => true,
): BoxId | null {
  for (let i = list.items.length - 1; i >= 0; i--) {
    const item = list.items[i];
    if (item === undefined || !item.visible || !accept(item.box)) continue;

    if (item.clippedBy !== null && !inside(geometry.fragments.get(item.clippedBy)?.rect, x, y)) {
      continue;
    }

    const fragment = geometry.fragments.get(item.box);
    const rects = geometry.pieces.get(item.box) ?? (fragment === undefined ? [] : [fragment.rect]);

    for (const rect of rects) {
      if (inside(rect, x, y)) return item.box;
    }
  }

  return null;
}

function inside(rect: Rect | undefined, x: number, y: number): boolean {
  if (rect === undefined) return false;
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}
