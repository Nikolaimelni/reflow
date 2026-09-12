import { type BlockBox, type Box, type BoxId, type InlineBox, isBlock } from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import type { Edges } from '../geometry.js';
import type { Fragment, LayoutEvent } from '../trace/events.js';
import { type AtomicSize, layoutInlineContent } from './inline.js';
import { intrinsicWidths, shrinkToFit } from './intrinsic.js';
import {
  type CollapsedMargin,
  mergeMargins,
  NO_MARGIN,
  resolveMargin,
  withMargin,
} from './margins.js';
import type { TextMeasurer } from './text.js';
import {
  clampSize,
  usedBorderWidths,
  usedMargin,
  usedMaxSize,
  usedPadding,
  usedSize,
} from './used.js';

export type Viewport = { width: number; height: number };

export type LayoutResult = {
  fragments: Map<BoxId, Fragment>;
  trace: LayoutEvent[];
};

type ContainingBlock = {
  x: number;
  width: number;
  /** null when the containing block's own height is still auto. */
  height: number | null;
};

type Context = {
  fragments: Map<BoxId, Fragment>;
  trace: LayoutEvent[];
  measurer: TextMeasurer;
};

type BlockResult = {
  /** Border-box height, margins excluded. */
  height: number;
  /** What is left adjoining the bottom edge and may still collapse with what follows. */
  marginBottom: CollapsedMargin;
  collapsedThrough: boolean;
  /** Last line box baseline, measured from the border-box top, for an atomic inline. */
  baseline: number | null;
};

type Horizontal = {
  marginLeft: number;
  marginRight: number;
  contentWidth: number;
  reason: string;
};

export function layoutDocument(
  root: BlockBox,
  viewport: Viewport,
  measurer: TextMeasurer,
): LayoutResult {
  const context: Context = { fragments: new Map(), trace: [], measurer };
  const containing: ContainingBlock = { x: 0, width: viewport.width, height: viewport.height };

  // The root's margins never collapse with anything, so its own top margin is all there is.
  const top = usedMargin(root.style.marginTop, viewport.width) ?? 0;
  layoutBlock(root, containing, top, context, true);

  return { fragments: context.fragments, trace: context.trace };
}

/**
 * `top` is the final position of the border box. The caller already knows it, because every
 * margin that could still move the box has been collapsed on the way in.
 */
function layoutBlock(
  box: BlockBox,
  containing: ContainingBlock,
  top: number,
  context: Context,
  isRoot = false,
): BlockResult {
  const style = box.style;

  context.trace.push({
    t: 'measure:start',
    box: box.id,
    constraint: { availableWidth: containing.width, availableHeight: containing.height },
  });

  const border = usedBorderWidths(style);
  const padding = usedPadding(style, containing.width);
  const horizontal = resolveHorizontal(style, containing.width, border, padding);

  const margin: Edges = {
    top: usedMargin(style.marginTop, containing.width) ?? 0,
    right: horizontal.marginRight,
    bottom: usedMargin(style.marginBottom, containing.width) ?? 0,
    left: horizontal.marginLeft,
  };

  const x = containing.x + margin.left;
  const contentTop = top + border.top + padding.top;
  const specifiedHeight = contentHeight(
    style,
    usedSize(style.height, containing.height),
    border,
    padding,
  );

  const childContaining: ContainingBlock = {
    x: x + border.left + padding.left,
    width: horizontal.contentWidth,
    height: specifiedHeight,
  };

  const flow = layoutChildren(box, childContaining, contentTop, border, padding, context, isRoot);
  const bottomEscapes = !isRoot && canCollapseBottom(style, padding, border, specifiedHeight);

  // A trailing margin that cannot escape has to be paid for in this box's own height.
  const fromContent = flow.height + (bottomEscapes ? 0 : resolveMargin(flow.trailing));

  const height = clampSize(
    specifiedHeight ?? fromContent,
    contentHeight(style, usedSize(style.minHeight, containing.height), border, padding),
    contentHeight(style, usedMaxSize(style.maxHeight, containing.height), border, padding),
  );

  const fragment: Fragment = {
    box: box.id,
    rect: {
      x,
      y: top,
      width: horizontal.contentWidth + padding.left + padding.right + border.left + border.right,
      height: height + padding.top + padding.bottom + border.top + border.bottom,
    },
    margin,
    border,
    padding,
  };

  context.fragments.set(box.id, fragment);
  context.trace.push({
    t: 'size:resolved',
    box: box.id,
    fragment,
    reason: `${horizontal.reason}; ${specifiedHeight === null ? 'height from content' : 'height from the style'}`,
  });

  const ownBottom = withMargin(NO_MARGIN, margin.bottom);

  return {
    height: fragment.rect.height,
    marginBottom: bottomEscapes ? mergeMargins(ownBottom, flow.trailing) : ownBottom,
    collapsedThrough: !isRoot && collapsesThrough(box, containing.width),
    baseline: flow.baseline === null ? null : border.top + padding.top + flow.baseline,
  };
}

