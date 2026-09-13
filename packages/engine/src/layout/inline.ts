import type { BlockBox, Box, BoxId, InlineBox } from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import { type Edges, type Rect, zeroEdges } from '../geometry.js';
import type { Fragment, LayoutEvent } from '../trace/events.js';
import { relativeOffset } from './position.js';
import { fontOf, segmentText, type TextMeasurer, usedLineHeight, wraps } from './text.js';
import { usedBorderWidths, usedMargin, usedPadding } from './used.js';

export type AtomicSize = {
  width: number;
  height: number;
  /** Offset from the top of the box to its baseline, or null to sit on its bottom edge. */
  baseline: number | null;
};

export type InlineResult = {
  height: number;
  /** The last line's baseline, measured from the content top, for a parent to align to. */
  lastBaseline: number | null;
};

export type InlineInput = {
  container: BlockBox;
  containerStyle: ComputedStyle;
  contentX: number;
  contentTop: number;
  available: number;
  measurer: TextMeasurer;
  fragments: Map<BoxId, Fragment>;
  /** One rect per line a box appears on, which is what a pointer is tested against. */
  pieces: Map<BoxId, Rect[]>;
  trace: LayoutEvent[];
  layoutAtomic: (box: InlineBox, available: number) => AtomicSize;
  placeAtomic: (box: InlineBox, x: number, y: number) => void;
};

type Offset = { dx: number; dy: number };

type PieceKind = 'glyphs' | 'space' | 'atomic' | 'edge-start' | 'edge-end';

type Piece = {
  /** An edge takes room in the line for one side of an inline box's padding and border. */
  kind: PieceKind;
  box: BoxId;
  source: InlineBox | null;
  width: number;
  height: number;
  baseline: number | null;
  style: ComputedStyle;
  ancestors: readonly BoxId[];
  /** Relative offsets of the inline boxes this piece sits inside, already added up. */
  offset: Offset;
};

type Item = Piece | { kind: 'newline' };

type Placed = { piece: Piece; x: number };

type Line = { items: Placed[]; width: number; height: number; baseline: number };

/** What an inline box adds around its own content, and where it has been shifted to. */
type Surround = { margin: Edges; border: Edges; padding: Edges; offset: Offset };

export function layoutInlineContent(input: InlineInput): InlineResult {
  const surrounds = new Map<BoxId, Surround>();
  const items = collect(input.container.children, [], { dx: 0, dy: 0 }, input, surrounds);
  const lines = breakIntoLines(items, input);

  let y = input.contentTop;
  let lastBaseline: number | null = null;
  const extents = new Map<BoxId, Extent>();
  const perLine = new Map<BoxId, Extent[]>();

  lines.forEach((line, index) => {
    input.trace.push({
      t: 'line:broken',
      box: input.container.id,
      at: index,
      width: line.width,
    });

    const offset = alignmentOffset(input.containerStyle, input.available, line.width);
    lastBaseline = y + line.baseline - input.contentTop;
    const onThisLine = new Map<BoxId, Extent>();

    for (const placed of line.items) {
      const piece = placed.piece;
      if (isEdge(piece.kind)) continue;

      const metrics = input.measurer.metrics(fontOf(piece.style));
      const above = piece.kind === 'atomic' ? baselineOf(piece) : metrics.ascent;

      const rect = {
        x: input.contentX + offset + placed.x + piece.offset.dx,
        y: y + line.baseline - above + piece.offset.dy,
        width: piece.width,
        height: piece.height,
      };

      record(input.pieces, piece.box, rect);
      for (const ancestor of piece.ancestors) record(input.pieces, ancestor, rect);

      if (piece.source !== null) {
        // Laid out once to measure it and again where the line put it. The second pass is
        // what ends up in the fragments, and the trace shows both.
        input.placeAtomic(piece.source, rect.x, rect.y);
      } else {
        grow(extents, piece.box, rect);
      }

      for (const ancestor of piece.ancestors) {
        grow(extents, ancestor, rect);
        grow(onThisLine, ancestor, rect);
      }
    }

    for (const [box, extent] of onThisLine) {
      const seen = perLine.get(box);
      if (seen === undefined) perLine.set(box, [extent]);
      else seen.push(extent);
    }

    y += line.height;
  });

  for (const [box, extent] of extents) {
    const surround = surrounds.get(box);
    const onLines = perLine.get(box);

    // An inline box that wraps is its lines, not the rectangle around them. Its own padding
    // sits at the start of the first line and the end of the last, so growing the union by it
    // puts the box's left edge somewhere it never reaches, and a pointer in the gap beside a
    // short line finds the inline when it is over the block.
    const rects =
      surround === undefined || onLines === undefined
        ? [toRect(extent)]
        : onLines.map((line, index) =>
            padded(line, surround, index === 0, index === onLines.length - 1),
          );

    const fragment = toFragment(box, union(rects), surround);

    input.fragments.set(box, fragment);

    if (surround !== undefined) {
      for (const rect of rects) record(input.pieces, box, rect);
    }

    input.trace.push({
      t: 'size:resolved',
      box,
      fragment,
      reason:
        surround === undefined
          ? 'union of the line boxes it sits on'
          : 'its line boxes, plus its own padding and border',
    });
  }

  return { height: y - input.contentTop, lastBaseline };
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
  input: InlineInput,
  surrounds: Map<BoxId, Surround>,
): Item[] {
  const items: Item[] = [];

  for (const child of children) {
    if (child.kind === 'text') {
      const font = fontOf(child.style);
      const metrics = input.measurer.metrics(font);
      const height = metrics.ascent + metrics.descent;

      for (const segment of segmentText(child.text, child.style.whiteSpace)) {
        if (segment.kind === 'newline') {
          items.push({ kind: 'newline' });
          continue;
        }
        items.push({
          kind: segment.kind === 'word' ? 'glyphs' : 'space',
          box: child.id,
          source: null,
          width: input.measurer.advance(segment.text, font),
          height,
          baseline: metrics.ascent,
          style: child.style,
          ancestors,
          offset,
        });
      }
      continue;
    }

    if (child.kind === 'inline' && !child.atomic) {
      const surround = surroundOf(child.style, input.available, offset);
      surrounds.set(child.id, surround);

      const inside = [...ancestors, child.id];
      const edge = (kind: 'edge-start' | 'edge-end', width: number): Piece => ({
        kind,
        box: child.id,
        source: null,
        width,
        height: 0,
        baseline: null,
        style: child.style,
        ancestors: inside,
        offset: surround.offset,
      });

      items.push(
        edge('edge-start', surround.margin.left + surround.border.left + surround.padding.left),
      );
      items.push(...collect(child.children, inside, surround.offset, input, surrounds));
      items.push(
        edge('edge-end', surround.padding.right + surround.border.right + surround.margin.right),
      );
      continue;
    }

    if (child.kind === 'inline') {
      const size = input.layoutAtomic(child, input.available);
      items.push({
        kind: 'atomic',
        box: child.id,
        source: child,
        width: size.width,
        height: size.height,
        baseline: size.baseline,
        style: child.style,
        ancestors,
        offset,
      });
    }
  }

  return items;
}

