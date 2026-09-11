export type Token =
  | { type: 'ident'; value: string }
  | { type: 'function'; value: string }
  | { type: 'hash'; value: string }
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'percentage'; value: number }
  | { type: 'dimension'; value: number; unit: string }
  | { type: 'delim'; value: string }
  | { type: 'whitespace' }
  | { type: 'colon' }
  | { type: 'semicolon' }
  | { type: 'comma' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'lbrace' }
  | { type: 'rbrace' }
  | { type: 'eof' };

function isWhitespace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9';
}

function isNameStart(c: string): boolean {
  return /[a-zA-Z_]/.test(c) || c.charCodeAt(0) >= 0x80;
}

function isName(c: string): boolean {
  return c !== '' && (isNameStart(c) || isDigit(c) || c === '-');
}

export function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  const at = (offset = 0): string => input.charAt(i + offset);

  const startsNumber = (): boolean => {
    const c = at();
    if (isDigit(c)) return true;
    if (c === '.') return isDigit(at(1));
    if (c === '+' || c === '-') return isDigit(at(1)) || (at(1) === '.' && isDigit(at(2)));
    return false;
  };

  const startsIdent = (): boolean => {
    const c = at();
    if (c !== '' && isNameStart(c)) return true;
    return c === '-' && (isNameStart(at(1)) || at(1) === '-');
  };

  const readName = (): string => {
    const start = i;
    while (isName(at())) i++;
    return input.slice(start, i);
  };

  const readNumber = (): number => {
    const start = i;
    if (at() === '+' || at() === '-') i++;
    while (isDigit(at())) i++;
    if (at() === '.' && isDigit(at(1))) {
      i += 2;
      while (isDigit(at())) i++;
    }
    return Number(input.slice(start, i));
  };

  const readString = (quote: string): string => {
    i++;
    let out = '';
    while (i < input.length && at() !== quote) {
      if (at() === '\\') i++;
      out += at();
      i++;
    }
    i++;
    return out;
  };

  while (i < input.length) {
    const c = at();

    if (c === '/' && at(1) === '*') {
      const end = input.indexOf('*/', i + 2);
      i = end === -1 ? input.length : end + 2;
      continue;
    }

    if (isWhitespace(c)) {
      while (isWhitespace(at())) i++;
      tokens.push({ type: 'whitespace' });
      continue;
    }

    if (c === '"' || c === "'") {
      tokens.push({ type: 'string', value: readString(c) });
      continue;
    }

    if (c === '#' && isName(at(1))) {
      i++;
      tokens.push({ type: 'hash', value: readName() });
      continue;
    }

    if (startsNumber()) {
      const value = readNumber();
      if (at() === '%') {
        i++;
        tokens.push({ type: 'percentage', value });
      } else if (startsIdent()) {
        tokens.push({ type: 'dimension', value, unit: readName().toLowerCase() });
      } else {
        tokens.push({ type: 'number', value });
      }
      continue;
    }

    if (startsIdent()) {
      const name = readName();
      if (at() === '(') {
        i++;
        tokens.push({ type: 'function', value: name });
      } else {
        tokens.push({ type: 'ident', value: name });
      }
      continue;
    }

    i++;
    switch (c) {
      case ':':
        tokens.push({ type: 'colon' });
        break;
      case ';':
        tokens.push({ type: 'semicolon' });
        break;
      case ',':
        tokens.push({ type: 'comma' });
        break;
      case '(':
        tokens.push({ type: 'lparen' });
        break;
      case ')':
        tokens.push({ type: 'rparen' });
        break;
      case '{':
        tokens.push({ type: 'lbrace' });
        break;
      case '}':
        tokens.push({ type: 'rbrace' });
        break;
      default:
        tokens.push({ type: 'delim', value: c });
    }
  }

  tokens.push({ type: 'eof' });
  return tokens;
}
