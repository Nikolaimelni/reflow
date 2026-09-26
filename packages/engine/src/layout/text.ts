import type { ComputedStyle, FontStyle, WhiteSpace } from '../cascade/properties.js';

export type FontSpec = {
  size: number;
  family: readonly string[];
  weight: number;
  style: FontStyle;
};

export type FontMetrics = {
  /** Font extents. An inline box is exactly this tall, whatever the line-height says. */
  ascent: number;
  descent: number;
  /**
   * What `line-height: normal` works out to. Not the same as ascent plus descent: a font
   * carries a line gap on top, and Chromium reports a 40px Times line box as 47 while the
   * inline box inside it measures 45.
   */
  lineHeight: number;
};

/**
 * The engine cannot measure text on its own, and writing a shaper is a different project.
 * The host passes one of these in: the app backs it with `canvas.measureText`, the unit
 * tests back it with fixed numbers so they stay deterministic.
 */
export type TextMeasurer = {
  advance(text: string, font: FontSpec): number;
  metrics(font: FontSpec): FontMetrics;
};

export function fontOf(style: ComputedStyle): FontSpec {
  return {
    size: style.fontSize,
    family: style.fontFamily,
    weight: style.fontWeight,
    style: style.fontStyle,
  };
}

export type Segment =
  | { kind: 'word'; text: string }
  | { kind: 'space'; text: string }
  | { kind: 'newline' };

const SPACE = /[ \t\n\r\f]/;

/**
 * Splits a text run into the pieces a line can be built from. Under `white-space: normal` a
 * run of spaces, tabs and newlines becomes one space, which is why source indentation does
 * not show up on the page. Under `pre` everything survives and newlines break the line.
 */
export function segmentText(text: string, whiteSpace: WhiteSpace): Segment[] {
  const segments: Segment[] = [];
  const collapse = whiteSpace !== 'pre';
  let i = 0;

  while (i < text.length) {
    const character = text.charAt(i);

    if (!SPACE.test(character)) {
      const start = i;
      while (i < text.length && !SPACE.test(text.charAt(i))) i++;
      segments.push({ kind: 'word', text: text.slice(start, i) });
      continue;
    }

    if (collapse) {
      while (i < text.length && SPACE.test(text.charAt(i))) i++;
      segments.push({ kind: 'space', text: ' ' });
      continue;
    }

    if (character === '\n') {
      segments.push({ kind: 'newline' });
      i++;
      continue;
    }

    const start = i;
    while (i < text.length && SPACE.test(text.charAt(i)) && text.charAt(i) !== '\n') i++;
    segments.push({ kind: 'space', text: text.slice(start, i) });
  }

  return segments;
}

/**
 * How far a disc, circle or square inside a list item pushes the text after it. Blink does not
 * measure a glyph for these: it sizes the symbol from the font's ascent, rounded to a whole
 * pixel, and gives it a margin of a pixel less than nothing in front and an em behind.
 */
export function symbolMarkerAdvance(metrics: FontMetrics, fontSize: number): number {
  const ascent = Math.round(metrics.ascent);
  const symbol = Math.floor((Math.floor((ascent * 2) / 3) + 1) / 2) + 2;
  return symbol - 1 + fontSize;
}

export function usedLineHeight(style: ComputedStyle, metrics: FontMetrics): number {
  switch (style.lineHeight.kind) {
    case 'normal':
      return metrics.lineHeight;
    case 'number':
      return style.lineHeight.value * style.fontSize;
    case 'px':
      return style.lineHeight.value;
    case 'percent':
      return (style.lineHeight.value / 100) * style.fontSize;
  }
}

export function wraps(whiteSpace: WhiteSpace): boolean {
  return whiteSpace === 'normal';
}

/**
 * A measurer with made-up but stable numbers, for tests and for anything running where no
 * canvas exists. Every character is the same width, which is wrong and predictable.
 */
export function fixedAdvanceMeasurer(
  options: { advance?: number; ascent?: number; descent?: number } = {},
): TextMeasurer {
  const advance = options.advance ?? 0.5;
  const ascent = options.ascent ?? 0.8;
  const descent = options.descent ?? 0.2;

  return {
    advance: (text, font) => text.length * advance * font.size,
    metrics: (font) => ({
      ascent: ascent * font.size,
      descent: descent * font.size,
      lineHeight: (ascent + descent) * font.size,
    }),
  };
}