type FlowResult = {
  /** Height taken by the children inside the content box. */
  height: number;
  /** Margins still adjoining the bottom of the content, not yet committed to the height. */
  trailing: CollapsedMargin;
  /** Last baseline found among the children, measured from the content top. */
  baseline: number | null;
};

function layoutChildren(
  box: BlockBox,
  containing: ContainingBlock,
  contentTop: number,
  border: Edges,
  padding: Edges,
  context: Context,
  isRoot: boolean,
): FlowResult {
  const blocks = box.children.filter(isBlock);

  if (blocks.length === 0) {
    if (box.children.length === 0) return { height: 0, trailing: NO_MARGIN, baseline: null };

    const inline = layoutInlineContent({
      container: box,
      containerStyle: box.style,
      contentX: containing.x,
      contentTop,
      available: containing.width,
      measurer: context.measurer,
      fragments: context.fragments,
      trace: context.trace,
      layoutAtomic: (child, available) => measureAtomic(child, available, context),
      placeAtomic: (child, x, y) => placeAtomic(child, x, y, containing.width, context),
    });

    return { height: inline.height, trailing: NO_MARGIN, baseline: inline.lastBaseline };
  }

  const collapseIntoTop = !isRoot && canCollapseTop(box.style, padding, border);
  let height = 0;
  let pending = NO_MARGIN;
  let placed = false;
  let baseline: number | null = null;

  for (const child of blocks) {
    if (!placed && collapseIntoTop) {
      // Already folded into this box's own top margin, so it must not push the child down.
      pending = NO_MARGIN;
    } else {
      pending = collapseWithTrace(
        pending,
        adjoiningTopMargins(child, containing.width),
        child.id,
        context,
      );
    }

    const childTop = contentTop + height + resolveMargin(pending);
    const result = layoutBlock(child, containing, childTop, context);

    if (result.collapsedThrough) {
      pending = mergeMargins(pending, result.marginBottom);
      continue;
    }

    context.trace.push({
      t: 'child:positioned',
      box: child.id,
      parent: box.id,
      rect: { x: containing.x, y: childTop, width: containing.width, height: result.height },
    });

    height = childTop + result.height - contentTop;
    pending = result.marginBottom;
    placed = true;

    if (result.baseline !== null) baseline = childTop - contentTop + result.baseline;
  }

  return { height, trailing: pending, baseline };
}

function collapseWithTrace(
  pending: CollapsedMargin,
  incoming: CollapsedMargin,
  child: BoxId,
  context: Context,
): CollapsedMargin {
  const merged = mergeMargins(pending, incoming);
  const before = resolveMargin(pending);
  const after = resolveMargin(incoming);

  if (before !== 0 && after !== 0) {
    context.trace.push({
      t: 'margin:collapsed',
      boxes: [child],
      from: [before, after],
      to: resolveMargin(merged),
    });
  }

  return merged;
}

