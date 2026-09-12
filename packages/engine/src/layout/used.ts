import type { BorderStyle, ComputedStyle } from '../cascade/properties.js';
import type { Inset, LengthPercentage, Margin, MaxSize, Px, Size } from '../cascade/values.js';
import type { Edges } from '../geometry.js';

/**
 * A border with no style takes no space, whatever its width says. This is the first place
 * where a computed value and a used value part company, and it is the reason a fixture with
 * `border-width: 5px` and no `border-style` matches Chromium at zero rather than five.
 */
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

export function usedLength(value: LengthPercentage, basis: number): number {
  return value.kind === 'px' ? value.value : (value.value / 100) * basis;
}

/**
 * null means auto. A percentage against an unknown basis is also auto, which is the rule
 * that keeps `height: 50%` inside an auto-height parent from looping forever.
 */
export function usedSize(value: Size, basis: number | null): number | null {
  if (value.kind === 'auto') return null;
  if (value.kind === 'px') return value.value;
  return basis === null ? null : (value.value / 100) * basis;
}

export function usedMaxSize(value: MaxSize, basis: number | null): number | null {
  if (value.kind === 'none') return null;
  if (value.kind === 'px') return value.value;
  return basis === null ? null : (value.value / 100) * basis;
}

export function usedMargin(value: Margin, basis: number): number | null {
  return value.kind === 'auto' ? null : usedLength(value, basis);
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

export function clampSize(value: number, min: number | null, max: number | null): number {
  const withMax = max === null ? value : Math.min(value, max);
  return min === null ? withMax : Math.max(withMax, min);
}
