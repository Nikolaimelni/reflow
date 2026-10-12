import type { FontMetrics, FontSpec, TextMeasurer } from '@reflow/engine';

// Advance widths come from canvas. Font extents do not: canvas rounds them to whole pixels while
// the browser snaps them to device pixels, so they are measured off a real line instead.
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
      // The probe's answer is snapped to device pixels, so it goes stale when the window moves
      // to another screen or the page is zoomed.
      const face = fontString(font);
      const key = `${window.devicePixelRatio} ${face}`;
      const known = metrics.get(key);
      if (known !== undefined) return known;

      const measured = probe(face);
      metrics.set(key, measured);
      return measured;
    },
  };
}

export function fontString(font: FontSpec): string {
  const slant = font.style === 'normal' ? '' : `${font.style} `;
  return `${slant}${font.weight} ${font.size}px ${font.family.join(', ')}`;
}

function probe(face: string): FontMetrics {
  const host = document.createElement('div');
  // `all: initial` first, or the app's own stylesheet decides the answer instead of the font.
  host.style.cssText = `all:initial;display:block;position:absolute;top:-9999px;left:0;white-space:nowrap;font:${face}`;

  // A box with no height at all sits on the baseline, and the glyphs beside it stand on the
  // same line, so one line answers all three questions.
  const onBaseline = document.createElement('span');
  onBaseline.style.cssText = 'display:inline-block;width:0;height:0';
  const glyphs = document.createElement('span');
  glyphs.textContent = 'Hg';

  host.append(onBaseline, glyphs);
  document.body.append(host);

  const line = host.getBoundingClientRect();
  const baseline = onBaseline.getBoundingClientRect().bottom;
  const extents = glyphs.getBoundingClientRect();
  host.remove();

  const ascent = baseline - extents.top;
  return { ascent, descent: extents.height - ascent, lineHeight: line.height };
}
