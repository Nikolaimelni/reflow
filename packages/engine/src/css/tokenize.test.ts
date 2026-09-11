import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize.js';

const types = (css: string) => tokenize(css).map((t) => t.type);

describe('tokenize', () => {
  it('splits numbers from their unit', () => {
    expect(tokenize('12px')).toEqual([
      { type: 'dimension', value: 12, unit: 'px' },
      { type: 'eof' },
    ]);
  });

  it('keeps percentages apart from plain numbers', () => {
    expect(tokenize('50% 50')).toEqual([
      { type: 'percentage', value: 50 },
      { type: 'whitespace' },
      { type: 'number', value: 50 },
      { type: 'eof' },
    ]);
  });

  it('reads signed and fractional numbers', () => {
    expect(tokenize('-1.5em')).toEqual([
      { type: 'dimension', value: -1.5, unit: 'em' },
      { type: 'eof' },
    ]);
    expect(tokenize('.5')).toEqual([{ type: 'number', value: 0.5 }, { type: 'eof' }]);
  });

  it('collapses runs of whitespace into one token', () => {
    expect(types('a   \n  b')).toEqual(['ident', 'whitespace', 'ident', 'eof']);
  });

  it('drops comments', () => {
    expect(types('a/* gone */b')).toEqual(['ident', 'ident', 'eof']);
  });

  it('reads a hash, and a bare hash as a delimiter', () => {
    expect(tokenize('#main')).toEqual([{ type: 'hash', value: 'main' }, { type: 'eof' }]);
    expect(types('# ')).toEqual(['delim', 'whitespace', 'eof']);
  });

  it('marks an ident followed by a paren as a function', () => {
    expect(types('rgb(0,0,0)')).toEqual([
      'function',
      'number',
      'comma',
      'number',
      'comma',
      'number',
      'rparen',
      'eof',
    ]);
  });

  it('unwraps strings', () => {
    expect(tokenize('"a\\"b"')).toEqual([{ type: 'string', value: 'a"b' }, { type: 'eof' }]);
  });
});
