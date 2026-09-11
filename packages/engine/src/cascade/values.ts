/**
 * Computed values, not used values. A percentage stays a percentage until layout knows the
 * containing block, so nothing here is allowed to be a bare pixel number except the cases
 * where the spec says the computed value is absolute.
 */

export type Px = { kind: 'px'; value: number };
export type Percent = { kind: 'percent'; value: number };
export type Auto = { kind: 'auto' };
export type None = { kind: 'none' };

export type LengthPercentage = Px | Percent;
export type Size = LengthPercentage | Auto;
export type MaxSize = LengthPercentage | None;
export type Margin = LengthPercentage | Auto;
export type Inset = LengthPercentage | Auto;

export type LineHeight = { kind: 'normal' } | { kind: 'number'; value: number } | LengthPercentage;

export type ZIndex = Auto | { kind: 'integer'; value: number };

export const AUTO: Auto = { kind: 'auto' };
export const NONE: None = { kind: 'none' };
export const ZERO: Px = { kind: 'px', value: 0 };
export const NORMAL_LINE_HEIGHT: LineHeight = { kind: 'normal' };

export function px(value: number): Px {
  return { kind: 'px', value };
}

export function percent(value: number): Percent {
  return { kind: 'percent', value };
}

export function isPx(value: { kind: string }): value is Px {
  return value.kind === 'px';
}

export function isPercent(value: { kind: string }): value is Percent {
  return value.kind === 'percent';
}
