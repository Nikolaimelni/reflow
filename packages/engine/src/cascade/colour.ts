import type { Token } from '../css/tokenize.js';

export type Colour = { r: number; g: number; b: number; a: number };

export const TRANSPARENT: Colour = { r: 0, g: 0, b: 0, a: 0 };
export const BLACK: Colour = { r: 0, g: 0, b: 0, a: 1 };

/**
 * A short list on purpose. The named colours run to a hundred and forty and none of them
 * teach anything about layout, so the ones here are the ones a test fixture actually reaches
 * for. Everything else goes through hex or `rgb()`.
 */
const NAMED: Record<string, Colour | undefined> = {
  transparent: TRANSPARENT,
  black: BLACK,
  white: { r: 255, g: 255, b: 255, a: 1 },
  red: { r: 255, g: 0, b: 0, a: 1 },
  green: { r: 0, g: 128, b: 0, a: 1 },
  blue: { r: 0, g: 0, b: 255, a: 1 },
  yellow: { r: 255, g: 255, b: 0, a: 1 },
  orange: { r: 255, g: 165, b: 0, a: 1 },
  purple: { r: 128, g: 0, b: 128, a: 1 },
  gray: { r: 128, g: 128, b: 128, a: 1 },
  grey: { r: 128, g: 128, b: 128, a: 1 },
  silver: { r: 192, g: 192, b: 192, a: 1 },
  teal: { r: 0, g: 128, b: 128, a: 1 },
  navy: { r: 0, g: 0, b: 128, a: 1 },
  maroon: { r: 128, g: 0, b: 0, a: 1 },
  olive: { r: 128, g: 128, b: 0, a: 1 },
  lime: { r: 0, g: 255, b: 0, a: 1 },
  aqua: { r: 0, g: 255, b: 255, a: 1 },
  cyan: { r: 0, g: 255, b: 255, a: 1 },
  fuchsia: { r: 255, g: 0, b: 255, a: 1 },
  magenta: { r: 255, g: 0, b: 255, a: 1 },
};

export function parseColour(value: readonly Token[]): Colour | null {
  const meaningful = value.filter((token) => token.type !== 'whitespace');
  const first = meaningful[0];
  if (first === undefined) return null;

  if (meaningful.length === 1 && first.type === 'ident') {
    // Own keys only, or `color: constructor` finds Object's and hands back a function.
    const name = first.value.toLowerCase();
    return Object.hasOwn(NAMED, name) ? (NAMED[name] ?? null) : null;
  }

  if (meaningful.length === 1 && first.type === 'hash') {
    return fromHex(first.value);
  }

  if (first.type === 'function') {
    const name = first.value.toLowerCase();
    if (name === 'rgb' || name === 'rgba') return fromRgb(meaningful.slice(1));
  }

  return null;
}

export function formatColour(colour: Colour): string {
  const channels = `${round(colour.r)}, ${round(colour.g)}, ${round(colour.b)}`;
  return colour.a >= 1 ? `rgb(${channels})` : `rgba(${channels}, ${serialiseAlpha(colour.a)})`;
}

/**
 * The shortest run of digits that lands back on the same eight bit alpha, which is what the
 * colour spec asks for and what a browser prints. `#1b3f5c80` is 128/255, or 0.50196, and it
 * comes back as 0.5 because 0.5 rounds to 128 as well.
 *
 * The digits come from the byte, not from what was written: `0.3%` is stored as 1/255 and
 * Chromium prints 0.004.
 */
function serialiseAlpha(alpha: number): string {
  const byte = Math.round(alpha * 255);
  const stored = byte / 255;

  for (const digits of [1, 2, 3]) {
    const candidate = stored.toFixed(digits);
    if (Math.round(Number.parseFloat(candidate) * 255) === byte) {
      return String(Number.parseFloat(candidate));
    }
  }

  return String(trim(stored));
}

/** For a canvas or a stylesheet, where the alpha always belongs in the string. */
export function toCss(colour: Colour): string {
  return `rgba(${round(colour.r)}, ${round(colour.g)}, ${round(colour.b)}, ${trim(colour.a)})`;
}

function fromHex(digits: string): Colour | null {
  const hex = digits.toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return null;

  const expand = (part: string) => Number.parseInt(part.length === 1 ? part + part : part, 16);

  if (hex.length === 3 || hex.length === 4) {
    return {
      r: expand(hex[0] ?? ''),
      g: expand(hex[1] ?? ''),
      b: expand(hex[2] ?? ''),
      a: hex.length === 4 ? expand(hex[3] ?? '') / 255 : 1,
    };
  }

  if (hex.length === 6 || hex.length === 8) {
    return {
      r: expand(hex.slice(0, 2)),
      g: expand(hex.slice(2, 4)),
      b: expand(hex.slice(4, 6)),
      a: hex.length === 8 ? expand(hex.slice(6, 8)) / 255 : 1,
    };
  }

  return null;
}

/** Both the comma form and the space form, and a percentage alpha after a slash. */
function fromRgb(tokens: readonly Token[]): Colour | null {
  const values: { value: number; percent: boolean }[] = [];

  for (const token of tokens) {
    if (token.type === 'number' || token.type === 'percentage') {
      values.push({ value: token.value, percent: token.type === 'percentage' });
    } else if (token.type === 'comma' || token.type === 'rparen') continue;
    else if (token.type === 'delim' && token.value === '/') continue;
    else return null;
  }

  const [r, g, b, a] = values;
  if (r === undefined || g === undefined || b === undefined || values.length > 4) return null;

  // A percentage is of 255 for a channel and of 1 for the alpha.
  const scaled = (part: { value: number; percent: boolean }, whole: number) =>
    clamp(part.percent ? (part.value / 100) * whole : part.value, whole);

  return {
    r: scaled(r, 255),
    g: scaled(g, 255),
    b: scaled(b, 255),
    a: a === undefined ? 1 : scaled(a, 1),
  };
}

function clamp(value: number, top: number): number {
  return Math.min(Math.max(0, value), top);
}

function round(value: number): number {
  return Math.round(value);
}

function trim(value: number): number {
  return Math.round(value * 1000) / 1000;
}
