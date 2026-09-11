import { describe, expect, it } from 'vitest';
import { computeStyles } from '../cascade/cascade.js';
import { type ElementNode, element, text } from '../dom/node.js';
import { type Box, describeBox } from './box.js';
import { buildBoxTree } from './build.js';

function tree(root: ElementNode, css: string) {
  const box = buildBoxTree(root, computeStyles(root, css));
  if (box === null) throw new Error('the root generated no box');
  return box;
}

function shape(box: Box): string[] {
  if (box.kind === 'text') return [describeBox(box)];
  return [describeBox(box), ...box.children.flatMap(shape).map((line) => `  ${line}`)];
}

describe('buildBoxTree', () => {
  it('drops a subtree with display none', () => {
    const hidden = element('div', { classes: ['gone'] }, [element('p')]);
    const root = element('div', {}, [hidden, element('p')]);

    expect(shape(tree(root, '.gone { display: none }'))).toEqual(['block <div>', '  block <p>']);
  });

  it('leaves a run of inlines alone when there is no block among them', () => {
    const root = element('p', {}, [text('hello '), element('span', {}, [text('world')])]);

    expect(shape(tree(root, ''))).toEqual([
      'block <p>',
      '  text "hello "',
      '  inline <span>',
      '    text "world"',
    ]);
  });

  it('wraps a run of inlines in an anonymous block when a block joins them', () => {
    const root = element('div', {}, [
      text('loose text'),
      element('span', {}, [text('and more')]),
      element('p', {}, [text('a block')]),
      text('trailing'),
    ]);

    expect(shape(tree(root, ''))).toEqual([
      'block <div>',
      '  anonymous block',
      '    text "loose text"',
      '    inline <span>',
      '      text "and more"',
      '  block <p>',
      '    text "a block"',
      '  anonymous block',
      '    text "trailing"',
    ]);
  });

  it('drops whitespace between blocks instead of boxing it', () => {
    const root = element('div', {}, [
      text('\n  '),
      element('p'),
      text('\n  '),
      element('p'),
      text('\n'),
    ]);

    expect(shape(tree(root, ''))).toEqual(['block <div>', '  block <p>', '  block <p>']);
  });

  it('makes an inline-block atomic but still lays its children out as blocks', () => {
    const root = element('div', { classes: ['host'] }, [
      element('span', { classes: ['ib'] }, [element('p'), text('x')]),
    ]);
    const built = tree(root, '.ib { display: inline-block }');

    expect(shape(built)).toEqual([
      'block <div>',
      '  inline-block <span>',
      '    block <p>',
      '    anonymous block',
      '      text "x"',
    ]);
  });

  it('gives an anonymous box the inherited half of its parent style', () => {
    const root = element('div', {}, [text('x'), element('p')]);
    const built = tree(root, 'div { font-size: 30px; padding: 9px; text-align: center }');
    const anonymous = built.children[0];

    expect(anonymous?.style.fontSize).toBe(30);
    expect(anonymous?.style.textAlign).toBe('center');
    expect(anonymous?.style.paddingTop).toEqual({ kind: 'px', value: 0 });
  });

  it('numbers every box exactly once', () => {
    const root = element('div', {}, [element('p', {}, [text('a')]), element('p')]);
    const ids: number[] = [];
    const collect = (box: Box) => {
      ids.push(box.id);
      if (box.kind !== 'text') for (const child of box.children) collect(child);
    };
    collect(tree(root, ''));

    expect(new Set(ids).size).toBe(ids.length);
  });
});
