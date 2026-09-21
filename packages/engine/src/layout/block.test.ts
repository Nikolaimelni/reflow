import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, type ElementNode, element, text } from '../dom/node.js';
import { type Fragment, frameAt, replay } from '../trace/events.js';
import { layoutDocument, type Viewport } from './block.js';
import { fixedAdvanceMeasurer } from './text.js';

const VIEWPORT: Viewport = { width: 400, height: 300 };

function page(css: string, children: DomNode[], viewport = VIEWPORT) {
  const root = element('html', {}, children);
  const boxTree = buildBoxTree(root, computeStyles(root, css));
  if (boxTree === null) throw new Error('the root generated no box');

  const result = layoutDocument(boxTree, viewport, fixedAdvanceMeasurer());
  const byElement = new Map<ElementNode, BoxId>();
  walkBoxes(boxTree, (box: Box) => {
    if (box.kind === 'block' && box.element !== null) byElement.set(box.element, box.id);
  });

  const rectOf = (node: ElementNode): Fragment['rect'] => {
    const id = byElement.get(node);
    const fragment = id === undefined ? undefined : result.fragments.get(id);
    if (fragment === undefined) throw new Error(`no fragment for <${node.tag}>`);
    return fragment.rect;
  };

  return { result, rectOf };
}

describe('widths', () => {
  it('fills the containing block when width is auto', () => {
    const div = element('div');
    expect(page('', [div]).rectOf(div)).toMatchObject({ x: 0, width: 400 });
  });

  it('takes margins out of an auto width', () => {
    const div = element('div');
    expect(page('div { margin: 0 25px }', [div]).rectOf(div)).toMatchObject({ x: 25, width: 350 });
  });

  it('centres a fixed width between auto margins', () => {
    const div = element('div');
    const css = 'div { width: 200px; margin-left: auto; margin-right: auto }';
    expect(page(css, [div]).rectOf(div)).toMatchObject({ x: 100, width: 200 });
  });

  it('lets the right margin give when the box is over-constrained', () => {
    const div = element('div');
    const css = 'div { width: 300px; margin-left: 50px; margin-right: 300px }';
    expect(page(css, [div]).rectOf(div)).toMatchObject({ x: 50, width: 300 });
  });

  it('counts padding and border inside the width under border-box', () => {
    const div = element('div');
    const css = 'div { box-sizing: border-box; width: 200px; padding: 10px; border: 5px solid }';
    expect(page(css, [div]).rectOf(div)).toMatchObject({ width: 200 });
  });

  it('counts padding and border outside the width under content-box', () => {
    const div = element('div');
    const css = 'div { width: 200px; padding: 10px; border: 5px solid }';
    expect(page(css, [div]).rectOf(div)).toMatchObject({ width: 230 });
  });

  it('clamps to max-width and keeps the margins honest', () => {
    const div = element('div');
    const css = 'div { width: 380px; max-width: 100px; margin-left: auto; margin-right: auto }';
    expect(page(css, [div]).rectOf(div)).toMatchObject({ x: 150, width: 100 });
  });
});

describe('heights', () => {
  it('takes an auto height from the children', () => {
    const child = element('div', { classes: ['tall'] });
    const parent = element('div', { classes: ['host'] }, [child]);
    expect(page('.tall { height: 70px }', [parent]).rectOf(parent)).toMatchObject({ height: 70 });
  });

  it('treats a percentage height as auto when the parent height is auto', () => {
    const child = element('div', { classes: ['half'] });
    const parent = element('div', {}, [child]);
    const css = '.half { height: 50% }';
    expect(page(css, [parent]).rectOf(child)).toMatchObject({ height: 0 });
  });

  it('resolves a percentage height once the parent has one', () => {
    const child = element('div', { classes: ['half'] });
    const parent = element('div', { classes: ['host'] }, [child]);
    const css = '.host { height: 200px } .half { height: 50% }';
    expect(page(css, [parent]).rectOf(child)).toMatchObject({ height: 100 });
  });
});

