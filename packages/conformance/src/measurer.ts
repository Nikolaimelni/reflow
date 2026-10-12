import {
  type Box,
  type FontSpec,
  fontOf,
  segmentText,
  type TextMeasurer,
  walkBoxes,
} from '@reflow/engine';
import type { Measurements, MeasureRequest } from './extract.js';

export function fontString(font: FontSpec): string {
  const slant = font.style === 'normal' ? '' : `${font.style} `;
  return `${slant}${font.weight} ${font.size}px ${font.family.join(', ')}`;
}

// The engine only ever measures whole segments, so the harness can ask the engine's own
// segmentation what strings it will need and measure exactly those in the page.
export function measurementRequests(boxTree: Box): MeasureRequest[] {
  const byFont = new Map<string, Set<string>>();

  walkBoxes(boxTree, (box: Box) => {
    const font = fontString(fontOf(box.style));
    const texts = byFont.get(font) ?? new Set<string>();
    byFont.set(font, texts);

    if (box.kind !== 'text') return;
    for (const segment of segmentText(box.text, box.style.whiteSpace)) {
      if (segment.kind !== 'newline') texts.add(segment.text);
    }
  });

  return [...byFont].map(([font, texts]) => ({ font, texts: [...texts] }));
}

// Throws on a miss rather than guessing, so a gap in the table is loud.
export function tableMeasurer(measurements: Measurements): TextMeasurer {
  return {
    advance(text, font) {
      const key = `${fontString(font)} ${text}`;
      const width = measurements.widths[key];
      if (width === undefined) throw new Error(`nothing measured for ${JSON.stringify(key)}`);
      return width;
    },
    metrics(font) {
      const key = fontString(font);
      const metrics = measurements.metrics[key];
      if (metrics === undefined) throw new Error(`no metrics for ${JSON.stringify(key)}`);
      return metrics;
    },
  };
}
