import { describe, expect, it } from 'vitest';
import { tokenize } from '../css/tokenize.js';
import { formatColour, parseColour } from './colour.js';

function colour(text: string) {
  return parseColour(tokenize(text).filter((token) => token.type !== 'eof'));
}

describe('parseColour', () => {
  it.each([
    ['rgba(0, 0, 0, 0.5)', 'rgba(0, 0, 0, 0.5)'],
    ['rgb(0 0 0 / 50%)', 'rgba(0, 0, 0, 0.5)'],
    ['rgb(0 0 0 / 0.3%)', 'rgba(0, 0, 0, 0.004)'],
    ['rgba(0, 0, 0, 2)', 'rgb(0, 0, 0)'],
    ['rgb(100%, 50%, 0%)', 'rgb(255, 128, 0)'],
    ['rgb(300, -5, 0)', 'rgb(255, 0, 0)'],
  ])('reads %s', (text, expected) => {
    const parsed = colour(text);
    expect(parsed && formatColour(parsed)).toBe(expected);
  });

  it('turns down more than four values', () => {
    expect(colour('rgb(0, 0, 0, 1, 1)')).toBeNull();
  });

  it('does not find a colour on the object prototype', () => {
    expect(colour('constructor')).toBeNull();
    expect(colour('__proto__')).toBeNull();
    expect(colour('toString')).toBeNull();
  });
});
