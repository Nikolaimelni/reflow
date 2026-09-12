import { type DomNode, type ElementNode, element, text } from '@reflow/engine';

/**
 * `DOMParser` does the HTML parsing. The parsing spec is enormous and none of it is what this
 * project is about, so the browser keeps that job and hands back a document, which then gets
 * copied into the engine's own node tree.
 *
 * Head content is dropped: those elements generate no boxes, and the stylesheet is handed to
 * the engine separately.
 */
const SKIP = new Set(['head', 'style', 'script', 'link', 'meta', 'title', 'base']);

export function parseHtml(source: string): ElementNode | null {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  return convert(parsed.documentElement);
}

function convert(node: Element): ElementNode | null {
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag)) return null;

  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(node.attributes)) {
    attributes[attribute.name] = attribute.value;
  }

  const children: DomNode[] = [];
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 3) {
      children.push(text(child.nodeValue ?? ''));
      continue;
    }
    if (child.nodeType !== 1) continue;

    const converted = convert(child as Element);
    if (converted !== null) children.push(converted);
  }

  return element(
    tag,
    {
      ...(node.id === '' ? {} : { id: node.id }),
      classes: Array.from(node.classList),
      attributes,
    },
    children,
  );
}
