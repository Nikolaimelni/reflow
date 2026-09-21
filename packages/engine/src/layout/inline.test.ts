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

  it('breaks for an edge the browser will not let hang', () => {
    const css = '.pad { display: inline; padding-left: 20px }';
    const linesFor = (tag: string) => {
      const box = element(tag, { classes: ['pad'] });
      const p = element('p', {}, [text('abcdefghij ab '), box]);
      return page(css, [p], 120).lines.length;
    };

    // The words take 104 of the 120 available and the padding another 20, with the space
    // between them hanging. A span lets its padding hang as well and the line holds; a div
    // made inline is broken for, and the last word goes down with it. That is the same thing
    // the browser does with a newline in front of a closing tag.
    expect(linesFor('span')).toBe(1);
    expect(linesFor('div')).toBe(2);
  });

  it('lets a closing margin hang rather than empty the line for it', () => {
    const em = element('em', { classes: ['wide-edges'] }, [text(' abcdefghij ')]);
    const p = element('p', {}, [em]);
    const css = 'p { margin: 0 } .wide-edges { margin: 0 10px; padding-left: 8px }';
    const { rectOf, lines } = page(css, [p], 100);

    // 10 + 8 + 80 + 10 is two over the hundred available. There is nowhere useful to break:
    // moving the word down would leave a line with nothing on it and the margin would still
    // be there, so the line keeps what it has.
    expect(lines).toHaveLength(1);
    expect(rectOf(em)).toMatchObject({ x: 10, width: 88 });
  });

  it('makes a line for a percentage edge that comes to nothing', () => {
    const hair = element('span', { classes: ['hair'] });
    const nothing = element('span', { classes: ['nothing'] });
    const css = '.hair { padding-left: 1% } .nothing { padding-left: 0 }';

    // The browser decides whether an inline box has a padding before the percentages are
    // resolved, so one per cent of nothing still makes a line and a plain zero does not.
    const withHair = element('p', {}, [hair]);
    const withNothing = element('p', {}, [nothing]);

    expect(page(css, [withHair], 0).rectOf(withHair).height).toBe(16);
    expect(page(css, [withNothing], 0).rectOf(withNothing).height).toBe(0);
  });

  it('does not break a line for the border of a box with nothing in it', () => {
    const empty = element('span', { classes: ['edged'] });
    const p = element('p', {}, [text('ab cd'), empty]);
    const css = 'p { margin: 0 } .edged { border: 4px solid }';

    // "ab cd" is 40 wide and the borders take it past the 44 available, but a box with
    // nothing in it is not worth moving a word for.
    expect(page(css, [p], 44).lines).toHaveLength(1);
  });

  it('does not break a full line for a space that hangs off the end', () => {
    const full = element('span', { classes: ['full'] });
    const after = element('span', { classes: ['after'] });
    const p = element('p', {}, [full, text(' '), after]);
    const css = 'p { margin: 0 } .full { display: inline-block; width: 400px; height: 4px }';

    // The box fills the line exactly, and the space behind it takes no room, so the empty
    // span that follows stays on the same line.
    expect(page(css, [p]).rectOf(after)).toMatchObject({ x: 400, y: 0 });
  });

  it('gives a space at the end of a line no room at all', () => {
    const box = element('span', { classes: ['atomic'] });
    const empty = element('span', { classes: ['late'] });
    const p = element('p', {}, [box, text(' '), empty]);
    const css = 'p { margin: 0 } .atomic { display: inline-block; width: 20px; height: 8px }';

    // The space is the last thing on the line, so it hangs, and the empty span behind it
    // falls back to where the space began rather than sitting a space further along.
    expect(page(css, [p]).rectOf(empty).x).toBe(20);
  });

  it('keeps the first space of a nowrap run that crosses a box boundary', () => {
    const span = element('span', { classes: ['inner'] }, [text(' cd')]);
    const p = element('p', { classes: ['held'] }, [text('ab '), span]);
    const css = 'p { margin: 0 } .held { white-space: nowrap }';

    // One space between them, on the outside, so the span starts after it.
    expect(page(css, [p]).rectOf(span)).toMatchObject({ x: 24, width: 16 });
  });

  it('keeps the first space of a run that crosses a box boundary', () => {
    const span = element('span', { classes: ['crossing'] }, [text('ab ')]);
    const p = element('p', {}, [span, text(' cd')]);

    // One space between them, and it belongs to the span, so the span is wide enough for it.
    expect(page('p { margin: 0 }', [p]).rectOf(span)).toMatchObject({ x: 0, width: 24 });
  });

  it('keeps the first space of a run that starts inside a nowrap box', () => {
    const span = element('span', { classes: ['held'] }, [text('ab ')]);
    const p = element('p', {}, [span, text(' '), element('span', { classes: ['block'] })]);
    const css = 'p { margin: 0 } .held { white-space: nowrap } .block { display: inline-block }';

    // The space inside the span comes first, so it stays there, and the one after it collapses.
    expect(page(css, [p]).rectOf(span)).toMatchObject({ x: 0, width: 24 });
  });

  it('settles a nowrap space inside the box, in front of its padding', () => {
    const span = element('span', { classes: ['held'] }, [text('ab ')]);
    const p = element('p', {}, [text('x '), span, text('cd')]);
    const css = 'p { margin: 0 } .held { padding-right: 30px; white-space: nowrap }';

    expect(page(css, [p]).rectOf(span)).toMatchObject({ x: 16, width: 54 });
  });

  it('leaves an empty line alone when it has no edge to put there', () => {
    const span = element('span', { classes: ['bare'] }, [text('\n  one\n')]);
    const p = element('p', {}, [span]);
    const rect = page('p { margin: 0 } .bare { white-space: pre }', [p]).rectOf(span);

    // Three lines in the block, one of them with the word on it, and that is the box.
    expect({ y: rect.y, height: rect.height }).toEqual({ y: 16, height: 16 });
  });

  it('takes its height from its own font and not from what is inside it', () => {
    const tall = element('span', { classes: ['tall'] });
    const holder = element('span', { classes: ['holder'] }, [tall]);
    const p = element('p', {}, [holder]);
    const css = 'p { margin: 0 } .tall { display: inline-block; width: 8px; height: 30px }';
    const { rectOf } = page(css, [p]);

    // The stub font is 12.8 up and 3.2 down, so the holder is 16 tall on the baseline the
    // inline-block sets at 30, and it is as wide as the box inside it.
    expect(rectOf(tall).height).toBe(30);
    expect(rectOf(holder)).toMatchObject({ x: 0, y: 17.2, width: 8 });
    expect(rectOf(holder).height).toBeCloseTo(16);
  });

  it('covers a line it puts nothing on', () => {
    const box = element('div', { classes: ['kept'] }, [text('\n  one\n')]);
    const p = element('p', {}, [box]);
    const css = 'p { margin: 0 } .kept { display: inline; border: 1px solid; white-space: pre }';
    const rect = page(css, [p]).rectOf(box);

    // Three lines of sixteen, plus a border above the first and below the last.
    expect({ y: rect.y, height: rect.height }).toEqual({ y: -1, height: 50 });
  });

  it('does not give a box a line for a closing edge with nothing on it', () => {
    const first = element('div', { classes: ['kept'] }, [text('\n  one\n')]);
    const second = element('div', { classes: ['plain'] }, [text('two')]);
    const p = element('p', {}, [first, second]);
    const css =
      'p { margin: 0 } .kept { display: inline; white-space: pre } .plain { display: inline }';

    // The first box ends on the line the second one starts, but it puts nothing there.
    expect(page(css, [p]).rectOf(first)).toMatchObject({ y: 16, height: 16 });
  });

  it('drops the newline at the end of a tag that is inline to begin with', () => {
    const span = element('span', { classes: ['kept'] }, [text('\n  one\n')]);
    const p = element('p', {}, [span]);
    const css = 'p { margin: 0 } .kept { border: 1px solid; white-space: pre }';
    const rect = page(css, [p]).rectOf(span);

    // The same content in a span is two lines, not three, which is Chromium's answer and not
    // one the spec explains.
    expect({ y: rect.y, height: rect.height }).toEqual({ y: -1, height: 34 });
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

  it('resolves an inline-block percentage height against the block above it', () => {
    const box = element('span', { classes: ['half'] });
    const p = element('p', { classes: ['frame'] }, [box]);
    const css = 'p { margin: 0 } .half { display: inline-block; width: 8px; height: 50% }';

    // Half of the forty the paragraph was given, and nothing at all when it was given none.
    expect(page(`${css} .frame { height: 40px }`, [p]).rectOf(box).height).toBe(20);
    expect(page(css, [p]).rectOf(box).height).toBe(0);
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

describe('atomic inlines', () => {
  const css =
    'p { margin: 0 } .block { display: inline-block; width: 100px; height: 4px } .inl { display: inline } .over { display: inline-block; width: 110px; height: 4px } .full { display: inline-block; width: 100px; height: 4px } .out { position: absolute }';

  it('breaks beside an atomic inline with no space to break at', () => {
    const before = element('p', {}, [text('ab'), element('span', { classes: ['block'] })]);
    const after = element('p', {}, [element('span', { classes: ['block'] }), text('ab')]);

    expect(page(css, [before], 100).lines).toHaveLength(2);
    expect(page(css, [after], 100).lines).toHaveLength(2);
  });

  it('leaves an empty div behind on a line of its own, and keeps an empty span', () => {
    const div = element('div', { classes: ['inl'] });
    const span = element('span');
    const leaves = page(
      css,
      [element('p', {}, [div, element('span', { classes: ['over'] })])],
      100,
    );
    const keeps = page(
      css,
      [element('p', {}, [span, element('span', { classes: ['over'] })])],
      100,
    );

    // The line the div is left on holds nothing, so it has no height, and neither does the div.
    expect(leaves.lines).toHaveLength(2);
    expect(leaves.rectOf(div)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
    expect(keeps.lines).toHaveLength(1);
    expect(keeps.rectOf(span).height).toBe(16);
  });

  it('starts the next line for an inline box out of the flow that comes after a full one', () => {
    const late = element('span', { classes: ['out'] });
    const onTime = element('span', { classes: ['out'] });
    const over = page(css, [element('p', {}, [element('span', { classes: ['over'] }), late])], 100);
    const full = page(
      css,
      [element('p', {}, [element('span', { classes: ['full'] }), onTime])],
      100,
    );

    expect(over.rectOf(late)).toMatchObject({ x: 0, y: 16 });
    expect(full.rectOf(onTime)).toMatchObject({ x: 100, y: 0 });
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
