import type { ComputedStyle } from '../cascade/properties.js';
import { usedInset } from './used.js';

/**
 * `position: relative` shifts a box after it has been laid out, and leaves the space it came
 * from untouched. Left wins over right, top wins over bottom: with both given the second is
 * ignored, and with only the second given it moves the other way.
 */
export function relativeOffset(
  style: ComputedStyle,
  containing: { width: number; height: number | null },
): { dx: number; dy: number } {
  if (style.position !== 'relative') return { dx: 0, dy: 0 };

  const left = usedInset(style.left, containing.width);
  const right = usedInset(style.right, containing.width);
  const top = usedInset(style.top, containing.height ?? 0);
  const bottom = usedInset(style.bottom, containing.height ?? 0);

  return {
    dx: left ?? (right === null ? 0 : -right),
    dy: top ?? (bottom === null ? 0 : -bottom),
  };
}

export type AxisInput = {
  containerSize: number;
  /** left or top, null when auto. */
  start: number | null;
  /** right or bottom, null when auto. */
  end: number | null;
  /** Content width or height, null when auto. */
  size: number | null;
  marginStart: number | null;
  marginEnd: number | null;
  /** Border and padding on this axis. */
  surround: number;
  /** Where the box would have sat in the flow, relative to the container's start edge. */
  staticStart: number;
  autoSize: (available: number) => number;
};

export type AxisResult = {
  /** Border-box offset from the container's start edge. */
  start: number;
  size: number;
  marginStart: number;
  marginEnd: number;
};

/** One axis of an absolute box: insets, margins, borders, padding and size add up to the block. */
export function solveAbsoluteAxis(input: AxisInput): AxisResult {
  const { containerSize, start, end, size, surround } = input;
  const marginStart = input.marginStart;
  const marginEnd = input.marginEnd;

  if (start === null && end === null) {
    const before = marginStart ?? 0;
    const after = marginEnd ?? 0;
    const available = Math.max(0, containerSize - input.staticStart - surround - before - after);

    // The static position is where the margin edge would have been, so the border box sits
    // one margin further in.
    return {
      start: input.staticStart + before,
      size: size ?? input.autoSize(available),
      marginStart: before,
      marginEnd: after,
    };
  }

  if (start !== null && end !== null && size !== null) {
    return overConstrained(input, start, end, size);
  }

  const before = marginStart ?? 0;
  const after = marginEnd ?? 0;

  if (size === null) {
    if (start !== null && end !== null) {
      const resolved = Math.max(0, containerSize - start - end - before - after - surround);
      return { start: start + before, size: resolved, marginStart: before, marginEnd: after };
    }

    const taken = (start ?? 0) + (end ?? 0) + before + after + surround;
    const resolved = input.autoSize(Math.max(0, containerSize - taken));
    const offset =
      start !== null ? start + before : containerSize - (end ?? 0) - after - resolved - surround;

    return { start: offset, size: resolved, marginStart: before, marginEnd: after };
  }

  const offset =
    start !== null ? start + before : containerSize - (end ?? 0) - after - size - surround;

  return { start: offset, size, marginStart: before, marginEnd: after };
}

// With start, size and end all given the box is over-constrained, and auto margins are what
// absorb the slack. That is how an absolutely positioned box gets centred. If the margins are
// given too, the end inset is the one that loses.
function overConstrained(input: AxisInput, start: number, end: number, size: number): AxisResult {
  const free = input.containerSize - start - end - size - input.surround;

  if (input.marginStart === null && input.marginEnd === null) {
    const half = free >= 0 ? free / 2 : 0;
    return { start: start + half, size, marginStart: half, marginEnd: free - half };
  }

  if (input.marginStart === null) {
    const after = input.marginEnd ?? 0;
    return { start: start + (free - after), size, marginStart: free - after, marginEnd: after };
  }

  const before = input.marginStart;
  return {
    start: start + before,
    size,
    marginStart: before,
    marginEnd: free - before,
  };
}
