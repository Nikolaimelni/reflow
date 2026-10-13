import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, type ElementNode, element, text } from '../dom/node.js';
import type { Fragment } from '../trace/events.js';
import { layoutDocument } from './block.js';
import { fixedAdvanceMeasurer } from './text.js';

// Half an em per character, so "hello" is 40px at the default 16px font size.
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

  it('lets a line run a sixty-fourth of a pixel past the end and still fit', () => {
    const p = element('p', {}, [text('aa bb')]);

    // Forty wide in a box a LayoutUnit narrower than that stays on one line, as in Blink.
    expect(page('p { margin: 0 }', [p], 40 - 1 / 64).lines).toHaveLength(1);
    expect(page('p { margin: 0 }', [p], 40 - 2 / 64).lines).toHaveLength(2);
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

  it('lets a closing margin behind a space hang when more of the line follows', () => {
    const span = element('span', { classes: ['wide'] }, [text(' one one one ')]);
    const p = element('p', {}, [span, text('x')]);
    const css = 'p { margin: 0 } .wide { margin: 0 50px }';
    const { rectOf, lines } = page(css, [p], 180);

    // The same 188 that breaks the span when it ends the paragraph. With the x after it, the
    // line breaks at the space instead and keeps the margin, hanging over the edge.
    expect(lines).toHaveLength(2);
    expect(rectOf(span)).toMatchObject({ x: 50, y: 0, width: 88 });
  });

  it('measures a span end to end, so a negative margin inside can leave it no width', () => {
    const span = element('span', {}, [text('ab'), element('span', { classes: ['pull'] })]);
    const p = element('p', {}, [span]);
    const css = 'p { margin: 0 } .pull { display: inline-block; width: 0; margin: -12px }';

    // The word takes sixteen and the inline-block gives back twenty four, so the span ends
    // eight in front of where it started, and a box is never less than nothing.
    expect(page(css, [p]).rectOf(span)).toMatchObject({ x: 0, width: 0 });
  });

  it('does not count a box out of the flow as what follows a hanging closing edge', () => {
    const span = element('span', { classes: ['wide'] }, [text(' one one one ')]);
    const p = element('p', {}, [span, element('div', { classes: ['out'] })]);
    const css = 'p { margin: 0 } .wide { margin: 0 50px } .out { position: absolute }';

    // Nothing that takes room comes after the span, so its margin counts and the last word
    // goes down with it, the same as if the paragraph ended there.
    expect(page(css, [p], 180).lines).toHaveLength(2);
    expect(page(css, [p], 180).rectOf(span).height).toBe(32);
  });

  it('waits for a box to put something down before breaking for its padding', () => {
    const first = element('span', {}, [text('ab cd ef')]);
    const deep = element('div', { classes: ['deep'] }, [text('gh')]);
    const p = element('p', {}, [first, text(' '), deep]);
    const css = 'p { margin: 0 } .deep { display: inline; padding-left: 60px }';

    // The padding alone runs over, but the break is not taken until the word inside arrives,
    // and then it goes in front of the whole box rather than into the span before it.
    expect(page(css, [p], 120).rectOf(first)).toMatchObject({ y: 0, height: 16 });
  });

  it('lets the closing edge of a div made inline hang behind a space as well', () => {
    const box = element('div', { classes: ['wide'] }, [text(' one one one ')]);
    const p = element('p', {}, [box, text('x')]);
    const css = 'p { margin: 0 } .wide { display: inline; margin: 0 50px }';

    // What a div cannot do is hang the edges of a box with nothing in it; behind a space the
    // closing margin hangs the same as a span's.
    expect(page(css, [p], 180).rectOf(box)).toMatchObject({ y: 0, height: 16 });
  });

  it('counts an edge whose margin and padding cancel out as an edge', () => {
    const box = element('span', { classes: ['even'] }, [text('\nab')]);
    const p = element('p', {}, [box]);
    const css =
      'p { margin: 0 } .even { margin-left: -12px; padding-left: 12px; white-space: pre }';

    // Nothing wide, but a margin and a padding all the same, so the box starts on the line
    // above the word, where it opens.
    expect(page(css, [p]).rectOf(box)).toMatchObject({ y: 0, height: 32 });
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

  it('breaks in front of a box whose content opens with a space', () => {
    const box = element('span', { classes: ['padded'] }, [text(' cd')]);
    const p = element('p', {}, [element('span', { classes: ['block'] }), box]);
    const css =
      'p { margin: 0 } .block { display: inline-block; width: 80px } .padded { padding-left: 10px }';

    // Breaking after the space would leave the padding alone at the end of the line, so the
    // whole box goes down, and the space it opened with is not drawn there.
    expect(page(css, [p], 100).rectOf(box)).toMatchObject({ x: 0, y: 16, width: 26 });
  });

  it('breaks at the end of a run that crosses an empty box, not in front of it', () => {
    const empty = element('em', { classes: ['empty'] });
    const p = element('p', {}, [
      text('ab '),
      empty,
      text(' '),
      element('span', {}, [text('cdefgh')]),
    ]);
    const css = 'p { margin: 0 } .empty { padding: 0 10px }';

    // The two spaces collapse into the one in front of the em, but the line still breaks
    // where the run ends, so the em stays with the word before it.
    expect(page(css, [p], 60).rectOf(empty).y).toBe(0);
  });

  it('breaks at the first space of a run, before a box the run opens', () => {
    const boxed = element('span', { classes: ['boxed'] }, [text(' cd ')]);
    const p = element('p', {}, [element('span', { classes: ['block'] }), text(' '), boxed]);
    const css =
      'p { margin: 0 } .block { display: inline-block; width: 60px } .boxed { padding-left: 20px }';

    // The space inside the span collapses into the one before it, so that is where the line
    // breaks, and the span goes down whole with its padding.
    expect(page(css, [p], 100).rectOf(boxed)).toMatchObject({ x: 0, y: 16, width: 36 });
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

  it('keeps that newline when something follows the tag, and closes the tag in front of it', () => {
    const span = element('span', { classes: ['kept'] }, [text('\n  one\n')]);
    const after = element('span', {}, [text('x')]);
    const p = element('p', {}, [span, after]);
    const css = 'p { margin: 0 } .kept { border: 1px solid; white-space: pre }';
    const laid = page(css, [p]);

    // Still two lines for the span, with its border closing on the second, and the word that
    // follows starts the third.
    expect(laid.rectOf(span)).toMatchObject({ y: -1, height: 34 });
    expect(laid.rectOf(after).x).toBe(0);
    expect(laid.rectOf(after).y).toBeCloseTo(32);
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

  it('reports a span that draws nothing as what is inside it', () => {
    const build = (classes: string[]) =>
      element('span', { classes }, [
        text('a'),
        element('span', { classes: ['tall'] }, [text('b')]),
      ]);
    const css = 'p { margin: 0 } .tall { padding: 5px 0 } .kept { margin-top: 1px }';
    const bare = build([]);
    const kept = build(['kept']);

    // With no box of its own the outer span is its text and the span inside, padding and all.
    // A margin that moves nothing still gives it a box, and a box is as tall as its font.
    expect(page(css, [element('p', {}, [bare])]).rectOf(bare)).toMatchObject({ y: -5, height: 26 });
    expect(page(css, [element('p', {}, [kept])]).rectOf(kept)).toMatchObject({ y: 0, height: 16 });
  });

  it('reports a span with nothing but an empty bordered box in it as that box', () => {
    const ring = element('div', { classes: ['ring'] });
    const span = element('span', {}, [text('\n  '), ring, text('\n')]);
    const css = 'p { margin: 0 } .ring { display: inline; border: 1px solid }';

    expect(page(css, [element('p', {}, [span])]).rectOf(span)).toMatchObject({
      x: 0,
      y: -1,
      width: 2,
      height: 18,
    });
  });

  it('keeps a box for a span a block cut in two', () => {
    const span = element('span', {}, [
      text(' '),
      element('div', {}),
      text(' '),
      element('span', { classes: ['ring'] }),
      text(' '),
    ]);
    const css = 'p { margin: 0 } .ring { border: 1px solid }';

    // The half after the block is a box of its own, as tall as its font, rather than the
    // bordered span inside it.
    expect(page(css, [element('p', {}, [span])]).rectOf(span)).toMatchObject({ y: 0, height: 16 });
  });

  it('keeps a box for a span whose content needs one', () => {
    const tall = () => element('span', { classes: ['tall'] }, [text('b')]);
    const css =
      'p { margin: 0 } .tall { padding: 5px 0 } .ib { display: inline-block; width: 4px; height: 4px } .big { font-size: 20px } .apart { margin-left: 2px }';
    const heightOf = (inside: DomNode) => {
      const span = element('span', {}, [tall(), inside]);
      return page(css, [element('p', {}, [span])]).rectOf(span).height;
    };

    // An atomic inline, a font of other metrics and a margin each keep the span a box of its
    // own, which is only as tall as its font.
    expect(heightOf(element('span', { classes: ['ib'] }))).toBe(16);
    expect(heightOf(element('span', { classes: ['big'] }, [text('c')]))).toBe(16);
    expect(heightOf(element('span', { classes: ['apart'] }, [text('c')]))).toBe(16);
    expect(heightOf(text('c'))).toBe(26);
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

  it('does not break beside an atomic inline for nothing but the edges of an empty box', () => {
    const edges = element('span', { classes: ['edges'] });
    const p = element('p', {}, [element('span', { classes: ['full'] }), text(' '), edges]);
    const wide = `${css} .edges { padding-left: 20px }`;

    // A break there would start the next line with the space, which vanishes, and then the
    // padding, which is no more content than it was on this line.
    expect(page(wide, [p], 100).lines).toHaveLength(1);
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

  it('breaks in front of a div that opens before an atomic, whatever comes before it', () => {
    const lines = (before: DomNode[]) => {
      const opened = element('div', { classes: ['inl'] }, [element('span', { classes: ['over'] })]);
      return page(css, [element('p', {}, [...before, opened])], 100).lines.length;
    };

    // Chromium 153 glued the div to a word or an empty div in front of it. 156 does not.
    expect(lines([text('x')])).toBe(2);
    expect(lines([element('div', { classes: ['inl'] })])).toBe(2);
    expect(lines([text('x ')])).toBe(2);
    expect(lines([element('span', { classes: ['block'] })])).toBe(2);
  });

  it('breaks in front of a div that opens past the end and then breaks, but not a span', () => {
    const top = (tag: string) => {
      const opened = element(tag, { classes: ['inl', 'forced'] }, [text('\nyy')]);
      const wide = `${css} .forced { white-space: pre; padding-left: 40px }`;
      return page(wide, [element('p', {}, [text('xxxxxxxxxx '), opened])], 100).rectOf(opened).y;
    };

    // Eighty of text, a space, and forty of padding in a hundred. The space in front of the
    // span goes with the forced break, so there is nowhere to break and the padding hangs
    // over the end. In front of the div the space stays, and the div starts the next line.
    expect(top('span')).toBe(0);
    expect(top('div')).toBe(16);
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

  it('puts a block one under a box that opened and closed in front of it, and only then', () => {
    const under = element('div', { classes: ['out'] });
    const inside = element('div', { classes: ['out'] });
    const wide = `${css} .padded { padding-left: 10px }`;
    const before = page(wide, [
      element('p', {}, [element('span', { classes: ['padded'] }), under]),
    ]);
    const within = page(wide, [
      element('p', {}, [element('span', { classes: ['padded'] }, [inside])]),
    ]);

    expect(before.rectOf(under).y).toBe(16);
    expect(within.rectOf(inside).y).toBe(0);
  });

  it('leaves it where it was written when the line could not have broken there', () => {
    const late = element('span', { classes: ['out'] });
    const held = element('span', { classes: ['held'] }, [text('abcdefghijklm')]);
    const laid = page(
      `${css} .held { white-space: nowrap }`,
      [element('p', {}, [held, late])],
      100,
    );

    // Straight after a word that runs over, with no space and nothing atomic in between.
    expect(laid.rectOf(late)).toMatchObject({ x: 104, y: 0 });
  });

  it('leaves it where it was written when the text may not wrap', () => {
    const late = element('span', { classes: ['out'] });
    const held = element('p', { classes: ['held'] }, [
      element('span', { classes: ['over'] }),
      late,
    ]);
    const laid = page(`${css} .held { white-space: nowrap }`, [held], 100);

    expect(laid.rectOf(late)).toMatchObject({ x: 110, y: 0 });
  });
});

describe('an inline-block that aligns its content', () => {
  it('takes the baseline down with the lines it moved', () => {
    const word = element('span', {}, [text('x')]);
    const box = element('span', { classes: ['box'] }, [text('ab')]);
    const p = element('p', {}, [word, box]);
    const css =
      'p { margin: 0 } .box { display: inline-block; height: 40px; align-content: flex-end }';

    // The line in the inline-block moved 24 down to the bottom of its forty, and the word
    // beside it sits on that line's baseline, not on the one it would have had at the top.
    expect(page(css, [p]).rectOf(word).y).toBeCloseTo(24);
  });
});

describe('a line with nothing on it', () => {
  it('gives an inline-block no baseline from it', () => {
    const box = element('span', { classes: ['box'] }, [element('div', { classes: ['out'] })]);
    const p = element('p', {}, [text('x'), box]);
    const css =
      'p { margin: 0 } .box { display: inline-block; width: 10px; height: 40px } .out { position: absolute }';

    // Its only line holds a box out of the flow, which does not count, so the inline-block
    // sits on its bottom edge: forty above the baseline and the descent of the strut below.
    expect(page(css, [p]).rectOf(p).height).toBeCloseTo(43.2);
  });

  it('moves an empty inline left on it by its relative offset, down as well as across', () => {
    const empty = element('span', { classes: ['moved'] });
    const css = 'p { margin: 0 } .moved { position: relative; top: 3px; left: 2px }';

    expect(page(css, [element('p', {}, [empty])]).rectOf(empty)).toMatchObject({
      x: 2,
      y: 3,
      width: 0,
      height: 0,
    });
  });
});

describe('an inline-block whose last child clips', () => {
  it('sits on the bottom margin edge of that child, even above its own top', () => {
    const word = element('span', {}, [text('x')]);
    const box = element('span', { classes: ['box'] }, [element('div', { classes: ['clips'] })]);
    const p = element('p', {}, [word, box]);
    const css =
      'p { margin: 0 } .box { display: inline-block } .clips { overflow: hidden; margin-top: -12px }';

    // The child ends twelve above the inline-block's top, so that is its baseline, and the
    // inline-block sits twelve below the line's baseline: the line is that much deeper.
    expect(page(css, [p]).rectOf(p).height).toBeCloseTo(12.8 + 12);
  });

  it('takes its own baseline from a flex container that clips, no lower than its bottom', () => {
    const baselineOf = (inside: DomNode[]) => {
      const mark = element('span', { classes: ['mark'] });
      const box = element('span', { classes: ['box'] }, inside);
      const laid = page(
        'p { margin: 0 } .mark { display: inline-block } .box { display: inline-block } .row { display: flex; overflow: hidden; height: 6px; margin-bottom: 5px }',
        [element('p', {}, [mark, box])],
      );
      return laid.rectOf(mark).y - laid.rectOf(box).y;
    };
    const row = (inside: DomNode[] = []) => element('div', { classes: ['row'] }, inside);

    // The word's baseline is 12.8 down, and the six pixel row cuts it off at its bottom border
    // edge rather than at the margin under it. An empty row gives no baseline at all, so the
    // line above it keeps its own.
    expect(baselineOf([row([element('div', {}, [text('x')])])])).toBe(6);
    expect(baselineOf([element('div', {}, [text('x')]), row()])).toBeCloseTo(12.8);
  });
});

describe('list markers', () => {
  const item = (css: string, children: DomNode[] = []) => {
    const li = element('li', {}, children);
    const list = element('ul', {}, [li]);
    return page(`ul { margin: 0; padding: 0 } ${css}`, [list]).rectOf(li);
  };

  it('gives an empty item a line for a marker outside it, and none without one', () => {
    expect(item('').height).toBe(16);
    expect(item('ul { list-style-type: none }').height).toBe(0);
  });

  it('makes the first line real for what sits on it beside an outside marker', () => {
    const empty = element('span');
    const li = element('li', {}, [empty]);
    const laid = page('ul { margin: 0; padding: 0 }', [element('ul', {}, [li])]);

    // On its own the empty span makes no line, but the marker is on it, so the span gets the
    // strut of a real one.
    expect(laid.rectOf(empty).height).toBe(16);
  });

  it('pushes the text along by a number inside the item', () => {
    const word = element('span', {}, [text('x')]);
    const li = element('li', {}, [word]);
    const laid = page('ul { margin: 0; padding: 0; list-style: decimal inside }', [
      element('ul', {}, [li]),
    ]);

    // "1. " is three characters at eight each.
    expect(laid.rectOf(word).x).toBe(24);
  });

  it('pushes it by the room Blink gives a symbol, not by a character', () => {
    const word = element('span', {}, [text('x')]);
    const li = element('li', {}, [word]);
    const laid = page('ul { margin: 0; padding: 0; list-style-position: inside }', [
      element('ul', {}, [li]),
    ]);

    // An ascent of 12.8 rounds to 13, which makes a symbol of 6, then a pixel back and an em on.
    expect(laid.rectOf(word).x).toBe(21);
  });

  it('lets the space after a number hang when nothing follows it', () => {
    const empty = element('li', {});
    const full = element('li', {}, [text('x')]);
    const css =
      'ol { margin: 0; padding: 0; list-style: decimal inside } li { position: absolute }';

    // "1." is sixteen wide and the space after it eight, which only counts once there is
    // something for it to stand in front of.
    expect(page(css, [element('ol', {}, [empty])]).rectOf(empty).width).toBe(16);
    expect(page(css, [element('ol', {}, [full])]).rectOf(full).width).toBe(32);
  });

  it('drops the space after it and can break straight after it', () => {
    const word = element('span', {}, [text('ab')]);
    const css = 'ul { margin: 0; padding: 0; list-style: decimal inside }';
    const list = () => element('ul', {}, [element('li', {}, [text(' '), word, text(' cd')])]);

    // The space goes the way one at the start of a line would, so "1. " is all there is in
    // front of the word. Too narrow for both, and the line breaks after the marker.
    expect(page(css, [list()]).rectOf(word).x).toBe(24);
    expect(page(css, [list()], 30).rectOf(word)).toMatchObject({ x: 0, y: 16 });
  });
});

describe('a positioned inline', () => {
  const css =
    'p { margin: 0 } .anchor { position: relative; padding: 0 4px; border-left: 2px solid; border-right: 2px solid } .fill { position: absolute; left: 0; right: 0; top: 0; bottom: 0 }';

  it('is the containing block for what is out of the flow inside it', () => {
    const fill = element('span', { classes: ['fill'] });
    const anchor = element('span', { classes: ['anchor'] }, [text('ab'), fill]);
    const p = element('p', {}, [text('x '), anchor]);

    // Its padding box: past the word, the space and its own border, and as wide as its text
    // and padding.
    expect(page(css, [p]).rectOf(fill)).toMatchObject({ x: 18, y: 0, width: 24, height: 16 });
  });

  it('counts the block between its halves as one of its boxes when a block cuts it', () => {
    const fill = element('span', { classes: ['fill'] });
    const cut = element('div', { classes: ['cut'] });
    const anchor = element('span', { classes: ['plain'] }, [fill, cut]);
    const p = element('p', {}, [anchor]);
    const wide = `${css} .plain { position: relative } .cut { height: 20px; width: 50px }`;

    // Nothing after the block, so the box around it is the last one and the containing block
    // is as wide as the line and as tall as the block.
    expect(page(wide, [p], 100).rectOf(fill)).toMatchObject({ x: 0, y: 0, width: 100, height: 20 });
  });

  it('is the containing block for what is absolute inside the block that cut it', () => {
    const fill = element('span', { classes: ['fill'] });
    const anchor = element('span', { classes: ['plain'] }, [text('x'), element('div', {}, [fill])]);
    const wide = `${css} .plain { position: relative }`;

    // The block between the halves holds nothing that takes room, so it has no height and does
    // not count, and nor does the empty half after it: the first half is all there is.
    expect(page(wide, [element('p', {}, [anchor])], 100).rectOf(fill)).toMatchObject({
      x: 0,
      y: 0,
      width: 8,
      height: 16,
    });
  });

  it('moves the block that cut it along with its own offset', () => {
    const cut = element('div', { classes: ['cut'] });
    const anchor = element('span', { classes: ['moved'] }, [text('x'), cut]);
    const moved = `${css} .moved { position: relative; top: 2px; left: 10% } .cut { height: 4px }`;

    // Down with the halves, and across by a tenth of the block they are all in.
    expect(page(moved, [element('p', {}, [anchor])], 100).rectOf(cut)).toMatchObject({
      x: 10,
      y: 18,
    });
  });

  it('runs from its first box to its last when it wraps', () => {
    const fill = element('span', { classes: ['fill'] });
    const anchor = element('span', { classes: ['anchor'] }, [text('abcd efgh'), fill]);
    const p = element('p', {}, [text('x '), anchor]);

    // From the padding edge on the first line, at 18, to the padding edge on the second, at
    // 36, so the block is narrower than the first box and two lines tall.
    expect(page(css, [p], 60).rectOf(fill)).toMatchObject({ x: 18, y: 0, width: 18, height: 32 });
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
