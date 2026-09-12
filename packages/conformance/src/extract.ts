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
  viewport: { width: number; height: number };
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
    viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
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
 * Advances and font extents come from canvas. The line box a font produces under
 * `line-height: normal` is a different number again, taller than ascent plus descent by the
 * font's line gap, so that one gets measured directly off a live line box.
 */
export function measureInPage(requests: MeasureRequest[]): Measurements {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('no 2d context');

  const widths: Record<string, number> = {};
  const metrics: Measurements['metrics'] = {};

  const normalLineHeight = (font: string): number => {
    const host = document.createElement('div');
    host.style.cssText = `position:absolute;top:-9999px;left:0;white-space:nowrap;font:${font};line-height:normal`;
    host.textContent = 'x';

    document.body.append(host);
    const height = host.getBoundingClientRect().height;
    host.remove();

    return height;
  };

  for (const request of requests) {
    context.font = request.font;
    const sample = context.measureText('Hg');

    metrics[request.font] = {
      ascent: sample.fontBoundingBoxAscent,
      descent: sample.fontBoundingBoxDescent,
      lineHeight: normalLineHeight(request.font),
    };

    for (const text of request.texts) {
      widths[`${request.font} ${text}`] = context.measureText(text).width;
    }
  }

  return { widths, metrics };
}