describe('margin collapsing', () => {
  it('collapses two adjacent siblings to the larger margin', () => {
    const first = element('div', { classes: ['a'] });
    const second = element('div', { classes: ['b'] });
    const css = '.a { height: 10px; margin-bottom: 20px } .b { height: 10px; margin-top: 30px }';
    const { rectOf } = page(css, [first, second]);

    expect(rectOf(first).y).toBe(0);
    expect(rectOf(second).y).toBe(40);
  });

  it('keeps the most negative and the largest positive', () => {
    const first = element('div', { classes: ['a'] });
    const second = element('div', { classes: ['b'] });
    const css = '.a { height: 10px; margin-bottom: 40px } .b { height: 10px; margin-top: -15px }';
    expect(page(css, [first, second]).rectOf(second).y).toBe(35);
  });

  it('collapses a parent with its first child', () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['outer'] }, [inner]);
    const css = '.outer { margin-top: 20px } .inner { margin-top: 30px; height: 50px }';
    const { rectOf } = page(css, [outer]);

    expect(rectOf(outer).y).toBe(30);
    expect(rectOf(inner).y).toBe(30);
    expect(rectOf(outer).height).toBe(50);
  });

  it('resolves a percentage height against the height the box ends up with', () => {
    const inner = element('div', { classes: ['share'] });
    const outer = element('div', { classes: ['floored'] }, [inner]);
    const css = '.floored { height: 0; min-height: 40px } .share { height: 25% }';

    // A quarter of the forty it was clamped to, not of the nothing it asked for.
    expect(page(css, [outer]).rectOf(inner).height).toBe(10);
  });

  it('lets a column that wraps be as wide as its content asks', () => {
    const css =
      '.down { display: flex; flex-direction: column; width: 40px } .wraps { flex-wrap: wrap }';
    const widthOf = (classes: string[]) => {
      const item = element('div', {}, [text('abcdefgh ab')]);
      const column = element('div', { classes }, [item]);
      return page(css, [column]).rectOf(item).width;
    };

    // The longest word is 64 wide and the column is 40. A column that wraps lets its line be
    // as wide as the item asks for and overflows; one that does not stretches the item to the
    // column and the text breaks inside it instead.
    expect(widthOf(['down', 'wraps'])).toBe(64);
    expect(widthOf(['down'])).toBe(40);
  });

  it('keeps a margin inside a flex item', () => {
    const inner = element('div', { classes: ['inner'] });
    const item = element('div', {}, [inner]);
    const row = element('div', { classes: ['row'] }, [item]);
    const css = '.row { display: flex } .inner { height: 4px; margin-bottom: 6px }';

    // A flex item is a formatting context of its own, so the margin is paid for inside it.
    expect(page(css, [row]).rectOf(item).height).toBe(10);
  });

  it('does not make an item out of whitespace, even preserved whitespace', () => {
    const row = element('div', { classes: ['row'] }, [
      text('\n  '),
      element('div', { classes: ['cell'] }),
      text('\n'),
    ]);
    const css = '.row { display: flex; white-space: pre } .cell { width: 10px; height: 4px }';

    expect(page(css, [row]).rectOf(row).height).toBe(4);
  });

  it('drops a flex item automatic minimum when it clips', () => {
    const css = '.row { display: flex } .item { flex-basis: 0 } .hidden { overflow: hidden }';
    const widthOf = (classes: string[]) => {
      const item = element('div', { classes }, [text('ab')]);
      const row = element('div', { classes: ['row'] }, [item]);
      return page(css, [row]).rectOf(item).width;
    };

    // The word is sixteen wide and holds the item open, unless the item hides what runs over.
    expect(widthOf(['item'])).toBe(16);
    expect(widthOf(['item', 'hidden'])).toBe(0);
  });

  it('caps a flex item automatic minimum at its width and its maximum', () => {
    const css =
      '.row { display: flex } .flat { width: 0% } .thin { width: 4px } .capped { max-width: 0% }';
    const widthOf = (classes: string[]) => {
      const item = element('div', { classes }, [text('ab')]);
      const row = element('div', { classes: ['row'] }, [item]);
      return page(css, [row]).rectOf(item).width;
    };

    // The word is sixteen wide and would hold an auto width open. A width of its own is the
    // most the content is protected up to.
    expect(widthOf(['flat'])).toBe(0);
    expect(widthOf(['thin'])).toBe(4);
    expect(widthOf(['capped'])).toBe(0);
  });

  it('measures a flex item with the container as the percentage basis', () => {
    const cell = element('div', { classes: ['cell'] }, [text('ab')]);
    const row = element('div', { classes: ['row'] }, [cell]);
    const css = '.row { display: flex; width: 200px } .cell { padding: 1% }';

    // Two per cent of the row, not of the sixteen pixels the item shrank to.
    expect(page(css, [row]).rectOf(row).height).toBe(20);
  });

  it('lays out flex items in the order they ask for', () => {
    const first = element('div', { classes: ['cell'] });
    const second = element('div', { classes: ['cell', 'early'] });
    const row = element('div', { classes: ['row'] }, [first, second]);
    const css = '.row { display: flex } .cell { width: 10px; height: 4px } .early { order: -1 }';
    const laid = page(css, [row]);

    expect(laid.rectOf(second).x).toBe(0);
    expect(laid.rectOf(first).x).toBe(10);
  });

  it('resolves a percentage gap against the axis it runs along', () => {
    const first = element('div', { classes: ['cell'] });
    const second = element('div', { classes: ['cell'] });
    const row = element('div', { classes: ['row', 'apart'] }, [first, second]);
    const css =
      '.row { display: flex } .apart { width: 200px; gap: 10% } .cell { width: 10px; height: 4px }';

    // A tenth of the two hundred the row is across, not of the four it is tall.
    expect(page(css, [row]).rectOf(second).x).toBe(30);
  });

  it('clamps a flex item cross size the way a block is clamped', () => {
    const cell = element('div', { classes: ['flat'] });
    const row = element('div', { classes: ['row'] }, [cell]);
    const css = '.row { display: flex } .flat { width: 20px; height: 0; min-height: 6px }';

    expect(page(css, [row]).rectOf(cell).height).toBe(6);
  });

  it('collapses a margin through an inline that puts nothing on a line', () => {
    const css = '.after { margin-top: 18px; height: 10px } .marked { padding-left: 4px }';
    const build = (span: ElementNode) =>
      element('div', {}, [span, element('div', { classes: ['after'] })]);

    const bare = build(element('span', {}));
    const padded = build(element('span', { classes: ['marked'] }));

    // The padded one is drawn, so it makes a line, and the line stops the margin escaping.
    expect(page(css, [bare]).rectOf(bare)).toMatchObject({ y: 18, height: 10 });
    expect(page(css, [padded]).rectOf(padded)).toMatchObject({ y: 0, height: 44 });

    // A negative margin takes room the same way, so it stops the margin escaping too.
    const pulled = build(element('span', { classes: ['pulled'] }));
    expect(page(`${css} .pulled { margin: -12px }`, [pulled]).rectOf(pulled)).toMatchObject({
      y: 0,
    });
  });

  it('keeps a preserved whitespace box between two blocks', () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['kept'] }, [text('\n  '), inner, text('\n')]);
    const css = '.kept { white-space: pre } .inner { height: 10px }';
    const { rectOf } = page(css, [outer]);

    // Two lines above it and one below, at the stub measurer's sixteen pixels a line.
    expect(rectOf(inner).y).toBe(32);
    expect(rectOf(outer).height).toBe(58);
  });

  it('keeps a child margin inside an inline-block', () => {
    const inner = element('div', { classes: ['inner'] });
    const holder = element('div', { classes: ['holder'] }, [inner]);
    const css = '.holder { display: inline-block } .inner { margin-top: 20px; height: 10px }';

    expect(page(css, [holder]).rectOf(inner).y).toBe(20);
  });

  it('stops collapsing at a border', () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['outer'] }, [inner]);
    const css =
      '.outer { margin-top: 20px; border-top: 1px solid } .inner { margin-top: 30px; height: 50px }';
    const { rectOf } = page(css, [outer]);

    expect(rectOf(outer).y).toBe(20);
    expect(rectOf(inner).y).toBe(51);
  });

  it('stops collapsing at a padding', () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['outer'] }, [inner]);
    const css = '.outer { margin-top: 20px; padding-top: 5px } .inner { margin-top: 30px }';
    expect(page(css, [outer]).rectOf(inner).y).toBe(55);
  });

  it('stops collapsing at a block formatting context', () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['outer'] }, [inner]);
    const css = '.outer { overflow: hidden } .inner { margin-top: 30px; height: 10px }';
    const { rectOf } = page(css, [outer]);

    expect(rectOf(outer).y).toBe(0);
    expect(rectOf(inner).y).toBe(30);
  });

  it('does not let a percentage height collapse through', () => {
    const middle = element('div', { classes: ['share'] });
    const after = element('div', { classes: ['after'] });
    const outer = element('div', { classes: ['outer'] }, [middle, after]);
    const css = '.outer { height: 100px } .share { height: 50% } .after { height: 10px }';

    // Fifty of a hundred is a height like any other, so the box below it starts at fifty.
    expect(page(css, [outer]).rectOf(after).y).toBe(50);
  });

  it('lets an empty box collapse through and takes no height from it', () => {
    const first = element('div', { classes: ['a'] });
    const empty = element('div', { classes: ['gap'] });
    const second = element('div', { classes: ['b'] });
    const css =
      '.a { height: 10px; margin-bottom: 10px } .gap { margin: 25px 0 } .b { height: 10px; margin-top: 5px }';

    expect(page(css, [first, empty, second]).rectOf(second).y).toBe(35);
  });
});

