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

/**
 * Chromium's default font size is 13px when the family is exactly `monospace`, and 16px
 * otherwise. `monospace, Arial` gets 16, and so does `"Courier New", monospace`: the list has
 * to be the bare generic. This is why a `<pre>` looks smaller than the text around it.
 */
const MONOSPACE_DEFAULT = 13;

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
  const rootComputed = computeFor(root, null, false, declarations, properties.fontSize.initial);
  styles.set(root, rootComputed.style);

  const walk = (node: ElementNode, parent: ComputedStyle, fontSizeSpecified: boolean) => {
    const computed = computeFor(
      node,
      parent,
      fontSizeSpecified,
      declarations,
      rootComputed.style.fontSize,
    );
    styles.set(node, computed.style);
    for (const child of elementChildren(node)) {
      walk(child, computed.style, computed.fontSizeSpecified);
    }
  };

  for (const child of elementChildren(root)) {
    walk(child, rootComputed.style, rootComputed.fontSizeSpecified);
  }

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
  parentSpecifiedFontSize: boolean,
  declarations: readonly MatchableDeclaration[],
  rootFontSize: number,
) {
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

  // The family comes first because the default font size depends on it, and font-size comes
  // second because every other em length on this element is relative to it.
  const base: ComputeContext = { fontSize: 0, rootFontSize };
  style.fontFamily = resolve('fontFamily', winners.get('fontFamily'), parent, base);

  const fontSize = resolveFontSize(
    winners.get('fontSize'),
    style.fontFamily,
    parent,
    parentSpecifiedFontSize,
    rootFontSize,
  );
  style.fontSize = fontSize.size;

  const context: ComputeContext = { fontSize: fontSize.size, rootFontSize };
  for (const name of propertyNames) {
    if (name === 'fontSize' || name === 'fontFamily') continue;
    assign(style, name, winners.get(name), parent, context);
  }

  return { style, fontSizeSpecified: fontSize.specified };
}

/**
 * Until something declares a font size, each element resolves the default for its own family
 * rather than inheriting a length. Once a declaration appears anywhere up the chain, ordinary
 * inheritance takes over.
 */
function resolveFontSize(
  candidate: Candidate | undefined,
  family: readonly string[],
  parent: ComputedStyle | null,
  parentSpecified: boolean,
  rootFontSize: number,
): { size: number; specified: boolean } {
  const initial =
    family.length === 1 && family[0] === 'monospace'
      ? MONOSPACE_DEFAULT
      : properties.fontSize.initial;
  const inherited = parentSpecified ? (parent?.fontSize ?? initial) : initial;

  if (candidate === undefined) return { size: inherited, specified: parentSpecified };

  const context: ComputeContext = { fontSize: inherited, rootFontSize };

  switch (globalKeyword(candidate.value)) {
    case 'inherit':
    case 'unset':
      return { size: inherited, specified: true };
    case 'initial':
      return { size: initial, specified: true };
    default:
      break;
  }

  if (isMedium(candidate.value)) return { size: initial, specified: true };

  const parsed = properties.fontSize.parse(candidate.value, context);
  return { size: parsed ?? inherited, specified: true };
}

function isMedium(value: readonly Token[]): boolean {
  const meaningful = value.filter((token) => token.type !== 'whitespace');
  const token = meaningful.length === 1 ? meaningful[0] : undefined;
  return token?.type === 'ident' && token.value.toLowerCase() === 'medium';
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
