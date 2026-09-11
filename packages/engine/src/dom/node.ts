export type ElementNode = {
  kind: 'element';
  tag: string;
  id: string | null;
  classes: string[];
  attributes: Record<string, string>;
  hover: boolean;
  parent: ElementNode | null;
  children: DomNode[];
};

export type TextNode = {
  kind: 'text';
  text: string;
  parent: ElementNode | null;
};

export type DomNode = ElementNode | TextNode;

export type ElementProps = {
  id?: string;
  classes?: string[];
  attributes?: Record<string, string>;
  hover?: boolean;
};

export function element(
  tag: string,
  props: ElementProps = {},
  children: DomNode[] = [],
): ElementNode {
  const node: ElementNode = {
    kind: 'element',
    tag: tag.toLowerCase(),
    id: props.id ?? null,
    classes: props.classes ?? [],
    attributes: props.attributes ?? {},
    hover: props.hover ?? false,
    parent: null,
    children,
  };

  for (const child of children) child.parent = node;
  return node;
}

export function text(value: string): TextNode {
  return { kind: 'text', text: value, parent: null };
}

export function elementChildren(node: ElementNode): ElementNode[] {
  return node.children.filter((child): child is ElementNode => child.kind === 'element');
}

export function previousElement(node: ElementNode): ElementNode | null {
  const siblings = node.parent === null ? [] : elementChildren(node.parent);
  const index = siblings.indexOf(node);
  return index > 0 ? (siblings[index - 1] ?? null) : null;
}

/** One-based, the way `:nth-child` counts. */
export function indexAmongSiblings(node: ElementNode): number {
  if (node.parent === null) return 1;
  return elementChildren(node.parent).indexOf(node) + 1;
}

export function siblingCount(node: ElementNode): number {
  return node.parent === null ? 1 : elementChildren(node.parent).length;
}
