import { matches } from '../css/match.js';
import type { StyleRule } from '../css/parse.js';
import { type Declaration, parseDeclarationBlock, parseStylesheet } from '../css/parse.js';
import {
  type ComplexSelector,
  compareSpecificity,
  type Specificity,
  specificity,
} from '../css/selector.js';
import type { Token } from '../css/tokenize.js';
import { type ElementNode, elementChildren } from '../dom/node.js';
import {
  type ComputeContext,
  type ComputedStyle,
  type PropertyName,
  properties,
  propertyByCssName,
  propertyNames,
} from './properties.js';
import { expandShorthand } from './shorthand.js';
import { USER_AGENT_CSS } from './ua.js';

export type StyleMap = Map<ElementNode, ComputedStyle>;

type Origin = 'user-agent' | 'author';

type Candidate = {
  property: PropertyName;
  value: Token[];
  important: boolean;
  origin: Origin;
  inline: boolean;
  specificity: Specificity;
  order: number;
};

type MatchableDeclaration = Candidate & { selector: ComplexSelector };

let userAgentRules: StyleRule[] | null = null;

function userAgentSheet(): StyleRule[] {
  userAgentRules ??= parseStylesheet(USER_AGENT_CSS);
  return userAgentRules;
}

export function computeStyles(root: ElementNode, authorCss: string): StyleMap {
  const declarations = [
    ...flatten(userAgentSheet(), 'user-agent', 0),
    ...flatten(parseStylesheet(authorCss), 'author', 1_000_000),
  ];

  const styles: StyleMap = new Map();

  // rem on the root element's own font-size refers to the initial value, not to itself.
  const rootStyle = computeFor(root, null, declarations, properties.fontSize.initial);
  styles.set(root, rootStyle);

  const walk = (node: ElementNode, parent: ComputedStyle) => {
    const style = computeFor(node, parent, declarations, rootStyle.fontSize);
    styles.set(node, style);
    for (const child of elementChildren(node)) walk(child, style);
  };

  for (const child of elementChildren(root)) walk(child, rootStyle);
  return styles;
}

function flatten(
  rules: readonly StyleRule[],
  origin: Origin,
  startOrder: number,
): MatchableDeclaration[] {
  const flat: MatchableDeclaration[] = [];
  let order = startOrder;

  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      for (const longhand of toLonghands(declaration)) {
        for (const selector of rule.selectors) {
          flat.push({
            selector,
            specificity: specificity(selector),
            origin,
            inline: false,
            important: declaration.important,
            order,
            ...longhand,
          });
        }
        order++;
      }
    }
  }

  return flat;
}

function toLonghands(declaration: Declaration): { property: PropertyName; value: Token[] }[] {
  const expanded = expandShorthand(declaration.property, declaration.value);
  if (expanded !== null) return expanded;

  const property = propertyByCssName(declaration.property);
  return property === undefined ? [] : [{ property, value: declaration.value }];
}

function computeFor(
  node: ElementNode,
  parent: ComputedStyle | null,
  declarations: readonly MatchableDeclaration[],
  rootFontSize: number,
): ComputedStyle {
  const winners = new Map<PropertyName, Candidate>();

  const offer = (candidate: Candidate) => {
    const current = winners.get(candidate.property);
    if (current === undefined || beats(candidate, current)) {
      winners.set(candidate.property, candidate);
    }
  };

  for (const declaration of declarations) {
    if (matches(declaration.selector, node)) offer(declaration);
  }

  const inline = node.attributes.style;
  if (inline !== undefined) {
    let order = 0;
    for (const declaration of parseDeclarationBlock(inline)) {
      for (const longhand of toLonghands(declaration)) {
        offer({
          ...longhand,
          important: declaration.important,
          origin: 'author',
          inline: true,
          specificity: [0, 0, 0],
          order,
        });
        order++;
      }
    }
  }

  // why: every property below is assigned in the loop, so the empty object is only ever
  // observed complete.
  const style = {} as ComputedStyle;

  // font-size resolves first: every other em length on this element is relative to it.
  const parentFontSize = parent?.fontSize ?? properties.fontSize.initial;
  style.fontSize = resolve('fontSize', winners.get('fontSize'), parent, {
    fontSize: parentFontSize,
    rootFontSize,
  });

  const context: ComputeContext = { fontSize: style.fontSize, rootFontSize };
  for (const name of propertyNames) {
    if (name === 'fontSize') continue;
    assign(style, name, winners.get(name), parent, context);
  }

  return style;
}

function assign<K extends PropertyName>(
  style: ComputedStyle,
  name: K,
  candidate: Candidate | undefined,
  parent: ComputedStyle | null,
  context: ComputeContext,
): void {
  style[name] = resolve(name, candidate, parent, context);
}

function resolve<K extends PropertyName>(
  name: K,
  candidate: Candidate | undefined,
  parent: ComputedStyle | null,
  context: ComputeContext,
): ComputedStyle[K] {
  const definition = properties[name];
  const inherited = parent === null ? definition.initial : parent[name];
  const fallback = definition.inherited ? inherited : definition.initial;

  if (candidate === undefined) return fallback;

  switch (globalKeyword(candidate.value)) {
    case 'inherit':
      return inherited;
    case 'initial':
      return definition.initial;
    case 'unset':
      return fallback;
    default:
      return definition.parse(candidate.value, context) ?? fallback;
  }
}

function globalKeyword(value: readonly Token[]): 'inherit' | 'initial' | 'unset' | null {
  const meaningful = value.filter((token) => token.type !== 'whitespace');
  const token = meaningful.length === 1 ? meaningful[0] : undefined;
  if (token?.type !== 'ident') return null;

  switch (token.value.toLowerCase()) {
    case 'inherit':
      return 'inherit';
    case 'initial':
      return 'initial';
    case 'unset':
      return 'unset';
    default:
      return null;
  }
}

/** CSS cascade order: normal user agent, normal author, important author, important user agent. */
function rank(candidate: Candidate): number {
  if (!candidate.important) return candidate.origin === 'user-agent' ? 0 : 1;
  return candidate.origin === 'author' ? 2 : 3;
}

function beats(a: Candidate, b: Candidate): boolean {
  const byRank = rank(a) - rank(b);
  if (byRank !== 0) return byRank > 0;
  if (a.inline !== b.inline) return a.inline;
  const bySpecificity = compareSpecificity(a.specificity, b.specificity);
  if (bySpecificity !== 0) return bySpecificity > 0;
  return a.order >= b.order;
}
