import {
  type ElementNode,
  indexAmongSiblings,
  previousElement,
  siblingCount,
} from '../dom/node.js';
import type { ComplexSelector, CompoundSelector, PseudoClass } from './selector.js';

export function matches(selector: ComplexSelector, node: ElementNode): boolean {
  if (!matchesCompound(selector.key, node)) return false;

  const link = selector.ancestor;
  if (link === null) return true;

  switch (link.combinator) {
    case 'child':
      return node.parent !== null && matches(link.selector, node.parent);

    case 'descendant': {
      for (let parent = node.parent; parent !== null; parent = parent.parent) {
        if (matches(link.selector, parent)) return true;
      }
      return false;
    }

    case 'next-sibling': {
      const previous = previousElement(node);
      return previous !== null && matches(link.selector, previous);
    }

    case 'subsequent-sibling': {
      for (let s = previousElement(node); s !== null; s = previousElement(s)) {
        if (matches(link.selector, s)) return true;
      }
      return false;
    }
  }
}

function matchesCompound(compound: CompoundSelector, node: ElementNode): boolean {
  if (compound.tag !== null && compound.tag !== node.tag) return false;
  if (compound.id !== null && compound.id !== node.id) return false;
  if (!compound.classes.every((name) => node.classes.includes(name))) return false;
  return compound.pseudoClasses.every((pseudo) => matchesPseudoClass(pseudo, node));
}

function matchesPseudoClass(pseudo: PseudoClass, node: ElementNode): boolean {
  switch (pseudo.name) {
    case 'hover':
      return node.hover;
    case 'first-child':
      return indexAmongSiblings(node) === 1;
    case 'last-child':
      return indexAmongSiblings(node) === siblingCount(node);
    case 'nth-child':
      return matchesAnB(pseudo.a, pseudo.b, indexAmongSiblings(node));
  }
}

function matchesAnB(a: number, b: number, index: number): boolean {
  if (a === 0) return index === b;
  const n = (index - b) / a;
  return n >= 0 && Number.isInteger(n);
}
