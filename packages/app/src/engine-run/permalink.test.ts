import { describe, expect, it } from 'vitest';
import { decode, encode, type Shared } from './permalink.js';

async function linkOf(shared: Shared): Promise<string> {
  const link = await encode(shared);
  if (link === null) throw new Error('encode turned down a valid source');
  return link;
}

// What a hand-made link looks like, for the inputs encode() would refuse to write.
async function rawLink(json: string): Promise<string> {
  const stream = new Blob([json]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}

describe('permalink', () => {
  it('gets back what went in', async () => {
    const shared = { html: '<p class="a">é</p>', css: '.a { margin: 0 }', width: 420 };
    expect(await decode(await linkOf(shared))).toEqual(shared);
  });

  it('still opens a link with both sources at the limit and nothing but escapes in them', async () => {
    const worst = { html: '\u0001'.repeat(40_000), css: '\u0001'.repeat(40_000), width: 420 };
    expect(await decode(await linkOf(worst))).toEqual(worst);
  });

  it('makes no link for a source decode would turn down', async () => {
    expect(await encode({ html: 'x'.repeat(40_001), css: '', width: 420 })).toBeNull();
    expect(await encode({ html: '', css: '', width: 5000 })).toBeNull();
  });

  it('stops inflating a link that claims far more than a valid one can hold', async () => {
    const bomb = await rawLink(
      JSON.stringify({ html: 'x'.repeat(50_000_000), css: '', width: 420 }),
    );
    expect(bomb.length).toBeLessThan(100_000);
    expect(await decode(bomb)).toBeNull();
  });

  it('turns down a width the viewport input would not allow', async () => {
    expect(await decode(await rawLink('{"html":"","css":"","width":5000}'))).toBeNull();
  });

  it('turns down a link that is not one', async () => {
    expect(await decode('not-a-link')).toBeNull();
    expect(await decode('')).toBeNull();
  });
});
