import {
  type BlockBox,
  type Box,
  type BoxId,
  type InlineBox,
  inFlexOrder,
  walkBoxes,
} from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import { AUTO } from '../cascade/values.js';
import type { ElementNode } from '../dom/node.js';
import type { Rect } from '../geometry.js';
import type { Fragment } from '../trace/events.js';

export type PaintItem = {
  box: BoxId;
  /**
   * The box itself, or the line boxes of a block that holds inline content. Those have
   * nothing to draw, but they are hit tested where that content paints, over the backgrounds
   * of the blocks that come after, so a line hanging out of its block still finds the block.
   */
  part: 'box' | 'lines';
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
  blocks: Entry[];
  /** `own` marks an atomic inline, which paints in its step as one unit. */
  inlines: (Entry & { own: boolean; part: 'box' | 'lines' })[];
  /**
   * Positioned with no z-index of its own, or transparent, so it paints on top of the plain
   * content.
   */
  level: Entry[];
  positive: (Entry & { z: number })[];
  /**
   * Set while painting a box that paints as one piece without being a stacking context. What
   * is layered inside it was handed to the context when the box was, so it is not gathered
   * again here.
   */
  hoisted: boolean;
  /** Halves that paint with the first half of their element, never on their own. */
  skip: ReadonlySet<BoxId>;
  together: ReadonlyMap<BoxId, Box[]>;
  flexItems: ReadonlySet<BoxId>;
};

type State = {
  items: PaintItem[];
  contexts: StackingContext[];
  /**
   * A layered inline that a block cut in two is still one element: its halves paint together,
   * under the first of them, and whatever is positioned inside any half paints after all of
   * them rather than under the next half.
   */
  together: Map<BoxId, Box[]>;
  followers: Set<BoxId>;
  /** A flex item takes a z-index without being positioned. */
  flexItems: Set<BoxId>;
};

/**
 * Appendix E of CSS 2.1, in the order it lists: the context's own background and border, then
 * negative stacking contexts, then blocks, then inline content, then positioned boxes with no
 * z-index, then positive stacking contexts. Floats are not in the subset, so step four is
 * missing and nothing else moves.
 */
export function buildDisplayList(root: BlockBox): DisplayList {
  const flexItems = new Set<BoxId>();
  walkBoxes(root, (box) => {
    if (box.kind === 'block' && box.style.display === 'flex') {
      for (const child of box.children) flexItems.add(child.id);
    }
  });
  const state: State = { items: [], contexts: [], flexItems, ...cutAndPositioned(root) };

  state.contexts.push({ box: root.id, zIndex: 'auto', parent: null, depth: 0 });
  paint(root, state, root.id, 0, null);

  return { items: state.items, contexts: state.contexts };
}

function cutAndPositioned(root: BlockBox): Pick<State, 'together' | 'followers'> {
  const byElement = new Map<ElementNode, Box[]>();
  walkBoxes(root, (box) => {
    if (box.kind !== 'inline' || box.atomic || !layered(box.style)) return;
    const seen = byElement.get(box.element);
    if (seen === undefined) byElement.set(box.element, [box]);
    else seen.push(box);
  });

  const together = new Map<BoxId, Box[]>();
  const followers = new Set<BoxId>();
  for (const halves of byElement.values()) {
    const [first, ...rest] = halves;
    if (first === undefined || rest.length === 0) continue;
    together.set(first.id, halves);
    for (const half of rest) followers.add(half.id);
  }
  return { together, followers };
}

/**
 * A positioned box with a z-index makes one, and so does a flex item with one, positioned or
 * not, and anything the compositor has to hand separately, which in this subset means
 * `opacity` below one.
 */
export function formsStackingContext(style: ComputedStyle, flexItem = false): boolean {
  if (style.opacity < 1) return true;
  return (style.position !== 'static' || flexItem) && style.zIndex.kind === 'integer';
}

/**
 * Painted as one unit with the positioned boxes rather than with the plain content. A box that
 * is transparent and not positioned goes where one positioned with a z-index of zero would,
 * since the compositor needs the whole of it before it can fade it, and a flex item with a
 * z-index goes where its z-index says.
 */
function layered(style: ComputedStyle, flexItem = false): boolean {
  return (
    style.position !== 'static' ||
    style.opacity < 1 ||
    (flexItem && style.zIndex.kind === 'integer')
  );
}

