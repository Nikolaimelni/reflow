import {
  type BlockBox,
  type Box,
  type BoxId,
  type InlineBox,
  isBlock,
  reportedUnion,
} from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import { blockByDefault } from '../cascade/ua.js';
import { type Edges, type Rect, zeroEdges } from '../geometry.js';
import type { Fragment, LayoutEvent } from '../trace/events.js';
import { relativeOffset } from './position.js';
import {
  type FontMetrics,
  fontOf,
  segmentText,
  symbolMarkerAdvance,
  type TextMeasurer,
  usedLineHeight,
  wraps,
} from './text.js';
import { usedBorderWidths, usedMargin, usedPadding } from './used.js';

export type AtomicSize = {
  width: number;
  height: number;
  /** Offset from the top of the box to its baseline, or null to sit on its bottom edge. */
  baseline: number | null;
};

export type InlineResult = {
  height: number;
  /** The first and last lines' baselines, measured from the content top. */
  firstBaseline: number | null;
  lastBaseline: number | null;
};

export type InlineInput = {
  container: BlockBox;
  containerStyle: ComputedStyle;
  contentX: number;
  contentTop: number;
  available: number;
  measurer: TextMeasurer;
  devicePixelRatio: number;
  fragments: Map<BoxId, Fragment>;
  /** One rect per line a box appears on, which is what a pointer is tested against. */
  pieces: Map<BoxId, Rect[]>;
  /** The lines an inline box covers, kept apart so a view can draw the box where it is. */
  lines: Map<BoxId, Rect[]>;
  /** The line boxes themselves, filed under the block they belong to. */
  lineBoxes: Map<BoxId, Rect[]>;
  trace: LayoutEvent[];
  layoutAtomic: (box: InlineBox, available: number) => AtomicSize;
  placeAtomic: (box: InlineBox, x: number, y: number) => void;
  /**
   * Hands an out of flow box back with the static position it had in the line, and how tall
   * a rectangle below that point `align-self` may move it about in: none at all in the block
   * flow, a line's height inside a line, and null where it may not move. `within` is the
   * positioned inline around it, when there is one, which is then its containing block.
   */
  defer: (box: BlockBox, x: number, y: number, room: number | null, within: BoxId | null) => void;
};

type Offset = { dx: number; dy: number };

type PieceKind = 'glyphs' | 'space' | 'atomic' | 'edge-start' | 'edge-end' | 'out-of-flow';

type Piece = {
  /** An edge takes room in the line for one side of an inline box's padding and border. */
  kind: PieceKind;
  box: BoxId;
  source: InlineBox | null;
  width: number;
  height: number;
  baseline: number | null;
  style: ComputedStyle;
  /**
   * Whether an edge is allowed to hang over the end of a line. Chromium lets the border of an
   * empty `<span>` hang and breaks the line for the same border on a `<div>` that has been
   * made inline, which is the same thing it does with a newline in front of a closing tag: it
   * remembers what the tag was. Measured, not found in a spec.
   */
  mayHang: boolean;
  /** Part of a list marker inside its item, which a space after it does not count as content. */
  listMarker: boolean;
  ancestors: readonly BoxId[];
  /** Relative offsets of the inline boxes this piece sits inside, already added up. */
  offset: Offset;
};

/**
 * A boundary is a place the line may break with no space to break at, which is either side of
 * an atomic inline in text that wraps.
 */
type Item =
  | Piece
  /** `droppable` marks one at the end of a box, which only counts if anything follows it. */
  | { kind: 'newline'; droppable: boolean }
  | { kind: 'boundary' };

/** A box out of the flow, and whether the text it was written in may wrap. */
type OutOfFlow = { box: BlockBox; wraps: boolean };

type Placed = { piece: Piece; x: number };

/** A phantom line holds nothing that counts, so it has no height and no baseline to offer. */
type Line = { items: Placed[]; width: number; height: number; baseline: number; phantom: boolean };

/** What an inline box adds around its own content, and where it has been shifted to. */
type Surround = {
  margin: Edges;
  border: Edges;
  padding: Edges;
  offset: Offset;
  /** The box's own style, which is what its height comes from rather than its children's. */
  style: ComputedStyle;
};

