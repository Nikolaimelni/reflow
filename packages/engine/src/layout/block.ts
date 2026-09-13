import { type BlockBox, type Box, type BoxId, type InlineBox, isBlock } from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import { type Edges, type Rect, zeroEdges } from '../geometry.js';
import type { Fragment, LayoutEvent } from '../trace/events.js';
import { type FlexItemInput, solveFlexLine } from './flex.js';
import { type AtomicSize, layoutInlineContent } from './inline.js';
import { intrinsicContentWidths, shrinkToFit } from './intrinsic.js';
import {
  type CollapsedMargin,
  mergeMargins,
  NO_MARGIN,
  resolveMargin,
  withMargin,
} from './margins.js';
import { relativeOffset, solveAbsoluteAxis } from './position.js';
import type { TextMeasurer } from './text.js';
import {
  clampSize,
  toContentBox,
  usedBorderWidths,
  usedInset,
  usedMargin,
  usedMaxSize,
  usedPadding,
  usedSize,
} from './used.js';

export type Viewport = { width: number; height: number };

export type LayoutResult = {
  fragments: Map<BoxId, Fragment>;
  /** Per line rects for inline content, where one box can appear in several places. */
  pieces: Map<BoxId, Rect[]>;
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
  pieces: Map<BoxId, Rect[]>;
  trace: LayoutEvent[];
  measurer: TextMeasurer;
  /** The initial containing block, which is what an absolute box falls back to. */
  icb: Rect;
};

/** An out of flow box, parked until the containing block it belongs to has a size. */
type Deferred = { box: BlockBox; staticX: number; staticY: number };

/** Absolute positioning solves width, position and margins together, so it hands them over. */
type Override = {
  x: number;
  contentWidth: number;
  margin: Edges;
  contentHeight: number | null;
};

type BlockInput = {
  box: BlockBox;
  containing: ContainingBlock;
  /** Where the border box goes in the flow, before any relative offset. */
  top: number;
  absolutes: Deferred[];
  isRoot: boolean;
  override: Override | null;
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
  const icb: Rect = { x: 0, y: 0, width: viewport.width, height: viewport.height };
  const context: Context = {
    fragments: new Map(),
    pieces: new Map(),
    trace: [],
    measurer,
    icb,
  };
  const containing: ContainingBlock = { x: 0, width: viewport.width, height: viewport.height };

  // The root's margins never collapse with anything, so its own top margin is all there is.
  const top = usedMargin(root.style.marginTop, viewport.width) ?? 0;
  layoutBlock({ box: root, containing, top, absolutes: [], isRoot: true, override: null }, context);

  return { fragments: context.fragments, pieces: context.pieces, trace: context.trace };
}

/**
 * `top` is the final position of the border box. The caller already knows it, because every
 * margin that could still move the box has been collapsed on the way in.
 */
