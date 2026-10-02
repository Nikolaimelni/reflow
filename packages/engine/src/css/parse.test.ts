import { describe, expect, it } from 'vitest';
import { parseStylesheet } from './parse.js';

describe('parseStylesheet', () => {
  it('reads selectors and declarations', () => {
    const [rule] = parseStylesheet('p, div { width: 50%; margin: 0 auto }');

    expect(rule?.selectors).toHaveLength(2);
    expect(rule?.declarations.map((d) => d.property)).toEqual(['width', 'margin']);
    expect(rule?.declarations[0]?.value).toEqual([{ type: 'percentage', value: 50 }]);
  });

  it('picks up !important and strips it from the value', () => {
    const [rule] = parseStylesheet('p { color: red !important }');

    expect(rule?.declarations[0]?.important).toBe(true);
    expect(rule?.declarations[0]?.value).toEqual([{ type: 'ident', value: 'red' }]);
  });

  it('allows space between the bang and important', () => {
    const [rule] = parseStylesheet('p { color: red ! IMPORTANT }');

    expect(rule?.declarations[0]?.important).toBe(true);
    expect(rule?.declarations[0]?.value).toEqual([{ type: 'ident', value: 'red' }]);
  });

  it('drops a rule whose selector is unsupported but keeps the next one', () => {
    const rules = parseStylesheet('p::before { content: "x" } p { width: 1px }');

    expect(rules).toHaveLength(1);
    expect(rules[0]?.declarations[0]?.property).toBe('width');
  });

  it('skips at-rules whole', () => {
    const rules = parseStylesheet('@media print { p { width: 1px } } div { height: 2px }');

    expect(rules).toHaveLength(1);
    expect(rules[0]?.selectors[0]?.key.tag).toBe('div');
  });

  it('survives a declaration with no colon', () => {
    const [rule] = parseStylesheet('p { garbage; height: 2px }');

    expect(rule?.declarations.map((d) => d.property)).toEqual(['height']);
  });
});
