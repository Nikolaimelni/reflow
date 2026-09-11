import type { BorderStyle, ComputedStyle } from '../cascade/properties.js';
import type { Px } from '../cascade/values.js';
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
