import type { Token } from '../css/tokenize.js';
import { BLACK, type Colour, parseColour, TRANSPARENT } from './colour.js';
import {
  AUTO,
  type Gap,
  type Inset,
  type LengthPercentage,
  type LineHeight,
  type Margin,
  type MaxSize,
  NONE,
  NORMAL_GAP,
  NORMAL_LINE_HEIGHT,
  type Px,
  percent,
  px,
  type Size,
  ZERO,
  type ZIndex,
} from './values.js';

export type Display = 'block' | 'inline' | 'inline-block' | 'flex' | 'list-item' | 'none';
export type Position = 'static' | 'relative' | 'absolute';
export type BoxSizing = 'content-box' | 'border-box';
export type Overflow = 'visible' | 'hidden';
export type BorderStyle = 'none' | 'solid' | 'dashed' | 'dotted';
export type TextAlign = 'left' | 'right' | 'center';
export type WhiteSpace = 'normal' | 'pre' | 'nowrap';
export type FontStyle = 'normal' | 'italic' | 'oblique';
export type FlexDirection = 'row' | 'row-reverse' | 'column' | 'column-reverse';
export type FlexWrap = 'nowrap' | 'wrap' | 'wrap-reverse';
export type JustifyContent =
  | 'normal'
  | 'flex-start'
  | 'flex-end'
  | 'center'
  | 'space-between'
  | 'space-around'
  | 'space-evenly';
export type AlignItems = 'normal' | 'stretch' | 'flex-start' | 'flex-end' | 'center' | 'baseline';
export type AlignContent = JustifyContent | 'stretch';
export type AlignSelf = 'auto' | AlignItems;
export type Visibility = 'visible' | 'hidden';
export type ListStyleType = 'disc' | 'circle' | 'square' | 'decimal' | 'none';
export type ListStylePosition = 'outside' | 'inside';

export type ComputedStyle = {
  display: Display;
  /**
   * What `display` would be if the box were in the flow. An out of flow box is blockified,
   * and its static position is measured from where the box it used to be would have gone, so
   * the one it used to be has to survive somewhere.
   */
  staticDisplay: Display;
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
  fontFamily: string[];
  fontWeight: number;
  fontStyle: FontStyle;
  lineHeight: LineHeight;
  textAlign: TextAlign;
  whiteSpace: WhiteSpace;

  zIndex: ZIndex;

  listStyleType: ListStyleType;
  listStylePosition: ListStylePosition;

  flexDirection: FlexDirection;
  flexWrap: FlexWrap;
  justifyContent: JustifyContent;
  alignItems: AlignItems;
  alignSelf: AlignSelf;
  alignContent: AlignContent;
  flexGrow: number;
  flexShrink: number;
  flexBasis: Size;
  order: number;
  rowGap: Gap;
  columnGap: Gap;

  /** None of these four reach layout, which is the point of having them. */
  color: Colour;
  backgroundColor: Colour;
  visibility: Visibility;
  opacity: number;
};

export type PropertyName = Exclude<keyof ComputedStyle, 'staticDisplay'>;

export type ComputeContext = {
  /** Font size of the element itself, or of the parent while font-size is being computed. */
  fontSize: number;
  rootFontSize: number;
  devicePixelRatio: number;
};

/**
 * A browser rounds a border down to whole device pixels, and never down to nothing. On a
 * 1.25 display a 2px border is used as 1.6px and a 1px border as 0.8px, which is why a
 * bordered box measures shorter there than the arithmetic says. It shows up in
 * `getComputedStyle`, so this is a used value decision rather than a painting one.
 */
export function snapToDevicePixels(width: number, devicePixelRatio: number): number {
  if (width <= 0) return 0;
  return Math.max(1, Math.floor(width * devicePixelRatio)) / devicePixelRatio;
}

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
  const snap = (width: number) => px(snapToDevicePixels(width, context.devicePixelRatio));

  const named = keyword('thin', 'medium', 'thick')(value);
  if (named === 'thin') return snap(1);
  if (named === 'medium') return snap(3);
  if (named === 'thick') return snap(5);

  const length = nonNegative(lengthPercentage(value, context));
  return length !== null && length.kind === 'px' ? snap(length.value) : null;
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

/** `Times New Roman` arrives as three idents, and quoted names as one string token. */
const fontFamily: PropertyDefinition<string[]>['parse'] = (value) => {
  const families: string[] = [];
  let current: string[] = [];

  for (const token of value) {
    if (token.type === 'comma') {
      if (current.length > 0) families.push(current.join(' '));
      current = [];
    } else if (token.type === 'string' || token.type === 'ident') {
      current.push(token.value);
    } else if (token.type !== 'whitespace') {
      return null;
    }
  }

  if (current.length > 0) families.push(current.join(' '));
  return families.length === 0 ? null : families;
};