/** Turns a border-box measurement into a content-box one when `box-sizing` asks for it. */
function contentHeight(
  style: ComputedStyle,
  value: number | null,
  border: Edges,
  padding: Edges,
): number | null {
  if (value === null || style.boxSizing !== 'border-box') return value;
  return Math.max(0, value - padding.top - padding.bottom - border.top - border.bottom);
}

function resolveHorizontal(
  style: ComputedStyle,
  containingWidth: number,
  border: Edges,
  padding: Edges,
): Horizontal {
  const surround = border.left + border.right + padding.left + padding.right;
  const specified = usedSize(style.width, containingWidth);

  const first = solveHorizontal(style, containingWidth, surround, specified);
  const clamped = clampSize(
    first.contentWidth,
    usedSize(style.minWidth, containingWidth),
    usedMaxSize(style.maxWidth, containingWidth),
  );

  if (clamped === first.contentWidth) {
    return { ...first, reason: describeWidth(style, specified, false) };
  }

  // A clamped width is then treated as a fixed one, margins and all.
  const again = solveHorizontal(style, containingWidth, surround, clamped, true);
  return { ...again, reason: describeWidth(style, specified, true) };
}

function solveHorizontal(
  style: ComputedStyle,
  containingWidth: number,
  surround: number,
  width: number | null,
  isContentWidth = false,
): Omit<Horizontal, 'reason'> {
  const left = usedMargin(style.marginLeft, containingWidth);
  const right = usedMargin(style.marginRight, containingWidth);

  if (width === null) {
    // An auto width eats whatever the margins leave, and auto margins become zero.
    const marginLeft = left ?? 0;
    const marginRight = right ?? 0;
    return {
      marginLeft,
      marginRight,
      contentWidth: Math.max(0, containingWidth - surround - marginLeft - marginRight),
    };
  }

  const contentWidth =
    isContentWidth || style.boxSizing !== 'border-box'
      ? Math.max(0, width)
      : Math.max(0, width - surround);
  const free = containingWidth - surround - contentWidth;

  if (left === null && right === null) {
    const half = Math.max(0, free / 2);
    return { marginLeft: half, marginRight: half, contentWidth };
  }
  if (left === null) {
    const marginRight = right ?? 0;
    return { marginLeft: free - marginRight, marginRight, contentWidth };
  }

  // Either the right margin is auto, or the box is over-constrained. In a left-to-right
  // document both end the same way: the right margin takes what is left.
  return { marginLeft: left, marginRight: free - left, contentWidth };
}

function describeWidth(style: ComputedStyle, specified: number | null, clamped: boolean): string {
  if (clamped) return 'width clamped by min or max';
  if (specified === null) return 'width auto fills the containing block';
  if (style.width.kind === 'percent') return `width ${style.width.value}% of the containing block`;
  return `width ${specified}px from the style`;
}

function establishesBfc(style: ComputedStyle): boolean {
  return style.overflow !== 'visible' || style.display === 'flex';
}

/** Nothing may sit between two margins for them to touch: no border, no padding. */
function canCollapseTop(style: ComputedStyle, padding: Edges, border: Edges): boolean {
  return !establishesBfc(style) && padding.top === 0 && border.top === 0;
}

function canCollapseBottom(
  style: ComputedStyle,
  padding: Edges,
  border: Edges,
  specifiedHeight: number | null,
): boolean {
  return (
    !establishesBfc(style) &&
    padding.bottom === 0 &&
    border.bottom === 0 &&
    specifiedHeight === null
  );
}

/**
 * The margins adjoining the top edge of a box, including the ones escaping from inside it.
 * Read from styles alone, so a parent can place a child before laying it out.
 */
