import { describe, expect, it } from 'vitest';
import { type ElementNode, element, elementChildren, text } from '../dom/node.js';
import { matches } from './match.js';
import { type ComplexSelector, parseSelector } from './selector.js';

function selector(source: string): ComplexSelector {
  const first = parseSelector(source)?.[0];
  if (first === undefined) throw new Error(`cannot parse ${source}`);
  return first;
}

function find(root: ElementNode, tag: string): ElementNode {
  const found = findOrNull(root, tag);
  if (found === null) throw new Error(`no ${tag} in the tree`);
  return found;
}

function findOrNull(root: ElementNode, tag: string): ElementNode | null {
  if (root.tag === tag) return root;
  for (const child of elementChildren(root)) {
    const found = findOrNull(child, tag);
    if (found !== null) return found;
  }
  return null;
}

function at(nodes: ElementNode[], index: number): ElementNode {
  const node = nodes[index];
  if (node === undefined) throw new Error(`no child at ${String(index)}`);
  return node;
}

const tree = element('div', { id: 'page' }, [
  element('ul', { classes: ['list'] }, [
    element('li', { classes: ['item'] }, [text('one')]),
    element('li', { classes: ['item', 'current'], hover: true }, [text('two')]),
    element('li', { classes: ['item'] }, [text('three')]),
  ]),
  element('p', {}, [text('after')]),
]);

const items = elementChildren(find(tree, 'ul'));
const second = at(items, 1);

describe('matches', () => {
  it('matches a descendant at any depth', () => {
    expect(matches(selector('#page li'), second)).toBe(true);
  });

  it('does not let a child combinator skip a generation', () => {
    expect(matches(selector('#page > li'), second)).toBe(false);
    expect(matches(selector('ul > li'), second)).toBe(true);
  });

  it('walks siblings backwards', () => {
    expect(matches(selector('li + li'), second)).toBe(true);
    expect(matches(selector('li + li'), at(items, 0))).toBe(false);
    expect(matches(selector('.item ~ .item'), at(items, 2))).toBe(true);
  });

  it('needs every class in the compound', () => {
    expect(matches(selector('.item.current'), second)).toBe(true);
    expect(matches(selector('.item.missing'), second)).toBe(false);
  });

  it('reads hover off the node', () => {
    expect(matches(selector('li:hover'), second)).toBe(true);
    expect(matches(selector('li:hover'), at(items, 2))).toBe(false);
  });

  it('counts nth-child from one', () => {
    expect(items.map((item) => matches(selector('li:nth-child(2n)'), item))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it('handles first-child and last-child', () => {
    expect(items.map((item) => matches(selector('li:last-child'), item))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it('backtracks when an ancestor chain has several candidates', () => {
    const nested = element('div', { classes: ['a'] }, [
      element('div', { classes: ['b'] }, [element('span')]),
    ]);
    const span = find(nested, 'span');

    expect(matches(selector('.a .b span'), span)).toBe(true);
    expect(matches(selector('.b .a span'), span)).toBe(false);
  });
});
