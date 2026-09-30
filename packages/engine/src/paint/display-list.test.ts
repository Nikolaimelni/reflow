import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, element, text } from '../dom/node.js';
import { layoutDocument } from '../layout/block.js';
import { fixedAdvanceMeasurer } from '../layout/text.js';
import { buildDisplayList, hitTest } from './display-list.js';

function order(css: string, children: DomNode[]) {
  const root = element('html', {}, children);
  const boxTree = buildBoxTree(root, computeStyles(root, css));
  if (boxTree === null) throw new Error('the root generated no box');

  const names = new Map<BoxId, string>();
  walkBoxes(boxTree, (box: Box) => {
    if (box.kind === 'text') names.set(box.id, `"${box.text.trim()}"`);
    else if (box.element === null) names.set(box.id, 'anon');
    else names.set(box.id, box.element.classes[0] ?? box.element.tag);
  });

  const list = buildDisplayList(boxTree);
  return {
    painted: list.items
      .filter((item) => item.part === 'box')
      .map((item) => names.get(item.box) ?? '?'),
    contexts: list.contexts.map((one) => ({
      box: names.get(one.box) ?? '?',
      zIndex: one.zIndex,
      depth: one.depth,
    })),
  };
}

describe('buildDisplayList', () => {
  it('paints the tree in document order when nothing is positioned', () => {
    const first = element('div', { classes: ['first'] });
    const second = element('div', { classes: ['second'] }, [
      element('div', { classes: ['nested'] }),
    ]);

    expect(order('', [first, second]).painted).toEqual(['html', 'first', 'second', 'nested']);
  });

  it('paints flex items in the order they ask for', () => {
    const first = element('div', { classes: ['first'] });
    const second = element('div', { classes: ['second', 'early'] });
    const row = element('div', { classes: ['row'] }, [first, second]);
    const css = '.row { display: flex } .early { order: -1 }';

    expect(order(css, [row]).painted).toEqual(['html', 'row', 'second', 'first']);
  });

  it('paints the halves of a cut positioned inline as one, with what it positions on top', () => {
    const anchor = element('span', { classes: ['anchor'] }, [
      element('span', { classes: ['out'] }),
      element('div', { classes: ['cut'] }),
      text('after'),
    ]);
    const css = '.anchor { position: relative } .out { position: absolute }';

    // Both halves of the anchor come before the absolute box, which is inside the first.
    const painted = order(css, [anchor]).painted;
    expect(painted.indexOf('out')).toBeGreaterThan(painted.lastIndexOf('anchor'));
  });

  it('paints a flex item as one piece, the way an inline-block paints', () => {
    const row = element('div', { classes: ['row'] }, [
      element('div', { classes: ['first'] }, [text('words')]),
      element('div', { classes: ['second'] }),
    ]);

    // The first item's text comes before the second item, not after every block.
    expect(order('.row { display: flex }', [row]).painted).toEqual([
      'html',
      'row',
      'first',
      '"words"',
      'second',
    ]);
  });

  it('gives a flex item a z-index without it being positioned', () => {
    const row = element('div', { classes: ['row'] }, [
      element('div', { classes: ['raised'] }),
      element('div', { classes: ['plain'] }),
      element('div', { classes: ['sunk'] }),
    ]);
    const css = '.row { display: flex } .raised { z-index: 1 } .sunk { z-index: -1 }';

    const laid = order(css, [row]);
    expect(laid.painted).toEqual(['html', 'sunk', 'row', 'plain', 'raised']);
    expect(laid.contexts.map((one) => one.box)).toEqual(['html', 'sunk', 'raised']);
  });

  it('puts inline content on top of the blocks around it', () => {
    const host = element('div', { classes: ['host'] }, [
      text('loose'),
      element('div', { classes: ['block'] }),
    ]);

    expect(order('', [host]).painted).toEqual(['html', 'host', 'anon', 'block', '"loose"']);
  });

  it('paints an inline-block with its own contents rather than with the blocks around it', () => {
    const host = element('div', { classes: ['host'] }, [
      element('div', { classes: ['shrunk'] }, [element('div', { classes: ['inner'] })]),
      element('div', { classes: ['after'] }),
    ]);

    expect(order('.shrunk { display: inline-block }', [host]).painted).toEqual([
      'html',
      'host',
      'anon',
      'after',
      'shrunk',
      'inner',
    ]);
  });

  it('lifts a positioned box above its later siblings', () => {
    const lifted = element('div', { classes: ['lifted'] });
    const after = element('div', { classes: ['after'] });
    const css = '.lifted { position: relative }';

    expect(order(css, [lifted, after]).painted).toEqual(['html', 'after', 'lifted']);
  });

  it('lifts a transparent box the way a z-index of zero would', () => {
    const faded = element('div', { classes: ['faded'] });
    const after = element('div', { classes: ['after'] });
    const shifted = element('div', { classes: ['shifted'] });
    const css = '.faded { opacity: 0.5 } .shifted { position: relative }';

    // Over the plain content, and in tree order with what is positioned.
    expect(order(css, [faded, after, shifted]).painted).toEqual([
      'html',
      'after',
      'faded',
      'shifted',
    ]);
  });

  it('sorts a z-index inside a positioned box with none in the context around both', () => {
    const outer = element('div', { classes: ['outer'] }, [element('div', { classes: ['high'] })]);
    const later = element('div', { classes: ['later'] });
    const css =
      '.outer, .high, .later { position: relative } .high { z-index: 5 } .later { z-index: 1 }';

    // The outer box makes no context of its own, so five is compared with one, not with it.
    expect(order(css, [outer, later]).painted).toEqual(['html', 'outer', 'later', 'high']);
  });

  it('paints what is positioned inside an inline-block once, with the context', () => {
    const shrunk = element('span', { classes: ['shrunk'] }, [
      element('span', { classes: ['rel'] }),
    ]);
    const css = '.shrunk { display: inline-block } .rel { position: relative }';

    expect(order(css, [element('div', {}, [shrunk])]).painted).toEqual([
      'html',
      'div',
      'shrunk',
      'rel',
    ]);
  });

  it('drops a negative z-index below the plain content', () => {
    const behind = element('div', { classes: ['behind'] });
    const plain = element('div', { classes: ['plain'] });
    const css = '.behind { position: relative; z-index: -1 }';

    expect(order(css, [behind, plain]).painted).toEqual(['html', 'behind', 'plain']);
  });

  it('sorts stacking contexts by z-index, not by document order', () => {
    const high = element('div', { classes: ['high'] });
    const low = element('div', { classes: ['low'] });
    const css = '.high { position: relative; z-index: 5 } .low { position: relative; z-index: 2 }';

    expect(order(css, [high, low]).painted).toEqual(['html', 'low', 'high']);
  });

  it('keeps a child z-index inside its parent context', () => {
    const eager = element('div', { classes: ['eager'] }, [element('div', { classes: ['inner'] })]);
    const rival = element('div', { classes: ['rival'] });
    const css =
      '.eager { position: relative; z-index: 1 } .inner { position: relative; z-index: 999 }' +
      ' .rival { position: relative; z-index: 2 }';

    // 999 cannot climb out of the context its parent established at 1
    expect(order(css, [eager, rival]).painted).toEqual(['html', 'eager', 'inner', 'rival']);
  });

  it('records a context for the root and for every z-index that makes one', () => {
    const outer = element('div', { classes: ['outer'] }, [
      element('div', { classes: ['inner'] }),
      element('div', { classes: ['plain'] }),
    ]);
    const css =
      '.outer { position: relative; z-index: 1 } .inner { position: absolute; z-index: 3 }';

    expect(order(css, [outer]).contexts).toEqual([
      { box: 'html', zIndex: 'auto', depth: 0 },
      { box: 'outer', zIndex: 1, depth: 1 },
      { box: 'inner', zIndex: 3, depth: 2 },
    ]);
  });

  it('does not make a context out of a positioned box with no z-index', () => {
    const floating = element('div', { classes: ['floating'] });
    const css = '.floating { position: absolute }';

    expect(order(css, [floating]).contexts).toEqual([{ box: 'html', zIndex: 'auto', depth: 0 }]);
  });
});