export function layoutInlineContent(input: InlineInput): InlineResult {
  const surrounds = new Map<BoxId, Surround>();
  const outOfFlow = new Map<BoxId, OutOfFlow>();
  const items = collect(
    input.container.children,
    [],
    { dx: 0, dy: 0 },
    wraps(input.containerStyle.whiteSpace),
    input,
    surrounds,
    outOfFlow,
  );
  const { lines, atBreak } = breakIntoLines(items, input);

  // Nothing here but boxes out of the flow, and whitespace that collapses away.
  const alone = items.every(
    (item) =>
      item.kind === 'out-of-flow' || (item.kind === 'space' && item.style.whiteSpace !== 'pre'),
  );

  let y = input.contentTop;
  let firstBaseline: number | null = null;
  let lastBaseline: number | null = null;
  const extents = new Map<BoxId, Extent>();
  const perLine = new Map<BoxId, Extent[]>();
  /** Where a box was left on a line with no height, in case that is the only place it is. */
  const stranded = new Map<BoxId, { x: number; y: number }>();

  lines.forEach((line, index) => {
    input.trace.push({
      t: 'line:broken',
      box: input.container.id,
      at: index,
      width: line.width,
    });

    const offset = alignmentOffset(input.containerStyle, input.available, line.width);
    // A line with nothing on it is treated as not being there for anything but placing what
    // is in it, and a baseline is one of those other things.
    if (!line.phantom) {
      lastBaseline = y + line.baseline - input.contentTop;
      firstBaseline ??= lastBaseline;
    }
    const onThisLine = new Map<BoxId, Extent>();
    const whole = opensAndCloses(line);
    /** Whether anything on this line has been laid down yet, which an out of flow box asks. */
    let behind = false;
    /** The room the opening edge of each box took on this line, for when it closes. */
    const opened = new Map<BoxId, number>();

    for (const placed of line.items) {
      const piece = placed.piece;
      const metrics = input.measurer.metrics(fontOf(piece.style));
      const above = piece.kind === 'atomic' ? baselineOf(piece) : metrics.ascent;

      // Out of the flow, so it takes no room and paints nowhere near here. All the line owes
      // it is the place it would have had. An inline one would have sat where it is written.
      // A block one would have cut the line in two and gone under whatever came before it,
      // which is the next line down, or the top of this one when nothing came before it.
      if (piece.kind === 'out-of-flow') {
        const parked = outOfFlow.get(piece.box);
        const deferred = parked?.box;
        const still = piece.style.staticDisplay;
        const inline = still === 'inline' || still === 'inline-block';

        // An inline one that comes after the line has already run out of room starts the
        // next one instead, where the alignment would put an empty line. A line that is only
        // full keeps it, and so does text that may not wrap, whatever the box itself says.
        const late =
          inline && parked?.wraps === true && atBreak.has(piece) && placed.x > input.available;

        if (deferred !== undefined) {
          const x = late
            ? input.contentX + alignmentOffset(input.containerStyle, input.available, 0)
            : inline
              ? input.contentX + offset + placed.x + piece.offset.dx
              : input.contentX;
          // A relative offset on an inline around it moves where it would have been, down as
          // well as across.
          const top = late
            ? y + line.height
            : inline
              ? y + piece.offset.dy
              : behind
                ? y + line.height
                : y;

          // A positioned inline is the containing block for what is out of the flow inside
          // it. The box is still placed with the block's others, once every box the inline
          // makes has been laid out, which a block cutting it in two may not have been yet.
          const within = piece.ancestors.findLast((id) => isPositioned(surrounds.get(id)));
          // Inside a line it is aligned in that line's box, or in one as tall below it when it
          // went under the line, unless that line ran over the edge, and then about the point
          // it went to. A line with nothing on it is no line at all to Chromium, so a box there
          // aligns about its static position, except an inline-level one that is the only
          // thing in the block: that one does not move. Measured, not derived.
          const under = !inline && behind && !late;
          const overflowed = line.width > input.available + FIT_SLACK;
          const room = line.phantom
            ? inline && alone
              ? null
              : 0
            : under && overflowed
              ? 0
              : line.height;
          input.defer(deferred, x, top, room, within ?? null);
        }
        continue;
      }

      // An inline box reaches a line it puts nothing on, but only if it has something to put
      // there. `pre` text that starts with a newline leaves the opening border alone on the
      // line above the first word, and that border is a box. Take the border away and there
      // is nothing left but a boundary, and a boundary alone is not a rectangle: the whole of
      // an empty `<span>` sitting on a line is, which is the same box seen from both ends.
      if (isEdge(piece.kind)) {
        // A padding or a border took room even if the box around it drew nothing else, but
        // only once the box has opened and closed here. An opening edge on its own is not in
        // front of anything yet, and a closing one left over from the line above is not
        // either.
        if (piece.kind === 'edge-start') opened.set(piece.box, piece.width);
        const start = opened.get(piece.box);
        if (piece.kind === 'edge-end' && start !== undefined && start + piece.width > 0) {
          behind = true;
        }

        const at = input.contentX + offset + placed.x + piece.offset.dx;
        if (line.height === 0) {
          if (!stranded.has(piece.box)) stranded.set(piece.box, { x: at, y: y + piece.offset.dy });
          continue;
        }
        if (!takesRoom(piece) && !whole.has(piece.box)) continue;

        const rect = {
          x: piece.kind === 'edge-start' ? at + piece.width : at,
          y: y + line.baseline - metrics.ascent + piece.offset.dy,
          width: 0,
          height: metrics.ascent + metrics.descent,
        };

        for (const ancestor of piece.ancestors) {
          widen(extents, ancestor, rect);
          widen(onThisLine, ancestor, rect);
        }
        continue;
      }

      behind = true;

      const rect = {
        x: input.contentX + offset + placed.x + piece.offset.dx,
        y: y + line.baseline - above + piece.offset.dy,
        width: piece.width,
        height: piece.height,
      };

      // An atomic inline takes its room in the line as a margin box, which is the rect the
      // boxes around it are built from. Its own fragment is the border box, and that is what
      // a pointer has to land on, so it does not record a piece of its own. The inline boxes
      // around it are not recorded here either: they get one rect per line further down, and
      // that rect covers this one with the padding this one does not know about.
      if (piece.source === null) record(input.pieces, piece.box, rect);

      if (piece.source !== null) {
        // Laid out once to measure it and again where the line put it. The second pass is
        // what ends up in the fragments, and the trace shows both.
        input.placeAtomic(piece.source, rect.x, rect.y);
      } else {
        grow(extents, piece.box, rect);
        grow(onThisLine, piece.box, rect);
      }

      for (const ancestor of piece.ancestors) {
        widen(extents, ancestor, rect);
        widen(onThisLine, ancestor, rect);
      }
    }

    // An inline box runs from where it starts on the line to where it ends, in the order the
    // line was laid down, and not around whatever is inside it. The two only differ when a
    // negative margin pulls the end back in front of the start, and then the box has no
    // width at all: Chromium measures it end to end and will not go below nothing.
    for (const [box, along] of endToEnd(line)) {
      const extent = onThisLine.get(box);
      const surround = surrounds.get(box);
      if (extent === undefined || surround === undefined) continue;

      const base = input.contentX + offset + surround.offset.dx;
      const lead = along.opens ? surround.border.left + surround.padding.left : 0;
      const trail = along.closes ? surround.border.right + surround.padding.right : 0;
      extent.left = base + along.from;
      extent.right = Math.max(base + along.to, extent.left - lead - trail);
    }

    // Now that the line has a baseline, every inline box on it gets the height its own font
    // gives it, sitting on that baseline.
    for (const [box, extent] of onThisLine) {
      const surround = surrounds.get(box);
      if (surround === undefined) continue;

      const metrics = input.measurer.metrics(fontOf(surround.style));
      const middle = y + line.baseline + surround.offset.dy;
      extent.top = middle - metrics.ascent;
      extent.bottom = middle + metrics.descent;
      grow(extents, box, toRect(extent));
    }

    for (const [box, extent] of onThisLine) {
      const seen = perLine.get(box);
      if (seen === undefined) perLine.set(box, [extent]);
      else seen.push(extent);
    }

    // As wide as what is on it and no wider, starting where the alignment put it.
    if (line.height > 0) {
      const rect = { x: input.contentX + offset, y, width: line.width, height: line.height };
      record(input.lineBoxes, input.container.id, rect);
    }

    y += line.height;
  });

  // A box whose edges only ever met on a line with nothing on it is still reported, at the
  // start of that line and with no size at all. That is what Chromium does with an empty
  // `<div>` made inline that it left behind when the line broke after it.
  for (const [box, point] of stranded) {
    if (extents.has(box)) continue;
    extents.set(box, { left: point.x, right: point.x, top: point.y, bottom: point.y });
  }

  // Every box's own rects come first, because a box Chromium culls is reported as the rects of
  // what is inside it, and those are only known once everything inside it has been laid.
  const own = new Map<BoxId, Rect[]>();
  for (const [box, extent] of extents) {
    const surround = surrounds.get(box);
    const onLines = perLine.get(box);

    // An inline box that wraps is its lines, not the rectangle around them. Its own padding
    // sits at the start of the first line and the end of the last, so growing the union by it
    // puts the box's left edge somewhere it never reaches, and a pointer in the gap beside a
    // short line finds the inline when it is over the block.
    own.set(
      box,
      onLines === undefined
        ? [toRect(extent)]
        : onLines.map((line, index) =>
            surround === undefined
              ? toRect(line)
              : padded(line, surround, index === 0, index === onLines.length - 1),
          ),
    );
  }

  // In the order Blink walks them: all of one child, then the next. A culled box with nothing
  // inside that reached a line is left with its own rects, which is where it opened and closed.
  const culled = culledBoxes(input.container.children, input.measurer);
  const reported = (box: BoxId): Rect[] => {
    const gathered = culled.get(box)?.flatMap((child) => reported(child.id)) ?? [];
    return gathered.length > 0 ? gathered : (own.get(box) ?? []);
  };

  for (const box of own.keys()) {
    const surround = surrounds.get(box);
    const rects = reported(box);
    const whole = culled.has(box) ? reportedUnion(rects) : null;
    const fragment = toFragment(box, whole ?? union(rects), surround);

    input.fragments.set(box, fragment);

    input.lines.set(box, rects);
    if (surround !== undefined) {
      for (const rect of rects) record(input.pieces, box, rect);
    }

    input.trace.push({
      t: 'size:resolved',
      box,
      fragment,
      reason: culled.has(box)
        ? 'what is inside it, since it has no box of its own'
        : surround === undefined
          ? 'union of the line boxes it sits on'
          : 'its line boxes, plus its own padding and border',
    });
  }

  return { height: y - input.contentTop, firstBaseline, lastBaseline };
}

