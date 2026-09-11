export type ExtractedRect = { x: number; y: number; width: number; height: number };

export type ExtractedElement = {
  tag: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  parent: number | null;
  computed: Record<string, string>;
  rect: ExtractedRect;
};

export type ExtractedPage = {
  css: string;
  viewport: { width: number; height: number };
  elements: ExtractedElement[];
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

  const elements: ExtractedElement[] = [];

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

    const at = elements.length;
    elements.push({
      tag: node.tagName.toLowerCase(),
      id: node.id === '' ? null : node.id,
      classes: Array.from(node.classList),
      attributes,
      parent,
      computed: values,
      rect: { x: box.x, y: box.y, width: box.width, height: box.height },
    });

    for (const child of Array.from(node.children)) walk(child, at);
  };

  walk(document.documentElement, null);
  return {
    css,
    viewport: { width: document.documentElement.clientWidth, height: window.innerHeight },
    elements,
  };
}