describe('hitTest', () => {
  function pointer(css: string, children: DomNode[]) {
    const root = element('html', {}, children);
    const boxTree = buildBoxTree(root, computeStyles(root, css));
    if (boxTree === null) throw new Error('the root generated no box');

    const layout = layoutDocument(boxTree, { width: 400, height: 300 }, fixedAdvanceMeasurer());
    const list = buildDisplayList(boxTree);
    const names = new Map<BoxId, string>();
    walkBoxes(boxTree, (box: Box) => {
      if (box.kind !== 'text' && box.element !== null) {
        names.set(box.id, box.element.classes[0] ?? box.element.tag);
      }
    });

    return (x: number, y: number) => {
      const hit = hitTest(list, layout, x, y);
      return hit === null ? 'nothing' : (names.get(hit) ?? 'anonymous');
    };
  }

  it('finds a block through a line box that hangs out of it', () => {
    const at = pointer(
      '.crowded { width: 100px; height: 10px } .fat { display: inline-block; width: 80px; height: 4px } .kept { height: 40px }',
      [
        element('div', { classes: ['crowded'] }, [
          text('ab '),
          element('span', { classes: ['fat'] }),
        ]),
        element('div', { classes: ['kept'] }),
      ],
    );

    // The second line runs from 16 to 32 and over the block below, as wide as the 80 on it.
    // Inline content paints after every block background, so the line wins inside that width
    // and the block underneath wins beside it.
    expect(at(40, 18)).toBe('crowded');
    expect(at(90, 18)).toBe('kept');
    expect(at(40, 26)).toBe('fat');
  });

  it('clips to the padding box, and leaves alone what is placed against a block outside', () => {
    const at = pointer(
      '.clip { overflow: hidden; border: 10px solid; width: 100px; height: 40px } .wide { width: 200px; height: 80px } .out { position: absolute; width: 200px; height: 20px }',
      [
        element('div', { classes: ['clip'] }, [element('div', { classes: ['wide'] })]),
        element('div', { classes: ['clip'] }, [element('div', { classes: ['out'] })]),
      ],
    );

    // The first clip's border runs from 110 to 120 across, and over it the clip is on top. The
    // box in the second belongs to the page, not to the clip, so it shows past the clip's edge.
    expect(at(115, 30)).toBe('clip');
    expect(at(150, 75)).toBe('out');
  });

  it('finds a block through a line only as far as the block reaches from where the line starts', () => {
    const along = pointer(
      '.stubby { width: 100px; white-space: nowrap } .back { position: relative; left: -150px; padding: 0 60px }',
      [
        element('div', { classes: ['stubby'] }, [
          text('xx'),
          element('span', { classes: ['back'] }, [text('yy')]),
        ]),
      ],
    );
    const down = pointer(
      '.low { width: 100px; height: 10px; line-height: 40px } .ib { display: inline-block; width: 80px; height: 4px }',
      [element('div', { classes: ['low'] }, [text('ab '), element('span', { classes: ['ib'] })])],
    );

    // The line runs out to 152, but the block is a hundred wide, and past that the page is
    // what is found, with the span that made the line so long drawn back at its start.
    expect(along(120, 8)).toBe('html');
    expect(along(50, 8)).toBe('stubby');
    // The second line runs from 40 to 80 under a block ten tall, so its first ten find the block
    // and below that there is nothing, which a browser answers with the root.
    expect(down(40, 45)).toBe('low');
    expect(down(40, 55)).toBe('nothing');
  });

  it('goes through an anonymous block to what is under it', () => {
    const at = pointer(
      '.lifting { height: 4px; margin-bottom: -12px } .ib { display: inline-block }',
      [
        element('span', {}, [element('div', { classes: ['lifting'] })]),
        element('span', { classes: ['ib'] }),
      ],
    );

    // The block after the first one is anonymous, pulled up over it by the negative margin.
    // It has nothing of its own to be found, so the block under it is.
    expect(at(90, 2)).toBe('lifting');
  });

  it('finds a run of text in a flex container, which is a box of its own', () => {
    const at = pointer(
      '.col { display: flex; flex-direction: column; flex-wrap: wrap } .wide { white-space: nowrap }',
      [
        element('div', { classes: ['col'] }, [
          text('ab'),
          element('div', { classes: ['wide'] }, [text('x'.repeat(60))]),
        ]),
      ],
    );

    // The wide item makes the column 480 across, and the item around "ab" is stretched to it,
    // out past the page. Unlike an anonymous block among blocks, that item is a box to be found.
    expect(at(420, 8)).toBe('anonymous');
  });

  it('clips by every clip around a box, not only the nearest one', () => {
    const at = pointer(
      '.outer { position: absolute; overflow: hidden } .inner { position: absolute; overflow: hidden }',
      [
        element('div', { classes: ['outer'] }, [
          element('div', { classes: ['inner'] }, [text('one')]),
        ]),
      ],
    );

    // Nothing in the outer box is in the flow, so it has no size, and it clips the inner box
    // away along with the word inside it, which the inner box's own clip would have let through.
    expect(at(5, 5)).toBe('nothing');
  });

  it('lets a later line cover a padded box that hangs down into it', () => {
    const at = pointer('.host { width: 60px; line-height: 30px } .deep { padding-bottom: 12px }', [
      element('div', { classes: ['host'] }, [
        element('span', { classes: ['deep'] }, [text('abcdef')]),
        text(' gh'),
      ]),
    ]);

    // The span's text ends at 23 and its padding at 35, inside the second line, which starts at
    // 30 and is as wide as "gh". Over that word the line is on top, even where the word itself
    // is not drawn yet, and beside it the span still shows.
    expect(at(4, 32)).toBe('host');
    expect(at(30, 32)).toBe('deep');
  });

  it('does not cover a box with a layer of its own with a later line', () => {
    const at = (layered: string) =>
      pointer(
        `.host { width: 60px; line-height: 30px } .deep { padding-bottom: 12px; ${layered} }`,
        [
          element('div', { classes: ['host'] }, [
            element('span', { classes: ['deep'] }, [text('abcdef')]),
            text(' gh'),
          ]),
        ],
      )(4, 32);

    // Transparent or positioned, the span is tested before the lines of the block it sits in.
    expect(at('opacity: 0.5')).toBe('deep');
    expect(at('position: relative')).toBe('deep');
  });
});