/**
 * Where each inline box's content starts and ends on a line, measured along it. The start is
 * just past its opening edge, or where its first piece begins when it came from the line
 * above. The end is just short of its closing edge, or where its last piece finishes.
 */
function endToEnd(
  line: Line,
): Map<BoxId, { from: number; to: number; opens: boolean; closes: boolean }> {
  const found = new Map<BoxId, { from: number; to: number; opens: boolean; closes: boolean }>();

  for (const { piece, x } of line.items) {
    if (piece.kind === 'out-of-flow') continue;

    for (const box of piece.ancestors) {
      const opens = piece.kind === 'edge-start' && piece.box === box;
      const closes = piece.kind === 'edge-end' && piece.box === box;
      const to = closes ? x : x + piece.width;
      const seen = found.get(box);

      if (seen === undefined) {
        found.set(box, { from: opens ? x + piece.width : x, to, opens, closes });
      } else {
        seen.to = to;
        seen.closes ||= closes;
      }
    }
  }

  return found;
}

function isPositioned(surround: Surround | undefined): boolean {
  return surround !== undefined && surround.style.position !== 'static';
}

function toFragment(box: BoxId, rect: Rect, surround: Surround | undefined): Fragment {
  return {
    box,
    rect,
    margin: surround?.margin ?? zeroEdges,
    border: surround?.border ?? zeroEdges,
    padding: surround?.padding ?? zeroEdges,
  };
}