describe('align-content on a block container', () => {
  const inside = (declarations: string, kid = '.kid { height: 20px }') => {
    const child = element('div', { classes: ['kid'] });
    const box = element('div', { classes: ['box'] }, [child]);
    const laid = page(`.box { ${declarations} } ${kid}`, [box]);

    return { box: laid.rectOf(box), kid: laid.rectOf(child) };
  };

  it('pushes the group to the far edge of a box with room to spare', () => {
    expect(inside('height: 100px; align-content: flex-end').kid.y).toBe(80);
    expect(inside('height: 100px; align-content: center').kid.y).toBe(40);
  });

  it('falls back for the values with nothing to distribute', () => {
    expect(inside('height: 100px; align-content: space-between').kid.y).toBe(0);
    expect(inside('height: 100px; align-content: space-around').kid.y).toBe(40);
  });

  it('aligns inside the height a minimum gave the box', () => {
    expect(inside('min-height: 100px; align-content: flex-end').kid.y).toBe(80);
  });

  it('leaves content taller than the box where it is', () => {
    const css = '.kid { height: 200px }';
    expect(inside('height: 100px; align-content: center', css).kid.y).toBe(0);
  });

  it('keeps the margins of the group inside the box it is aligned in', () => {
    const css = '.kid { height: 20px; margin: 10px 0 }';

    // Forty of content to place, so the group starts sixty down and the child ten below that.
    expect(inside('height: 100px; align-content: flex-end', css).kid.y).toBe(70);
    // Nothing escapes a box that aligns, so with no height of its own it pays for both.
    expect(inside('align-content: flex-end', css).box.height).toBe(40);
  });
});