function surroundOf(style: ComputedStyle, available: number, parent: Offset): Surround {
  const shift = relativeOffset(style, { width: available, height: null });

  return {
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
    // trailing space of a `nowrap` run would survive to the end of the line.
    if (held !== null && !isEdge(piece.kind)) {
      pieces.push(held);
      width += held.width;
      held = null;
    }
    pieces.push(piece);
    width += piece.width;
    if (!isEdge(piece.kind)) content = true;
  };

  for (const item of items) {
    if (item.kind === 'newline') {
      close();
      entries.push({ kind: 'newline' });
      continue;
    }

    if (item.kind === 'space' && wraps(item.style.whiteSpace)) {
      close();
      entries.push({ kind: 'space', space: item });
      continue;
    }

    if (item.kind === 'space' && item.style.whiteSpace === 'nowrap') {
      // Collapses like any other space, but it is not a place the line may break, so it
      // stays inside the chunk rather than ending it.
      if (content) held = item;
      continue;
    }

    add(item);
  }

  close();
  return entries;
}

function breakIntoLines(items: readonly Item[], input: InlineInput): Line[] {
  const lines: Line[] = [];
  const preserve = input.containerStyle.whiteSpace === 'pre';

  let current: Placed[] = [];
  let width = 0;
  let pending: Piece | null = null;
  /** An inline box's own edges do not count: a space after one is still a leading space. */
  let content = false;
  const flush = (force = false) => {
    if (current.length === 0 && !force) return;
    lines.push({ items: current, width, ...verticalMetrics(current, input, force) });
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

  for (const entry of intoEntries(items)) {
    if (entry.kind === 'newline') {
      pending = null;
      flush(true);
      continue;
    }

    if (entry.kind === 'space') {
      // A space at the start of a line disappears, and a run of them counts once.
      if (content) pending = entry.space;
      continue;
    }

    if (!entry.chunk.content) {
      // Nothing but an inline box's own edges. It takes its room without settling a space
      // that is hanging at the end of the line, which is what keeps `<em> one </em>` from
      // measuring a space wider than its word.
      place(entry.chunk);
      continue;
    }

    const gap = pending?.width ?? 0;
    const breakable = pending !== null && wraps(pending.style.whiteSpace);

    if (content && breakable && width + gap + entry.chunk.width > input.available) {
      // The pending space is dropped with the break, which is why a wrapped line does not
      // start with a gap.
      pending = null;
      flush();
      place(entry.chunk);
      continue;
    }

    if (pending !== null) {
      current.push({ piece: pending, x: width });
      width += gap;
      pending = null;
    }

    place(entry.chunk);
  }

  if (preserve && pending !== null) {
    current.push({ piece: pending, x: width });
    width += pending.width;
  }

  flush();
  return lines;
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
): { height: number; baseline: number } {
  // A line the source asked for with a newline exists whatever is on it, and so does one
  // holding preserved whitespace. That is the difference between a `pre` block's blank line
  // and an empty `<span>`, which takes no room at all.
  const substantial =
    forced ||
    items.some(({ piece }) =>
      isEdge(piece.kind)
        ? piece.width !== 0
        : piece.kind !== 'space' || piece.style.whiteSpace === 'pre',
    );

  if (!substantial) return { height: 0, baseline: 0 };

  const strut = input.measurer.metrics(fontOf(input.containerStyle));
  const strutHeight = usedLineHeight(input.containerStyle, strut);
  const strutLeading = (strutHeight - (strut.ascent + strut.descent)) / 2;

  let above = strutLeading + strut.ascent;
  let below = strutHeight - above;

  // An edge carries no glyphs but it is still an inline box, and an inline box contributes
  // its own line-height to the line whether or not there is anything inside it.
  for (const { piece } of items) {
    if (piece.kind === 'atomic') {
      const ascent = baselineOf(piece);
      above = Math.max(above, ascent);
      below = Math.max(below, piece.height - ascent);
      continue;
    }

    const metrics = input.measurer.metrics(fontOf(piece.style));
    const lineHeight = usedLineHeight(piece.style, metrics);
    const leading = (lineHeight - (metrics.ascent + metrics.descent)) / 2;
    const ascent = leading + metrics.ascent;

    above = Math.max(above, ascent);
    below = Math.max(below, lineHeight - ascent);
  }

  return { height: above + below, baseline: above };
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