function toRect(extent: Extent): Rect {
  return {
    x: extent.left,
    y: extent.top,
    width: extent.right - extent.left,
    height: extent.bottom - extent.top,
  };
}

function union(rects: readonly Rect[]): Rect {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));

  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * Padding and border on an inline box grow it without touching the line height, which is why a
 * padded `<span>` spills over the text above and below it. Vertically that happens on every
 * line, horizontally only where the box starts and ends.
 */
function padded(extent: Extent, surround: Surround, first: boolean, last: boolean): Rect {
  const { border, padding } = surround;
  const left = first ? border.left + padding.left : 0;
  const right = last ? border.right + padding.right : 0;
  const top = border.top + padding.top;
  const bottom = border.bottom + padding.bottom;

  return {
    x: extent.left - left,
    y: extent.top - top,
    width: extent.right - extent.left + left + right,
    height: extent.bottom - extent.top + top + bottom,
  };
}

/**
 * Half the leading goes above the text and half below, except that Blink floors the top half
 * to a whole device pixel and lets the bottom half take what is left. On a line of plain text
 * the two halves add back up to the line height and nothing shows. It shows the moment
 * something else sets the ascent, such as an inline-block sitting on its bottom margin edge,
 * and then the line is half a pixel taller than even division makes it.
 */
function halfLeading(lineHeight: number, metrics: FontMetrics, ratio: number): number {
  const leading = (lineHeight - (metrics.ascent + metrics.descent)) / 2;
  return Math.floor(leading * ratio) / ratio;
}

/** What a line can end with without having been pushed there: nothing of it is drawn after. */
function idle(kind: PieceKind | undefined): boolean {
  return kind === 'edge-end' || kind === 'out-of-flow';
}

/** A list item whose marker hangs outside it, which still needs a line to sit on. */
export function hasOutsideMarker(style: ComputedStyle): boolean {
  return (
    style.display === 'list-item' &&
    style.listStylePosition === 'outside' &&
    style.listStyleType !== 'none'
  );
}

/**
 * Whether an item would put anything on the line after a newline: content, the opening of a
 * box, preserved whitespace, or another newline. A box closing, a space that collapses and a
 * box out of the flow would not.
 */
function opensALine(item: Item): boolean {
  switch (item.kind) {
    case 'newline':
      return !item.droppable;
    case 'boundary':
    case 'edge-end':
    case 'out-of-flow':
      return false;
    case 'space':
      return item.style.whiteSpace === 'pre';
    default:
      return true;
  }
}

/** Content, or the edge of a box that may not hang, which is enough to hold a line of its own. */
function holdsALine(piece: Piece): boolean {
  return !isMarker(piece.kind) || (isEdge(piece.kind) && !piece.mayHang);
}

/** A piece that is not content of its own: an inline box's edge, or a box out of the flow. */
function isMarker(kind: PieceKind): boolean {
  return kind !== 'glyphs' && kind !== 'space' && kind !== 'atomic';
}

/**
 * Whether an inline box's edge is worth a line of its own. The spec asks whether the box has
 * a margin, padding or border there, not whether they add up to anything: a margin of -12 and
 * a padding of 12 come to nothing and still count. A browser also decides it before the
 * percentages are resolved, so `padding-left: 1%` of a box that turns out to be nothing wide
 * still makes a line where `padding-left: 0` does not.
 */
function takesRoom(piece: Piece): boolean {
  if (piece.width !== 0) return true;

  const style = piece.style;
  const start = piece.kind === 'edge-start';
  const [padding, margin] = start
    ? [style.paddingLeft, style.marginLeft]
    : [style.paddingRight, style.marginRight];
  const border = usedBorderWidths(style)[start ? 'left' : 'right'];

  // A percentage that is not zero counts even when it resolves to nothing; zero is zero in
  // any unit.
  const given = (value: typeof padding | typeof margin) =>
    (value.kind === 'percent' || value.kind === 'px') && value.value !== 0;
  return given(padding) || given(margin) || border !== 0;
}

/** The inline boxes Chromium culls, each with what is inside it. */
function culledBoxes(
  children: readonly Box[],
  measurer: TextMeasurer,
  found = new Map<BoxId, readonly Box[]>(),
): Map<BoxId, readonly Box[]> {
  for (const child of children) {
    if (child.kind !== 'inline' || child.atomic) continue;
    if (culls(child, measurer)) found.set(child.id, child.children);
    culledBoxes(child.children, measurer, found);
  }
  return found;
}

/**
 * Whether Chromium gives an inline box no fragment of its own and reports it as what is inside
 * it instead, so that the padding of a span inside sticks out of it too. A box keeps its
 * fragment if it draws anything, is positioned, or has a margin or padding anywhere, even one
 * that moves nothing. It also keeps it for something directly inside it that it has to be
 * there for: an atomic inline, whose height is not the box's, or an inline box with a margin
 * or a font of other metrics. Measured, and it is what Blink's inline items builder does.
 */
function culls(box: InlineBox, measurer: TextMeasurer): boolean {
  const style = box.style;
  const border = usedBorderWidths(style);
  const padding = [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft];

  if (
    style.backgroundColor.a > 0 ||
    style.opacity < 1 ||
    style.position !== 'static' ||
    border.top + border.right + border.bottom + border.left > 0 ||
    padding.some((side) => side.value !== 0) ||
    hasMargin(style)
  ) {
    return false;
  }

  const metrics = measurer.metrics(fontOf(style));
  return box.children.every((child) => {
    if (child.kind !== 'inline') return true;
    if (child.atomic) return false;

    const inner = measurer.metrics(fontOf(child.style));
    return (
      !hasMargin(child.style) &&
      inner.ascent === metrics.ascent &&
      inner.descent === metrics.descent
    );
  });
}

