import {
  type ComputedStyle,
  type ElementNode,
  element,
  type Margin,
  usedBorderWidths,
} from '@reflow/engine';
import type { ExtractedElement } from './extract.js';

export type Comparison = {
  property: string;
  ours: string;
  theirs: string;
  ok: boolean;
};

type Formatter = (style: ComputedStyle) => string | null;

const SIDES = ['top', 'right', 'bottom', 'left'] as const;

/**
 * Only properties whose computed value the browser reports back unchanged. Width, height and
 * anything else that `getComputedStyle` resolves against a real box belongs to the geometry
 * harness, not here: comparing a percentage against a used pixel value is a guaranteed miss.
 *
 * `font-family` is left out on purpose. Its initial value is whatever the user picked in the
 * browser's settings, so there is nothing to agree on. Fixtures declare a family instead.
 */
const FORMATTERS: Record<string, Formatter> = {
  display: (style) => style.display,
  position: (style) => style.position,
  'box-sizing': (style) => style.boxSizing,
  'overflow-x': (style) => style.overflow,
  'text-align': (style) => style.textAlign,
  'white-space': (style) => style.whiteSpace,
  'font-size': (style) => `${round(style.fontSize)}px`,
  'font-weight': (style) => String(style.fontWeight),
  'font-style': (style) => style.fontStyle,
  'line-height': (style) => lineHeight(style),
  'z-index': (style) => (style.zIndex.kind === 'auto' ? 'auto' : String(style.zIndex.value)),
};

const MARGIN = {
  top: 'marginTop',
  right: 'marginRight',
  bottom: 'marginBottom',
  left: 'marginLeft',
} as const;

const PADDING = {
  top: 'paddingTop',
  right: 'paddingRight',
  bottom: 'paddingBottom',
  left: 'paddingLeft',
} as const;

const BORDER_STYLE = {
  top: 'borderTopStyle',
  right: 'borderRightStyle',
  bottom: 'borderBottomStyle',
  left: 'borderLeftStyle',
} as const;

for (const side of SIDES) {
  FORMATTERS[`margin-${side}`] = (style) => pixelsOnly(style[MARGIN[side]]);
  FORMATTERS[`padding-${side}`] = (style) => pixelsOnly(style[PADDING[side]]);
  FORMATTERS[`border-${side}-width`] = (style) => `${round(usedBorderWidths(style)[side])}px`;
  FORMATTERS[`border-${side}-style`] = (style) => style[BORDER_STYLE[side]];
}

export const COMPARED_PROPERTIES = Object.keys(FORMATTERS);

export function buildTree(elements: readonly ExtractedElement[]): ElementNode[] {
  const nodes = elements.map((extracted) =>
    element(extracted.tag, {
      ...(extracted.id === null ? {} : { id: extracted.id }),
      classes: extracted.classes,
      attributes: extracted.attributes,
    }),
  );

  elements.forEach((extracted, index) => {
    if (extracted.parent === null) return;
    const node = nodes[index];
    const parent = nodes[extracted.parent];
    if (node === undefined || parent === undefined) return;
    node.parent = parent;
    parent.children.push(node);
  });

  return nodes;
}

export function compareElement(
  style: ComputedStyle,
  reported: Record<string, string>,
): Comparison[] {
  const comparisons: Comparison[] = [];

  for (const [property, format] of Object.entries(FORMATTERS)) {
    const ours = format(style);
    const theirs = normalise(property, reported[property] ?? '');
    if (ours === null || theirs === '') continue;

    comparisons.push({ property, ours, theirs, ok: same(ours, theirs) });
  }

  return comparisons;
}

/** Chromium reports the initial `text-align` as `start`, which for this subset means left. */
function normalise(property: string, value: string): string {
  if (property !== 'text-align') return value;
  if (value === 'start') return 'left';
  if (value === 'end') return 'right';
  return value;
}

function same(ours: string, theirs: string): boolean {
  if (ours === theirs) return true;

  const a = Number.parseFloat(ours);
  const b = Number.parseFloat(theirs);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  return Math.abs(a - b) < 0.02;
}

function lineHeight(style: ComputedStyle): string {
  switch (style.lineHeight.kind) {
    case 'normal':
      return 'normal';
    case 'number':
      return `${round(style.lineHeight.value * style.fontSize)}px`;
    case 'px':
      return `${round(style.lineHeight.value)}px`;
    case 'percent':
      return `${round((style.lineHeight.value / 100) * style.fontSize)}px`;
  }
}

function pixelsOnly(value: Margin): string | null {
  return value.kind === 'px' ? `${round(value.value)}px` : null;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
