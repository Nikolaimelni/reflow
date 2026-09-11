import { describe, expect, it } from 'vitest';
import { deflate, edges, inflate, type Rect } from './geometry.js';

const box: Rect = { x: 10, y: 20, width: 200, height: 100 };

describe('deflate', () => {
  it('moves the origin in and shrinks the size', () => {
    expect(deflate(box, edges(5, 10, 5, 10))).toEqual({ x: 20, y: 25, width: 180, height: 90 });
  });

  it('clamps to zero instead of going negative', () => {
    expect(deflate(box, edges(0, 150, 0, 150))).toMatchObject({ width: 0 });
  });
});

describe('inflate', () => {
  it('is the inverse of deflate while the box stays positive', () => {
    const e = edges(1, 2, 3, 4);
    expect(inflate(deflate(box, e), e)).toEqual(box);
  });
});