function hasMargin(style: ComputedStyle): boolean {
  return [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft].some(
    (side) => side.kind === 'auto' || side.value !== 0,
  );
}

/** The inline boxes that both begin and end on this line, which is all of an empty one. */
function opensAndCloses(line: Line): Set<BoxId> {
  const opened = new Set<BoxId>();
  const both = new Set<BoxId>();

  for (const { piece } of line.items) {
    if (piece.kind === 'edge-start') opened.add(piece.box);
    else if (piece.kind === 'edge-end' && opened.has(piece.box)) both.add(piece.box);
  }

  return both;
}

function isEdge(kind: PieceKind): boolean {
  return kind === 'edge-start' || kind === 'edge-end';
}

/** An atomic inline with no line boxes of its own sits on its bottom edge. */
function baselineOf(piece: Piece): number {
  return piece.baseline ?? piece.height;
}

function record(pieces: Map<BoxId, Rect[]>, box: BoxId, rect: Rect): void {
  const existing = pieces.get(box);
  if (existing === undefined) pieces.set(box, [rect]);
  else existing.push(rect);
}

type Extent = { left: number; top: number; right: number; bottom: number };

/**
 * An inline box is as tall as its own font says, whatever is inside it: a forty pixel word in
 * a ten pixel span sticks out of the span rather than stretching it, and so does an
 * inline-block. So a child widens the box it sits in and never heightens it.
 */
function widen(extents: Map<BoxId, Extent>, box: BoxId, rect: Rect): void {
  const current = extents.get(box);
  extents.set(box, {
    left: Math.min(current?.left ?? rect.x, rect.x),
    top: current?.top ?? Number.POSITIVE_INFINITY,
    right: Math.max(current?.right ?? rect.x + rect.width, rect.x + rect.width),
    bottom: current?.bottom ?? Number.NEGATIVE_INFINITY,
  });
}

function grow(extents: Map<BoxId, Extent>, box: BoxId, rect: Rect): void {
  const current = extents.get(box);
  const next: Extent = {
    left: Math.min(current?.left ?? rect.x, rect.x),
    top: Math.min(current?.top ?? rect.y, rect.y),
    right: Math.max(current?.right ?? rect.x + rect.width, rect.x + rect.width),
    bottom: Math.max(current?.bottom ?? rect.y + rect.height, rect.y + rect.height),
  };
  extents.set(box, next);
}

function collect(
  children: readonly Box[],
  ancestors: readonly BoxId[],
  offset: Offset,
  wrapping: boolean,
  input: InlineInput,
  surrounds: Map<BoxId, Surround>,
  outOfFlow: Map<BoxId, OutOfFlow>,
): Item[] {
  const items: Item[] = [];

  for (const child of children) {
    if (child.kind === 'text') {
      const font = fontOf(child.style);
      const metrics = input.measurer.metrics(font);
      const height = metrics.ascent + metrics.descent;

      for (const segment of segmentText(child.text, child.style.whiteSpace)) {
        if (segment.kind === 'newline') {
          items.push({ kind: 'newline', droppable: false });
          continue;
        }
        items.push({
          kind: segment.kind === 'word' ? 'glyphs' : 'space',
          box: child.id,
          source: null,
          width:
            child.listMarker === 'symbol'
              ? symbolMarkerAdvance(metrics, font.size)
              : input.measurer.advance(segment.text, font),
          height,
          baseline: metrics.ascent,
          style: child.style,
          mayHang: true,
          listMarker: child.listMarker !== null,
          ancestors,
          offset,
        });
      }
      // A marker inside its item can be broken after, the way an atomic inline can, whether or
      // not a space follows it.
      if (child.listMarker !== null && wrapping) items.push({ kind: 'boundary' });
      continue;
    }

    if (child.kind === 'inline' && !child.atomic) {
      const surround = surroundOf(child.style, input.available, offset);
      surrounds.set(child.id, surround);

      const inside = [...ancestors, child.id];
      const hangs = !blockByDefault(child.element?.tag ?? '');
      const edge = (kind: 'edge-start' | 'edge-end', width: number): Piece => ({
        kind,
        box: child.id,
        source: null,
        width,
        height: 0,
        baseline: null,
        style: child.style,
        mayHang: hangs,
        listMarker: false,
        ancestors: inside,
        offset: surround.offset,
      });

      items.push(
        edge('edge-start', surround.margin.left + surround.border.left + surround.padding.left),
      );
      const within = collect(
        child.children,
        inside,
        surround.offset,
        wraps(child.style.whiteSpace),
        input,
        surrounds,
        outOfFlow,
      );

      // Chromium keeps a preserved newline at the end of a `<div>` where it is, whatever its
      // `display` says, and the box closes on the line after it. At the end of a `<span>` the
      // box closes first, on the line the newline ends, and the newline only counts at all
      // if something comes after the span. A tag it does not know behaves like the span.
      // Measured rather than found in a spec. Without it a `pre` inline at the end of a
      // paragraph ends up a line taller than the page it is on.
      const trailing =
        !blockByDefault(child.element?.tag ?? '') && within.at(-1)?.kind === 'newline'
          ? within.pop()
          : undefined;

      items.push(...within);
      items.push(
        edge('edge-end', surround.padding.right + surround.border.right + surround.margin.right),
      );
      if (trailing !== undefined) items.push({ kind: 'newline', droppable: true });
      continue;
    }

    if (isBlock(child)) {
      if (child.style.position !== 'absolute') continue;

      outOfFlow.set(child.id, { box: child, wraps: wrapping });
      items.push({
        kind: 'out-of-flow',
        box: child.id,
        source: null,
        width: 0,
        height: 0,
        baseline: null,
        style: child.style,
        mayHang: true,
        listMarker: false,
        ancestors,
        offset,
      });
      continue;
    }

    if (child.kind === 'inline') {
      const size = input.layoutAtomic(child, input.available);
      if (wrapping) items.push({ kind: 'boundary' });
      items.push({
        kind: 'atomic',
        box: child.id,
        source: child,
        width: size.width,
        height: size.height,
        baseline: size.baseline,
        style: child.style,
        mayHang: true,
        listMarker: false,
        ancestors,
        offset,
      });
      if (wrapping) items.push({ kind: 'boundary' });
    }
  }

  return items;
}