function layoutBlock(input: BlockInput, context: Context): BlockResult {
  const { box, containing, top, isRoot, override } = input;
  const style = box.style;

  context.trace.push({
    t: 'measure:start',
    box: box.id,
    constraint: { availableWidth: containing.width, availableHeight: containing.height },
  });

  const border = usedBorderWidths(style);
  const padding = usedPadding(style, containing.width);
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

  const offset = relativeOffset(style, containing);
  const x = (override === null ? containing.x + margin.left : override.x) + offset.dx;
  const boxTop = top + offset.dy;
  const contentTop = boxTop + border.top + padding.top;

  const specifiedHeight =
    override === null
      ? toContentBox(style.boxSizing, usedSize(style.height, containing.height), down)
      : override.contentHeight;

  const childContaining: ContainingBlock = {
    x: x + border.left + padding.left,
    width: horizontal.contentWidth,
    height: specifiedHeight,
  };

  // A positioned box is the containing block for the absolute boxes under it, so it collects
  // them on the way down and places them once its own size is known.
  const positioned = isRoot || style.position !== 'static';
  const mine = positioned ? [] : input.absolutes;

  const flow =
    style.display === 'flex'
      ? layoutFlexItems(box, childContaining, contentTop, context, mine)
      : layoutChildren(box, childContaining, contentTop, border, padding, context, isRoot, mine);
  const bottomEscapes = !isRoot && canCollapseBottom(style, padding, border, specifiedHeight);

  // A trailing margin that cannot escape has to be paid for in this box's own height.
  const fromContent = flow.height + (bottomEscapes ? 0 : resolveMargin(flow.trailing));

  // A used height is never negative, however far a negative margin pulls the content up.
  const height = Math.max(
    0,
    clampSize(
      specifiedHeight ?? fromContent,
      toContentBox(style.boxSizing, usedSize(style.minHeight, containing.height), down),
      toContentBox(style.boxSizing, usedMaxSize(style.maxHeight, containing.height), down),
    ),
  );

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
  absolutes: Deferred[],
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
      pieces: context.pieces,
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
    if (child.style.position === 'absolute') {
      absolutes.push({
        box: child,
        staticX: containing.x,
        staticY: contentTop + height + resolveMargin(pending),
      });
      continue;
    }

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
    toContentBox(style.boxSizing, usedMaxSize(style.maxWidth, containingWidth), surround),
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

/** A root of its own formatting context keeps its children's margins to itself. */
function establishesBfc(style: ComputedStyle): boolean {
  return (
    style.overflow !== 'visible' ||
    style.display === 'flex' ||
    style.display === 'inline-block' ||
    style.position === 'absolute'
  );
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
  return box.children.filter(
    (child) => !isWhitespaceText(child) && child.style.position !== 'absolute',
  );
}

function isWhitespaceText(box: Box): boolean {
  return box.kind === 'text' && box.text.trim() === '';
}

/**
 * An inline-block lays its own children out as blocks, so it goes through the block path in
 * a throwaway context first just to find out how big it is.
 */
function measureAtomic(box: InlineBox, available: number, context: Context): AtomicSize {
  const scratch: Context = { ...context, fragments: new Map(), pieces: new Map(), trace: [] };
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
        contentHeight: atomicContentHeight(box, available),
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

/** An atomic inline takes its place in the line as a margin box, not a border box. */
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
  available: number,
  context: Context,
): void {
  const margin = atomicMargin(box, available);
  const contentWidth = atomicContentWidth(box, available, context);

  // x and y arrive as the margin box origin.
  layoutBlock(
    {
      box: asBlock(box),
      containing: { x, width: available, height: null },
      top: y + margin.top,
      absolutes: [],
      isRoot: false,
      override: {
        x: x + margin.left,
        contentWidth,
        contentHeight: atomicContentHeight(box, available),
        margin,
      },
    },
    context,
  );
}

/**
 * An inline-block keeps its own height. Percentages have no basis to resolve against inside
 * a line, so they read as auto, which is the same rule an auto height parent gets.
 */
function atomicContentHeight(box: InlineBox, available: number): number | null {
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, available);
  const down = border.top + border.bottom + padding.top + padding.bottom;

  return toContentBox(box.style.boxSizing, usedSize(box.style.height, null), down);
}

/**
 * An inline-block with an auto width shrinks to fit. The width is solved here rather than by
 * handing the block path a narrower containing block, because every percentage inside the box
 * resolves against the room the line had, not against the width the box ended up with. A one
 * per cent padding on an empty inline-block is not zero.
 */
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
    toContentBox(style.boxSizing, usedMaxSize(style.maxWidth, available), surround),
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

/**
 * An absolutely positioned box is out of the flow, so nothing about it is known until the
 * containing block it hangs from has a size. Both axes go through the same solver; the
 * horizontal one has to finish first, because the height depends on the width.
 */
function layoutAbsolute(deferred: Deferred, containing: Rect, context: Context): void {
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
    toContentBox(style.boxSizing, usedMaxSize(style.maxWidth, containing.width), across),
  );
  const horizontal = width === wide.size ? wide : acrossAxis(width);

  const fromContent = measureAbsolute(box, horizontal.size, context);

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

  const tall = downAxis(
    toContentBox(style.boxSizing, usedSize(style.height, containing.height), down),
  );
  const height = clampSize(
    tall.size,
    toContentBox(style.boxSizing, usedSize(style.minHeight, containing.height), down),
    toContentBox(style.boxSizing, usedMaxSize(style.maxHeight, containing.height), down),
  );
  const vertical = height === tall.size ? tall : downAxis(height);

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

/** A throwaway pass just to find out how tall the content comes out at that width. */
function measureAbsolute(box: BlockBox, contentWidth: number, context: Context): number {
  const scratch: Context = { ...context, fragments: new Map(), pieces: new Map(), trace: [] };
  const border = usedBorderWidths(box.style);
  const padding = usedPadding(box.style, contentWidth);

  const result = layoutBlock(
    {
      box,
      containing: { x: 0, width: contentWidth, height: null },
      top: 0,
      absolutes: [],
      isRoot: false,
      override: { x: 0, contentWidth, contentHeight: null, margin: zeroEdges },
    },
    scratch,
  );

  return Math.max(0, result.height - border.top - border.bottom - padding.top - padding.bottom);
}

