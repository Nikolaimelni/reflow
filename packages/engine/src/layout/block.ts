import {
  type BlockBox,
  type Box,
  type BoxId,
  boxesByElement,
  type InlineBox,
  inFlexOrder,
  isBlock,
  isCollapsibleWhitespace,
  walkBoxes,
} from '../boxtree/box.js';
import type { AlignContent, AlignItems, ComputedStyle } from '../cascade/properties.js';
import type { ElementNode } from '../dom/node.js';
import { type Edges, type Rect, zeroEdges } from '../geometry.js';
import type { Fragment, LayoutEvent } from '../trace/events.js';
import { type FlexItemInput, solveFlex } from './flex.js';
import { type AtomicSize, hasOutsideMarker, type LineRef, layoutInlineContent } from './inline.js';
import { intrinsicContentWidths, shrinkToFit } from './intrinsic.js';
import {
  type CollapsedMargin,
  mergeMargins,
  NO_MARGIN,
  resolveMargin,
  withMargin,
} from './margins.js';
import { type AxisResult, relativeOffset, solveAbsoluteAxis } from './position.js';
import { fontOf, type TextMeasurer, usedLineHeight } from './text.js';
import {
  clampSize,
  toContentBox,
  usedBorderWidths,
  usedGap,
  usedInset,
  usedMargin,
  usedPadding,
  usedSize,
} from './used.js';

export type Viewport = {
  width: number;
  height: number;
  /** The screen the layout is for. Blink snaps parts of a line box to it, so the engine does. */
  devicePixelRatio?: number;
};

export type LayoutResult = {
  fragments: Map<BoxId, Fragment>;
  /** Per line rects for inline content, where one box can appear in several places. */
  pieces: Map<BoxId, Rect[]>;
  /** The same, but only for inline boxes, and one rect per line rather than per word. */
  lines: Map<BoxId, Rect[]>;
  /**
   * The line boxes of every block that holds inline content, as wide as what is on them. A
   * pointer that lands in one finds the block, even where the line hangs over something else.
   */
  lineBoxes: Map<BoxId, Rect[]>;
  /** The line each rect in `pieces` sits on, for a later line to be hit tested over it. */
  lineOf: Map<Rect, LineRef>;
  trace: LayoutEvent[];
};

type ContainingBlock = {
  x: number;
  width: number;
  // null when the containing block's own height is still auto.
  height: number | null;
};

type Context = {
  fragments: Map<BoxId, Fragment>;
  pieces: Map<BoxId, Rect[]>;
  lines: Map<BoxId, Rect[]>;
  lineBoxes: Map<BoxId, Rect[]>;
  lineOf: Map<Rect, LineRef>;
  trace: LayoutEvent[];
  measurer: TextMeasurer;
  devicePixelRatio: number;
  // The initial containing block, which is what an absolute box falls back to.
  icb: Rect;
  // Every box an element made, in order, for a positioned inline that was cut in two.
  boxesOf: ReadonlyMap<ElementNode, readonly BoxId[]>;
  elementOf: ReadonlyMap<BoxId, ElementNode>;
  // Elements laid out as inline boxes that are positioned, and so containing blocks, with the
  // style their boxes carry.
  positionedInlines: ReadonlyMap<ElementNode, ComputedStyle>;
};

// An out of flow box, parked until the containing block it belongs to has a size.
type Deferred = {
  box: BlockBox;
  staticX: number;
  staticY: number;
  // A child of a flex container takes its static position as if it were the only item in
  // it, so it is aligned inside the container's content box rather than parked at its start.
  // One that came out of a line or the block flow is aligned in a rectangle that starts at
  // its static position instead: a line tall, or no size at all.
  aligned: { within: BoxId | { width: number; height: number }; x: Placement; y: Placement } | null;
  // A positioned inline that is the containing block, rather than the block it was given.
  inside: ElementNode | null;
};

type Placement = 'start' | 'center' | 'end';

// Absolute positioning solves width, position and margins together, so it hands them over.
type Override = {
  x: number;
  contentWidth: number;
  margin: Edges;
  contentHeight: number | null;
  // Whether that height is a size the box was given rather than one it worked out from its
  // content. A percentage height inside only has something to resolve against when it is.
  definite?: boolean;
};

type BlockInput = {
  box: BlockBox;
  containing: ContainingBlock;
  // Where the border box goes in the flow, before any relative offset.
  top: number;
  absolutes: Deferred[];
  isRoot: boolean;
  // What this box's own percentage edges resolve against, when it is not the given width.
  basis?: number;
  // A box that is a formatting context root because of where it sits rather than because of
  // anything in its own style, which is what a flex item is. Nothing inside it collapses out.
  independent?: boolean;
  override: Override | null;
};

type BlockResult = {
  // Border-box height, margins excluded.
  height: number;
  // What is left adjoining the bottom edge and may still collapse with what follows.
  marginBottom: CollapsedMargin;
  collapsedThrough: boolean;
  // Last line box baseline, measured from the border-box top, for an atomic inline.
  baseline: number | null;
  // The first, which is the one a flex line lines its items up by.
  firstBaseline: number | null;
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
  const icb: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const context: Context = {
    fragments: new Map(),
    pieces: new Map(),
    lines: new Map(),
    lineBoxes: new Map(),
    lineOf: new Map(),
    trace: [],
    measurer,
    icb,
    devicePixelRatio: viewport.devicePixelRatio ?? 1,
    ...elementsOf(root),
  };
  const containing: ContainingBlock = { x: 0, width: viewport.width, height: viewport.height };

  // The root's margins never collapse with anything, so its own top margin is all there is.
  const top = usedMargin(root.style.marginTop, viewport.width) ?? 0;
  layoutBlock({ box: root, containing, top, absolutes: [], isRoot: true, override: null }, context);

  return {
    fragments: context.fragments,
    pieces: context.pieces,
    lines: context.lines,
    lineBoxes: context.lineBoxes,
    lineOf: context.lineOf,
    trace: context.trace,
  };
}

