export type ExtractedRect = { x: number; y: number; width: number; height: number };

export type ExtractedElement = {
  kind: 'element';
  tag: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  parent: number | null;
  computed: Record<string, string>;
  rect: ExtractedRect;
};

export type ExtractedText = {
  kind: 'text';
  text: string;
  parent: number;
};

export type ExtractedNode = ExtractedElement | ExtractedText;

export type ExtractedPage = {
  css: string;
  viewport: { width: number; height: number; devicePixelRatio: number };
  nodes: ExtractedNode[];
};

/**
 * Runs inside the page, so it may not reference anything outside its own body. Playwright
 * ships the source of this function to Chromium and calls it there.
 */
export function extractPage(propertyNames: string[]): ExtractedPage {
  // Elements that never generate a box, and that the engine's tree does not carry either.
  const skip = ['head', 'style', 'script', 'link', 'meta', 'title', 'base'];

  const css = Array.from(document.querySelectorAll('style'))
    .map((node) => node.textContent ?? '')
    .join('\n');

  const nodes: ExtractedNode[] = [];

  const walk = (node: Element, parent: number | null): void => {
    if (skip.includes(node.tagName.toLowerCase())) return;

    const computed = window.getComputedStyle(node);
    const values: Record<string, string> = {};
    for (const name of propertyNames) values[name] = computed.getPropertyValue(name);

    const attributes: Record<string, string> = {};
    for (const attribute of Array.from(node.attributes)) {
      attributes[attribute.name] = attribute.value;
    }

    const box = node.getBoundingClientRect();
    const at = nodes.length;

    nodes.push({
      kind: 'element',
      tag: node.tagName.toLowerCase(),
      id: node.id === '' ? null : node.id,
      classes: Array.from(node.classList),
      attributes,
      parent,
      computed: values,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    });

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        nodes.push({ kind: 'text', text: child.nodeValue ?? '', parent: at });
      } else if (child.nodeType === 1) {
        walk(child as Element, at);
      }
    }
  };

  walk(document.documentElement, null);

  return {
    css,
    viewport: {
      width: document.documentElement.clientWidth,
      height: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
    },
    nodes,
  };
}

export type MeasureRequest = { font: string; texts: string[] };

export type Measurements = {
  widths: Record<string, number>;
  metrics: Record<string, { ascent: number; descent: number; lineHeight: number }>;
};

/**
 * Also runs in the page. Taking the numbers from the same browser that laid the fixture out
 * is what makes the comparison fair, and it sidesteps pinning a font file: both sides end up
 * measuring whatever Chromium actually loaded.
 *
 * Advances come from canvas. The font's extents do not: `fontBoundingBoxAscent` and its
 * descent are whole numbers whatever the screen is, while Blink lays out with metrics snapped
 * to device pixels, so on a 1.25 display the two drift apart by up to a pixel. Both the
 * extents and the line box `line-height: normal` produces are measured off a live line
 * instead, which is the same answer the browser is using.
 */
export function measureInPage(requests: MeasureRequest[]): Measurements {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');

  const widths: Record<string, number> = {};
  const metrics: Measurements['metrics'] = {};

  const probe = (font: string) => {
    const host = document.createElement('div');
    // `all: initial` first, or the fixture's own `div { height: 20px }` measures the probe
    // instead of the font. That mistake cost an evening.
    host.style.cssText = `all:initial;display:block;position:absolute;top:-9999px;left:0;white-space:nowrap;font:${font}`;

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
  };

  for (const request of requests) {
    context.font = request.font;
    metrics[request.font] = probe(request.font);

    for (const text of request.texts) {
      widths[`${request.font} ${text}`] = context.measureText(text).width;
    }
  }

  return { widths, metrics };
}

/**
 * Runs in the page. Numbers the elements exactly the way `extractPage` does, so a hit test
 * answer can be matched up with the engine's own tree.
 */
export function hitTestInPage(points: readonly { x: number; y: number }[]): number[] {
  const skip = ['head', 'style', 'script', 'link', 'meta', 'title', 'base'];
  const indexOf = new Map<Element, number>();
  let index = 0;

  const walk = (node: Element): void => {
    if (skip.includes(node.tagName.toLowerCase())) return;
    indexOf.set(node, index);
    index++;

    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) index++;
      else if (child.nodeType === 1) walk(child as Element);
    }
  };

  walk(document.documentElement);

  return points.map((point) => {
    const found = document.elementFromPoint(point.x, point.y);
    return found === null ? -1 : (indexOf.get(found) ?? -1);
  });
}
