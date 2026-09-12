import type { FontMetrics, FontSpec, TextMeasurer } from '@reflow/engine';

/**
 * The engine cannot measure text on its own, so this is the half that knows about browsers.
 *
 * Canvas gives advance widths, which agree with the DOM to about a hundredth of a pixel, and
 * font extents. What it does not give is the line box a font produces under
 * `line-height: normal`: that is taller than ascent plus descent by the font's line gap, so it
 * gets measured off a real line box once per font. Both answers are cached, because a layout
 * asks for the same word over and over.
 */
export function canvasMeasurer(): TextMeasurer {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('this browser has no 2d canvas context');

  const widths = new Map<string, number>();
  const metrics = new Map<string, FontMetrics>();

  return {
    advance(value, font) {
      const face = fontString(font);
      const key = `${face} ${value}`;
      const known = widths.get(key);
      if (known !== undefined) return known;

      context.font = face;
      const width = context.measureText(value).width;
      widths.set(key, width);
      return width;
    },

    metrics(font) {
      const face = fontString(font);
      const known = metrics.get(face);
      if (known !== undefined) return known;

      context.font = face;
      const sample = context.measureText('Hg');
      const measured: FontMetrics = {
        ascent: sample.fontBoundingBoxAscent,
        descent: sample.fontBoundingBoxDescent,
        lineHeight: normalLineHeight(face),
      };

      metrics.set(face, measured);
      return measured;
    },
  };
}

/** The canvas font shorthand, which is the CSS one: style, weight, size, family. */
export function fontString(font: FontSpec): string {
  const slant = font.style === 'normal' ? '' : `${font.style} `;
  return `${slant}${font.weight} ${font.size}px ${font.family.join(', ')}`;
}

function normalLineHeight(face: string): number {
  const host = document.createElement('div');
  // `all: initial` first, or the app's own stylesheet decides the answer instead of the font.
  host.style.cssText = `all:initial;display:block;position:absolute;top:-9999px;left:0;white-space:nowrap;font:${face}`;
  host.textContent = 'x';

  document.body.append(host);
  const height = host.getBoundingClientRect().height;
  host.remove();

  return height;
}
