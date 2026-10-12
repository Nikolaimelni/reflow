import type { BorderStyle, ComputedStyle } from '../cascade/properties.js';
import type { Gap, Inset, LengthPercentage, Margin, MaxSize, Px, Size } from '../cascade/values.js';
import type { Edges } from '../geometry.js';

/** A border with no style takes no space, whatever its width says. */
export function usedBorderWidths(style: ComputedStyle): Edges {
  return {
    top: used(style.borderTopStyle, style.borderTopWidth),
    right: used(style.borderRightStyle, style.borderRightWidth),
    bottom: used(style.borderBottomStyle, style.borderBottomWidth),
    left: used(style.borderLeftStyle, style.borderLeftWidth),
  };
}

function used(borderStyle: BorderStyle, width: Px): number {
  return borderStyle === 'none' ? 0 : width.value;
}

/**
 * Blink keeps every used length as a LayoutUnit, which is a sixty-fourth of a pixel, and it
 * truncates on the way in rather than rounding. So `padding: 4%` of a 180px box is 7.1875
 * and not 7.2, and a box with that padding on both sides comes out a fortieth of a pixel
 * narrower than the arithmetic says.
 */
export function layoutUnit(value: number): number {
  return Math.floor(value * 64) / 64;
}

export function usedLength(value: LengthPercentage, basis: number): number {
  return layoutUnit(value.kind === 'px' ? value.value : (value.value / 100) * basis);
}

/**
 * null means auto, or none for a max size. A percentage against an unknown basis is also
 * auto, which is the rule that keeps `height: 50%` inside an auto-height parent from looping
 * forever.
 */
export function usedSize(value: Size | MaxSize, basis: number | null): number | null {
  if (value.kind === 'auto' || value.kind === 'none') return null;
  if (value.kind === 'percent' && basis === null) return null;
  return usedLength(value, basis ?? 0);
}

export function usedMargin(value: Margin, basis: number): number | null {
  return value.kind === 'auto' ? null : usedLength(value, basis);
}

/**
 * `normal` is a gap of zero outside multi-column. A percentage resolves against the content
 * box along its own axis, and against nothing at all while that size is still unknown.
 */
export function usedGap(value: Gap, basis: number | null): number {
  if (value.kind === 'normal') return 0;
  if (value.kind === 'percent' && basis === null) return 0;
  return usedLength(value, basis ?? 0);
}

export function usedInset(value: Inset, basis: number): number | null {
  return value.kind === 'auto' ? null : usedLength(value, basis);
}

/** Vertical padding is a percentage of the containing block's width, not its height. */
export function usedPadding(style: ComputedStyle, containingWidth: number): Edges {
  return {
    top: usedLength(style.paddingTop, containingWidth),
    right: usedLength(style.paddingRight, containingWidth),
    bottom: usedLength(style.paddingBottom, containingWidth),
    left: usedLength(style.paddingLeft, containingWidth),
  };
}

/**
 * `box-sizing: border-box` applies to min-width and max-width too, not only to width. A
 * `max-width: 1px` on a box with a 1px border either side leaves no content at all, and the
 * box comes out two pixels wide because a border cannot shrink.
 */
export function toContentBox(
  boxSizing: ComputedStyle['boxSizing'],
  value: number | null,
  surround: number,
): number | null {
  if (value === null || boxSizing !== 'border-box') return value;
  return Math.max(0, value - surround);
}

export function clampSize(value: number, min: number | null, max: number | null): number {
  const withMax = max === null ? value : Math.min(value, max);
  return min === null ? withMax : Math.max(withMax, min);
}