function surroundOf(style: ComputedStyle, available: number, parent: Offset): Surround {
  const shift = relativeOffset(style, { width: available, height: null });

  return {
    style,
    margin: {
      top: usedMargin(style.marginTop, available) ?? 0,
      right: usedMargin(style.marginRight, available) ?? 0,
      bottom: usedMargin(style.marginBottom, available) ?? 0,
      left: usedMargin(style.marginLeft, available) ?? 0,
    },
    border: usedBorderWidths(style),
    padding: usedPadding(style, available),
    offset: { dx: parent.dx + shift.dx, dy: parent.dy + shift.dy },
  };
}

/** A run with no break opportunity inside it, which has to fit on a line whole or not at all. */
type Chunk = { pieces: Piece[]; width: number; content: boolean };

type Entry =
  | { kind: 'chunk'; chunk: Chunk }
  /** A space that collapses. Whether it may also break depends on its own white-space. */
  | { kind: 'space'; space: Piece }
  | { kind: 'boundary' }
  | { kind: 'newline' };

/**
 * Splits the items at every collapsible space. Whether a given space may also be broken at
 * depends on its own `white-space`, which is why a `nowrap` run travels to the next line as
 * one piece instead of starting on the first line and hanging off the edge, while its own
 * spaces still collapse the way they do anywhere else.
 */
function intoEntries(items: readonly Item[]): Entry[] {
  const entries: Entry[] = [];
  let pieces: Piece[] = [];
  let width = 0;
  let content = false;
  /** A collapsible space inside a chunk: it survives only if more content follows it. */
  let held: Piece | null = null;
  /** Where that space belongs, which is in front of any closing edge that came after it. */
  let heldAt = 0;

  const close = () => {
    held = null;
    if (pieces.length === 0) return;
    entries.push({ kind: 'chunk', chunk: { pieces, width, content } });
    pieces = [];
    width = 0;
    content = false;
  };

  const add = (piece: Piece) => {
    // An inline box's own edge does not settle a space that is hanging behind it, or the
    // trailing space of a `nowrap` run would survive to the end of the line. When something
    // else does settle it, it goes back to where it was: inside the box, in front of the
    // closing padding rather than beyond it.
    if (held !== null && !isMarker(piece.kind)) {
      pieces.splice(heldAt, 0, held);
      width += held.width;
      held = null;
    }
    pieces.push(piece);
    width += piece.width;
    if (!isMarker(piece.kind) && !piece.listMarker) content = true;
  };

  items.forEach((item, index) => {
    if (item.kind === 'newline') {
      if (item.droppable && !items.slice(index + 1).some(opensALine)) return;
      close();
      entries.push({ kind: 'newline' });
      return;
    }

    if (item.kind === 'boundary') {
      // An opening edge belongs with what comes after it, so it crosses to the far side.
      let at = pieces.length;
      while (at > 0 && pieces[at - 1]?.kind === 'edge-start') at--;
      const opening = pieces.splice(at);
      width -= opening.reduce((sum, piece) => sum + piece.width, 0);

      close();
      entries.push({ kind: 'boundary' });
      for (const piece of opening) add(piece);
      return;
    }

    if (item.kind === 'space' && wraps(item.style.whiteSpace)) {
      // A space held back from a nowrap run is the first of this run, so it is the one that
      // stays, inside its own box. The one arriving now collapses into it.
      if (held !== null) {
        pieces.splice(heldAt, 0, held);
        width += held.width;
        held = null;
      }
      close();
      entries.push({ kind: 'space', space: item });
      return;
    }

    if (item.kind === 'space' && item.style.whiteSpace === 'nowrap') {
      // Collapses like any other space, but it is not a place the line may break, so it
      // stays inside the chunk rather than ending it. A run of them counts once, and it is
      // the first that counts: that is the one whose box the space is drawn in.
      if (content && held === null) {
        held = item;
        heldAt = pieces.length;
      }
      return;
    }

    add(item);
  });

  close();
  return entries;
}

/**
 * The lines, and the boxes out of the flow that sit where the line could have broken: right
 * after a space or beside an atomic inline, with nothing but the edges of boxes in between.
 * One of those goes to the next line when it comes too late for this one. One written inside
 * a run that cannot break stays where it is, however far over the edge that is.
 */
/**
 * How far past the end a line may run and still count as fitting: one LayoutUnit. Blink adds
 * it to the width it tests against, so that a width rounded down on the way in does not push
 * a word that measured exactly that wide onto the next line.
 */
const FIT_SLACK = 1 / 64;

