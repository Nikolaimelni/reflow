import type { BlockBox, Box, BoxId } from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import type { Rect } from '../geometry.js';
import type { Fragment } from '../trace/events.js';

export type PaintItem = {
  box: BoxId;
  /** `visibility: hidden` keeps a box's space but takes it out of painting and hit testing. */
  visible: boolean;
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

type Bucket = {
  negative: { z: number; box: Box }[];
  /** `own` marks a box that paints in the block step but as one unit of its own. */
  blocks: { box: Box; own: boolean }[];
  inlines: Box[];
  /** Positioned, but with no z-index of its own, so it paints on top of the plain content. */
  level: Box[];
  positive: { z: number; box: Box }[];
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
  paint(root, state, root.id, 0);

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

function paint(box: Box, state: State, context: BoxId, depth: number): void {
  push(box, state, context, depth);
  if (box.kind === 'text') return;

  const bucket: Bucket = { negative: [], blocks: [], inlines: [], level: [], positive: [] };
  collect(box.children, bucket);

  for (const entry of [...bucket.negative].sort((a, b) => a.z - b.z)) {
    descend(entry.box, state, context, depth);
  }
  for (const entry of bucket.blocks) {
    if (entry.own) descend(entry.box, state, context, depth);
    else push(entry.box, state, context, depth);
  }
  for (const child of bucket.inlines) {
    push(child, state, context, depth);
  }
  for (const child of bucket.level) {
    descend(child, state, context, depth);
  }
  for (const entry of [...bucket.positive].sort((a, b) => a.z - b.z)) {
    descend(entry.box, state, context, depth);
  }
}

function push(box: Box, state: State, context: BoxId, depth: number): void {
  state.items.push({
    box: box.id,
    visible: box.style.visibility === 'visible',
    order: state.items.length,
    context,
    depth,
  });
}

/**
 * A positioned box with `z-index: auto` does not start a stacking context, but it does paint
 * as one piece, so it recurses without adding a level.
 */
function descend(box: Box, state: State, context: BoxId, depth: number): void {
  if (box.kind === 'text' || !formsStackingContext(box.style)) {
    paint(box, state, context, depth);
    return;
  }

  const zIndex = box.style.zIndex.kind === 'integer' ? box.style.zIndex.value : 'auto';
  state.contexts.push({ box: box.id, zIndex, parent: context, depth: depth + 1 });
  paint(box, state, box.id, depth + 1);
}

/**
 * Gathers what paints inside one stacking context. Non-positioned boxes hand their own
 * descendants over to the same buckets, which is why all the blocks come before all the
 * inline content rather than being interleaved per subtree.
 */
function collect(children: readonly Box[], bucket: Bucket): void {
  for (const child of children) {
    if (child.kind === 'text') {
      bucket.inlines.push(child);
      continue;
    }

    if (child.style.opacity < 1 && child.style.position === 'static') {
      // Transparent but not positioned. It keeps its place among the plain content, and it
      // paints as one unit, because the compositor needs the whole subtree before it can
      // fade it.
      bucket.blocks.push({ box: child, own: true });
      continue;
    }

    if (child.style.position !== 'static') {
      const zIndex = child.style.zIndex;
      if (zIndex.kind === 'integer' && zIndex.value < 0) {
        bucket.negative.push({ z: zIndex.value, box: child });
      } else if (zIndex.kind === 'integer' && zIndex.value > 0) {
        bucket.positive.push({ z: zIndex.value, box: child });
      } else {
        bucket.level.push(child);
      }
      continue;
    }

    if (child.kind === 'inline') {
      bucket.inlines.push(child);
    } else {
      bucket.blocks.push({ box: child, own: false });
    }

    collect(child.children, bucket);
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

    const fragment = geometry.fragments.get(item.box);
    const rects = geometry.pieces.get(item.box) ?? (fragment === undefined ? [] : [fragment.rect]);

    for (const rect of rects) {
      if (x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) {
        return item.box;
      }
    }
  }

  return null;
}
