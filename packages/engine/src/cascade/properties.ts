import type { Token } from '../css/tokenize.js';
import {
  AUTO,
  type Inset,
  type LengthPercentage,
  type LineHeight,
  type Margin,
  type MaxSize,
  NONE,
  NORMAL_LINE_HEIGHT,
  type Px,
  percent,
  px,
  type Size,
  ZERO,
  type ZIndex,
} from './values.js';

export type Display = 'block' | 'inline' | 'inline-block' | 'flex' | 'none';
export type Position = 'static' | 'relative' | 'absolute';
export type BoxSizing = 'content-box' | 'border-box';
export type Overflow = 'visible' | 'hidden';
export type BorderStyle = 'none' | 'solid' | 'dashed' | 'dotted';
export type TextAlign = 'left' | 'right' | 'center';
export type WhiteSpace = 'normal' | 'pre' | 'nowrap';

export type ComputedStyle = {
  display: Display;
  position: Position;
  boxSizing: BoxSizing;
  overflow: Overflow;

  width: Size;
  height: Size;
  minWidth: Size;
  minHeight: Size;
  maxWidth: MaxSize;
  maxHeight: MaxSize;

  marginTop: Margin;
  marginRight: Margin;
  marginBottom: Margin;
  marginLeft: Margin;

  paddingTop: LengthPercentage;
  paddingRight: LengthPercentage;
  paddingBottom: LengthPercentage;
  paddingLeft: LengthPercentage;

  borderTopWidth: Px;
  borderRightWidth: Px;
  borderBottomWidth: Px;
  borderLeftWidth: Px;

  borderTopStyle: BorderStyle;
  borderRightStyle: BorderStyle;
  borderBottomStyle: BorderStyle;
  borderLeftStyle: BorderStyle;

  top: Inset;
  right: Inset;
  bottom: Inset;
  left: Inset;

  fontSize: number;
  lineHeight: LineHeight;
  textAlign: TextAlign;
  whiteSpace: WhiteSpace;

  zIndex: ZIndex;
};

export type PropertyName = keyof ComputedStyle;

export type ComputeContext = {
  /** Font size of the element itself, or of the parent while font-size is being computed. */
  fontSize: number;
  rootFontSize: number;
};

export type PropertyDefinition<T> = {
  cssName: string;
  initial: T;
  inherited: boolean;
  parse: (value: readonly Token[], context: ComputeContext) => T | null;
};

function single(value: readonly Token[]): Token | null {
  const meaningful = value.filter((token) => token.type !== 'whitespace');
  return meaningful.length === 1 ? (meaningful[0] ?? null) : null;
}

function keyword<T extends string>(...allowed: readonly T[]) {
  return (value: readonly Token[]): T | null => {
    const token = single(value);
    if (token?.type !== 'ident') return null;
    const name = token.value.toLowerCase();
    return allowed.find((candidate) => candidate === name) ?? null;
  };
}

function lengthPercentage(
  value: readonly Token[],
  context: ComputeContext,
): LengthPercentage | null {
  const token = single(value);
  if (token === null) return null;

  if (token.type === 'percentage') return percent(token.value);
  if (token.type === 'number' && token.value === 0) return ZERO;
  if (token.type !== 'dimension') return null;

  switch (token.unit) {
    case 'px':
      return px(token.value);
    case 'em':
      return px(token.value * context.fontSize);
    case 'rem':
      return px(token.value * context.rootFontSize);
    default:
      return null;
  }
}

function nonNegative(value: LengthPercentage | null): LengthPercentage | null {
  return value === null || value.value < 0 ? null : value;
}

function withAuto<T>(
  parse: (value: readonly Token[], context: ComputeContext) => T | null,
): (value: readonly Token[], context: ComputeContext) => T | typeof AUTO | null {
  return (value, context) => (keyword('auto')(value) === 'auto' ? AUTO : parse(value, context));
}

const size: PropertyDefinition<Size>['parse'] = withAuto((value, context) =>
  nonNegative(lengthPercentage(value, context)),
);

const margin: PropertyDefinition<Margin>['parse'] = withAuto(lengthPercentage);

const inset: PropertyDefinition<Inset>['parse'] = withAuto(lengthPercentage);

const padding: PropertyDefinition<LengthPercentage>['parse'] = (value, context) =>
  nonNegative(lengthPercentage(value, context));

const maxSize: PropertyDefinition<MaxSize>['parse'] = (value, context) =>
  keyword('none')(value) === 'none' ? NONE : nonNegative(lengthPercentage(value, context));

/** `thin`, `medium` and `thick` are the only keywords, and browsers agree on these pixels. */
const borderWidth: PropertyDefinition<Px>['parse'] = (value, context) => {
  const named = keyword('thin', 'medium', 'thick')(value);
  if (named === 'thin') return px(1);
  if (named === 'medium') return px(3);
  if (named === 'thick') return px(5);
  const length = nonNegative(lengthPercentage(value, context));
  return length !== null && length.kind === 'px' ? length : null;
};

