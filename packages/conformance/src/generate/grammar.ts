import fc from 'fast-check';

export type GeneratedNode = {
  tag: string;
  declarations: Record<string, string>;
  text: string;
  children: GeneratedNode[];
};

export type GeneratedDocument = {
  width: number;
  roots: GeneratedNode[];
};

// Only what the engine supports, so a failure is a bug. The values are picked to be awkward.
const px = fc.integer({ min: 0, max: 90 }).map((n) => `${String(n)}px`);
const percent = fc.integer({ min: 0, max: 100 }).map((n) => `${String(n)}%`);
const size = fc.oneof(px, percent, fc.constant('auto'));
const margin = fc.oneof(px, percent, fc.constant('auto'), fc.constant('-12px'));
const factor = fc.integer({ min: 0, max: 3 }).map(String);

const declarations = fc.record(
  {
    display: fc.constantFrom('block', 'inline', 'inline-block', 'flex', 'list-item'),
    position: fc.constantFrom('static', 'relative', 'absolute'),
    'box-sizing': fc.constantFrom('content-box', 'border-box'),
    overflow: fc.constantFrom('visible', 'hidden'),

    width: size,
    height: size,
    'min-height': fc.oneof(px, fc.constant('auto')),
    'max-width': fc.oneof(px, percent, fc.constant('none')),

    margin: margin,
    'margin-top': margin,
    'margin-bottom': margin,
    padding: fc.oneof(px, percent),
    'padding-left': fc.oneof(px, percent),

    border: fc
      .tuple(fc.integer({ min: 0, max: 6 }), fc.constantFrom('solid', 'dashed', 'none'))
      .map(([width, style]) => `${String(width)}px ${style}`),

    top: fc.oneof(px, fc.constant('auto')),
    left: fc.oneof(px, fc.constant('auto')),
    right: fc.oneof(px, fc.constant('auto')),

    'font-size': fc.integer({ min: 9, max: 30 }).map((n) => `${String(n)}px`),
    'line-height': fc.oneof(
      fc.constant('normal'),
      px,
      fc.integer({ min: 10, max: 24 }).map((n) => String(n / 10)),
    ),
    'text-align': fc.constantFrom('left', 'right', 'center'),
    'white-space': fc.constantFrom('normal', 'pre', 'nowrap'),

    'flex-grow': factor,
    'flex-shrink': factor,
    'flex-basis': fc.oneof(px, fc.constant('auto')),
    'justify-content': fc.constantFrom('flex-start', 'flex-end', 'center', 'space-between'),
    'align-items': fc.constantFrom('stretch', 'flex-start', 'center', 'baseline'),
    'align-self': fc.constantFrom(
      'auto',
      'stretch',
      'flex-start',
      'flex-end',
      'center',
      'baseline',
    ),
    'flex-direction': fc.constantFrom('row', 'row-reverse', 'column', 'column-reverse'),
    'flex-wrap': fc.constantFrom('nowrap', 'wrap', 'wrap-reverse'),
    'align-content': fc.constantFrom(
      'normal',
      'flex-start',
      'flex-end',
      'center',
      'space-between',
      'space-around',
      'stretch',
    ),
    order: fc.integer({ min: -2, max: 2 }).map(String),
    'list-style-type': fc.constantFrom('disc', 'circle', 'square', 'decimal', 'none'),
    'list-style-position': fc.constantFrom('outside', 'inside'),
    // Nothing to do with geometry, but everything to do with what the pointer lands on.
    'z-index': fc.constantFrom('auto', '-1', '0', '1', '3'),
    opacity: fc.constantFrom('1', '0.5'),
    gap: fc.oneof(
      px,
      percent,
      fc.tuple(px, px).map((both) => both.join(' ')),
    ),
  },
  { requiredKeys: [] },
);

const WORDS = ['one', 'two', 'three', 'liquorice', 'a', 'of', 'internationalisation', 'xy'];

const text = fc.oneof(
  { weight: 2, arbitrary: fc.constant('') },
  {
    weight: 3,
    arbitrary: fc
      .array(fc.constantFrom(...WORDS), { maxLength: 9 })
      .map((parts) => parts.join(' ')),
  },
);

// Shallow and narrow on purpose. Deep trees make slow pages and long shrinking runs without
// finding anything a three level tree does not already find.
const node: fc.Arbitrary<GeneratedNode> = fc.letrec<{ node: GeneratedNode }>((tie) => ({
  node: fc.record({
    tag: fc.constantFrom('div', 'p', 'span', 'section', 'em', 'li'),
    declarations,
    text,
    children: fc.oneof(
      { weight: 4, arbitrary: fc.constant<GeneratedNode[]>([]) },
      { weight: 1, arbitrary: fc.array(tie('node'), { maxLength: 3 }) },
    ),
  }),
})).node;

export const documents: fc.Arbitrary<GeneratedDocument> = fc.record({
  width: fc.integer({ min: 180, max: 640 }),
  roots: fc.array(node, { minLength: 1, maxLength: 3 }),
});

export type Rendered = { html: string; css: string; document: string };

// A pinned family, and no body margin so a difference shows up where it happened.
export function render(generated: GeneratedDocument): Rendered {
  const rules: string[] = [
    `body { margin: 0; font-family: Arial, sans-serif; width: ${String(generated.width)}px }`,
  ];

  let next = 0;

  const emit = (current: GeneratedNode, indent: string): string => {
    const name = `c${String(next++)}`;
    const pairs = Object.entries(current.declarations);

    if (pairs.length > 0) {
      rules.push(`.${name} { ${pairs.map(([key, value]) => `${key}: ${value}`).join('; ')} }`);
    }

    const inside = [
      current.text === '' ? '' : `${indent}  ${current.text}`,
      ...current.children.map((child) => emit(child, `${indent}  `)),
    ].filter((part) => part !== '');

    if (inside.length === 0) return `${indent}<${current.tag} class="${name}"></${current.tag}>`;

    return [
      `${indent}<${current.tag} class="${name}">`,
      ...inside,
      `${indent}</${current.tag}>`,
    ].join('\n');
  };

  const html = generated.roots.map((root) => emit(root, '')).join('\n');
  const css = rules.join('\n');

  return {
    html,
    css,
    document: `<!doctype html>\n<meta charset="utf-8" />\n<style>\n${css}\n</style>\n${html}\n`,
  };
}
