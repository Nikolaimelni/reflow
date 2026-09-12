import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, type ElementNode, element } from '../dom/node.js';
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

  it('lets an empty box collapse through and takes no height from it', () => {
    const first = element('div', { classes: ['a'] });
    const empty = element('div', { classes: ['gap'] });
    const second = element('div', { classes: ['b'] });
    const css =
      '.a { height: 10px; margin-bottom: 10px } .gap { margin: 25px 0 } .b { height: 10px; margin-top: 5px }';

    expect(page(css, [first, empty, second]).rectOf(second).y).toBe(35);
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