function breakIntoLines(
  items: readonly Item[],
  input: InlineInput,
): { lines: Line[]; atBreak: Set<Piece> } {
  const atBreak = new Set<Piece>();
  let afterBreak = false;

  const lines: Line[] = [];

  let current: Placed[] = [];
  let width = 0;
  /** An inline box's own edges do not count: a space after one is still a leading space. */
  let content = false;
  /** Where on the current line a boundary falls, as the index of the piece after it. */
  const boundaries = new Set<number>();

  /** The index of a collapsible space at the end of the line, past any closing edges. */
  const hanging = (): number => {
    let at = current.length;
    while (at > 0 && isMarker(current[at - 1]?.piece.kind ?? 'glyphs')) at--;

    const last = at > 0 ? current[at - 1] : undefined;
    const space = last?.piece;
    return space !== undefined && space.kind === 'space' && space.style.whiteSpace !== 'pre'
      ? at - 1
      : -1;
  };

  const flush = (force = false) => {
    // A line never ends on a collapsible space: it hangs over the edge and takes no room, so
    // it comes off along with the width it lent to any closing edge behind it.
    const at = hanging();
    const space = at < 0 ? undefined : current.splice(at, 1)[0]?.piece;

    if (space !== undefined) {
      for (const placed of current.slice(at)) placed.x -= space.width;
      width -= space.width;
    }

    boundaries.clear();
    if (current.length === 0 && !force) return;

    // The marker outside a list item sits on its first line, which makes that line a line
    // whatever else is on it.
    const marked = lines.length === 0 && hasOutsideMarker(input.container.style);
    lines.push({ items: current, width, ...verticalMetrics(current, input, force || marked) });
    current = [];
    width = 0;
    content = false;
  };

  const place = (chunk: Chunk) => {
    for (const piece of chunk.pieces) {
      current.push({ piece, x: width });
      width += piece.width;
    }
    if (chunk.content) content = true;
  };

  /**
   * What is on the end of the line but takes no room in the decision to break: a collapsible
   * space, which hangs over the edge, and the edges of a box that opened and closed there
   * without putting anything between them. A border on an empty span is not worth a break.
   *
   * While more of the paragraph is still to come, the closing edges behind a hanging space
   * hang with it. Chromium only breaks for them if they are the last thing there is: when
   * something follows, the line breaks at that space and keeps the edges, overflowing.
   */
  const hangs = (closing: boolean): number => {
    let at = current.length;
    while (at > 0 && isMarker(current[at - 1]?.piece.kind ?? 'glyphs')) at--;

    const trailing = current.slice(at).map(({ piece }) => piece);
    const opened = new Set(trailing.filter((p) => p.kind === 'edge-start').map((p) => p.box));
    const closed = new Set(trailing.filter((p) => p.kind === 'edge-end').map((p) => p.box));

    const space = hanging();
    const idle = trailing
      .filter(
        (piece) =>
          isEdge(piece.kind) &&
          // Whether the tag was a block by default decides an empty box, not a closing edge
          // behind a space: that one hangs whatever the box was.
          ((piece.mayHang && opened.has(piece.box) && closed.has(piece.box)) ||
            (closing && space >= 0 && piece.kind === 'edge-end')),
      )
      .reduce((sum, piece) => sum + piece.width, 0);

    return idle + (space < 0 ? 0 : (current[space]?.piece.width ?? 0));
  };

  /**
   * Where the next line may start, which needs something other than edges behind it. After a
   * space, or at a boundary beside an atomic inline. A boundary also needs something in front
   * of it on the line: content, or the edge of a box whose tag is a block by default, which
   * Chromium will leave on a line of its own where it keeps an empty span with what follows.
   */
  const opportunity = (): number => {
    for (let at = current.length - 1; at > 0; at--) {
      // Only content is worth a new line. A space would vanish at the start of it, and a box
      // out of the flow takes no room: where a full line sends one is its static position's
      // business, not the break's.
      const behind = current.slice(at);
      if (!behind.some(({ piece }) => !isMarker(piece.kind) && piece.kind !== 'space')) continue;

      const before = current[at - 1]?.piece;
      if (before?.kind === 'space' && wraps(before.style.whiteSpace)) {
        // A space that is the first thing inside a box breaks in front of the box: its
        // opening edge would be left on its own at the end of the line otherwise. The space
        // goes down with it and vanishes at the start of the new line.
        let start = at - 1;
        while (start > 0 && current[start - 1]?.piece.kind === 'edge-start') start--;
        const content = current.slice(0, start).some(({ piece }) => holdsALine(piece));
        return start < at - 1 && content ? start : at;
      }

      if (boundaries.has(at) && current.slice(0, at).some(({ piece }) => holdsALine(piece))) {
        return at;
      }
    }
    return -1;
  };

  /**
   * Back to the last space and start again there. A closing edge that follows it stays put:
   * the box it ends has its content on this line, so its margin and border belong here too,
   * which is also what makes them count against the width before the break.
   */
  const carryOver = (from: number) => {
    const carried = current.splice(from);
    const ahead = [...boundaries].filter((at) => at > from).map((at) => at - from);
    width = carried[0]?.x ?? width;
    flush();

    // A collapsible space at the start of the new line is not drawn, so it goes, along with
    // the room it took and its place in the count the boundaries are kept by.
    let shift = carried[0]?.x ?? 0;
    const dropped: number[] = [];
    carried.forEach((placed, index) => {
      const { piece } = placed;
      if (!content && piece.kind === 'space' && wraps(piece.style.whiteSpace)) {
        shift += piece.width;
        dropped.push(index);
        return;
      }
      current.push({ piece, x: placed.x - shift });
      width = placed.x - shift + piece.width;
      if (!isMarker(piece.kind) && piece.kind !== 'space') content = true;
    });
    for (const at of ahead) boundaries.add(at - dropped.filter((index) => index < at).length);
  };

  const rewind = () => {
    // A line always keeps what it has: a space at the start is not drawn and is not a place
    // to break either, so what overflows simply hangs over the edge.
    const from = opportunity();
    if (from < 0) return;

    // A closing edge stays put, and so does a box out of the flow: neither of them is what
    // overflowed the line. If holding them back leaves nothing to carry, the break would do
    // nothing at all, so they come along after all.
    let keep = from;
    while (idle(current[keep]?.piece.kind)) keep++;

    carryOver(keep < current.length ? keep : from);
  };

  for (const entry of intoEntries(items)) {
    if (entry.kind === 'newline') {
      flush(true);
      continue;
    }

    if (entry.kind === 'boundary') {
      boundaries.add(current.length);
      afterBreak = true;
      continue;
    }

    if (entry.kind === 'space') {
      // A space at the start of a line disappears, and a run of them counts once: the first,
      // which decides whose box it is drawn in when the run crosses a boundary. The run is
      // still somewhere the line may break at its end: past the space it kept, past any box
      // that closed after it or opened and closed with nothing in it, and in front of a box
      // that has only opened.
      afterBreak = true;
      if (!content) continue;
      const kept = hanging();
      if (kept >= 0) {
        const run = current.slice(kept + 1);
        const closed = new Set(
          run.filter(({ piece }) => piece.kind === 'edge-end').map(({ piece }) => piece.box),
        );
        const opening = run.findIndex(
          ({ piece }) => piece.kind === 'edge-start' && !closed.has(piece.box),
        );
        boundaries.add(opening < 0 ? current.length : kept + 1 + opening);
        continue;
      }

      current.push({ piece: entry.space, x: width });
      width += entry.space.width;
      continue;
    }

    if (afterBreak) {
      for (const piece of entry.chunk.pieces) {
        if (piece.kind === 'out-of-flow') atBreak.add(piece);
        else if (!isEdge(piece.kind)) break;
      }
    }
    afterBreak = false;

    place(entry.chunk);

    // A box that has only opened so far has nothing on the line to break for yet. Its padding
    // may already be over the edge, but the break is decided when its content arrives, and
    // then the space in front of the box is a place to break.
    const opening = !entry.chunk.content && entry.chunk.pieces.at(-1)?.kind === 'edge-start';
    if (!opening && width - hangs(true) > input.available + FIT_SLACK) rewind();
  }

  // Nothing follows the end of the paragraph, so the closing edges take their room after all.
  while (width - hangs(false) > input.available + FIT_SLACK) {
    const before = lines.length;
    rewind();
    if (lines.length === before) break;
  }

  flush(lines.length === 0 && hasOutsideMarker(input.container.style));
  return { lines, atBreak };
}