const borderStyle = keyword('none', 'solid', 'dashed', 'dotted');

const fontSize: PropertyDefinition<number>['parse'] = (value, context) => {
  const length = lengthPercentage(value, context);
  if (length === null || length.value < 0) return null;
  return length.kind === 'percent' ? (length.value / 100) * context.fontSize : length.value;
};

const lineHeight: PropertyDefinition<LineHeight>['parse'] = (value, context) => {
  if (keyword('normal')(value) === 'normal') return { kind: 'normal' };
  const token = single(value);
  if (token?.type === 'number') {
    return token.value < 0 ? null : { kind: 'number', value: token.value };
  }
  return nonNegative(lengthPercentage(value, context));
};

const zIndex: PropertyDefinition<ZIndex>['parse'] = (value) => {
  if (keyword('auto')(value) === 'auto') return AUTO;
  const token = single(value);
  if (token?.type !== 'number' || !Number.isInteger(token.value)) return null;
  return { kind: 'integer', value: token.value };
};

function own<T>(
  cssName: string,
  initial: T,
  parse: PropertyDefinition<T>['parse'],
): PropertyDefinition<T> {
  return { cssName, initial, inherited: false, parse };
}

type PropertyTable = { [K in PropertyName]: PropertyDefinition<ComputedStyle[K]> };

export const properties: PropertyTable = {
  display: {
    cssName: 'display',
    initial: 'inline',
    inherited: false,
    parse: keyword('block', 'inline', 'inline-block', 'flex', 'none'),
  },
  position: {
    cssName: 'position',
    initial: 'static',
    inherited: false,
    parse: keyword('static', 'relative', 'absolute'),
  },
  boxSizing: {
    cssName: 'box-sizing',
    initial: 'content-box',
    inherited: false,
    parse: keyword('content-box', 'border-box'),
  },
  overflow: {
    cssName: 'overflow',
    initial: 'visible',
    inherited: false,
    parse: keyword('visible', 'hidden'),
  },

  width: own('width', AUTO, size),
  height: own('height', AUTO, size),
  minWidth: own('min-width', AUTO, size),
  minHeight: own('min-height', AUTO, size),
  maxWidth: own('max-width', NONE, maxSize),
  maxHeight: own('max-height', NONE, maxSize),

  marginTop: own('margin-top', ZERO, margin),
  marginRight: own('margin-right', ZERO, margin),
  marginBottom: own('margin-bottom', ZERO, margin),
  marginLeft: own('margin-left', ZERO, margin),

  paddingTop: own('padding-top', ZERO, padding),
  paddingRight: own('padding-right', ZERO, padding),
  paddingBottom: own('padding-bottom', ZERO, padding),
  paddingLeft: own('padding-left', ZERO, padding),

  borderTopWidth: own('border-top-width', px(3), borderWidth),
  borderRightWidth: own('border-right-width', px(3), borderWidth),
  borderBottomWidth: own('border-bottom-width', px(3), borderWidth),
  borderLeftWidth: own('border-left-width', px(3), borderWidth),

  borderTopStyle: own('border-top-style', 'none', borderStyle),
  borderRightStyle: own('border-right-style', 'none', borderStyle),
  borderBottomStyle: own('border-bottom-style', 'none', borderStyle),
  borderLeftStyle: own('border-left-style', 'none', borderStyle),

  top: own('top', AUTO, inset),
  right: own('right', AUTO, inset),
  bottom: own('bottom', AUTO, inset),
  left: own('left', AUTO, inset),

  fontSize: { cssName: 'font-size', initial: 16, inherited: true, parse: fontSize },
  lineHeight: {
    cssName: 'line-height',
    initial: NORMAL_LINE_HEIGHT,
    inherited: true,
    parse: lineHeight,
  },
  textAlign: {
    cssName: 'text-align',
    initial: 'left',
    inherited: true,
    parse: keyword('left', 'right', 'center'),
  },
  whiteSpace: {
    cssName: 'white-space',
    initial: 'normal',
    inherited: true,
    parse: keyword('normal', 'pre', 'nowrap'),
  },

  zIndex: own('z-index', AUTO, zIndex),
};

// why: Object.entries and Object.keys widen the key to string. The table above is annotated
// with the mapped type, so the keys really are PropertyName.
const byCssName = new Map<string, PropertyName>(
  Object.entries(properties).map(([name, definition]) => [
    definition.cssName,
    name as PropertyName,
  ]),
);

export function propertyByCssName(cssName: string): PropertyName | undefined {
  return byCssName.get(cssName);
}

export const propertyNames = Object.keys(properties) as PropertyName[];

// why: same widening as above. Writing this object out by hand would be thirty lines that
// drift from the table.
export const initialStyle: ComputedStyle = Object.fromEntries(
  Object.entries(properties).map(([name, definition]) => [name, definition.initial]),
) as ComputedStyle;