// `top` is the final position of the border box. The caller already knows it, because every
// margin that could still move the box has been collapsed on the way in.
function layoutBlock(input: BlockInput, context: Context): BlockResult {
  const { box, containing, top, isRoot, override } = input;
  const style = box.style;

  context.trace.push({
    t: 'measure:start',
    box: box.id,
    constraint: { availableWidth: containing.width, availableHeight: containing.height },
  });

  const border = usedBorderWidths(style);
  // Percentages on the box's own edges go against its containing block, which is not the
  // same width the box ended up with when it was measured for a shrink to fit.
  const padding = usedPadding(style, input.basis ?? containing.width);
  const down = border.top + border.bottom + padding.top + padding.bottom;
  const horizontal =
    override === null
      ? resolveHorizontal(style, containing.width, border, padding)
      : {
          marginLeft: override.margin.left,
          marginRight: override.margin.right,
          contentWidth: override.contentWidth,
          reason: 'width from the insets that placed it',
        };

  const margin: Edges =
    override === null
      ? {
          top: usedMargin(style.marginTop, containing.width) ?? 0,
          right: horizontal.marginRight,
          bottom: usedMargin(style.marginBottom, containing.width) ?? 0,
          left: horizontal.marginLeft,
        }
      : override.margin;

  // The block around what cut a positioned inline in two moves with the inline, by the offset
  // its halves were given.
  const owner = box.element === null ? undefined : context.positionedInlines.get(box.element);
  const offset =
    owner === undefined
      ? relativeOffset(style, containing)
      : relativeOffset(owner, { width: containing.width, height: null });
  const x = (override === null ? containing.x + margin.left : override.x) + offset.dx;
  const boxTop = top + offset.dy;
  const contentTop = boxTop + border.top + padding.top;

  const minHeight = toContentBox(
    style.boxSizing,
    usedSize(style.minHeight, containing.height),
    down,
  );
  const maxHeight = toContentBox(
    style.boxSizing,
    usedSize(style.maxHeight, containing.height),
    down,
  );

  const given =
    override === null
      ? toContentBox(style.boxSizing, usedSize(style.height, containing.height), down)
      : override.contentHeight;

  // A percentage inside goes against what this box ends up being, not what it asked for, so
  // the min and max bite before the children are told anything.
  const specifiedHeight = given === null ? null : clampSize(given, minHeight, maxHeight);

  const childContaining: ContainingBlock = {
    x: x + border.left + padding.left,
    width: horizontal.contentWidth,
    height: override?.definite === false ? null : specifiedHeight,
  };

  // A positioned box is the containing block for the absolute boxes under it, so it collects
  // them on the way down and places them once its own size is known.
  const positioned = isRoot || style.position !== 'static';
  // The block around what cut a positioned inline in two belongs to the inline, and so does
  // anything absolutely positioned inside it: the inline is its containing block, not a block
  // further out.
  const cut =
    !positioned && box.element !== null && context.positionedInlines.has(box.element)
      ? box.element
      : null;
  const mine = positioned || cut !== null ? [] : input.absolutes;

  const independent = isRoot || input.independent === true || alignsContent(style);

  // Aligning the content means knowing how tall it is before anything is placed, so it is
  // laid out once in a throwaway context and then again where the alignment puts it.
  const group = alignsContent(style)
    ? measureFlow(box, childContaining, contentTop, border, padding, context)
    : 0;
  const leading = alignsContent(style)
    ? alignmentLeading(
        style.alignContent,
        clampSize(specifiedHeight ?? group, minHeight, maxHeight) - group,
      )
    : 0;

  const flow =
    style.display === 'flex'
      ? layoutFlexItems(box, childContaining, contentTop, context, mine, {
          min: minHeight ?? 0,
          max: maxHeight,
        })
      : layoutChildren(
          box,
          childContaining,
          contentTop + leading,
          border,
          padding,
          context,
          independent,
          mine,
        );
  const bottomCollapses =
    !isRoot && !independent && canCollapseBottom(style, padding, border, specifiedHeight);

  // A trailing margin that cannot escape has to be paid for in this box's own height. A
  // marker outside a list item has to sit on a line, and when nothing in the item makes one
  // it makes its own, as tall as the item's line height, without pushing anything down.
  const marker =
    hasOutsideMarker(style) && flow.baseline === null
      ? usedLineHeight(style, context.measurer.metrics(fontOf(style)))
      : 0;
  const fromContent = Math.max(
    marker,
    flow.height + (bottomCollapses ? 0 : resolveMargin(flow.trailing)),
  );

  // One that could escape only does while the min and the max leave the box the height of its
  // content. Once they change it, Blink drops the margin: it neither leaves nor adds to the
  // height. Measured, and not what CSS 2.1 says, which would keep it inside.
  const bottomEscapes =
    bottomCollapses &&
    Math.max(0, clampSize(fromContent, minHeight, maxHeight)) === Math.max(0, fromContent);

  // A used height is never negative, however far a negative margin pulls the content up.
  const height = Math.max(0, clampSize(specifiedHeight ?? fromContent, minHeight, maxHeight));

  const fragment: Fragment = {
    box: box.id,
    rect: {
      x,
      y: boxTop,
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

  if (positioned) {
    const paddingBox: Rect = isRoot
      ? context.icb
      : {
          x: x + border.left,
          y: boxTop + border.top,
          width: horizontal.contentWidth + padding.left + padding.right,
          height: height + padding.top + padding.bottom,
        };

    for (const deferred of mine) layoutAbsolute(deferred, paddingBox, context);
  }
  if (cut !== null) {
    for (const deferred of mine)
      input.absolutes.push({ ...deferred, inside: deferred.inside ?? cut });
  }

  const ownBottom = withMargin(NO_MARGIN, margin.bottom);

  return {
    height: fragment.rect.height,
    marginBottom: bottomEscapes ? mergeMargins(ownBottom, flow.trailing) : ownBottom,
    collapsedThrough: !isRoot && collapsesThrough(box, containing.width, containing.height),
    // The lines moved down with the alignment, and their baselines went with them.
    baseline: flow.baseline === null ? null : border.top + padding.top + leading + flow.baseline,
    firstBaseline:
      flow.firstBaseline === null ? null : border.top + padding.top + leading + flow.firstBaseline,
  };
}

type FlowResult = {
  // Height taken by the children inside the content box.
  height: number;
  // Margins still adjoining the bottom of the content, not yet committed to the height.
  trailing: CollapsedMargin;
  // Last baseline found among the children, measured from the content top.
  baseline: number | null;
  firstBaseline: number | null;
};

function layoutChildren(
  box: BlockBox,
  containing: ContainingBlock,
  contentTop: number,
  border: Edges,
  padding: Edges,
  context: Context,
  isRoot: boolean,
  absolutes: Deferred[],
): FlowResult {
  // An out of flow child is not part of this flow. The box tree keeps it among the inline
  // content, which is where it picks up the static position it would have had.
  const blocks = box.children.filter(
    (child): child is BlockBox => isBlock(child) && child.style.position !== 'absolute',
  );

  if (blocks.length === 0) {
    if (box.children.length === 0) {
      return { height: 0, trailing: NO_MARGIN, baseline: null, firstBaseline: null };
    }

    const inline = layoutInlineContent({
      container: box,
      containerStyle: box.style,
      contentX: containing.x,
      contentTop,
      available: containing.width,
      measurer: context.measurer,
      devicePixelRatio: context.devicePixelRatio,
      fragments: context.fragments,
      pieces: context.pieces,
      lines: context.lines,
      lineBoxes: context.lineBoxes,
      lineOf: context.lineOf,
      trace: context.trace,
      layoutAtomic: (child, available) =>
        measureAtomic(child, available, containing.height, context),
      cut: (child) => (context.boxesOf.get(child.element)?.length ?? 1) > 1,
      placeAtomic: (child, x, y) => placeAtomic(child, x, y, containing, context, absolutes),
      defer: (child, x, y, room, within) =>
        absolutes.push({
          box: child,
          staticX: x,
          staticY: y,
          aligned: room === null ? null : selfAligned(child, room),
          inside: within === null ? null : (context.elementOf.get(within) ?? null),
        }),
    });

    return {
      height: inline.height,
      trailing: NO_MARGIN,
      baseline: inline.lastBaseline,
      firstBaseline: inline.firstBaseline,
    };
  }

  const collapseIntoTop = !isRoot && canCollapseTop(box.style, padding, border);
  let height = 0;
  let pending = NO_MARGIN;
  let placed = false;
  let baseline: number | null = null;
  let firstBaseline: number | null = null;

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
    const result = layoutBlock(
      { box: child, containing, top: childTop, absolutes, isRoot: false, override: null },
      context,
    );

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

    // A child that clips its overflow gives the box its baseline at its own bottom margin
    // edge, whatever lines it holds and wherever that edge is, even above the box's top when
    // a negative margin put it there. It is the last one that counts, so it wins over any
    // line in front of it.
    // A flex container that clips keeps a baseline of its own instead, no lower than its bottom
    // border edge, and one with nothing in it to give a baseline gives none.
    if (child.style.overflow !== 'visible' && child.style.display === 'flex') {
      if (result.baseline !== null) {
        baseline = childTop - contentTop + Math.min(result.baseline, result.height);
      }
    } else if (child.style.overflow !== 'visible') {
      baseline = childTop - contentTop + result.height + resolveMargin(result.marginBottom);
    } else if (result.baseline !== null) {
      baseline = childTop - contentTop + result.baseline;
    }

    // The first has no such rule: a child that clips gives its first line like any other.
    if (firstBaseline === null && result.firstBaseline !== null) {
      firstBaseline = childTop - contentTop + result.firstBaseline;
    }
  }

  return { height, trailing: pending, baseline, firstBaseline };
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
    toContentBox(style.boxSizing, usedSize(style.minWidth, containingWidth), surround),
    toContentBox(style.boxSizing, usedSize(style.maxWidth, containingWidth), surround),
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

// A root of its own formatting context keeps its children's margins to itself.
function establishesBfc(style: ComputedStyle): boolean {
  return (
    style.overflow !== 'visible' ||
    style.display === 'flex' ||
    style.display === 'inline-block' ||
    style.position === 'absolute' ||
    alignsContent(style)
  );
}

// Nothing may sit between two margins for them to touch: no border, no padding.
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

// The margins adjoining the top edge of a box, including the ones escaping from inside it.
// Read from styles alone, so a parent can place a child before laying it out.
function adjoiningTopMargins(box: BlockBox, containingWidth: number): CollapsedMargin {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, containingWidth);
  let collapsed = withMargin(NO_MARGIN, usedMargin(box.style.marginTop, containingWidth) ?? 0);

  if (!canCollapseTop(box.style, padding, border)) return collapsed;

  const inner = resolveHorizontal(box.style, containingWidth, border, padding).contentWidth;
  const height = usedSize(box.style.height, null);

  for (const child of inFlowChildren(box)) {
    if (!isBlock(child)) break;

    collapsed = mergeMargins(collapsed, adjoiningTopMargins(child, inner));
    if (!collapsesThrough(child, inner, height)) break;
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
    if (!collapsesThrough(child, inner, height)) break;
    collapsed = mergeMargins(collapsed, adjoiningTopMargins(child, inner));
  }

  return collapsed;
}

// A box with nothing between its own two margins lets them meet, and takes no height.
function collapsesThrough(
  box: BlockBox,
  containingWidth: number,
  containingHeight: number | null,
): boolean {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, containingWidth);

  if (establishesBfc(box.style) || hasOutsideMarker(box.style)) return false;
  if (border.top + border.bottom + padding.top + padding.bottom > 0) return false;

  // A percentage height is a real height whenever there is something for it to be a
  // percentage of, and a box with one holds its own two margins apart.
  const height = usedSize(box.style.height, containingHeight);
  if (height !== null && height > 0) return false;
  if ((usedSize(box.style.minHeight, containingHeight) ?? 0) > 0) return false;

  const inner = resolveHorizontal(box.style, containingWidth, border, padding).contentWidth;
  return inFlowChildren(box).every((child) =>
    isBlock(child) ? collapsesThrough(child, inner, height) : !makesALine(child, inner),
  );
}

