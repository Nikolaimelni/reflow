import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, type ElementNode, element, text } from '../dom/node.js';
import type { Fragment } from '../trace/events.js';
import { layoutDocument } from './block.js';
import { fixedAdvanceMeasurer } from './text.js';

/** Half an em per character, so "hello" is 40px at the default 16px font size. */
const measurer = fixedAdvanceMeasurer();

function page(css: string, children: DomNode[], width = 400) {
  const root = element('html', {}, children);
  const boxTree = buildBoxTree(root, computeStyles(root, css));
  if (boxTree === null) throw new Error('the root generated no box');

  const result = layoutDocument(boxTree, { width, height: 600 }, measurer);
  const byElement = new Map<ElementNode, BoxId>();
  const texts: Box[] = [];

  walkBoxes(boxTree, (box: Box) => {
    if (box.kind === 'text') texts.push(box);
    else if (box.element !== null) byElement.set(box.element, box.id);
  });

  const rectOf = (node: ElementNode): Fragment['rect'] => {
    const id = byElement.get(node);
    const fragment = id === undefined ? undefined : result.fragments.get(id);
    if (fragment === undefined) throw new Error(`no fragment for <${node.tag}>`);
    return fragment.rect;
  };

  const lines = result.trace.filter((event) => event.t === 'line:broken');

  return { result, rectOf, texts, lines };
}

describe('line boxes', () => {
  it('puts a short run on one line and takes its height from the strut', () => {
    const p = element('p', {}, [text('hello world')]);
    const { rectOf, lines } = page('p { margin: 0 }', [p]);

    expect(lines).toHaveLength(1);
    expect(rectOf(p).height).toBe(16);
  });

  it('breaks when the next word does not fit', () => {
    const p = element('p', {}, [text('hello world')]);
    const { rectOf, lines } = page('p { margin: 0 }', [p], 50);

    expect(lines.map((line) => line.t === 'line:broken' && line.width)).toEqual([40, 40]);
    expect(rectOf(p).height).toBe(32);
  });

  it('drops the space that the break replaced', () => {
    const p = element('p', {}, [text('aa bb')]);
    const { lines } = page('p { margin: 0 }', [p], 30);

    expect(lines.map((line) => line.t === 'line:broken' && line.width)).toEqual([16, 16]);
  });

  it('collapses runs of whitespace to a single space', () => {
    const p = element('p', {}, [text('  aa \n\t bb  ')]);
    const { lines } = page('p { margin: 0 }', [p]);

    // two words of 16 plus one space of 8
    expect(lines.map((line) => line.t === 'line:broken' && line.width)).toEqual([40]);
  });

  it('never breaks under nowrap', () => {
    const p = element('p', {}, [text('hello world again')]);
    const { lines } = page('p { margin: 0; white-space: nowrap }', [p], 50);

    expect(lines).toHaveLength(1);
  });

  it('breaks at newlines and keeps spaces under pre', () => {
    const p = element('p', {}, [text('a  b\nc')]);
    const { lines } = page('p { margin: 0; white-space: pre }', [p]);

    // 8 for the a, 16 for the two spaces that survive, 8 for the b
    expect(lines.map((line) => line.t === 'line:broken' && line.width)).toEqual([32, 8]);
  });

  it('gives an empty line its own height under pre', () => {
    const p = element('p', {}, [text('a\n\nb')]);
    const { rectOf, lines } = page('p { margin: 0; white-space: pre }', [p]);

    expect(lines).toHaveLength(3);
    expect(rectOf(p).height).toBe(48);
  });
});

describe('line height', () => {
  it('takes a number as a multiple of the font size', () => {
    const p = element('p', {}, [text('hello')]);
    expect(page('p { margin: 0; line-height: 2 }', [p]).rectOf(p).height).toBe(32);
  });

  it('takes a length as it stands', () => {
    const p = element('p', {}, [text('hello')]);
    expect(page('p { margin: 0; line-height: 25px }', [p]).rectOf(p).height).toBe(25);
  });

  it('lets the tallest run on a line set the height', () => {
    const big = element('span', { classes: ['big'] }, [text('big')]);
    const p = element('p', {}, [text('small '), big]);
    const css = 'p { margin: 0 } .big { font-size: 32px }';

    expect(page(css, [p]).rectOf(p).height).toBe(32);
  });
});

describe('text-align', () => {
  const run = (align: string, width = 100) => {
    const span = element('span', {}, [text('ab')]);
    const p = element('p', {}, [span]);
    const css = `p { margin: 0; width: ${width}px; text-align: ${align} }`;
    return page(css, [p]).rectOf(span);
  };

  it('leaves a left aligned line where it starts', () => {
    expect(run('left')).toMatchObject({ x: 0, width: 16 });
  });

  it('centres a line', () => {
    expect(run('center')).toMatchObject({ x: 42 });
  });

  it('pushes a right aligned line to the far edge', () => {
    expect(run('right')).toMatchObject({ x: 84 });
  });
});

