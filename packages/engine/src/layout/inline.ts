import type { BlockBox, Box, BoxId, InlineBox } from '../boxtree/box.js';
import type { ComputedStyle } from '../cascade/properties.js';
import { type Rect, zeroEdges } from '../geometry.js';
import type { Fragment, LayoutEvent } from '../trace/events.js';
import { fontOf, segmentText, type TextMeasurer, usedLineHeight, wraps } from './text.js';

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

type Piece = {
  kind: 'glyphs' | 'space' | 'atomic';
  box: BoxId;
  source: InlineBox | null;
  width: number;
  height: number;
  baseline: number | null;
  style: ComputedStyle;
  ancestors: readonly BoxId[];
};

type Item = Piece | { kind: 'newline' };

type Placed = { piece: Piece; x: number };

type Line = { items: Placed[]; width: number; height: number; baseline: number };

export function layoutInlineContent(input: InlineInput): InlineResult {
  const items = collect(input.container.children, [], input);
  const lines = breakIntoLines(items, input);

  let y = input.contentTop;
  let lastBaseline: number | null = null;
  const extents = new Map<BoxId, Extent>();

  lines.forEach((line, index) => {
    input.trace.push({
      t: 'line:broken',
      box: input.container.id,
      at: index,
      width: line.width,
    });

    const offset = alignmentOffset(input.containerStyle, input.available, line.width);
    lastBaseline = y + line.baseline - input.contentTop;

    for (const placed of line.items) {
      const piece = placed.piece;
      const metrics = input.measurer.metrics(fontOf(piece.style));
      const above = piece.kind === 'atomic' ? baselineOf(piece) : metrics.ascent;
      const top = y + line.baseline - above;

      const rect = {
        x: input.contentX + offset + placed.x,
        y: top,
        width: piece.width,
        height: piece.height,
      };

      record(input.pieces, piece.box, rect);
      for (const ancestor of piece.ancestors) record(input.pieces, ancestor, rect);

      if (piece.source !== null) {
        // Laid out once to measure it and again where the line put it. The second pass is
        // what ends up in the fragments, and the trace shows both.
        input.placeAtomic(piece.source, rect.x, rect.y);
      } else if (piece.kind !== 'space') {
        grow(extents, piece.box, rect);
      }

      for (const ancestor of piece.ancestors) grow(extents, ancestor, rect);
    }

    y += line.height;
  });

  for (const [box, extent] of extents) {
    const fragment: Fragment = {
      box,
      rect: {
        x: extent.left,
        y: extent.top,
        width: extent.right - extent.left,
        height: extent.bottom - extent.top,
      },
      margin: zeroEdges,
      border: zeroEdges,
      padding: zeroEdges,
    };

    input.fragments.set(box, fragment);
    input.trace.push({
      t: 'size:resolved',
      box,
      fragment,
      reason: 'union of the line boxes it sits on',
    });
  }

  return { height: y - input.contentTop, lastBaseline };
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

function grow(extents: Map<BoxId, Extent>, box: BoxId, rect: Fragment['rect']): void {
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
  input: InlineInput,
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
        });
      }
      continue;
    }

    if (child.kind === 'inline' && !child.atomic) {
      items.push(...collect(child.children, [...ancestors, child.id], input));
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
      });
    }
  }

  return items;
}

function breakIntoLines(items: readonly Item[], input: InlineInput): Line[] {
  const lines: Line[] = [];
  const canWrap = wraps(input.containerStyle.whiteSpace);

  let current: Placed[] = [];
  let width = 0;
  let pendingSpace: Piece | null = null;

  const preserve = input.containerStyle.whiteSpace === 'pre';

  const flush = (force = false) => {
    if (current.length === 0 && !force) return;
    lines.push({ items: current, width, ...verticalMetrics(current, input) });
    current = [];
    width = 0;
  };

  for (const item of items) {
    if (item.kind === 'newline') {
      pendingSpace = null;
      flush(true);
      continue;
    }

    if (item.kind === 'space' && !preserve) {
      // A space at the start of a line disappears, and a run of them counts once.
      if (current.length > 0) pendingSpace = item;
      continue;
    }

    const gap = pendingSpace?.width ?? 0;

    if (canWrap && current.length > 0 && width + gap + item.width > input.available) {
      // The pending space is dropped with the break, which is why a wrapped line does not
      // start with a gap.
      pendingSpace = null;
      flush();
      current.push({ piece: item, x: 0 });
      width = item.width;
      continue;
    }

    if (pendingSpace !== null) {
      current.push({ piece: pendingSpace, x: width });
      width += gap;
      pendingSpace = null;
    }

    current.push({ piece: item, x: width });
    width += item.width;
  }

  flush();
  return lines;
}

/**
 * Every line carries a strut: the block's own font and line-height, present whether or not
 * any text on the line uses them. Without it an empty line would have no height at all.
 */
function verticalMetrics(
  items: readonly Placed[],
  input: InlineInput,
): { height: number; baseline: number } {
  const strut = input.measurer.metrics(fontOf(input.containerStyle));
  const strutHeight = usedLineHeight(input.containerStyle, strut);
  const strutLeading = (strutHeight - (strut.ascent + strut.descent)) / 2;

  let above = strutLeading + strut.ascent;
  let below = strutHeight - above;

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