// Whether an inline child puts anything on a line. An empty `<span>` does not, and a box that
// holds nothing else is as empty as one with no children at all, which is what lets a margin
// collapse straight through the anonymous block around it.
function makesALine(box: Box, containingWidth: number): boolean {
  if (box.kind === 'text') return !isCollapsibleWhitespace(box);
  // Out of the flow, so it takes no room on the line it would have been on.
  if (isBlock(box) && box.style.position === 'absolute') return false;
  if (isBlock(box) || box.style.display !== 'inline') return true;

  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, containingWidth);
  const margin = {
    left: usedMargin(box.style.marginLeft, containingWidth) ?? 0,
    right: usedMargin(box.style.marginRight, containingWidth) ?? 0,
  };

  // The two ends the line builder lays down, and either of them taking room is enough. A
  // negative margin takes room too: it is not nothing, it is nothing shifted twelve pixels.
  const start = margin.left + border.left + padding.left;
  const end = padding.right + border.right + margin.right;
  if (start !== 0 || end !== 0) return true;

  return box.children.some((child) => makesALine(child, containingWidth));
}

// `align-content` on a block container aligns everything in the flow as one group, which it
// can only do as a formatting context of its own: a margin that escaped would move the group
// it was measured as part of.
function alignsContent(style: ComputedStyle): boolean {
  return style.display !== 'flex' && style.alignContent !== 'normal';
}