function adjoiningTopMargins(box: BlockBox, containingWidth: number): CollapsedMargin {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, containingWidth);
  let collapsed = withMargin(NO_MARGIN, usedMargin(box.style.marginTop, containingWidth) ?? 0);

  if (!canCollapseTop(box.style, padding, border)) return collapsed;

  const inner = resolveHorizontal(box.style, containingWidth, border, padding).contentWidth;

  for (const child of inFlowChildren(box)) {
    if (!isBlock(child)) break;

    collapsed = mergeMargins(collapsed, adjoiningTopMargins(child, inner));
    if (!collapsesThrough(child, inner)) break;
    collapsed = mergeMargins(collapsed, adjoiningBottomMargins(child, inner));
  }

  return collapsed;
}

function adjoiningBottomMargins(box: BlockBox, containingWidth: number): CollapsedMargin {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, containingWidth);
  const height = usedSize(box.style.height, null);
  let collapsed = withMargin(NO_MARGIN, usedMargin(box.style.marginBottom, containingWidth) ?? 0);

  if (!canCollapseBottom(box.style, padding, border, height)) return collapsed;

  const inner = resolveHorizontal(box.style, containingWidth, border, padding).contentWidth;

  for (const child of [...inFlowChildren(box)].reverse()) {
    if (!isBlock(child)) break;

    collapsed = mergeMargins(collapsed, adjoiningBottomMargins(child, inner));
    if (!collapsesThrough(child, inner)) break;
    collapsed = mergeMargins(collapsed, adjoiningTopMargins(child, inner));
  }

  return collapsed;
}

/** A box with nothing between its own two margins lets them meet, and takes no height. */
function collapsesThrough(box: BlockBox, containingWidth: number): boolean {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, containingWidth);

  if (establishesBfc(box.style)) return false;
  if (border.top + border.bottom + padding.top + padding.bottom > 0) return false;

  const height = usedSize(box.style.height, null);
  if (height !== null && height > 0) return false;
  if ((usedSize(box.style.minHeight, null) ?? 0) > 0) return false;

  const inner = resolveHorizontal(box.style, containingWidth, border, padding).contentWidth;
  return inFlowChildren(box).every((child) => isBlock(child) && collapsesThrough(child, inner));
}

function inFlowChildren(box: BlockBox): Box[] {
  return box.children.filter((child) => !isWhitespaceText(child));
}

function isWhitespaceText(box: Box): boolean {
  return box.kind === 'text' && box.text.trim() === '';
}

/**
 * An inline-block lays its own children out as blocks, so it goes through the block path in
 * a throwaway context first just to find out how big it is.
 */
function measureAtomic(box: InlineBox, available: number, context: Context): AtomicSize {
  const scratch: Context = { fragments: new Map(), trace: [], measurer: context.measurer };
  const width = atomicWidth(box, available, context);
  const result = layoutBlock(asBlock(box), { x: 0, width, height: null }, 0, scratch);
  const fragment = scratch.fragments.get(box.id);

  // An inline-block that clips its overflow hides its baseline with it, so it aligns on its
  // bottom margin edge instead. Otherwise the last line inside it is what lines up outside.
  const baseline = box.style.overflow === 'visible' ? result.baseline : null;

  return { width: fragment?.rect.width ?? 0, height: result.height, baseline };
}

function placeAtomic(
  box: InlineBox,
  x: number,
  y: number,
  available: number,
  context: Context,
): void {
  const width = atomicWidth(box, available, context);
  layoutBlock(asBlock(box), { x, width, height: null }, y, context);
}

/**
 * An inline-block with an auto width shrinks to fit. Handing the block path a containing
 * block of exactly that width gets the same answer, because an auto width fills it.
 */
function atomicWidth(box: InlineBox, available: number, context: Context): number {
  if (box.style.width.kind !== 'auto') return available;
  return shrinkToFit(intrinsicWidths(asBlock(box), context.measurer), available);
}

function asBlock(box: InlineBox): BlockBox {
  return {
    kind: 'block',
    id: box.id,
    element: box.element,
    style: box.style,
    children: box.children,
  };
}
