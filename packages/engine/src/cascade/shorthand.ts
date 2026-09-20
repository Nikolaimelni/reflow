import type { Token } from '../css/tokenize.js';
import type { PropertyName } from './properties.js';

export type Longhand = { property: PropertyName; value: Token[] };

const MARGIN = ['marginTop', 'marginRight', 'marginBottom', 'marginLeft'] as const;
const PADDING = ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'] as const;
const BORDER_WIDTH = [
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
] as const;
const BORDER_STYLE = [
  'borderTopStyle',
  'borderRightStyle',
  'borderBottomStyle',
  'borderLeftStyle',
] as const;
const INSET = ['top', 'right', 'bottom', 'left'] as const;

const STYLE_KEYWORDS = ['none', 'solid', 'dashed', 'dotted'];
const WIDTH_KEYWORDS = ['thin', 'medium', 'thick'];

export function expandShorthand(cssName: string, value: readonly Token[]): Longhand[] | null {
  switch (cssName) {
    case 'margin':
      return perSide(MARGIN, value);
    case 'padding':
      return perSide(PADDING, value);
    case 'border-width':
      return perSide(BORDER_WIDTH, value);
    case 'border-style':
      return perSide(BORDER_STYLE, value);
    case 'inset':
      return perSide(INSET, value);
    case 'flex':
      return flex(value);
    case 'gap':
      return gap(value);
    case 'border':
      return border(BORDER_WIDTH, BORDER_STYLE, value);
    case 'border-top':
      return border(['borderTopWidth'], ['borderTopStyle'], value);
    case 'border-right':
      return border(['borderRightWidth'], ['borderRightStyle'], value);
    case 'border-bottom':
      return border(['borderBottomWidth'], ['borderBottomStyle'], value);
    case 'border-left':
      return border(['borderLeftWidth'], ['borderLeftStyle'], value);
    default:
      return null;
  }
}

function words(value: readonly Token[]): Token[][] {
  const out: Token[][] = [];
  let current: Token[] = [];

  for (const token of value) {
    if (token.type === 'whitespace' || token.type === 'eof') {
      if (current.length > 0) out.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }

  if (current.length > 0) out.push(current);
  return out;
}

function perSide(names: readonly PropertyName[], value: readonly Token[]): Longhand[] | null {
  const parts = words(value);
  const [a, b, c, d] = parts;

  if (a === undefined || parts.length > 4) return null;

  const box =
    b === undefined
      ? [a, a, a, a]
      : c === undefined
        ? [a, b, a, b]
        : d === undefined
          ? [a, b, c, b]
          : [a, b, c, d];

  return names.map((property, index) => ({ property, value: box[index] ?? [] }));
}

const ZERO_TOKEN: Token = { type: 'number', value: 0 };
const ONE_TOKEN: Token = { type: 'number', value: 1 };
const AUTO_TOKEN: Token = { type: 'ident', value: 'auto' };

/**
 * `flex: 1` means `1 1 0`, not `1 1 auto`. That difference is why a one-word `flex` makes
 * items share the space evenly while `flex: auto` lets their content matter.
 */
function flex(value: readonly Token[]): Longhand[] | null {
  const parts = words(value);
  const first = parts[0]?.[0];

  if (parts.length === 1 && first?.type === 'ident') {
    switch (first.value.toLowerCase()) {
      case 'none':
        return factors(ZERO_TOKEN, ZERO_TOKEN, AUTO_TOKEN);
      case 'auto':
        return factors(ONE_TOKEN, ONE_TOKEN, AUTO_TOKEN);
      case 'initial':
        return factors(ZERO_TOKEN, ONE_TOKEN, AUTO_TOKEN);
      default:
        return null;
    }
  }

  let grow: Token | null = null;
  let shrink: Token | null = null;
  let basis: Token | null = null;

  for (const part of parts) {
    const token = part[0];
    if (part.length !== 1 || token === undefined) return null;

    if (token.type === 'number' && basis === null) {
      if (grow === null) grow = token;
      else if (shrink === null) shrink = token;
      else return null;
      continue;
    }

    if (basis !== null) return null;
    basis = token;
  }

  if (grow === null) return null;
  return factors(grow, shrink ?? ONE_TOKEN, basis ?? ZERO_TOKEN);
}

/** One word sets both gaps, two set the row gap first. */
function gap(value: readonly Token[]): Longhand[] | null {
  const parts = words(value);
  const [row, column] = parts;

  if (row === undefined || parts.length > 2) return null;
  return [
    { property: 'rowGap', value: row },
    { property: 'columnGap', value: column ?? row },
  ];
}

function factors(grow: Token, shrink: Token, basis: Token): Longhand[] {
  return [
    { property: 'flexGrow', value: [grow] },
    { property: 'flexShrink', value: [shrink] },
    { property: 'flexBasis', value: [basis] },
  ];
}

function border(
  widthNames: readonly PropertyName[],
  styleNames: readonly PropertyName[],
  value: readonly Token[],
): Longhand[] | null {
  let width: Token[] = [{ type: 'ident', value: 'medium' }];
  let style: Token[] = [{ type: 'ident', value: 'none' }];

  for (const word of words(value)) {
    const token = word[0];
    if (word.length !== 1 || token === undefined) return null;

    if (token.type === 'ident' && STYLE_KEYWORDS.includes(token.value.toLowerCase())) {
      style = word;
    } else if (
      token.type === 'dimension' ||
      (token.type === 'number' && token.value === 0) ||
      (token.type === 'ident' && WIDTH_KEYWORDS.includes(token.value.toLowerCase()))
    ) {
      width = word;
    }
    // Anything else is the colour, which does not reach layout.
  }

  return [
    ...widthNames.map((property) => ({ property, value: width })),
    ...styleNames.map((property) => ({ property, value: style })),
  ];
}
