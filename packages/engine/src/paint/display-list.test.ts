import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, element, text } from '../dom/node.js';
import { buildDisplayList } from './display-list.js';

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
    painted: list.items.map((item) => names.get(item.box) ?? '?'),
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
