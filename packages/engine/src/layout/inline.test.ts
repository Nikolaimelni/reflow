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

  it('does not pad the union of a span that wraps', () => {
    const span = element('span', { classes: ['padded'] }, [text('one two three')]);
    const p = element('p', {}, [text('start '), span]);
    const css = 'p { margin: 0 } .padded { padding: 0 9px }';
    const rect = page(css, [p], 80).rectOf(span);

    // The padding is at the start of the first line and the end of the last, so it cannot
    // reach the left edge, where the second line begins without it.
    expect(rect.x).toBe(0);
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