function measureFlow(
  box: BlockBox,
  containing: ContainingBlock,
  contentTop: number,
  border: Edges,
  padding: Edges,
  context: Context,
): number {
  const scratch: Context = {
    ...context,
    fragments: new Map(),
    pieces: new Map(),
    lines: new Map(),
    lineBoxes: new Map(),
    lineOf: new Map(),
    trace: [],
  };
  const flow = layoutChildren(box, containing, contentTop, border, padding, scratch, true, []);
  return flow.height + resolveMargin(flow.trailing);
}

// One group has nothing to distribute between, so the distribution values fall back to what
// the spec gives them: `space-between` to the start, the other two to the centre. Content
// taller than the box stays where it is rather than being pushed off the top.
function alignmentLeading(align: AlignContent, free: number): number {
  if (free <= 0) return 0;

  switch (align) {
    case 'flex-end':
      return free;
    case 'center':
    case 'space-around':
    case 'space-evenly':
      return free / 2;
    default:
      return 0;
  }
}

// A text box carries its parent's whole computed style so it inherits the font, which means a
// run of text inside an absolutely positioned box looks absolutely positioned itself. It is
// not: only an element is ever taken out of the flow.
function inFlowChildren(box: BlockBox): Box[] {
  return box.children.filter(
    (child) =>
      !isCollapsibleWhitespace(child) &&
      (child.kind === 'text' || child.style.position !== 'absolute'),
  );
}

// An inline-block lays its own children out as blocks, so it goes through the block path in
// a throwaway context first just to find out how big it is.
function measureAtomic(
  box: InlineBox,
  available: number,
  basis: number | null,
  context: Context,
): AtomicSize {
  const scratch: Context = {
    ...context,
    fragments: new Map(),
    pieces: new Map(),
    lines: new Map(),
    lineBoxes: new Map(),
    lineOf: new Map(),
    trace: [],
  };
  const margin = atomicMargin(box, available);
  const contentWidth = atomicContentWidth(box, available, context);

  const result = layoutBlock(
    {
      box: asBlock(box),
      containing: { x: 0, width: available, height: null },
      top: 0,
      absolutes: [],
      isRoot: false,
      override: {
        x: 0,
        contentWidth,
        contentHeight: atomicContentHeight(box, available, basis),
        margin,
      },
    },
    scratch,
  );

  const fragment = scratch.fragments.get(box.id);

  // An inline-block that clips its overflow hides its baseline with it, and one with no line
  // boxes at all has none to offer. Both fall back to the bottom margin edge, which is what
  // a null baseline means to the line builder.
  const inner = box.style.overflow === 'visible' ? result.baseline : null;

  return {
    width: (fragment?.rect.width ?? 0) + margin.left + margin.right,
    height: result.height + margin.top + margin.bottom,
    baseline: inner === null ? null : margin.top + inner,
  };
}

// An atomic inline takes its place in the line as a margin box, not a border box.
function atomicMargin(box: InlineBox, available: number): Edges {
  return {
    top: usedMargin(box.style.marginTop, available) ?? 0,
    right: usedMargin(box.style.marginRight, available) ?? 0,
    bottom: usedMargin(box.style.marginBottom, available) ?? 0,
    left: usedMargin(box.style.marginLeft, available) ?? 0,
  };
}

