import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, type ElementNode, element, text } from '../dom/node.js';
import type { Fragment } from '../trace/events.js';
import { layoutDocument } from './block.js';
import { fixedAdvanceMeasurer } from './text.js';

const measurer = fixedAdvanceMeasurer();

function page(css: string, children: DomNode[], width = 400) {
  const root = element('html', {}, children);
  const boxTree = buildBoxTree(root, computeStyles(root, css));
  if (boxTree === null) throw new Error('the root generated no box');

  const result = layoutDocument(boxTree, { width, height: 300 }, measurer);
  const byElement = new Map<ElementNode, BoxId>();

  walkBoxes(boxTree, (box: Box) => {
    if (box.kind !== 'text' && box.element !== null) byElement.set(box.element, box.id);
  });

  return (node: ElementNode): Fragment['rect'] => {
    const id = byElement.get(node);
    const fragment = id === undefined ? undefined : result.fragments.get(id);
    if (fragment === undefined) throw new Error(`no fragment for <${node.tag}>`);
    return fragment.rect;
  };
}

describe('position relative', () => {
  it('takes the static position from the display the box would have had', () => {
    const bare = element('div', { classes: ['out'] });
    const line = element('p', {}, [text('ab'), bare]);
    const css = 'p { margin: 0 } .out { position: absolute; width: 5px; height: 5px }';

    // A div among the text would have been a block on the next line down, not beside it.
    expect(page(css, [line])(bare)).toMatchObject({ x: 0, y: 16 });

    // With nothing in front of it, that block would have been the first thing in the box.
    const first = element('div', { classes: ['out'] });
    expect(page(css, [element('p', {}, [first, text('ab')])])(first)).toMatchObject({ y: 0 });

    // An empty span with a padding is still something in front of it.
    const after = element('div', { classes: ['out'] });
    const padded = element('span', { classes: ['pad'] });
    const held = element('p', {}, [padded, after]);
    expect(page(`${css} .pad { padding: 2px }`, [held])(after)).toMatchObject({ y: 16 });

    // A flex box is block level in flow, so it goes under the line like any other block.
    const flexed = element('span', { classes: ['out', 'flexed'] });
    const holding = element('p', {}, [text('ab'), flexed]);
    expect(page(`${css} .flexed { display: flex }`, [holding])(flexed)).toMatchObject({ y: 16 });
  });

  it('keeps an out of flow box in the line it was written in', () => {
    const badge = element('span', { classes: ['badge'] });
    const card = element('span', { classes: ['card'] }, [text('ab'), badge]);
    const line = element('p', {}, [text('x '), card]);
    const css =
      'p { margin: 0 } .card { display: inline-block } .badge { position: absolute; width: 5px; height: 5px }';
    const rectOf = page(css, [line]);

    // The card starts after "x ", and the badge takes its static position from inside it
    // without widening it or pushing anything down.
    expect(rectOf(card)).toMatchObject({ x: 16, width: 16 });
    expect(rectOf(badge)).toMatchObject({ x: 32, width: 5 });
  });

  it('resolves its own percentage padding against the containing block', () => {
    const box = element('div', { classes: ['empty'] });
    const css =
      '.empty { position: absolute; box-sizing: border-box; min-height: 2px; padding: 1% }';

    // One per cent of 400, twice, and the min-height is already inside that border box.
    expect(page(css, [box])(box).height).toBe(8);
  });

  it('shifts the box and leaves its space behind', () => {
    const moved = element('div', { classes: ['moved'] });
    const after = element('div', { classes: ['after'] });
    const css = 'div { height: 20px } .moved { position: relative; top: 5px; left: 7px } .after {}';
    const rectOf = page(css, [moved, after]);

    expect(rectOf(moved)).toMatchObject({ x: 7, y: 5 });
    expect(rectOf(after)).toMatchObject({ x: 0, y: 20 });
  });

  it('moves the other way when only the far side is given', () => {
    const moved = element('div', { classes: ['moved'] });
    const css = 'div { height: 20px } .moved { position: relative; bottom: 8px; right: 3px }';
    expect(page(css, [moved])(moved)).toMatchObject({ x: -3, y: -8 });
  });

  it('ignores the far side when both are given', () => {
    const moved = element('div', { classes: ['moved'] });
    const css = 'div { height: 20px } .moved { position: relative; left: 4px; right: 40px }';
    expect(page(css, [moved])(moved)).toMatchObject({ x: 4 });
  });

  it('carries its children along', () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['outer'] }, [inner]);
    const css = '.outer { position: relative; top: 10px } .inner { height: 5px }';
    expect(page(css, [outer])(inner)).toMatchObject({ y: 10 });
  });
});

