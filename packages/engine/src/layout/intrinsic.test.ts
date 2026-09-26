import { describe, expect, it } from 'vitest';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, element, text } from '../dom/node.js';
import { intrinsicWidths, shrinkToFit } from './intrinsic.js';
import { fixedAdvanceMeasurer } from './text.js';

/** Half an em per character, so "abcd" is 32px at the default 16px font size. */
const measurer = fixedAdvanceMeasurer();

function widths(css: string, children: DomNode[]) {
  const root = element('html', {}, children);
  const boxTree = buildBoxTree(root, computeStyles(root, css));
  if (boxTree === null) throw new Error('the root generated no box');

  const first = boxTree.children[0];
  if (first === undefined) throw new Error('nothing to measure');
  return intrinsicWidths(first, measurer);
}

describe('intrinsicWidths', () => {
  it('leaves an out of flow child out of the width', () => {
    const wide = element('div', { classes: ['gone'] });
    const box = element('div', {}, [text('ab'), wide]);
    const css = '.gone { position: absolute; width: 90px }';

    expect(widths(css, [box])).toMatchObject({ min: 16, max: 16 });
  });

  it('counts a run of spaces across a nowrap boundary once', () => {
    const held = element('span', { classes: ['held'] }, [text(' cd ')]);
    const box = element('div', {}, [text('ab '), held]);
    const css = '.held { white-space: nowrap }';

    // "ab" and "cd" with one space between them, not two, and none after.
    expect(widths(css, [box]).max).toBe(40);
  });

  it('takes the minimum from the longest word and the maximum from the whole run', () => {
    const p = element('p', {}, [text('aa bbbb cc')]);
    // "bbbb" is 32, and the whole thing is 8+4+16+4+8 wide with its two spaces
    expect(widths('p { margin: 0 }', [p])).toEqual({ min: 32, max: 80 });
  });

  it('makes the minimum equal the maximum when nothing may break', () => {
    const p = element('p', {}, [text('aa bbbb cc')]);
    expect(widths('p { margin: 0; white-space: nowrap }', [p])).toEqual({ min: 80, max: 80 });
  });

  it('restarts the maximum at a forced break', () => {
    const p = element('p', {}, [text('aaaa\nbb')]);
    expect(widths('p { margin: 0; white-space: pre }', [p])).toEqual({ min: 32, max: 32 });
  });

  it('adds padding, border and margin to both figures', () => {
    const p = element('p', {}, [text('aa')]);
    const css = 'p { margin: 0 5px; padding: 0 3px; border-left: 2px solid }';
    expect(widths(css, [p])).toEqual({ min: 16 + 10 + 6 + 2, max: 16 + 10 + 6 + 2 });
  });

  it('lets a definite width stand in for the content', () => {
    const p = element('p', {}, [text('a very long run of words indeed')]);
    expect(widths('p { margin: 0; width: 40px }', [p])).toEqual({ min: 40, max: 40 });
  });

  it('takes the widest child of a block container', () => {
    const wide = element('div', { classes: ['wide'] }, [text('aaaaaa')]);
    const narrow = element('div', {}, [text('bb')]);
    const host = element('div', {}, [wide, narrow]);
    expect(widths('div { margin: 0 }', [host])).toEqual({ min: 48, max: 48 });
  });

  it('sums an inline-block into the line it sits on', () => {
    const box = element('span', { classes: ['ib'] }, [text('cc')]);
    const p = element('p', {}, [text('aa '), box]);
    const css = 'p { margin: 0 } .ib { display: inline-block; width: 20px }';
    expect(widths(css, [p])).toEqual({ min: 20, max: 16 + 8 + 20 });
  });

  it('clamps by min-width and max-width', () => {
    const p = element('p', {}, [text('aa bbbb cc')]);
    expect(widths('p { margin: 0; max-width: 50px }', [p])).toEqual({ min: 32, max: 50 });
  });
});

describe('shrinkToFit', () => {
  it('takes the preferred width when there is room', () => {
    expect(shrinkToFit({ min: 20, max: 80 }, 200)).toBe(80);
  });

  it('takes the available width when the preferred one does not fit', () => {
    expect(shrinkToFit({ min: 20, max: 80 }, 50)).toBe(50);
  });

  it('never goes below the minimum, however little room there is', () => {
    expect(shrinkToFit({ min: 20, max: 80 }, 5)).toBe(20);
  });
});
