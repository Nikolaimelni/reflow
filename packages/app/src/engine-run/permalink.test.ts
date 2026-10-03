import { describe, expect, it } from 'vitest';
import { decode, encode } from './permalink.js';

describe('permalink', () => {
  it('gets back what went in', async () => {
    const shared = { html: '<p class="a">é</p>', css: '.a { margin: 0 }', width: 420 };
    expect(await decode(await encode(shared))).toEqual(shared);
  });

  it('still opens a link with both sources at the limit and nothing but escapes in them', async () => {
    const worst = { html: '\u0001'.repeat(40_000), css: '\u0001'.repeat(40_000), width: 420 };
    expect(await decode(await encode(worst))).toEqual(worst);
  });

  it('stops inflating a link that claims far more than a valid one can hold', async () => {
    const bomb = await encode({ html: 'x'.repeat(50_000_000), css: '', width: 420 });
    expect(bomb.length).toBeLessThan(100_000);
    expect(await decode(bomb)).toBeNull();
  });

  it('turns down a width the viewport input would not allow', async () => {
    expect(await decode(await encode({ html: '', css: '', width: 5000 }))).toBeNull();
  });

  it('turns down a link that is not one', async () => {
    expect(await decode('not-a-link')).toBeNull();
    expect(await decode('')).toBeNull();
  });
});
