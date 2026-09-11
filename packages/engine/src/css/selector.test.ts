import { describe, expect, it } from 'vitest';
import {
  type ComplexSelector,
  compareSpecificity,
  parseSelector,
  specificity,
} from './selector.js';

function one(text: string): ComplexSelector {
  const list = parseSelector(text);
  const first = list?.[0];
  if (first === undefined) throw new Error(`cannot parse ${text}`);
  return first;
}

describe('parseSelector', () => {
  it('stores a descendant chain right to left', () => {
    const selector = one('div p');
    expect(selector.key.tag).toBe('p');
    expect(selector.ancestor?.combinator).toBe('descendant');
    expect(selector.ancestor?.selector.key.tag).toBe('div');
  });

  it('reads a compound of tag, id, class and pseudo-class', () => {
    expect(one('a#home.nav.wide:hover').key).toEqual({
      tag: 'a',
      id: 'home',
      classes: ['nav', 'wide'],
      pseudoClasses: [{ name: 'hover' }],
    });
  });

  it('reads every combinator', () => {
    expect(one('a > b').ancestor?.combinator).toBe('child');
    expect(one('a + b').ancestor?.combinator).toBe('next-sibling');
    expect(one('a ~ b').ancestor?.combinator).toBe('subsequent-sibling');
    expect(one('a>b').ancestor?.combinator).toBe('child');
  });

  it('splits a list on commas', () => {
    expect(parseSelector('h1, h2 , h3')).toHaveLength(3);
  });

  it.each([
    ['li:nth-child(2n+1)', { a: 2, b: 1 }],
    ['li:nth-child(odd)', { a: 2, b: 1 }],
    ['li:nth-child(even)', { a: 2, b: 0 }],
    ['li:nth-child(3)', { a: 0, b: 3 }],
    ['li:nth-child(-n+3)', { a: -1, b: 3 }],
    ['li:nth-child(2n - 1)', { a: 2, b: -1 }],
  ])('parses %s', (text, expected) => {
    expect(one(text).key.pseudoClasses[0]).toEqual({ name: 'nth-child', ...expected });
  });

  it('rejects what it does not support instead of guessing', () => {
    expect(parseSelector('p::before')).toBeNull();
    expect(parseSelector('p:not(.a)')).toBeNull();
    expect(parseSelector('[data-x]')).toBeNull();
    expect(parseSelector('')).toBeNull();
  });
});

describe('specificity', () => {
  it('counts ids, then classes and pseudo-classes, then tags', () => {
    expect(specificity(one('#a .b:hover p span'))).toEqual([1, 2, 2]);
    expect(specificity(one('*'))).toEqual([0, 0, 0]);
  });

  it('orders an id above any number of classes', () => {
    const idSelector = specificity(one('#a'));
    const classes = specificity(one('.a.b.c.d'));
    expect(compareSpecificity(idSelector, classes)).toBeGreaterThan(0);
  });
});