describe('the trace', () => {
  const build = () => {
    const inner = element('div', { classes: ['inner'] });
    const outer = element('div', { classes: ['outer'] }, [inner, element('p')]);
    const css = '.outer { margin: 20px; padding: 4px } .inner { margin-top: 30px; height: 50px }';
    return page(css, [outer, element('div', { classes: ['after'] })]);
  };

  it('replays to exactly the geometry the engine produced', () => {
    const { result } = build();
    expect(replay(result.trace)).toEqual(result.fragments);
  });

  it('survives a round trip through JSON', () => {
    const { result } = build();
    expect(JSON.parse(JSON.stringify(result.trace))).toEqual(result.trace);
  });

  it('reaches the same frame by folding a prefix of the events', () => {
    const { result } = build();
    expect(frameAt(result.trace, result.trace.length)).toEqual(result.fragments);
    expect(frameAt(result.trace, 0).size).toBe(0);
  });

  it('records a measurement before every size it resolves', () => {
    const { result } = build();
    const measured = new Set<BoxId>();

    for (const event of result.trace) {
      if (event.t === 'measure:start') measured.add(event.box);
      if (event.t === 'size:resolved') expect(measured.has(event.box)).toBe(true);
    }
  });

  it('reports the collapse that actually happened', () => {
    const first = element('div', { classes: ['a'] });
    const second = element('div', { classes: ['b'] });
    const css = '.a { height: 10px; margin-bottom: 20px } .b { height: 10px; margin-top: 30px }';
    const { result } = page(css, [first, second]);

    const collapses = result.trace.filter((event) => event.t === 'margin:collapsed');
    expect(collapses).toContainEqual(expect.objectContaining({ from: [20, 30], to: 30 }));
  });
});