function paint(
  box: Box,
  state: State,
  context: BoxId,
  depth: number,
  clip: BoxId | null,
  hoisted = false,
): void {
  const group = state.together.get(box.id) ?? [box];
  for (const one of group) push(one, state, context, depth, clip);
  if (box.kind === 'text') return;

  // Anything but visible overflow clips what is inside it, and the clip travels down
  // the tree with the descendants rather than applying to the box itself.
  const inner = box.style.overflow === 'visible' ? clip : box.id;

  const bucket: Bucket = {
    negative: [],
    blocks: [],
    inlines: [],
    level: [],
    positive: [],
    hoisted,
    skip: state.followers,
    together: state.together,
    flexItems: state.flexItems,
  };
  if (holdsLines(box)) bucket.inlines.push({ box, own: false, clip: inner, part: 'lines' });
  collect(
    group.flatMap((one) => (one.kind === 'text' ? [] : painted(one))),
    bucket,
    inner,
    box.style.display === 'flex',
  );

  for (const entry of [...bucket.negative].sort((a, b) => a.z - b.z)) {
    descend(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of bucket.blocks) {
    push(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of bucket.inlines) {
    if (entry.own) descend(entry.box, state, context, depth, entry.clip);
    else push(entry.box, state, context, depth, entry.clip, entry.part);
  }
  for (const entry of bucket.level) {
    descend(entry.box, state, context, depth, entry.clip);
  }
  for (const entry of [...bucket.positive].sort((a, b) => a.z - b.z)) {
    descend(entry.box, state, context, depth, entry.clip);
  }
}

function push(
  box: Box,
  state: State,
  context: BoxId,
  depth: number,
  clip: BoxId | null,
  part: PaintItem['part'] = 'box',
): void {
  state.items.push({
    box: box.id,
    part,
    visible: box.style.visibility === 'visible',
    clippedBy: clip,
    order: state.items.length,
    context,
    depth,
  });
}

/**
 * A positioned box with `z-index: auto` does not start a stacking context, and neither does an
 * atomic inline, but each paints as one piece, so it recurses without adding a level.
 */
function descend(box: Box, state: State, context: BoxId, depth: number, clip: BoxId | null): void {
  if (box.kind === 'text' || !formsStackingContext(box.style, state.flexItems.has(box.id))) {
    paint(box, state, context, depth, clip, true);
    return;
  }

  const zIndex = box.style.zIndex.kind === 'integer' ? box.style.zIndex.value : 'auto';
  state.contexts.push({ box: box.id, zIndex, parent: context, depth: depth + 1 });
  paint(box, state, box.id, depth + 1, clip);
}

/**
 * Gathers what paints inside one stacking context. Non-positioned boxes hand their own
 * descendants over to the same buckets, which is why all the blocks come before all the
 * inline content rather than being interleaved per subtree. Flex items do not: they paint the
 * way inline-blocks do, which `items` says these children are.
 */
function collect(
  children: readonly Box[],
  bucket: Bucket,
  clip: BoxId | null,
  items = false,
): void {
  for (const child of children) {
    if (child.kind === 'text') {
      bucket.inlines.push({ box: child, own: false, clip, part: 'box' });
      continue;
    }

    if (layered(child.style, items)) {
      if (!bucket.hoisted) layer(child, bucket, clip);
      continue;
    }

    if (child.kind === 'inline' || items) {
      // An atomic inline paints as one piece at the inline step. Handing its blocks to the
      // bucket above would paint them before it, which is to say underneath its own
      // background, and a pointer over them would find the atomic instead.
      const atomic = items || child.style.display !== 'inline';
      bucket.inlines.push({ box: child, own: atomic, clip, part: 'box' });
      if (atomic) {
        // It paints as one piece, but a layered descendant is not part of that piece: it
        // belongs to the stacking context, over the top of everything in the line.
        if (!bucket.hoisted) escapes(painted(child), bucket, clip);
        continue;
      }
    } else {
      bucket.blocks.push({ box: child, clip });
    }

    // A box that clips its overflow clips its descendants, whether or not it happens to be
    // the root of a stacking context.
    const inner = child.style.overflow === 'visible' ? clip : child.id;
    if (holdsLines(child))
      bucket.inlines.push({ box: child, own: false, clip: inner, part: 'lines' });
    collect(painted(child), bucket, inner, child.style.display === 'flex');
  }
}

/** A block laying out inline content has line boxes. An inline that is not atomic has none. */
function holdsLines(box: Box): boolean {
  if (box.kind === 'text' || (box.kind === 'inline' && !box.atomic)) return false;
  return box.children.some((child) => child.kind !== 'block');
}

/** Flex items paint in the order `order` puts them in, the way inline blocks would. */
function painted(box: BlockBox | InlineBox): readonly Box[] {
  return box.style.display === 'flex' ? inFlexOrder(box.children) : box.children;
}

/**
 * Files a layered box under the step its z-index puts it in. One that makes no stacking
 * context of its own only paints as one piece: what is layered inside it belongs to the same
 * context as the box, and is sorted there by its own z-index, after the box.
 */
function layer(box: Box, bucket: Bucket, clip: BoxId | null): void {
  if (box.kind === 'text' || bucket.skip.has(box.id)) return;
  // A z-index only does anything to a box that is positioned, or to a flex item.
  const flexItem = bucket.flexItems.has(box.id);
  const zIndex = box.style.position === 'static' && !flexItem ? AUTO : box.style.zIndex;

  if (zIndex.kind === 'integer' && zIndex.value < 0) {
    bucket.negative.push({ z: zIndex.value, box, clip });
  } else if (zIndex.kind === 'integer' && zIndex.value > 0) {
    bucket.positive.push({ z: zIndex.value, box, clip });
  } else {
    bucket.level.push({ box, clip });
  }

  if (formsStackingContext(box.style, flexItem)) return;
  const inner = box.style.overflow === 'visible' ? clip : box.id;
  const group = bucket.together.get(box.id) ?? [box];
  escapes(
    group.flatMap((one) => (one.kind === 'text' ? [] : painted(one))),
    bucket,
    inner,
  );
}

/** What comes out of a box that paints as one piece: its layered descendants, and nothing else. */
function escapes(children: readonly Box[], bucket: Bucket, clip: BoxId | null): void {
  for (const child of children) {
    if (child.kind === 'text') continue;
    if (layered(child.style, bucket.flexItems.has(child.id))) layer(child, bucket, clip);
    else escapes(painted(child), bucket, clip);
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
    lineBoxes: ReadonlyMap<BoxId, readonly Rect[]>;
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
    const rects =
      item.part === 'lines'
        ? (geometry.lineBoxes.get(item.box) ?? [])
        : (geometry.pieces.get(item.box) ?? (fragment === undefined ? [] : [fragment.rect]));

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