describe('inline boxes', () => {
  it('reports the union of the lines a span sits on', () => {
    const span = element('span', {}, [text('one two three')]);
    const p = element('p', {}, [span]);
    const rect = page('p { margin: 0 }', [p], 60).rectOf(span);

    expect(rect.height).toBe(32);
    expect(rect.y).toBe(0);
  });

  it('breaks so that the closing margin fits on the line', () => {
    const span = element('span', { classes: ['wide'] }, [text(' one one one ')]);
    const p = element('p', {}, [span]);
    const css = 'p { margin: 0 } .wide { margin: 0 50px }';
    const { rectOf, lines } = page(css, [p], 180);

    // 50 + "one one" + 50 is 156, and the third word would take it past 180.
    expect(lines).toHaveLength(2);
    expect(rectOf(span)).toMatchObject({ x: 0, width: 106 });
  });

  it('keeps the first space of a run that crosses a box boundary', () => {
    const span = element('span', { classes: ['crossing'] }, [text('ab ')]);
    const p = element('p', {}, [span, text(' cd')]);

    // One space between them, and it belongs to the span, so the span is wide enough for it.
    expect(page('p { margin: 0 }', [p]).rectOf(span)).toMatchObject({ x: 0, width: 24 });
  });

  it('settles a nowrap space inside the box, in front of its padding', () => {
    const span = element('span', { classes: ['held'] }, [text('ab ')]);
    const p = element('p', {}, [text('x '), span, text('cd')]);
    const css = 'p { margin: 0 } .held { padding-right: 30px; white-space: nowrap }';

    expect(page(css, [p]).rectOf(span)).toMatchObject({ x: 16, width: 54 });
  });

  it('covers a line it puts nothing on', () => {
    const span = element('span', { classes: ['kept'] }, [text('\n  one\n')]);
    const p = element('p', {}, [span]);
    const css = 'p { margin: 0 } .kept { border: 1px solid; white-space: pre }';
    const rect = page(css, [p]).rectOf(span);

    // Three lines of sixteen, plus a border above the first and below the last.
    expect({ y: rect.y, height: rect.height }).toEqual({ y: -1, height: 50 });
  });

  it('leaves a space in front of an inline box outside it', () => {
    const span = element('span', { classes: ['marked'] });
    const p = element('p', {}, [text('before '), span, text('after')]);

    // "before" is 48 wide under the stub measurer and the space is 8.
    expect(page('p { margin: 0 }', [p]).rectOf(span).x).toBe(56);
  });

  it('does not pad the union of a span that wraps', () => {
    const span = element('span', { classes: ['padded'] }, [text('one two three')]);
    const p = element('p', {}, [text('start '), span]);
    const css = 'p { margin: 0 } .padded { padding: 0 9px }';
    const rect = page(css, [p], 80).rectOf(span);

    // The padding is at the start of the first line and the end of the last, so it cannot
    // reach the left edge, where the second line begins without it.
    expect(rect.x).toBe(0);
  });

  it('floors the half leading and lets the descent take the rest', () => {
    const box = element('span', { classes: ['tall'] });
    const p = element('p', {}, [box, text('x')]);
    const css = 'p { margin: 0 } .tall { display: inline-block; width: 10px; height: 24px }';

    // The stub font is 12.8 up and 3.2 down in a 16px line, so there is no leading to split
    // and the box adds its 24 to the 3.2 below the baseline. At line-height 19 the half
    // leading is 1.5, floored to 1, and the descent keeps the other half pixel: 24 + 5.2.
    expect(page(css, [p]).rectOf(p).height).toBe(27.2);
    expect(page(`${css} p { line-height: 19px }`, [p]).rectOf(p).height).toBe(29.2);
  });

  it('lays an inline-block out as a block and sits it on the baseline', () => {
    const inner = element('div', { classes: ['inner'] });
    const box = element('span', { classes: ['ib'] }, [inner]);
    const p = element('p', {}, [box]);
    const css =
      'p { margin: 0; line-height: 20px } .ib { display: inline-block; width: 30px } .inner { height: 40px }';
    const { rectOf } = page(css, [p]);

    expect(rectOf(box)).toMatchObject({ x: 0, width: 30, height: 40 });

    // 40 above the baseline, plus the strut's own descent below it. That leftover 5.2 is the
    // gap everyone has fought underneath an image or an inline-block.
    expect(rectOf(p).height).toBeCloseTo(45.2, 5);
  });
});

describe('the trace with text in it', () => {
  it('still replays to the geometry it produced', () => {
    const p = element('p', {}, [text('hello world and a few more words')]);
    const { result } = page('p { margin: 4px }', [p], 80);
    const replayed = new Map<BoxId, Fragment>();

    for (const event of result.trace) {
      if (event.t === 'size:resolved') replayed.set(event.box, event.fragment);
    }

    expect(replayed).toEqual(result.fragments);
  });
});
