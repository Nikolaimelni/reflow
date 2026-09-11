import { describe, expect, it } from 'vitest';
import { computeStyles } from '../cascade/cascade.js';
import { type ElementNode, element } from '../dom/node.js';
import { usedBorderWidths } from './used.js';

function styleOf(css: string, node: ElementNode = element('div')) {
  const style = computeStyles(node, css).get(node);
  if (style === undefined) throw new Error('node was never styled');
  return style;
}

describe('usedBorderWidths', () => {
  it('is zero on a side with no border style, whatever the width says', () => {
    expect(usedBorderWidths(styleOf('div { border-width: 5px }'))).toEqual({
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
    });
  });

  it('follows the width once a style is set', () => {
    expect(usedBorderWidths(styleOf('div { border: 4px dashed }')).top).toBe(4);
  });

  it('works per side', () => {
    const css = 'div { border: 2px solid; border-left-style: none }';
    expect(usedBorderWidths(styleOf(css))).toEqual({ top: 2, right: 2, bottom: 2, left: 0 });
  });
});
