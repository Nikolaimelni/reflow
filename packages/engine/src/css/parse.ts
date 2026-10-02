import { type ComplexSelector, parseSelectorList } from './selector.js';
import { type Token, tokenize } from './tokenize.js';

export type Declaration = {
  property: string;
  value: Token[];
  important: boolean;
};

export type StyleRule = {
  selectors: ComplexSelector[];
  declarations: Declaration[];
};

export function parseStylesheet(css: string): StyleRule[] {
  const tokens = tokenize(css);
  const rules: StyleRule[] = [];
  let i = 0;

  const peek = (): Token => tokens[i] ?? { type: 'eof' };

  const skipAtRule = () => {
    let depth = 0;
    while (i < tokens.length) {
      const { type } = peek();
      i++;
      if (type === 'lbrace') depth++;
      else if (type === 'rbrace' && --depth <= 0) return;
      else if (type === 'semicolon' && depth === 0) return;
      else if (type === 'eof') return;
    }
  };

  const readDeclarations = () => {
    const declarations: Declaration[] = [];

    while (peek().type !== 'rbrace' && peek().type !== 'eof') {
      const start = i;
      while (peek().type !== 'semicolon' && peek().type !== 'rbrace' && peek().type !== 'eof') {
        i++;
      }
      const declaration = readDeclaration(tokens.slice(start, i));
      if (declaration !== null) declarations.push(declaration);
      if (peek().type === 'semicolon') i++;
    }

    if (peek().type === 'rbrace') i++;
    return declarations;
  };

  while (peek().type !== 'eof') {
    const token = peek();

    if (token.type === 'whitespace') {
      i++;
      continue;
    }

    // At-rules are outside the supported subset, so the whole thing goes in the bin.
    if (token.type === 'delim' && token.value === '@') {
      skipAtRule();
      continue;
    }

    const preludeStart = i;
    while (peek().type !== 'lbrace' && peek().type !== 'eof') i++;
    if (peek().type !== 'lbrace') break;
    i++;

    const selectors = parseSelectorList(tokens.slice(preludeStart, i - 1));
    const declarations = readDeclarations();

    if (selectors !== null && selectors.length > 0) {
      rules.push({ selectors, declarations });
    }
  }

  return rules;
}

/** For a `style` attribute, which is a declaration block without the braces around it. */
export function parseDeclarationBlock(css: string): Declaration[] {
  const tokens = tokenize(css);
  const declarations: Declaration[] = [];
  let start = 0;

  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i]?.type !== 'semicolon' && tokens[i]?.type !== 'eof') continue;
    const declaration = readDeclaration(tokens.slice(start, i));
    if (declaration !== null) declarations.push(declaration);
    start = i + 1;
  }

  return declarations;
}

function readDeclaration(tokens: readonly Token[]): Declaration | null {
  let i = 0;
  while (tokens[i]?.type === 'whitespace') i++;

  const name = tokens[i];
  if (name?.type !== 'ident') return null;
  i++;

  while (tokens[i]?.type === 'whitespace') i++;
  if (tokens[i]?.type !== 'colon') return null;
  i++;

  const value = tokens.slice(i).filter((token) => token.type !== 'eof');
  while (value[0]?.type === 'whitespace') value.shift();
  while (value.at(-1)?.type === 'whitespace') value.pop();

  let important = false;
  const last = value.at(-1);
  // `! important` is as valid as `!important`.
  const gap = value.at(-2)?.type === 'whitespace' ? 1 : 0;
  const bang = value.at(-2 - gap);
  if (
    last?.type === 'ident' &&
    last.value.toLowerCase() === 'important' &&
    bang?.type === 'delim' &&
    bang.value === '!'
  ) {
    important = true;
    value.splice(-2 - gap);
    while (value.at(-1)?.type === 'whitespace') value.pop();
  }

  if (value.length === 0) return null;

  return { property: name.value.toLowerCase(), value, important };
}