const fontWeight: PropertyDefinition<number>['parse'] = (value) => {
  const named = keyword('normal', 'bold')(value);
  if (named === 'normal') return 400;
  if (named === 'bold') return 700;

  const token = single(value);
  if (token?.type !== 'number') return null;
  return token.value >= 1 && token.value <= 1000 ? token.value : null;
};

const opacity: PropertyDefinition<number>['parse'] = (value) => {
  const token = single(value);
  if (token?.type === 'percentage') return Math.min(Math.max(0, token.value / 100), 1);
  if (token?.type !== 'number') return null;
  return Math.min(Math.max(0, token.value), 1);
};

const flexFactor: PropertyDefinition<number>['parse'] = (value) => {
  const token = single(value);
  if (token?.type !== 'number') return null;
  return token.value < 0 ? null : token.value;
};

function integer(value: readonly Token[]): number | null {
  const token = single(value);
  if (token?.type !== 'number' || !Number.isInteger(token.value)) return null;
  return token.value;
}

const zIndex: PropertyDefinition<ZIndex>['parse'] = (value) => {
  if (keyword('auto')(value) === 'auto') return AUTO;
  const depth = integer(value);
  return depth === null ? null : { kind: 'integer', value: depth };
};

const gap: PropertyDefinition<Gap>['parse'] = (value, context) =>
  keyword('normal')(value) === 'normal'
    ? NORMAL_GAP
    : nonNegative(lengthPercentage(value, context));

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
    parse: keyword('block', 'inline', 'inline-block', 'flex', 'list-item', 'none'),
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
  fontFamily: {
    cssName: 'font-family',
    initial: ['serif'],
    inherited: true,
    parse: fontFamily,
  },
  fontWeight: { cssName: 'font-weight', initial: 400, inherited: true, parse: fontWeight },
  fontStyle: {
    cssName: 'font-style',
    initial: 'normal',
    inherited: true,
    parse: keyword('normal', 'italic', 'oblique'),
  },
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

  listStyleType: {
    cssName: 'list-style-type',
    initial: 'disc',
    inherited: true,
    parse: keyword('disc', 'circle', 'square', 'decimal', 'none'),
  },
  listStylePosition: {
    cssName: 'list-style-position',
    initial: 'outside',
    inherited: true,
    parse: keyword('outside', 'inside'),
  },

  flexDirection: own(
    'flex-direction',
    'row',
    keyword('row', 'row-reverse', 'column', 'column-reverse'),
  ),
  flexWrap: own('flex-wrap', 'nowrap', keyword('nowrap', 'wrap', 'wrap-reverse')),
  // The initial value is `normal`, which in a flex container behaves as `flex-start`, and the
  // same for `align-items` against `stretch`. Chromium reports the new names, so these do too.
  justifyContent: own(
    'justify-content',
    'normal',
    keyword(
      'normal',
      'flex-start',
      'flex-end',
      'center',
      'space-between',
      'space-around',
      'space-evenly',
    ),
  ),
  alignItems: own(
    'align-items',
    'normal',
    keyword('normal', 'stretch', 'flex-start', 'flex-end', 'center', 'baseline'),
  ),
  alignSelf: own(
    'align-self',
    'auto',
    keyword('auto', 'normal', 'stretch', 'flex-start', 'flex-end', 'center', 'baseline'),
  ),
  alignContent: own(
    'align-content',
    'normal',
    keyword(
      'normal',
      'stretch',
      'flex-start',
      'flex-end',
      'center',
      'space-between',
      'space-around',
      'space-evenly',
    ),
  ),
  flexGrow: own('flex-grow', 0, flexFactor),
  flexShrink: own('flex-shrink', 1, flexFactor),
  flexBasis: own('flex-basis', AUTO, size),
  order: own('order', 0, integer),
  rowGap: own('row-gap', NORMAL_GAP, gap),
  columnGap: own('column-gap', NORMAL_GAP, gap),

  color: { cssName: 'color', initial: BLACK, inherited: true, parse: parseColour },
  backgroundColor: own('background-color', TRANSPARENT, parseColour),
  visibility: {
    cssName: 'visibility',
    initial: 'visible',
    inherited: true,
    parse: keyword('visible', 'hidden'),
  },
  opacity: own('opacity', 1, opacity),
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

export function cssNameOf(property: PropertyName): string {
  return properties[property].cssName;
}

export const propertyNames = Object.keys(properties) as PropertyName[];

// why: same widening as above. Writing this object out by hand would be thirty lines that
// drift from the table.
export const initialStyle: ComputedStyle = {
  ...(Object.fromEntries(
    Object.entries(properties).map(([name, definition]) => [name, definition.initial]),
  ) as Omit<ComputedStyle, 'staticDisplay'>),
  staticDisplay: 'inline',
};