/**
 * A single flex line. Wrapping is out of the subset, so every item shares one line, and the
 * container's cross size comes from that line.
 */
function layoutFlexItems(
  box: BlockBox,
  containing: ContainingBlock,
  contentTop: number,
  context: Context,
  absolutes: Deferred[],
): FlowResult {
  const isRow = box.style.flexDirection === 'row';
  const items: BlockBox[] = [];

  for (const child of box.children.filter(isBlock)) {
    if (child.style.position === 'absolute') {
      absolutes.push({ box: child, staticX: containing.x, staticY: contentTop });
      continue;
    }
    items.push(child);
  }

  const metrics = items.map((item) => itemMetrics(item, containing, isRow, context));

  const line = solveFlexLine({
    mainSize: isRow ? containing.width : containing.height,
    crossSize: isRow ? containing.height : containing.width,
    justify: box.style.justifyContent,
    align: box.style.alignItems,
    items: metrics.map((one) => one.input),
    crossOf: (index, main) => metrics[index]?.measure(main).cross ?? 0,
    baselineOf: (index, main) => metrics[index]?.measure(main).baseline ?? null,
  });

  items.forEach((item, index) => {
    const placement = line.placements[index];
    const metric = metrics[index];
    if (placement === undefined || metric === undefined) return;

    const x = containing.x + (isRow ? placement.mainStart : placement.crossStart);
    const y = contentTop + (isRow ? placement.crossStart : placement.mainStart);

    layoutBlock(
      {
        box: item,
        containing,
        top: y,
        absolutes,
        isRoot: false,
        override: {
          x,
          contentWidth: isRow ? placement.mainSize : placement.crossSize,
          contentHeight: isRow ? placement.crossSize : placement.mainSize,
          margin: metric.margin,
        },
      },
      context,
    );
  });

  return {
    height: isRow ? line.crossSize : line.mainSize,
    trailing: NO_MARGIN,
    baseline: null,
  };
}

type ItemMetrics = {
  input: FlexItemInput;
  margin: Edges;
  measure: (main: number) => { cross: number; baseline: number | null };
};

function itemMetrics(
  item: BlockBox,
  containing: ContainingBlock,
  isRow: boolean,
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

  const measure = (main: number) => {
    const width = isRow ? main : containing.width;
    const scratch: Context = {
      ...context,
      fragments: new Map(),
      pieces: new Map(),
      trace: [],
    };
    const result = layoutBlock(
      {
        box: item,
        containing: { x: 0, width, height: null },
        top: 0,
        absolutes: [],
        isRoot: false,
        override: { x: 0, contentWidth: width, contentHeight: null, margin: zeroEdges },
      },
      scratch,
    );

    return {
      cross: Math.max(0, result.height - down),
      baseline: result.baseline,
    };
  };

  const mainStyle = isRow ? style.width : style.height;
  const mainBasis = isRow ? containing.width : (containing.height ?? 0);
  const specified = usedSize(mainStyle, isRow ? containing.width : containing.height);
  const fromBasis = usedSize(style.flexBasis, mainBasis);

  const basis = fromBasis ?? specified ?? (isRow ? intrinsic.max : measure(containing.width).cross);

  // min-width and min-height are auto on a flex item, and auto means min-content: that is
  // what stops flex-shrink from squeezing a word in half.
  const minStyle = isRow ? style.minWidth : style.minHeight;
  const automatic = isRow ? intrinsic.min : 0;
  const along = isRow ? across : down;
  const basis_ = isRow ? containing.width : containing.height;
  const minMain = toContentBox(style.boxSizing, usedSize(minStyle, basis_), along) ?? automatic;
  const maxMain = toContentBox(
    style.boxSizing,
    usedMaxSize(isRow ? style.maxWidth : style.maxHeight, basis_),
    along,
  );

  const crossStyle = isRow ? style.height : style.width;
  const crossSize = usedSize(crossStyle, isRow ? containing.height : containing.width);

  return {
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
      marginCrossStart: isRow ? margin.top : margin.left,
      crossSize,
    },
    margin,
    measure,
  };
}
