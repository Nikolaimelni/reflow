import { type DomNode, type ElementNode, element, text } from '@reflow/engine';

// Head content makes no boxes. LiveFrame skips the same tags, as it pairs elements by order.
export const SKIP: ReadonlySet<string> = new Set([
  'head',
  'style',
  'script',
  'link',
  'meta',
  'title',
  'base',
]);

export function parseHtml(source: string): ElementNode | null {
  const parsed = new DOMParser().parseFromString(source, 'text/html');
  return convert(parsed.documentElement);
}

function convert(node: Element): ElementNode | null {
  const tag = node.tagName.toLowerCase();
  if (SKIP.has(tag)) return null;

  // fromEntries defines own properties, so an attribute called __proto__ is kept as one
  // instead of going to the prototype setter.
  const attributes = Object.fromEntries(
    Array.from(node.attributes, (attribute) => [attribute.name, attribute.value]),
  );

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
