import { describe, expect, it } from 'vitest';
import { type ElementNode, element, text } from '../dom/node.js';
import { computeStyles } from './cascade.js';
import type { ComputedStyle } from './properties.js';
import { AUTO, percent, px } from './values.js';

function styles(root: ElementNode, css: string) {
  const map = computeStyles(root, css);
  return (node: ElementNode): ComputedStyle => {
    const style = map.get(node);
    if (style === undefined) throw new Error('node was never styled');
    return style;
  };
}

describe('out of flow', () => {
  it('blockifies an absolutely positioned inline', () => {
    const span = element('span', { classes: ['out'] });
    const root = element('html', {}, [element('body', {}, [span])]);
    const style = styles(root, '.out { position: absolute }')(span);

    expect(style.display).toBe('block');
  });
});

describe('the user agent sheet', () => {
  it('turns a div into a block and a span into an inline', () => {
    const span = element('span');
    const div = element('div', {}, [span]);
    const styleOf = styles(div, '');

    expect(styleOf(div).display).toBe('block');
    expect(styleOf(span).display).toBe('inline');
  });

  it('gives body its eight pixels', () => {
    const body = element('body');
    expect(styles(body, '')(body).marginTop).toEqual(px(8));
  });

  it('loses to anything the author says', () => {
    const p = element('p');
    expect(styles(p, 'p { margin: 0 }')(p).marginTop).toEqual(px(0));
  });
});

describe('cascade order', () => {
  const target = () => element('p', { id: 'lead', classes: ['intro'] });

  it('prefers the higher specificity over document order', () => {
    const node = target();
    const css = '#lead { width: 10px } .intro { width: 20px }';
    expect(styles(node, css)(node).width).toEqual(px(10));
  });

  it('counts a tag alongside a class', () => {
    const node = target();
    const css = 'p.intro { width: 30px } .intro { width: 40px }';
    expect(styles(node, css)(node).width).toEqual(px(30));
  });

  it('prefers the later rule when specificity ties', () => {
    const node = target();
    const css = '.intro { width: 20px } .intro { width: 40px }';
    expect(styles(node, css)(node).width).toEqual(px(40));
  });

  it('puts the style attribute above any selector', () => {
    const node = element('p', { attributes: { style: 'width: 5px' } });
    expect(styles(node, '#x, p { width: 99px }')(node).width).toEqual(px(5));
  });

  it('lets !important beat the style attribute', () => {
    const node = element('p', { attributes: { style: 'width: 5px' } });
    expect(styles(node, 'p { width: 99px !important }')(node).width).toEqual(px(99));
  });
});

describe('inheritance', () => {
  it('passes inherited properties down and leaves the rest alone', () => {
    const child = element('span');
    const root = element('div', {}, [child]);
    const styleOf = styles(root, 'div { font-size: 20px; width: 100px }');

    expect(styleOf(child).fontSize).toBe(20);
    expect(styleOf(child).width).toEqual(AUTO);
  });

  it('honours the inherit and initial keywords', () => {
    const child = element('span', { classes: ['c'] });
    const root = element('div', {}, [child]);
    const styleOf = styles(root, 'div { width: 100px } .c { width: inherit; font-size: initial }');

    expect(styleOf(child).width).toEqual(px(100));
    expect(styleOf(child).fontSize).toBe(16);
  });
});

describe('computed lengths', () => {
  it('resolves em against the element, and font-size em against the parent', () => {
    const child = element('span');
    const root = element('div', {}, [child]);
    const styleOf = styles(root, 'div { font-size: 20px } span { font-size: 2em; width: 2em }');

    expect(styleOf(child).fontSize).toBe(40);
    expect(styleOf(child).width).toEqual(px(80));
  });

  it('resolves rem against the root font size, not the parent', () => {
    const child = element('span');
    const root = element('html', {}, [element('div', {}, [child])]);
    const styleOf = styles(root, 'div { font-size: 40px } span { width: 2rem }');

    expect(styleOf(child).width).toEqual(px(32));
  });

  it('resolves rem on the root itself against the initial font size', () => {
    const root = element('html');
    expect(styles(root, 'html { font-size: 2rem }')(root).fontSize).toBe(32);
  });

  it('leaves percentages alone, because the containing block is not known yet', () => {
    const node = element('div');
    expect(styles(node, 'div { width: 50% }')(node).width).toEqual(percent(50));
  });

  it('falls back when a value does not parse', () => {
    const node = element('div');
    expect(styles(node, 'div { width: banana }')(node).width).toEqual(AUTO);
  });
});