describe('position absolute', () => {
  it('leaves the flow, so the next sibling closes over it', () => {
    const gone = element('div', { classes: ['gone'] });
    const after = element('div', { classes: ['after'] });
    const css = 'div { height: 20px } .gone { position: absolute; top: 100px; left: 50px }';
    const rectOf = page(css, [gone, after]);

    expect(rectOf(gone)).toMatchObject({ x: 50, y: 100 });
    expect(rectOf(after)).toMatchObject({ y: 0 });
  });

  it('hangs from the nearest positioned ancestor, not the nearest parent', () => {
    const target = element('div', { classes: ['target'] });
    const middle = element('div', { classes: ['middle'] }, [target]);
    const anchor = element('div', { classes: ['anchor'] }, [middle]);
    const css =
      '.anchor { position: relative; margin: 30px } .middle { margin: 10px }' +
      ' .target { position: absolute; left: 5px; top: 5px; width: 10px; height: 10px }';

    expect(page(css, [anchor])(target)).toMatchObject({ x: 35, y: 35 });
  });

  it('falls back to the viewport when no ancestor is positioned', () => {
    const target = element('div', { classes: ['target'] });
    const middle = element('div', { classes: ['middle'] }, [target]);
    const css =
      '.middle { margin: 20px } .target { position: absolute; right: 0; bottom: 0;' +
      ' width: 10px; height: 10px }';

    expect(page(css, [middle])(target)).toMatchObject({ x: 390, y: 290 });
  });

  it('takes its width from both insets when width is auto', () => {
    const target = element('div', { classes: ['target'] });
    const css = '.target { position: absolute; left: 30px; right: 70px; height: 10px }';
    expect(page(css, [target])(target)).toMatchObject({ x: 30, width: 300 });
  });

  it('centres itself when the insets over-constrain it and the margins are auto', () => {
    const target = element('div', { classes: ['target'] });
    const css =
      '.target { position: absolute; left: 0; right: 0; width: 100px; height: 10px;' +
      ' margin-left: auto; margin-right: auto }';
    expect(page(css, [target])(target)).toMatchObject({ x: 150, width: 100 });
  });

  it('stays at its static position while both insets are auto', () => {
    const first = element('div', { classes: ['first'] });
    const target = element('div', { classes: ['target'] }, [text('ab')]);
    const css = '.first { height: 25px } .target { position: absolute }';

    expect(page(css, [first, target])(target)).toMatchObject({ x: 0, y: 25 });
  });

  it('shrinks to fit when nothing pins its width', () => {
    const target = element('div', { classes: ['target'] }, [text('one two')]);
    const css = '.target { position: absolute; left: 0 }';
    // "one two" is 56px wide with the fixed measurer, well under the 400px available
    expect(page(css, [target])(target)).toMatchObject({ width: 56 });
  });

  it('takes its height from its content when top alone is given', () => {
    const inner = element('div', { classes: ['inner'] });
    const target = element('div', { classes: ['target'] }, [inner]);
    const css = '.target { position: absolute; top: 10px; width: 50px } .inner { height: 40px }';
    expect(page(css, [target])(target)).toMatchObject({ y: 10, height: 40 });
  });

  it('is measured against the padding box of its containing block', () => {
    const target = element('div', { classes: ['target'] });
    const anchor = element('div', { classes: ['anchor'] }, [target]);
    const css =
      '.anchor { position: relative; padding: 12px; border: 3px solid; margin: 0 }' +
      ' .target { position: absolute; left: 0; top: 0; width: 10px; height: 10px }';

    // the padding box starts inside the border but outside the padding
    expect(page(css, [anchor])(target)).toMatchObject({ x: 3, y: 3 });
  });
});