/**
 * A line carries a strut, the block's own font and line-height, whether or not any text on it
 * uses them. But only if there is anything on the line at all: the spec says a line holding
 * no text, no preserved whitespace and no inline box with margins, padding or borders is a
 * zero height line box. That is why an empty `<span>` adds nothing to the page and a padded
 * one adds a whole line.
 */
function verticalMetrics(
  items: readonly Placed[],
  input: InlineInput,
  forced: boolean,
): { height: number; baseline: number; phantom: boolean } {
  // A line the source asked for with a newline exists whatever is on it, and so does one
  // holding preserved whitespace. That is the difference between a `pre` block's blank line
  // and an empty `<span>`, which takes no room at all.
  const substantial =
    forced ||
    items.some(({ piece }) => {
      if (piece.kind === 'out-of-flow') return false;
      if (isEdge(piece.kind)) return takesRoom(piece);
      return piece.kind !== 'space' || piece.style.whiteSpace === 'pre';
    });

  if (!substantial) return { height: 0, baseline: 0, phantom: true };

  const strut = input.measurer.metrics(fontOf(input.containerStyle));
  const strutHeight = usedLineHeight(input.containerStyle, strut);
  const strutLeading = halfLeading(strutHeight, strut, input.devicePixelRatio);

  let above = strutLeading + strut.ascent;
  let below = strutHeight - above;

  // An edge carries no glyphs but it is still an inline box, and an inline box contributes
  // its own line-height to the line whether or not there is anything inside it.
  for (const { piece } of items) {
    // Out of the flow, so its line-height is nobody's business but its own.
    if (piece.kind === 'out-of-flow') continue;

    if (piece.kind === 'atomic') {
      const ascent = baselineOf(piece);
      above = Math.max(above, ascent);
      below = Math.max(below, piece.height - ascent);
      continue;
    }

    const metrics = input.measurer.metrics(fontOf(piece.style));
    const lineHeight = usedLineHeight(piece.style, metrics);
    const ascent = halfLeading(lineHeight, metrics, input.devicePixelRatio) + metrics.ascent;

    above = Math.max(above, ascent);
    below = Math.max(below, lineHeight - ascent);
  }

  return { height: above + below, baseline: above, phantom: false };
}

function alignmentOffset(style: ComputedStyle, available: number, used: number): number {
  switch (style.textAlign) {
    case 'right':
      return Math.max(0, available - used);
    case 'center':
      return Math.max(0, (available - used) / 2);
    default:
      return 0;
  }
}