describe('border widths on a fractional device pixel ratio', () => {
  const widthOf = (declared: string, ratio: number) => {
    const node = element('div');
    const style = computeStyles(node, `div { border: ${declared} solid }`, ratio).get(node);
    if (style === undefined) throw new Error('node was never styled');
    return style.borderTopWidth.value;
  };

  it.each([
    ['0.5px', 0.8],
    ['1px', 0.8],
    ['1.5px', 0.8],
    ['2px', 1.6],
    ['2.4px', 2.4],
    ['3px', 2.4],
    ['4px', 4],
    ['5px', 4.8],
    ['7px', 6.4],
  ])('uses %s as %spx at 1.25, the way a browser does', (declared, expected) => {
    expect(widthOf(declared, 1.25)).toBeCloseTo(expected, 6);
  });

  it('leaves everything alone at one device pixel per css pixel', () => {
    expect(widthOf('2px', 1)).toBe(2);
    expect(widthOf('7px', 1)).toBe(7);
  });

  it('never rounds a border away to nothing', () => {
    expect(widthOf('0.1px', 1.25)).toBeCloseTo(0.8, 6);
    expect(widthOf('0.1px', 2)).toBeCloseTo(0.5, 6);
  });

  it('snaps the keywords too', () => {
    const node = element('div');
    const style = computeStyles(node, 'div { border: thick solid }', 1.25).get(node);
    expect(style?.borderTopWidth.value).toBeCloseTo(4.8, 6);
  });
});

describe('the monospace default font size', () => {
  it('is 13px while nothing has declared a size', () => {
    const node = element('pre');
    expect(styles(node, 'pre { font-family: monospace }')(node).fontSize).toBe(13);
  });

  it('needs the family to be the bare generic', () => {
    const node = element('pre');
    const css = 'pre { font-family: monospace, Arial }';
    expect(styles(node, css)(node).fontSize).toBe(16);
  });

  it('gives way to an inherited size that someone did declare', () => {
    const child = element('pre');
    const root = element('html', {}, [child]);
    const css = 'html { font-size: 16px } pre { font-family: monospace }';
    expect(styles(root, css)(child).fontSize).toBe(16);
  });

  it('comes back for an explicit medium', () => {
    const child = element('pre');
    const root = element('html', {}, [child]);
    const css = 'html { font-size: 20px } pre { font-family: monospace; font-size: medium }';
    expect(styles(root, css)(child).fontSize).toBe(13);
  });

  it('is what a relative size resolves against', () => {
    const node = element('pre');
    const css = 'pre { font-family: monospace; font-size: 2em }';
    expect(styles(node, css)(node).fontSize).toBe(26);
  });
});

describe('shorthands', () => {
  it.each([
    ['margin: 1px', [1, 1, 1, 1]],
    ['margin: 1px 2px', [1, 2, 1, 2]],
    ['margin: 1px 2px 3px', [1, 2, 3, 2]],
    ['margin: 1px 2px 3px 4px', [1, 2, 3, 4]],
  ])('expands %s', (declaration, expected) => {
    const node = element('div');
    const style = styles(node, `div { ${declaration} }`)(node);

    expect([style.marginTop, style.marginRight, style.marginBottom, style.marginLeft]).toEqual(
      expected.map(px),
    );
  });

  it('sets the row gap first out of the gap shorthand', () => {
    const node = element('div');
    const one = styles(node, 'div { gap: 4px }')(node);
    const two = styles(node, 'div { gap: 4px 8px }')(node);

    expect([one.rowGap, one.columnGap]).toEqual([px(4), px(4)]);
    expect([two.rowGap, two.columnGap]).toEqual([px(4), px(8)]);
  });

  it('reads width and style out of the border shorthand and drops the colour', () => {
    const node = element('div');
    const style = styles(node, 'div { border: 2px solid #f00 }')(node);

    expect(style.borderTopWidth).toEqual(px(2));
    expect(style.borderLeftStyle).toBe('solid');
  });

  it('resets the missing half of the border shorthand', () => {
    const node = element('div');
    const style = styles(node, 'div { border: solid }')(node);

    expect(style.borderTopWidth).toEqual(px(3));
    expect(style.borderTopStyle).toBe('solid');
  });

  it('keeps border-width and border-style independent', () => {
    const node = element('div');
    const style = styles(node, 'div { border-width: 5px }')(node);

    expect(style.borderTopWidth).toEqual(px(5));
    expect(style.borderTopStyle).toBe('none');
  });
});

describe('unsupported input', () => {
  it('ignores properties outside the subset', () => {
    const node = element('div', {}, [text('x')]);
    expect(() => styles(node, 'div { float: left; grid-template: none }')(node)).not.toThrow();
  });
});
