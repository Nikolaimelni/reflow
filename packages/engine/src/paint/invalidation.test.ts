import { describe, expect, it } from 'vitest';
import { type Box, type BoxId, walkBoxes } from '../boxtree/box.js';
import { buildBoxTree } from '../boxtree/build.js';
import { computeStyles } from '../cascade/cascade.js';
import { type DomNode, element, text } from '../dom/node.js';
import { dirtyBoxes, INVALIDATION } from './invalidation.js';

function scene(css: string, children: DomNode[]) {
  const root = element('html', {}, children);
  const boxTree = buildBoxTree(root, computeStyles(root, css));
  if (boxTree === null) throw new Error('the root generated no box');

  const names = new Map<BoxId, string>();
  const ids = new Map<string, BoxId>();

  walkBoxes(boxTree, (box: Box) => {
    const name =
      box.kind === 'text'
        ? `"${box.text.trim()}"`
        : (box.element?.classes[0] ?? box.element?.tag ?? 'anon');
    names.set(box.id, name);
    if (!ids.has(name)) ids.set(name, box.id);
  });

  return {
    dirt(name: string, property: Parameters<typeof dirtyBoxes>[2]) {
      const id = ids.get(name);
      if (id === undefined) throw new Error(`no box called ${name}`);

      const result = dirtyBoxes(boxTree, id, property);
      return {
        invalidation: result.invalidation,
        dirty: [...result.dirty].map((box) => names.get(box) ?? '?').sort(),
        climbs: result.climbs.map((box) => names.get(box) ?? '?'),
      };
    },
  };
}

const page = (css: string) =>
  scene(css, [
    element('div', { classes: ['first'] }, [text('one')]),
    element('div', { classes: ['host'] }, [element('div', { classes: ['inner'] }, [text('two')])]),
    element('div', { classes: ['last'] }, [text('three')]),
  ]);

describe('INVALIDATION', () => {
  it('puts the box model in layout and the colours outside it', () => {
    expect(INVALIDATION.width).toBe('layout');
    expect(INVALIDATION.marginTop).toBe('layout');
    expect(INVALIDATION.backgroundColor).toBe('paint');
    expect(INVALIDATION.zIndex).toBe('paint');
    expect(INVALIDATION.opacity).toBe('composite');
  });
});

describe('dirtyBoxes', () => {
  it('touches nothing but the box itself for a composite change', () => {
    expect(page('').dirt('inner', 'opacity')).toEqual({
      invalidation: 'composite',
      dirty: ['inner'],
      climbs: [],
    });
  });

  it('takes the subtree for a paint change and stops there', () => {
    expect(page('').dirt('host', 'backgroundColor')).toEqual({
      invalidation: 'paint',
      dirty: ['"two"', 'host', 'inner'],
      climbs: [],
    });
  });

  it('climbs to every auto height ancestor and pushes what follows', () => {
    const result = page('').dirt('inner', 'height');

    expect(result.invalidation).toBe('layout');
    expect(result.climbs).toEqual(['host', 'html']);
    expect(result.dirty).toEqual(['"three"', '"two"', 'host', 'html', 'inner', 'last']);
  });

  it('stops climbing at an ancestor with a height of its own', () => {
    const result = page('.host { height: 100px }').dirt('inner', 'height');

    expect(result.climbs).toEqual(['host']);
    expect(result.dirty).not.toContain('last');
  });

  it('leaves earlier siblings alone', () => {
    expect(page('').dirt('host', 'marginTop').dirty).not.toContain('first');
  });
});
