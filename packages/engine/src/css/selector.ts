import { type Token, tokenize } from './tokenize.js';

export type Combinator = 'descendant' | 'child' | 'next-sibling' | 'subsequent-sibling';

export type PseudoClass =
  | { name: 'hover' }
  | { name: 'first-child' }
  | { name: 'last-child' }
  | { name: 'nth-child'; a: number; b: number };

export type CompoundSelector = {
  tag: string | null;
  id: string | null;
  classes: string[];
  pseudoClasses: PseudoClass[];
};

/** Stored right to left, because that is the order matching walks it. */
export type ComplexSelector = {
  key: CompoundSelector;
  ancestor: { combinator: Combinator; selector: ComplexSelector } | null;
};

export type Specificity = readonly [number, number, number];

export function parseSelectorList(tokens: readonly Token[]): ComplexSelector[] | null {
  const selectors: ComplexSelector[] = [];
  let i = 0;

  const peek = (): Token => tokens[i] ?? { type: 'eof' };

  const skipSpace = () => {
    while (peek().type === 'whitespace') i++;
  };

  const readCompound = () => {
    const compound: CompoundSelector = { tag: null, id: null, classes: [], pseudoClasses: [] };
    let empty = true;

    for (;;) {
      const token = peek();

      if (token.type === 'ident' && empty) {
        compound.tag = token.value.toLowerCase();
        i++;
      } else if (token.type === 'hash') {
        compound.id = token.value;
        i++;
      } else if (token.type === 'delim' && token.value === '*' && empty) {
        i++;
      } else if (token.type === 'delim' && token.value === '.') {
        i++;
        const name = peek();
        if (name.type !== 'ident') return null;
        compound.classes.push(name.value);
        i++;
      } else if (token.type === 'colon') {
        i++;
        const pseudo = readPseudoClass();
        if (pseudo === null) return null;
        compound.pseudoClasses.push(pseudo);
      } else {
        break;
      }
      empty = false;
    }

    return empty ? null : compound;
  };

  const readPseudoClass = (): PseudoClass | null => {
    const token = peek();

    if (token.type === 'ident') {
      i++;
      switch (token.value.toLowerCase()) {
        case 'hover':
          return { name: 'hover' };
        case 'first-child':
          return { name: 'first-child' };
        case 'last-child':
          return { name: 'last-child' };
        default:
          return null;
      }
    }

    if (token.type === 'function' && token.value.toLowerCase() === 'nth-child') {
      i++;
      const args: Token[] = [];
      while (peek().type !== 'rparen' && peek().type !== 'eof') {
        const arg = peek();
        if (arg.type !== 'whitespace') args.push(arg);
        i++;
      }
      if (peek().type !== 'rparen') return null;
      i++;
      const nth = parseAnB(args);
      return nth === null ? null : { name: 'nth-child', a: nth.a, b: nth.b };
    }

    return null;
  };

  const readComplex = () => {
    skipSpace();
    const first = readCompound();
    if (first === null) return null;

    let selector: ComplexSelector = { key: first, ancestor: null };

    for (;;) {
      const space = peek().type === 'whitespace';
      if (space) skipSpace();

      const token = peek();
      let combinator: Combinator | null = null;

      if (token.type === 'delim' && token.value === '>') combinator = 'child';
      else if (token.type === 'delim' && token.value === '+') combinator = 'next-sibling';
      else if (token.type === 'delim' && token.value === '~') combinator = 'subsequent-sibling';

      if (combinator !== null) {
        i++;
        skipSpace();
      } else if (
        space &&
        (token.type === 'ident' ||
          token.type === 'hash' ||
          token.type === 'delim' ||
          token.type === 'colon')
      ) {
        combinator = 'descendant';
      } else {
        break;
      }

      const next = readCompound();
      if (next === null) return null;
      selector = { key: next, ancestor: { combinator, selector } };
    }

    return selector;
  };

  for (;;) {
    const selector = readComplex();
    if (selector === null) return null;
    selectors.push(selector);

    skipSpace();
    if (peek().type === 'comma') {
      i++;
      continue;
    }
    if (peek().type === 'eof' || i >= tokens.length) break;
    return null;
  }

  return selectors;
}

export function parseSelector(text: string): ComplexSelector[] | null {
  return parseSelectorList(tokenize(text));
}

export function specificity(selector: ComplexSelector): Specificity {
  let ids = 0;
  let classes = 0;
  let tags = 0;

  let current: ComplexSelector | null = selector;
  while (current !== null) {
    const { key } = current;
    if (key.id !== null) ids++;
    classes += key.classes.length + key.pseudoClasses.length;
    if (key.tag !== null) tags++;
    current = current.ancestor?.selector ?? null;
  }

  return [ids, classes, tags];
}

export function compareSpecificity(a: Specificity, b: Specificity): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

function parseAnB(tokens: readonly Token[]): { a: number; b: number } | null {
  const first = tokens[0];
  if (first === undefined) return null;

  if (tokens.length === 1 && first.type === 'ident') {
    const keyword = first.value.toLowerCase();
    if (keyword === 'odd') return { a: 2, b: 1 };
    if (keyword === 'even') return { a: 2, b: 0 };
  }

  if (tokens.length === 1 && first.type === 'number') {
    return { a: 0, b: first.value };
  }

  // A name runs on through dashes and digits, so `2n-1` arrives as a 2 with the unit `n-1`
  // and `-n-1` as one identifier. The minus, and sometimes b itself, can be inside the n.
  let a: number;
  let n: string;
  if (first.type === 'dimension') {
    a = first.value;
    n = first.unit;
  } else if (first.type === 'ident') {
    const name = first.value.toLowerCase();
    a = name.startsWith('-') ? -1 : 1;
    n = name.startsWith('-') ? name.slice(1) : name;
  } else {
    return null;
  }

  const second = tokens[1];
  const third = tokens[2];

  if (n === 'n') {
    if (second === undefined) return { a, b: 0 };
    if (second.type === 'number' && tokens.length === 2) return { a, b: second.value };
    if (second.type === 'delim' && third?.type === 'number' && tokens.length === 3) {
      if (second.value === '+') return { a, b: third.value };
      if (second.value === '-') return { a, b: -third.value };
    }
    return null;
  }

  if (n === 'n-' && second?.type === 'number' && tokens.length === 2) {
    return { a, b: -second.value };
  }

  const glued = /^n-(\d+)$/.exec(n)?.[1];
  return glued !== undefined && tokens.length === 1 ? { a, b: -Number(glued) } : null;
}