function placeAtomic(
  box: InlineBox,
  x: number,
  y: number,
  containing: ContainingBlock,
  context: Context,
  absolutes: Deferred[],
): void {
  const available = containing.width;
  const basis = containing.height;
  const margin = atomicMargin(box, available);
  const contentWidth = atomicContentWidth(box, available, context);

  // x and y arrive as the margin box origin.
  layoutBlock(
    {
      box: asBlock(box),
      containing: { x, width: available, height: null },
      top: y + margin.top,
      // An inline-block that is not itself positioned is not a containing block, so anything
      // out of flow inside it belongs to whoever is holding the list here.
      absolutes,
      isRoot: false,
      override: {
        x: x + margin.left,
        contentWidth,
        contentHeight: atomicContentHeight(box, available, basis),
        margin,
      },
    },
    context,
  );
}

// An inline-block keeps its own height, and a percentage of it goes against the block the
// line belongs to, the same as anywhere else. A line does not make the basis go away; only an
// indefinite height above does.
function atomicContentHeight(
  box: InlineBox,
  available: number,
  basis: number | null,
): number | null {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, available);
  const down = border.top + border.bottom + padding.top + padding.bottom;

  return toContentBox(box.style.boxSizing, usedSize(box.style.height, basis), down);
}

// An inline-block with an auto width shrinks to fit. The width is solved here rather than by
// handing the block path a narrower containing block, because every percentage inside the box
// resolves against the room the line had, not against the width the box ended up with. A one
// per cent padding on an empty inline-block is not zero.
function atomicContentWidth(box: InlineBox, available: number, context: Context): number {
  const style = box.style;
  const border = usedBorderWidths(style);
  const padding = usedPadding(style, available);
  const surround = border.left + border.right + padding.left + padding.right;
  const margin = atomicMargin(box, available);

  const definite = toContentBox(style.boxSizing, usedSize(style.width, available), surround);
  const room = Math.max(0, available - margin.left - margin.right - surround);
  const inner =
    definite ?? shrinkToFit(intrinsicContentWidths(asBlock(box), context.measurer), room);

  return clampSize(
    inner,
    toContentBox(style.boxSizing, usedSize(style.minWidth, available), surround),
    toContentBox(style.boxSizing, usedSize(style.maxWidth, available), surround),
  );
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

// Where the only item of this flex container would go, in each physical axis. `justify-content`
// places it along the line and `align-self` across it, and the values that distribute space
// fall back the way they do for one item. Stretch has nothing to stretch here, so it starts.
function soleItem(container: BlockBox, child: BlockBox): Deferred['aligned'] {
  const style = container.style;
  const direction = style.flexDirection;
  const isRow = direction === 'row' || direction === 'row-reverse';
  const reverse = direction === 'row-reverse' || direction === 'column-reverse';
  const flipped = style.flexWrap === 'wrap-reverse';

  const flip = (placement: Placement): Placement =>
    placement === 'start' ? 'end' : placement === 'end' ? 'start' : 'center';

  const justified: Placement = (() => {
    switch (style.justifyContent) {
      case 'flex-end':
        return 'end';
      case 'center':
      case 'space-around':
      case 'space-evenly':
        return 'center';
      default:
        return 'start';
    }
  })();

  const asked = child.style.alignSelf === 'auto' ? style.alignItems : child.style.alignSelf;
  const aligned: Placement = asked === 'flex-end' ? 'end' : asked === 'center' ? 'center' : 'start';

  const main = reverse ? flip(justified) : justified;
  const cross = flipped ? flip(aligned) : aligned;

  return { within: container.id, x: isRow ? main : cross, y: isRow ? cross : main };
}

// Moves a box whose static position is an alignment inside a flex container's content box,
// once its own size is known. Only when both insets on that axis are auto: an inset pins the
// box and the alignment has nothing left to say.
function alignStatic(
  axis: AxisResult,
  deferred: Deferred,
  which: 'x' | 'y',
  unpinned: boolean,
  surround: number,
  context: Context,
): AxisResult {
  const placement = deferred.aligned?.[which] ?? 'start';
  if (!unpinned || placement === 'start' || deferred.aligned === null) return axis;

  const within = deferred.aligned.within;
  const container = typeof within === 'number' ? context.fragments.get(within) : null;
  if (container === undefined) return axis;

  const room =
    container === null
      ? typeof within === 'number'
        ? 0
        : within[which === 'x' ? 'width' : 'height']
      : which === 'x'
        ? container.rect.width -
          container.border.left -
          container.border.right -
          container.padding.left -
          container.padding.right
        : container.rect.height -
          container.border.top -
          container.border.bottom -
          container.padding.top -
          container.padding.bottom;
  const outer = axis.marginStart + axis.size + surround + axis.marginEnd;
  const free = room - outer;

  return { ...axis, start: axis.start + (placement === 'end' ? free : free / 2) };
}

// `align-self` on an absolute box whose static position came out of the flow, aligned in a
// rectangle of the given height starting there. With no height, the only thing to align
// against is the point itself: the end puts the margin box above it, the centre across it.
function selfAligned(box: BlockBox, room: number): Deferred['aligned'] {
  const own = box.style.alignSelf;
  const y: Placement = own === 'flex-end' ? 'end' : own === 'center' ? 'center' : 'start';
  return y === 'start' ? null : { within: { width: 0, height: room }, x: 'start', y };
}

// From the padding edge of the first box the element made to that of its last, counting the
// block between cut halves. Boxes with no height do not count, however wide. Measured.
function inlineContainingBlock(element: ElementNode, context: Context): Rect | null {
  const all = (context.boxesOf.get(element) ?? []).flatMap((id) => {
    const fragment = context.fragments.get(id);
    const lines = context.lines.get(id);
    const rects = lines !== undefined && lines.length > 0 ? lines : fragment ? [fragment.rect] : [];
    return rects.map((rect) => ({ rect, border: fragment?.border ?? zeroEdges }));
  });
  const drawn = all.filter(({ rect }) => rect.height > 0);
  const used = drawn.length > 0 ? drawn : all;

  const first = used[0];
  const last = used.at(-1);
  if (first === undefined || last === undefined) return null;

  const left = first.rect.x + first.border.left;
  const top = first.rect.y + first.border.top;
  const right = last.rect.x + last.rect.width - last.border.right;
  const bottom = last.rect.y + last.rect.height - last.border.bottom;
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function elementsOf(root: BlockBox): Pick<Context, 'boxesOf' | 'elementOf' | 'positionedInlines'> {
  const boxesOf = boxesByElement(root);
  const elementOf = new Map<BoxId, ElementNode>();
  for (const [element, ids] of boxesOf) {
    for (const id of ids) elementOf.set(id, element);
  }

  const positionedInlines = new Map<ElementNode, ComputedStyle>();
  walkBoxes(root, (box) => {
    if (box.kind === 'inline' && !box.atomic && box.style.position !== 'static') {
      positionedInlines.set(box.element, box.style);
    }
  });
  return { boxesOf, elementOf, positionedInlines };
}

// An absolutely positioned box is out of the flow, so nothing about it is known until the
// containing block it hangs from has a size. Both axes go through the same solver; the
// horizontal one has to finish first, because the height depends on the width.
function layoutAbsolute(deferred: Deferred, given: Rect, context: Context): void {
  const containing =
    deferred.inside === null ? given : (inlineContainingBlock(deferred.inside, context) ?? given);
  const box = deferred.box;
  const style = box.style;
  const border = usedBorderWidths(style);
  const padding = usedPadding(style, containing.width);
  const across = border.left + border.right + padding.left + padding.right;
  const down = border.top + border.bottom + padding.top + padding.bottom;

  const acrossAxis = (size: number | null) =>
    solveAbsoluteAxis({
      containerSize: containing.width,
      start: usedInset(style.left, containing.width),
      end: usedInset(style.right, containing.width),
      size,
      marginStart: usedMargin(style.marginLeft, containing.width),
      marginEnd: usedMargin(style.marginRight, containing.width),
      surround: across,
      staticStart: deferred.staticX - containing.x,
      autoSize: (available) =>
        shrinkToFit(intrinsicContentWidths(box, context.measurer), available),
    });

  // Solve, clamp, and solve again if the clamp moved it. That second pass is what the spec
  // asks for when a min or max bites, and it is how `width: 1px; max-width: 0` lands on zero.
  const wide = acrossAxis(
    toContentBox(style.boxSizing, usedSize(style.width, containing.width), across),
  );
  const width = clampSize(
    wide.size,
    toContentBox(style.boxSizing, usedSize(style.minWidth, containing.width), across),
    toContentBox(style.boxSizing, usedSize(style.maxWidth, containing.width), across),
  );
  const horizontal = alignStatic(
    width === wide.size ? wide : acrossAxis(width),
    deferred,
    'x',
    style.left.kind === 'auto' && style.right.kind === 'auto',
    across,
    context,
  );

  const fromContent = measureAbsolute(box, horizontal.size, containing.width, context);

  const downAxis = (size: number | null) =>
    solveAbsoluteAxis({
      containerSize: containing.height,
      start: usedInset(style.top, containing.height),
      end: usedInset(style.bottom, containing.height),
      size,
      // Percentage margins go against the containing block's width on both axes.
      marginStart: usedMargin(style.marginTop, containing.width),
      marginEnd: usedMargin(style.marginBottom, containing.width),
      surround: down,
      staticStart: deferred.staticY - containing.y,
      autoSize: () => fromContent,
    });

  const askedHeight = toContentBox(
    style.boxSizing,
    usedSize(style.height, containing.height),
    down,
  );
  const tall = downAxis(askedHeight);
  const height = clampSize(
    tall.size,
    toContentBox(style.boxSizing, usedSize(style.minHeight, containing.height), down),
    toContentBox(style.boxSizing, usedSize(style.maxHeight, containing.height), down),
  );
  const vertical = alignStatic(
    height === tall.size ? tall : downAxis(height),
    deferred,
    'y',
    style.top.kind === 'auto' && style.bottom.kind === 'auto',
    down,
    context,
  );

  layoutBlock(
    {
      box,
      containing: { x: containing.x, width: containing.width, height: containing.height },
      top: containing.y + vertical.start,
      absolutes: [],
      isRoot: false,
      override: {
        x: containing.x + horizontal.start,
        contentWidth: horizontal.size,
        contentHeight: vertical.size,
        // Worked out from the content unless the style asked for a height or the insets
        // pinned one, and a percentage inside has nothing to resolve against either way.
        definite:
          askedHeight !== null ||
          (usedInset(style.top, containing.height) !== null &&
            usedInset(style.bottom, containing.height) !== null),
        margin: {
          top: vertical.marginStart,
          right: horizontal.marginEnd,
          bottom: vertical.marginEnd,
          left: horizontal.marginStart,
        },
      },
    },
    context,
  );
}

// A throwaway pass just to find out how tall the content comes out at that width.
function measureAbsolute(
  box: BlockBox,
  contentWidth: number,
  basis: number,
  context: Context,
): number {
  const scratch: Context = {
    ...context,
    fragments: new Map(),
    pieces: new Map(),
    lines: new Map(),
    lineBoxes: new Map(),
    lineOf: new Map(),
    trace: [],
  };
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, basis);

  const result = layoutBlock(
    {
      box,
      containing: { x: 0, width: contentWidth, height: null },
      top: 0,
      absolutes: [],
      isRoot: false,
      basis,
      override: { x: 0, contentWidth, contentHeight: null, margin: zeroEdges },
    },
    scratch,
  );

  return Math.max(0, result.height - border.top - border.bottom - padding.top - padding.bottom);
}

// `heights` is the container's own min and max height, as content. Across a row they still
// hold the lines when the container has no height of its own. Down a column the cross axis
// is the width, which is always settled by the time the items are laid out.
function layoutFlexItems(
  box: BlockBox,
  containing: ContainingBlock,
  contentTop: number,
  context: Context,
  absolutes: Deferred[],
  heights: { min: number; max: number | null },
): FlowResult {
  const direction = box.style.flexDirection;
  const isRow = direction === 'row' || direction === 'row-reverse';
  const reverse = direction === 'row-reverse' || direction === 'column-reverse';
  const collected: BlockBox[] = [];

  for (const child of box.children.filter(isBlock)) {
    if (child.style.position === 'absolute') {
      absolutes.push({
        box: child,
        staticX: containing.x,
        staticY: contentTop,
        aligned: soleItem(box, child),
        inside: null,
      });
      continue;
    }
    collected.push(child);
  }

  const items = inFlexOrder(collected);

  const wraps = box.style.flexWrap !== 'nowrap';
  // `wrap-reverse` runs the cross axis the other way, so the margin the items are laid out
  // from is the one on the other side.
  const flipped = box.style.flexWrap === 'wrap-reverse';
  const metrics = items.map((item) =>
    itemMetrics(item, containing, isRow, wraps, flipped, box.style.alignItems, context),
  );

  // A percentage gap resolves against the content box along its own axis, which down a
  // column is the height the container may not have settled yet.
  const rowGap = usedGap(box.style.rowGap, containing.height);
  const columnGap = usedGap(box.style.columnGap, containing.width);

  const line = solveFlex({
    reverse,
    wrap: box.style.flexWrap,
    mainSize: isRow ? containing.width : containing.height,
    crossSize: isRow ? containing.height : containing.width,
    crossMin: isRow ? heights.min : 0,
    crossMax: isRow ? heights.max : null,
    mainGap: isRow ? columnGap : rowGap,
    crossGap: isRow ? rowGap : columnGap,
    justify: box.style.justifyContent,
    align: box.style.alignItems,
    alignContent: box.style.alignContent,
    items: metrics.map((one) => one.input),
    // Across a row an item is as tall as its content; down a column it is as wide as its
    // content wants to be, which is not the same question and not the same number.
    crossOf: (index, main) =>
      (isRow ? metrics[index]?.measure(main).cross : metrics[index]?.fit) ?? 0,
    baselineOf: (index, main) => metrics[index]?.measure(main).baseline ?? null,
  });

  // Where each item's baseline ended up, from the content top, made up if it has none.
  const baselines: number[] = [];

  items.forEach((item, index) => {
    const placement = line.placements[index];
    const metric = metrics[index];
    if (placement === undefined || metric === undefined) return;

    const x = containing.x + (isRow ? placement.mainStart : placement.crossStart);
    const y = contentTop + (isRow ? placement.crossStart : placement.mainStart);

    const result = layoutBlock(
      {
        box: item,
        containing,
        top: y,
        absolutes,
        isRoot: false,
        // A flex item is a formatting context of its own, so a margin inside it stays inside.
        independent: true,
        override: {
          x,
          contentWidth: isRow ? placement.mainSize : placement.crossSize,
          contentHeight: isRow ? placement.crossSize : placement.mainSize,
          margin: metric.margin,
        },
      },
      context,
    );
    baselines[index] = y - contentTop + (result.firstBaseline ?? result.height);
  });

  // The container's baseline comes from the line that comes first on the page, and from the
  // item that does: with the flow reversed that is the last one in order. One that lines up
  // by its baseline wins over it. An inline-block holding the container sits on this one too,
  // not on a baseline from its last line. Measured.
  const first = line.lines[flipped ? line.lines.length - 1 : 0] ?? [];
  const shown = reverse ? [...first].reverse() : first;
  const byBaseline = shown.find((index) => {
    const input = metrics[index]?.input;
    return (
      input !== undefined &&
      (input.align ?? box.style.alignItems) === 'baseline' &&
      !input.autoCrossStart &&
      !input.autoCrossEnd
    );
  });
  const chosen = byBaseline ?? shown[0];
  const baseline = chosen === undefined ? null : (baselines[chosen] ?? null);

  return {
    height: isRow ? line.crossSize : line.mainSize,
    trailing: NO_MARGIN,
    baseline,
    firstBaseline: baseline,
  };
}

type ItemMetrics = {
  input: FlexItemInput;
  margin: Edges;
  // The width the item's content asks for, which is its cross size down a column.
  fit: number;
  measure: (main: number) => { cross: number; baseline: number | null };
};

function auto(margin: ComputedStyle['marginTop']): boolean {
  return margin.kind === 'auto';
}

function itemMetrics(
  item: BlockBox,
  containing: ContainingBlock,
  isRow: boolean,
  wraps: boolean,
  flipped: boolean,
  alignItems: AlignItems,
  context: Context,
): ItemMetrics {
  const style = item.style;
  const border = usedBorderWidths(style);
  const padding = usedPadding(style, containing.width);

  const margin: Edges = {
    top: usedMargin(style.marginTop, containing.width) ?? 0,
    right: usedMargin(style.marginRight, containing.width) ?? 0,
    bottom: usedMargin(style.marginBottom, containing.width) ?? 0,
    left: usedMargin(style.marginLeft, containing.width) ?? 0,
  };

  const across = border.left + border.right + padding.left + padding.right;
  const down = border.top + border.bottom + padding.top + padding.bottom;
  const intrinsic = intrinsicContentWidths(item, context.measurer);

  const crossStart = <T>(start: T, end: T) => (flipped ? end : start);
  const crossEnd = <T>(start: T, end: T) => (flipped ? start : end);

  const crossStyle = isRow ? style.height : style.width;

  // A size given on the cross axis is still a size, so the min and max on that axis bite the
  // same way they do on a block. Without this a flex item takes `height: 0` at its word.
  const crossBasis = isRow ? containing.height : containing.width;
  const crossSurround = isRow ? down : across;
  const givenCross = toContentBox(style.boxSizing, usedSize(crossStyle, crossBasis), crossSurround);
  const minCross =
    toContentBox(
      style.boxSizing,
      usedSize(isRow ? style.minHeight : style.minWidth, crossBasis),
      crossSurround,
    ) ?? 0;
  const maxCross = toContentBox(
    style.boxSizing,
    usedSize(isRow ? style.maxHeight : style.maxWidth, crossBasis),
    crossSurround,
  );
  const crossSize = givenCross === null ? null : clampSize(givenCross, minCross, maxCross);

  // Down a column an item is measured at the width it is going to have: its own if it has
  // one, the container's less its margins, border and padding if it stretches, and what its
  // content asks for otherwise, which in a column that wraps may be more than there is.
  const available = Math.max(0, containing.width - across - margin.left - margin.right);
  const fit = shrinkToFit(intrinsic, available);
  const aligned = style.alignSelf === 'auto' ? alignItems : style.alignSelf;
  const stretches =
    (aligned === 'normal' || aligned === 'stretch') &&
    style.marginLeft.kind !== 'auto' &&
    style.marginRight.kind !== 'auto';
  const columnWidth =
    crossSize ?? (!wraps && stretches ? clampSize(available, minCross, maxCross) : fit);

  const measure = (main: number) => {
    const width = isRow ? main : columnWidth;
    const scratch: Context = {
      ...context,
      fragments: new Map(),
      pieces: new Map(),
      lines: new Map(),
      lineBoxes: new Map(),
      lineOf: new Map(),
      trace: [],
    };
    const result = layoutBlock(
      {
        box: item,
        containing: { x: 0, width, height: null },
        top: 0,
        absolutes: [],
        isRoot: false,
        independent: true,
        // Measured at the width the item was given, but its own percentage edges still go
        // against the container, the same as they will when it is really laid out.
        basis: containing.width,
        override: { x: 0, contentWidth: width, contentHeight: null, margin: zeroEdges },
      },
      scratch,
    );

    return {
      cross: Math.max(0, result.height - down),
      baseline: result.firstBaseline,
    };
  };

  const mainStyle = isRow ? style.width : style.height;
  const mainSize = isRow ? containing.width : containing.height;
  const specified = usedSize(mainStyle, mainSize);
  // Down a column the content size is the height the item comes to at the width it has.
  const contentSize = () => (isRow ? intrinsic.max : measure(columnWidth).cross);

  // A percentage basis with nothing definite to be a percentage of is `content`, which skips
  // the item's own height as well as the percentage. That is what `flex: 1` down a column of
  // no fixed height comes to, since its basis is 0%.
  // A basis or a size given in the style is a border box under `border-box`, the same as a
  // width, and what the line shares out is content.
  const along = isRow ? across : down;
  const basis =
    style.flexBasis.kind === 'percent' && mainSize === null
      ? contentSize()
      : (toContentBox(style.boxSizing, usedSize(style.flexBasis, mainSize), along) ??
        toContentBox(style.boxSizing, specified, along) ??
        contentSize());

  // min-width and min-height are auto on a flex item, and auto means min-content: that is
  // what stops flex-shrink from squeezing a word in half, and down a column what stops a
  // basis of nothing from flattening the item. Unless the item clips what runs over, in
  // which case there is nothing to protect and the floor goes back to zero.
  const minStyle = isRow ? style.minWidth : style.minHeight;
  const basis_ = isRow ? containing.width : containing.height;
  const maxMain = toContentBox(
    style.boxSizing,
    usedSize(isRow ? style.maxWidth : style.maxHeight, basis_),
    along,
  );
  const content =
    style.overflow !== 'visible' ? 0 : isRow ? intrinsic.min : measure(columnWidth).cross;
  // A size the item asked for caps that floor, and so does a maximum. `width: 0` means zero
  // however long the word inside is, because the content is only protected up to the size it
  // was given and never past the most it may have.
  const asked = toContentBox(style.boxSizing, specified, along);
  const automatic = Math.min(content, asked ?? content, maxMain ?? content);
  const minMain = toContentBox(style.boxSizing, usedSize(minStyle, basis_), along) ?? automatic;

  // Only an item whose cross size is auto stretches. A percentage with nothing definite to be
  // a percentage of sizes the item from its content the way auto would, but it is not auto,
  // and on that item stretch is flex-start.
  const unstretchable =
    crossStyle.kind !== 'auto' && (aligned === 'normal' || aligned === 'stretch');

  return {
    fit,
    input: {
      grow: style.flexGrow,
      shrink: style.flexShrink,
      basis,
      minMain,
      maxMain,
      mainSurround: isRow ? across + margin.left + margin.right : down + margin.top + margin.bottom,
      crossSurround: isRow
        ? down + margin.top + margin.bottom
        : across + margin.left + margin.right,
      marginMainStart: isRow ? margin.left : margin.top,
      marginMainEnd: isRow ? margin.right : margin.bottom,
      marginCrossStart: crossStart(
        isRow ? margin.top : margin.left,
        isRow ? margin.bottom : margin.right,
      ),
      marginCrossEnd: crossEnd(
        isRow ? margin.top : margin.left,
        isRow ? margin.bottom : margin.right,
      ),
      autoMainStart: auto(isRow ? style.marginLeft : style.marginTop),
      autoMainEnd: auto(isRow ? style.marginRight : style.marginBottom),
      autoCrossStart: auto(
        crossStart(
          isRow ? style.marginTop : style.marginLeft,
          isRow ? style.marginBottom : style.marginRight,
        ),
      ),
      autoCrossEnd: auto(
        crossEnd(
          isRow ? style.marginTop : style.marginLeft,
          isRow ? style.marginBottom : style.marginRight,
        ),
      ),
      align: unstretchable ? 'flex-start' : style.alignSelf === 'auto' ? null : style.alignSelf,
      crossSize,
      minCross,
      maxCross,
    },
    margin,
    measure,
  };
}
