// A small, sandboxed interpreter for the Python subset VFX Script programs
// use: a tokenizer with indentation, a recursive-descent parser and a
// tree-walking evaluator. No eval / new Function: scripts only reach the
// builtins and modules given here, and every run has an instruction budget.
//
// Supported: modules (import / from-import of math, random, flvfx), def
// (defaults, keyword arguments, *args), class (single and builtin
// inheritance, class attributes, methods, __init__), lambda, if / elif /
// else, while / for (+ else), break / continue / pass, return, global /
// nonlocal, try / except / finally / raise, assert, del, assignment with
// unpacking and augmented assignment, the usual expressions (arithmetic,
// comparison chains, and / or / not, in / is, conditional expressions,
// slicing, list / tuple / dict / set displays, list and generator
// comprehensions, f-strings), and the common builtins and str / list / dict
// methods.

export class PyError extends Error {
  constructor(public type: string, message: string, public line = 0) {
    super(message);
  }
  get text(): string {
    return `${this.type}: ${this.message}${this.line ? ` (line ${this.line})` : ''}`;
  }
}

// ------------------------------------------------------------------ tokens

type Tok = { t: 'name' | 'num' | 'str' | 'fstr' | 'op' | 'nl' | 'indent' | 'dedent' | 'eof'; v: string; line: number; n?: number };

const KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']);
const OPS3 = ['**=', '//=', '>>=', '<<=', '...'];
const OPS2 = ['**', '//', '==', '!=', '<=', '>=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '->', '<<', '>>', ':='];
const OPS1 = '()[]{},:.;@=+-*/%<>&|^~';

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  const indents = [0];
  let i = 0, line = 1, depth = 0, atLineStart = true;
  const n = src.length;
  while (i < n) {
    if (atLineStart && depth === 0) {
      let col = 0, j = i;
      while (j < n && (src[j] === ' ' || src[j] === '\t')) { col += src[j] === '\t' ? 8 - (col % 8) : 1; j++; }
      if (j >= n) { i = j; break; }
      if (src[j] === '\n' || src[j] === '\r' || src[j] === '#') {
        // blank or comment-only line
        while (j < n && src[j] !== '\n') j++;
        i = j + 1; line++;
        continue;
      }
      i = j;
      atLineStart = false;
      if (col > indents[indents.length - 1]) { indents.push(col); out.push({ t: 'indent', v: '', line }); }
      else {
        while (col < indents[indents.length - 1]) { indents.pop(); out.push({ t: 'dedent', v: '', line }); }
        if (col !== indents[indents.length - 1]) throw new PyError('IndentationError', 'unindent does not match any outer indentation level', line);
      }
    }
    const c = src[i];
    if (c === '\n') {
      if (depth === 0) { out.push({ t: 'nl', v: '', line }); atLineStart = true; }
      line++; i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) { i += src[i + 1] === '\r' ? 3 : 2; line++; continue; }
    // strings (with prefixes)
    const pm = /^([rRbBuUfF]{0,2})(['"])/.exec(src.slice(i, i + 4));
    if (pm && (pm[1].length > 0 || c === '"' || c === "'")) {
      const prefix = pm[1].toLowerCase();
      if (prefix && !/^(r|b|u|f|rb|br|fr|rf)$/.test(prefix)) { /* a name, fall through */ } else {
        i += prefix.length;
        const q = src[i];
        const triple = src.slice(i, i + 3) === q.repeat(3);
        const qs = triple ? q.repeat(3) : q;
        i += qs.length;
        let s = '';
        const startLine = line;
        for (;;) {
          if (i >= n) throw new PyError('SyntaxError', 'unterminated string literal', startLine);
          if (src.startsWith(qs, i)) { i += qs.length; break; }
          const ch = src[i];
          if (ch === '\n') { if (!triple) throw new PyError('SyntaxError', 'unterminated string literal', startLine); line++; }
          if (ch === '\\' && !prefix.includes('r')) {
            const e = src[i + 1];
            const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
            if (e === '\n') { i += 2; line++; continue; }
            if (e === 'x') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16)); i += 4; continue; }
            if (e === 'u') { s += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6; continue; }
            if (e in map) { s += map[e]; i += 2; continue; }
            s += ch; i++; continue;
          }
          s += ch; i++;
        }
        const last = out[out.length - 1];
        const isF = prefix.includes('f');
        // implicit concatenation of adjacent literals
        if (last && (last.t === 'str' || last.t === 'fstr') && last.line >= startLine - 1 && !isF && last.t === 'str') { last.v += s; continue; }
        out.push({ t: isF ? 'fstr' : 'str', v: s, line: startLine });
        continue;
      }
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?))/.exec(src.slice(i));
      const txt = m![0];
      const clean = txt.replace(/_/g, '');
      let val: number;
      if (/^0[xX]/.test(clean)) val = parseInt(clean.slice(2), 16);
      else if (/^0[bB]/.test(clean)) val = parseInt(clean.slice(2), 2);
      else if (/^0[oO]/.test(clean)) val = parseInt(clean.slice(2), 8);
      else val = parseFloat(clean);
      out.push({ t: 'num', v: /[.eE]/.test(clean) && !/^0[xX]/.test(clean) ? 'f' : 'i', n: val, line });
      i += txt.length;
      continue;
    }
    if (/[A-Za-z_À-￿]/.test(c)) {
      const m = /^[A-Za-z_0-9À-￿]+/.exec(src.slice(i))!;
      out.push({ t: 'name', v: m[0], line });
      i += m[0].length;
      continue;
    }
    const s3 = src.slice(i, i + 3), s2 = src.slice(i, i + 2);
    const op = OPS3.includes(s3) ? s3 : OPS2.includes(s2) ? s2 : OPS1.includes(c) ? c : null;
    if (!op) throw new PyError('SyntaxError', `invalid character '${c}'`, line);
    if ('([{'.includes(op)) depth++;
    if (')]}'.includes(op)) depth = Math.max(0, depth - 1);
    out.push({ t: 'op', v: op, line });
    i += op.length;
  }
  if (out.length && out[out.length - 1].t !== 'nl') out.push({ t: 'nl', v: '', line });
  while (indents.length > 1) { indents.pop(); out.push({ t: 'dedent', v: '', line }); }
  out.push({ t: 'eof', v: '', line });
  return out;
}

// --------------------------------------------------------------------- AST

/* eslint-disable @typescript-eslint/no-explicit-any */
type Node = { k: string; line: number; [key: string]: any };

class Parser {
  private p = 0;
  constructor(private toks: Tok[]) {}
  private get tok(): Tok { return this.toks[this.p]; }
  private peek(o = 1): Tok { return this.toks[Math.min(this.toks.length - 1, this.p + o)]; }
  private isOp(v: string): boolean { return this.tok.t === 'op' && this.tok.v === v; }
  private isKw(v: string): boolean { return this.tok.t === 'name' && this.tok.v === v; }
  private next(): Tok { return this.toks[this.p++]; }
  private err(msg: string): never { throw new PyError('SyntaxError', msg, this.tok.line); }
  private expectOp(v: string): Tok { if (!this.isOp(v)) this.err(`expected '${v}'`); return this.next(); }
  private expectKw(v: string): Tok { if (!this.isKw(v)) this.err(`expected '${v}'`); return this.next(); }
  private name(): string {
    if (this.tok.t !== 'name' || KEYWORDS.has(this.tok.v)) this.err('invalid syntax');
    return this.next().v;
  }

  module(): Node[] {
    const body: Node[] = [];
    while (this.tok.t !== 'eof') {
      if (this.tok.t === 'nl') { this.next(); continue; }
      body.push(...this.statement());
    }
    return body;
  }

  private block(): Node[] {
    this.expectOp(':');
    if (this.tok.t !== 'nl') {
      const s = this.simpleLine();
      return s;
    }
    this.next();
    while (this.tok.t === 'nl') this.next();
    if (this.tok.t !== 'indent') this.err('expected an indented block');
    this.next();
    const body: Node[] = [];
    while (this.tok.t !== 'dedent' && this.tok.t !== 'eof') {
      if (this.tok.t === 'nl') { this.next(); continue; }
      body.push(...this.statement());
    }
    if (this.tok.t === 'dedent') this.next();
    return body;
  }

  private statement(): Node[] {
    const t = this.tok;
    if (t.t === 'name') {
      switch (t.v) {
        case 'if': return [this.ifStmt()];
        case 'while': {
          this.next();
          const test = this.expr();
          const body = this.block();
          const orelse = this.isKw('else') ? (this.next(), this.block()) : [];
          return [{ k: 'While', line: t.line, test, body, orelse }];
        }
        case 'for': {
          this.next();
          const target = this.targetList();
          this.expectKw('in');
          const iter = this.exprList();
          const body = this.block();
          const orelse = this.isKw('else') ? (this.next(), this.block()) : [];
          return [{ k: 'For', line: t.line, target, iter, body, orelse }];
        }
        case 'def': return [this.funcDef()];
        case 'class': {
          this.next();
          const name = this.name();
          let bases: Node[] = [];
          if (this.isOp('(')) {
            this.next();
            bases = [];
            while (!this.isOp(')')) { bases.push(this.expr()); if (!this.isOp(',')) break; this.next(); }
            this.expectOp(')');
          }
          return [{ k: 'Class', line: t.line, name, bases, body: this.block() }];
        }
        case 'try': {
          this.next();
          const body = this.block();
          const handlers: Node[] = [];
          while (this.isKw('except')) {
            const hl = this.next().line;
            let type: Node | null = null, as: string | null = null;
            if (!this.isOp(':')) { type = this.expr(); if (this.isKw('as')) { this.next(); as = this.name(); } }
            handlers.push({ k: 'Handler', line: hl, type, as, body: this.block() });
          }
          const orelse = this.isKw('else') ? (this.next(), this.block()) : [];
          const fin = this.isKw('finally') ? (this.next(), this.block()) : [];
          return [{ k: 'Try', line: t.line, body, handlers, orelse, fin }];
        }
        case 'with': this.err('with statements are not supported');
      }
    }
    if (this.isOp('@')) this.err('decorators are not supported');
    return this.simpleLine();
  }

  private ifStmt(): Node {
    const line = this.next().line;
    const test = this.expr();
    const body = this.block();
    let orelse: Node[] = [];
    if (this.isKw('elif')) orelse = [this.ifStmt()];
    else if (this.isKw('else')) { this.next(); orelse = this.block(); }
    return { k: 'If', line, test, body, orelse };
  }

  private funcDef(): Node {
    const line = this.next().line;
    const name = this.name();
    const args = this.params(')');
    if (this.isOp('->')) { this.next(); this.expr(); }
    return { k: 'Def', line, name, args, body: this.block() };
  }

  private params(close: string): { names: string[]; defaults: (Node | null)[]; star: string | null; kw: string | null } {
    if (close === ')') this.expectOp('(');
    const names: string[] = [], defaults: (Node | null)[] = [];
    let star: string | null = null, kw: string | null = null;
    while (!this.isOp(close)) {
      if (this.isOp('*')) { this.next(); if (this.tok.t === 'name') star = this.name(); }
      else if (this.isOp('**')) { this.next(); kw = this.name(); }
      else {
        names.push(this.name());
        if (this.isOp(':') && close === ')') { this.next(); this.expr(); }
        if (this.isOp('=')) { this.next(); defaults.push(this.expr()); } else defaults.push(null);
      }
      if (!this.isOp(',')) break;
      this.next();
    }
    if (close === ')') this.expectOp(')');
    return { names, defaults, star, kw };
  }

  private simpleLine(): Node[] {
    const out: Node[] = [this.simple()];
    while (this.isOp(';')) { this.next(); if (this.tok.t === 'nl' || this.tok.t === 'eof') break; out.push(this.simple()); }
    if (this.tok.t === 'nl') this.next();
    else if (this.tok.t !== 'eof' && this.tok.t !== 'dedent') this.err('invalid syntax');
    return out;
  }

  private simple(): Node {
    const t = this.tok;
    if (t.t === 'name') {
      switch (t.v) {
        case 'pass': this.next(); return { k: 'Pass', line: t.line };
        case 'break': this.next(); return { k: 'Break', line: t.line };
        case 'continue': this.next(); return { k: 'Continue', line: t.line };
        case 'return': {
          this.next();
          const value = this.tok.t === 'nl' || this.isOp(';') || this.tok.t === 'eof' ? null : this.exprList();
          return { k: 'Return', line: t.line, value };
        }
        case 'global': case 'nonlocal': {
          this.next();
          const names = [this.name()];
          while (this.isOp(',')) { this.next(); names.push(this.name()); }
          return { k: t.v === 'global' ? 'Global' : 'Nonlocal', line: t.line, names };
        }
        case 'import': {
          this.next();
          const items: { mod: string; as: string }[] = [];
          do {
            if (items.length) this.next();
            let mod = this.name();
            while (this.isOp('.')) { this.next(); mod += '.' + this.name(); }
            const as = this.isKw('as') ? (this.next(), this.name()) : mod.split('.')[0];
            items.push({ mod, as });
          } while (this.isOp(','));
          return { k: 'Import', line: t.line, items };
        }
        case 'from': {
          this.next();
          let mod = this.name();
          while (this.isOp('.')) { this.next(); mod += '.' + this.name(); }
          this.expectKw('import');
          const names: { name: string; as: string }[] = [];
          const paren = this.isOp('(');
          if (paren) this.next();
          if (this.isOp('*')) { this.next(); names.push({ name: '*', as: '*' }); }
          else do {
            if (names.length) this.next();
            if (paren && this.isOp(')')) break;
            const name = this.name();
            names.push({ name, as: this.isKw('as') ? (this.next(), this.name()) : name });
          } while (this.isOp(','));
          if (paren) this.expectOp(')');
          return { k: 'ImportFrom', line: t.line, mod, names };
        }
        case 'raise': {
          this.next();
          const exc = this.tok.t === 'nl' || this.tok.t === 'eof' ? null : this.expr();
          return { k: 'Raise', line: t.line, exc };
        }
        case 'assert': {
          this.next();
          const test = this.expr();
          const msg = this.isOp(',') ? (this.next(), this.expr()) : null;
          return { k: 'Assert', line: t.line, test, msg };
        }
        case 'del': {
          this.next();
          return { k: 'Del', line: t.line, targets: this.exprList() };
        }
      }
    }
    const first = this.exprList(true);
    if (this.isOp('=')) {
      const targets = [first];
      let value: Node = first;
      while (this.isOp('=')) { this.next(); value = this.exprList(true); targets.push(value); }
      targets.pop();
      for (const tg of targets) this.checkTarget(tg);
      return { k: 'Assign', line: t.line, targets, value };
    }
    if (this.tok.t === 'op' && /^(\+|-|\*|\/|\/\/|%|\*\*|&|\||\^|<<|>>)=$/.test(this.tok.v)) {
      const op = this.next().v.slice(0, -1);
      this.checkTarget(first);
      return { k: 'AugAssign', line: t.line, target: first, op, value: this.exprList() };
    }
    if (this.isOp(':')) { // annotated assignment: x: int = 3
      this.next();
      this.expr();
      if (this.isOp('=')) { this.next(); return { k: 'Assign', line: t.line, targets: [first], value: this.exprList() }; }
      return { k: 'Pass', line: t.line };
    }
    return { k: 'Expr', line: t.line, value: first };
  }

  private checkTarget(n: Node): void {
    if (n.k === 'Name' || n.k === 'Attribute' || n.k === 'Subscript') return;
    if ((n.k === 'Tuple' || n.k === 'List') && n.items.every((x: Node) => { this.checkTarget(x); return true; })) return;
    if (n.k === 'Starred') return;
    throw new PyError('SyntaxError', 'cannot assign to expression', n.line);
  }

  private targetList(): Node {
    // targets stop before 'in' (no comparisons)
    const line = this.tok.line;
    const one = () => (this.isOp('*') ? this.starred() : this.bitOr());
    const items: Node[] = [one()];
    while (this.isOp(',')) { this.next(); if (this.isKw('in')) break; items.push(one()); }
    return items.length === 1 ? items[0] : { k: 'Tuple', line, items };
  }

  private exprList(allowStar = false): Node {
    const line = this.tok.line;
    const first = allowStar && this.isOp('*') ? this.starred() : this.expr();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.isOp(',')) {
      this.next();
      if (this.tok.t === 'nl' || this.isOp('=') || this.isOp(')') || this.tok.t === 'eof' || this.isOp(';')) break;
      items.push(allowStar && this.isOp('*') ? this.starred() : this.expr());
    }
    return { k: 'Tuple', line, items };
  }

  private starred(): Node {
    const line = this.next().line;
    return { k: 'Starred', line, value: this.bitOr() };
  }

  expr(): Node {
    if (this.isKw('lambda')) {
      const line = this.next().line;
      const args = this.params(':');
      this.expectOp(':');
      return { k: 'Lambda', line, args, body: this.expr() };
    }
    const line = this.tok.line;
    const body = this.orExpr();
    if (this.isKw('if') ) {
      this.next();
      const test = this.orExpr();
      this.expectKw('else');
      const orelse = this.expr();
      return { k: 'IfExp', line, test, body, orelse };
    }
    return body;
  }

  private orExpr(): Node {
    let left = this.andExpr();
    while (this.isKw('or')) { const line = this.next().line; left = { k: 'Or', line, left, right: this.andExpr() }; }
    return left;
  }

  private andExpr(): Node {
    let left = this.notExpr();
    while (this.isKw('and')) { const line = this.next().line; left = { k: 'And', line, left, right: this.notExpr() }; }
    return left;
  }

  private notExpr(): Node {
    if (this.isKw('not')) { const line = this.next().line; return { k: 'Not', line, value: this.notExpr() }; }
    return this.comparison();
  }

  private comparison(): Node {
    const line = this.tok.line;
    const left = this.bitOr();
    const ops: string[] = [], rights: Node[] = [];
    for (;;) {
      let op: string | null = null;
      if (this.tok.t === 'op' && ['<', '>', '==', '>=', '<=', '!='].includes(this.tok.v)) op = this.next().v;
      else if (this.isKw('in')) { this.next(); op = 'in'; }
      else if (this.isKw('not') && this.peek().t === 'name' && this.peek().v === 'in') { this.next(); this.next(); op = 'not in'; }
      else if (this.isKw('is')) { this.next(); if (this.isKw('not')) { this.next(); op = 'is not'; } else op = 'is'; }
      if (!op) break;
      ops.push(op);
      rights.push(this.bitOr());
    }
    return ops.length ? { k: 'Compare', line, left, ops, rights } : left;
  }

  private binLevel(ops: string[], nextFn: () => Node): Node {
    let left = nextFn();
    while (this.tok.t === 'op' && ops.includes(this.tok.v)) {
      const t = this.next();
      left = { k: 'Bin', line: t.line, op: t.v, left, right: nextFn() };
    }
    return left;
  }

  private bitOr(): Node { return this.binLevel(['|'], () => this.bitXor()); }
  private bitXor(): Node { return this.binLevel(['^'], () => this.bitAnd()); }
  private bitAnd(): Node { return this.binLevel(['&'], () => this.shift()); }
  private shift(): Node { return this.binLevel(['<<', '>>'], () => this.arith()); }
  private arith(): Node { return this.binLevel(['+', '-'], () => this.term()); }
  private term(): Node { return this.binLevel(['*', '/', '//', '%', '@'], () => this.factor()); }

  private factor(): Node {
    if (this.tok.t === 'op' && ['-', '+', '~'].includes(this.tok.v)) {
      const t = this.next();
      return { k: 'Unary', line: t.line, op: t.v, value: this.factor() };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.postfix(this.atom());
    if (this.isOp('**')) { const line = this.next().line; return { k: 'Bin', line, op: '**', left: base, right: this.factor() }; }
    return base;
  }

  private postfix(n: Node): Node {
    for (;;) {
      if (this.isOp('.')) { const line = this.next().line; n = { k: 'Attribute', line, value: n, attr: this.name() }; }
      else if (this.isOp('(')) {
        const line = this.next().line;
        const args: Node[] = [], kwargs: { name: string; value: Node }[] = [];
        let starArgs: Node | null = null, kwStar: Node | null = null;
        while (!this.isOp(')')) {
          if (this.isOp('*')) { this.next(); starArgs = this.expr(); }
          else if (this.isOp('**')) { this.next(); kwStar = this.expr(); }
          else if (this.tok.t === 'name' && this.peek().t === 'op' && this.peek().v === '=') {
            const name = this.next().v; this.next();
            kwargs.push({ name, value: this.expr() });
          } else {
            const a = this.expr();
            if (this.isKw('for')) args.push(this.comprehension(a, 'Gen', line));
            else args.push(a);
          }
          if (!this.isOp(',')) break;
          this.next();
        }
        this.expectOp(')');
        n = { k: 'Call', line, func: n, args, kwargs, starArgs, kwStar };
      } else if (this.isOp('[')) {
        const line = this.next().line;
        const idx = this.subscript();
        this.expectOp(']');
        n = { k: 'Subscript', line, value: n, index: idx };
      } else return n;
    }
  }

  private subscript(): Node {
    const line = this.tok.line;
    const part = (): Node | null => (this.isOp(':') || this.isOp(']') || this.isOp(',') ? null : this.expr());
    const one = (): Node => {
      const lower = part();
      if (!this.isOp(':')) return lower!;
      this.next();
      const upper = part();
      let step: Node | null = null;
      if (this.isOp(':')) { this.next(); step = part(); }
      return { k: 'Slice', line, lower, upper, step };
    };
    const first = one();
    if (!this.isOp(',')) return first;
    const items = [first];
    while (this.isOp(',')) { this.next(); if (this.isOp(']')) break; items.push(one()); }
    return { k: 'Tuple', line, items };
  }

  private comprehension(elt: Node, kind: string, line: number, valueNode?: Node): Node {
    const gens: { target: Node; iter: Node; ifs: Node[] }[] = [];
    while (this.isKw('for')) {
      this.next();
      const target = this.targetList();
      this.expectKw('in');
      const iter = this.orExpr();
      const ifs: Node[] = [];
      while (this.isKw('if')) { this.next(); ifs.push(this.orExprNoCond()); }
      gens.push({ target, iter, ifs });
    }
    return { k: 'Comp', line, kind, elt, value: valueNode, gens };
  }

  private orExprNoCond(): Node { return this.orExpr(); }

  private atom(): Node {
    const t = this.tok;
    if (t.t === 'num') { this.next(); return { k: 'Const', line: t.line, value: t.n, isFloat: t.v === 'f' }; }
    if (t.t === 'str') { this.next(); return { k: 'Const', line: t.line, value: t.v }; }
    if (t.t === 'fstr') { this.next(); return this.fstring(t); }
    if (t.t === 'name') {
      if (t.v === 'True') { this.next(); return { k: 'Const', line: t.line, value: true }; }
      if (t.v === 'False') { this.next(); return { k: 'Const', line: t.line, value: false }; }
      if (t.v === 'None') { this.next(); return { k: 'Const', line: t.line, value: null }; }
      if (KEYWORDS.has(t.v)) this.err('invalid syntax');
      this.next();
      return { k: 'Name', line: t.line, id: t.v };
    }
    if (this.isOp('...')) { this.next(); return { k: 'Const', line: t.line, value: null }; }
    if (this.isOp('(')) {
      this.next();
      if (this.isOp(')')) { this.next(); return { k: 'Tuple', line: t.line, items: [] }; }
      const first = this.isOp('*') ? this.starred() : this.expr();
      if (this.isKw('for')) { const c = this.comprehension(first, 'Gen', t.line); this.expectOp(')'); return c; }
      if (this.isOp(')')) { this.next(); return first; }
      const items = [first];
      while (this.isOp(',')) { this.next(); if (this.isOp(')')) break; items.push(this.isOp('*') ? this.starred() : this.expr()); }
      this.expectOp(')');
      return { k: 'Tuple', line: t.line, items };
    }
    if (this.isOp('[')) {
      this.next();
      if (this.isOp(']')) { this.next(); return { k: 'List', line: t.line, items: [] }; }
      const first = this.isOp('*') ? this.starred() : this.expr();
      if (this.isKw('for')) { const c = this.comprehension(first, 'List', t.line); this.expectOp(']'); return c; }
      const items = [first];
      while (this.isOp(',')) { this.next(); if (this.isOp(']')) break; items.push(this.isOp('*') ? this.starred() : this.expr()); }
      this.expectOp(']');
      return { k: 'List', line: t.line, items };
    }
    if (this.isOp('{')) {
      this.next();
      if (this.isOp('}')) { this.next(); return { k: 'Dict', line: t.line, keys: [], values: [] }; }
      const first = this.expr();
      if (this.isOp(':')) {
        this.next();
        const v = this.expr();
        if (this.isKw('for')) { const c = this.comprehension(first, 'Dict', t.line, v); this.expectOp('}'); return c; }
        const keys = [first], values = [v];
        while (this.isOp(',')) { this.next(); if (this.isOp('}')) break; keys.push(this.expr()); this.expectOp(':'); values.push(this.expr()); }
        this.expectOp('}');
        return { k: 'Dict', line: t.line, keys, values };
      }
      if (this.isKw('for')) { const c = this.comprehension(first, 'Set', t.line); this.expectOp('}'); return c; }
      const items = [first];
      while (this.isOp(',')) { this.next(); if (this.isOp('}')) break; items.push(this.expr()); }
      this.expectOp('}');
      return { k: 'SetLit', line: t.line, items };
    }
    this.err('invalid syntax');
  }

  private fstring(t: Tok): Node {
    const parts: (string | { expr: Node; spec: string; conv: string })[] = [];
    const s = t.v;
    let i = 0, lit = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '{' && s[i + 1] === '{') { lit += '{'; i += 2; continue; }
      if (c === '}' && s[i + 1] === '}') { lit += '}'; i += 2; continue; }
      if (c === '{') {
        if (lit) { parts.push(lit); lit = ''; }
        let depth = 1, j = i + 1;
        while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; if (depth) j++; }
        const inner = s.slice(i + 1, j);
        let body = inner, spec = '', conv = '';
        const colon = findTopLevel(inner, ':');
        if (colon >= 0) { spec = inner.slice(colon + 1); body = inner.slice(0, colon); }
        const bang = findTopLevel(body, '!');
        if (bang >= 0 && body[bang + 1] !== '=') { conv = body.slice(bang + 1).trim(); body = body.slice(0, bang); }
        const sub = new Parser(tokenize(body.trim()));
        parts.push({ expr: sub.expr(), spec, conv });
        i = j + 1;
        continue;
      }
      lit += c;
      i++;
    }
    if (lit) parts.push(lit);
    return { k: 'FStr', line: t.line, parts };
  }
}

function findTopLevel(s: string, ch: string): number {
  let depth = 0, q = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}

export function parse(src: string): Node[] {
  return new Parser(tokenize(src.replace(/\r\n?/g, '\n'))).module();
}

// ------------------------------------------------------------------ values

export class PyTuple { constructor(public items: unknown[]) {} }
export class PySet { constructor(public items: Set<unknown> = new Set()) {} }
export class PyClass {
  constructor(public name: string, public bases: PyClass[], public attrs: Map<string, unknown>, public native?: NativeClass) {}
  lookup(name: string): unknown {
    if (this.attrs.has(name)) return this.attrs.get(name);
    for (const b of this.bases) { const v = b.lookup(name); if (v !== undefined) return v; }
    return undefined;
  }
  isSub(c: PyClass): boolean { return this === c || this.bases.some((b) => b.isSub(c)); }
  nativeOf(): NativeClass | undefined { return this.native ?? this.bases.map((b) => b.nativeOf()).find(Boolean); }
}
export class PyObject {
  attrs = new Map<string, unknown>();
  constructor(public cls: PyClass) {}
}
export class PyFunc {
  constructor(public name: string, public args: { names: string[]; defaults: (Node | null)[]; star: string | null; kw: string | null }, public defaults: unknown[], public body: Node[] | Node, public closure: Scope, public isLambda = false) {}
}
export class PyBound { constructor(public self: unknown, public fn: unknown) {} }
export type NativeFn = (args: unknown[], kwargs: Record<string, unknown>, vm: VM) => unknown;
export class PyBuiltin { constructor(public name: string, public fn: NativeFn) {} }
export class PyModule { constructor(public name: string, public attrs: Map<string, unknown>) {} }
export interface NativeClass {
  /** Called for instances of this class (and subclasses) right after creation. */
  init(self: PyObject, args: unknown[], kwargs: Record<string, unknown>, vm: VM): void;
  methods: Record<string, (self: PyObject, args: unknown[], kwargs: Record<string, unknown>, vm: VM) => unknown>;
}
class Cell { constructor(public v: unknown) {} }

class Scope {
  vars = new Map<string, unknown>();
  globals = new Set<string>();
  nonlocals = new Set<string>();
  constructor(public parent: Scope | null, public module: Scope | null) {}
}

class BreakSig { }
class ContinueSig { }
class ReturnSig { constructor(public value: unknown) {} }

export const typeName = (v: unknown): string => {
  if (v === null || v === undefined) return 'NoneType';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (typeof v === 'string') return 'str';
  if (Array.isArray(v)) return 'list';
  if (v instanceof PyTuple) return 'tuple';
  if (v instanceof Map) return 'dict';
  if (v instanceof PySet) return 'set';
  if (v instanceof PyObject) return v.cls.name;
  if (v instanceof PyClass) return 'type';
  if (v instanceof PyFunc || v instanceof PyBuiltin || v instanceof PyBound) return 'function';
  if (v instanceof PyModule) return 'module';
  return 'object';
};

export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof PyTuple) return v.items.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (v instanceof PySet) return v.items.size > 0;
  return true;
}

function fmtFloat(n: number): string {
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return n.toFixed(1);
  const s = String(n);
  return s.includes('e') ? s.replace(/e\+?(-?)(\d)$/, 'e$10$2') : s;
}

export function repr(v: unknown, vm?: VM): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  return str(v, vm);
}

export function str(v: unknown, vm?: VM): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isNaN(v) ? 'nan' : !Number.isFinite(v) ? (v > 0 ? 'inf' : '-inf') : floatTag.has(v) && Number.isInteger(v) ? fmtFloat(v) : String(v);
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return `[${v.map((x) => repr(x, vm)).join(', ')}]`;
  if (v instanceof PyTuple) return v.items.length === 1 ? `(${repr(v.items[0], vm)},)` : `(${v.items.map((x) => repr(x, vm)).join(', ')})`;
  if (v instanceof Map) return `{${[...v].map(([k, x]) => `${repr(k, vm)}: ${repr(x, vm)}`).join(', ')}}`;
  if (v instanceof PySet) return v.items.size ? `{${[...v.items].map((x) => repr(x, vm)).join(', ')}}` : 'set()';
  if (v instanceof PyObject) {
    const m = v.cls.lookup('__str__') ?? v.cls.lookup('__repr__');
    if (m && vm) return str(vm.call(new PyBound(v, m), []), vm);
    return `<${v.cls.name} object>`;
  }
  if (v instanceof PyClass) return `<class '${v.name}'>`;
  if (v instanceof PyFunc || v instanceof PyBuiltin) return `<function ${v.name}>`;
  if (v instanceof PyModule) return `<module '${v.name}'>`;
  return String(v);
}

/**
 * Python's int / float distinction is not tracked (JS numbers): whole floats
 * print like ints ("2" for 2.0). Kept as a no-op hook where floats are made.
 */
const floatTag = { add(_v: number): void {}, has(_v: number): boolean { return false; } };

// --------------------------------------------------------------------- VM

export interface VMOptions {
  /** Instruction budget per run (statements + expressions). */
  budget?: number;
  print?: (s: string) => void;
  modules?: Record<string, PyModule>;
  random?: () => number;
}

export class VM {
  readonly globals: Scope;
  private steps = 0;
  private budget: number;
  private print: (s: string) => void;
  private modules: Record<string, PyModule>;
  readonly random: () => number;
  readonly builtins = new Map<string, unknown>();
  private line = 0;

  constructor(opts: VMOptions = {}) {
    this.globals = new Scope(null, null);
    this.budget = opts.budget ?? 2_000_000;
    this.print = opts.print ?? (() => {});
    this.random = opts.random ?? Math.random;
    this.modules = { math: mathModule(), random: randomModule(this), ...(opts.modules ?? {}) };
    installBuiltins(this);
  }

  /** Reset the instruction budget (one per handler call batch). */
  refuel(budget = this.budget): void { this.steps = 0; this.budget = budget; }

  private tick(n: Node): void {
    this.line = n.line;
    if (++this.steps > this.budget) throw new PyError('RuntimeError', 'script took too long (instruction limit reached)', n.line);
  }

  run(src: string): void {
    const ast = parse(src);
    this.execBlock(ast, this.globals);
  }

  getGlobal(name: string): unknown { return this.globals.vars.get(name); }
  setGlobal(name: string, v: unknown): void { this.globals.vars.set(name, v); }

  // ---------------------------------------------------------- statements
  private execBlock(body: Node[], sc: Scope): void {
    for (const s of body) this.exec(s, sc);
  }

  private exec(s: Node, sc: Scope): void {
    this.tick(s);
    switch (s.k) {
      case 'Expr': this.eval(s.value, sc); return;
      case 'Assign': { const v = this.eval(s.value, sc); for (const t of s.targets) this.assign(t, v, sc); return; }
      case 'AugAssign': {
        const cur = this.eval(s.target, sc);
        const v = this.binop(s.op, cur, this.eval(s.value, sc), s.line, true);
        this.assign(s.target, v, sc);
        return;
      }
      case 'If': { if (truthy(this.eval(s.test, sc))) this.execBlock(s.body, sc); else this.execBlock(s.orelse, sc); return; }
      case 'While': {
        let broke = false;
        while (truthy(this.eval(s.test, sc))) {
          try { this.execBlock(s.body, sc); } catch (e) { if (e instanceof BreakSig) { broke = true; break; } if (e instanceof ContinueSig) continue; throw e; }
        }
        if (!broke) this.execBlock(s.orelse, sc);
        return;
      }
      case 'For': {
        const it = this.iterate(this.eval(s.iter, sc), s.line);
        let broke = false;
        for (const x of it) {
          this.assign(s.target, x, sc);
          try { this.execBlock(s.body, sc); } catch (e) { if (e instanceof BreakSig) { broke = true; break; } if (e instanceof ContinueSig) continue; throw e; }
        }
        if (!broke) this.execBlock(s.orelse, sc);
        return;
      }
      case 'Def': {
        const f = new PyFunc(s.name, s.args, s.args.defaults.map((d: Node | null) => (d ? this.eval(d, sc) : undefined)), s.body, sc);
        this.store(s.name, f, sc);
        return;
      }
      case 'Class': {
        const bases = s.bases.map((b: Node) => this.eval(b, sc));
        for (const b of bases) if (!(b instanceof PyClass)) throw new PyError('TypeError', 'bases must be classes', s.line);
        const cs = new Scope(sc, sc.module ?? sc);
        this.execBlock(s.body, cs);
        const cls = new PyClass(s.name, bases as PyClass[], cs.vars);
        this.store(s.name, cls, sc);
        return;
      }
      case 'Return': throw new ReturnSig(s.value ? this.eval(s.value, sc) : null);
      case 'Pass': return;
      case 'Break': throw new BreakSig();
      case 'Continue': throw new ContinueSig();
      case 'Global': for (const n of s.names) sc.globals.add(n); return;
      case 'Nonlocal': for (const n of s.names) sc.nonlocals.add(n); return;
      case 'Import': {
        for (const it of s.items) {
          const m = this.modules[it.mod];
          if (!m) throw new PyError('ModuleNotFoundError', `No module named '${it.mod}'`, s.line);
          this.store(it.as, m, sc);
        }
        return;
      }
      case 'ImportFrom': {
        const m = this.modules[s.mod];
        if (!m) throw new PyError('ModuleNotFoundError', `No module named '${s.mod}'`, s.line);
        for (const it of s.names) {
          if (it.name === '*') { for (const [k, v] of m.attrs) this.store(k, v, sc); continue; }
          if (!m.attrs.has(it.name)) throw new PyError('ImportError', `cannot import name '${it.name}' from '${s.mod}'`, s.line);
          this.store(it.as, m.attrs.get(it.name), sc);
        }
        return;
      }
      case 'Try': {
        try {
          try { this.execBlock(s.body, sc); }
          catch (e) {
            if (!(e instanceof PyError)) throw e;
            const h = s.handlers.find((hd: Node) => !hd.type || this.excMatches(e, this.eval(hd.type, sc)));
            if (!h) throw e;
            if (h.as) this.store(h.as, makeExc(e), sc);
            this.execBlock(h.body, sc);
            return;
          }
          this.execBlock(s.orelse, sc);
        } finally {
          if (s.fin.length) this.execBlock(s.fin, sc);
        }
        return;
      }
      case 'Raise': {
        if (!s.exc) throw new PyError('RuntimeError', 'No active exception to reraise', s.line);
        const v = this.eval(s.exc, sc);
        if (v instanceof PyObject && v.cls.attrs.get('__exc__')) throw new PyError(v.cls.name, str(v.attrs.get('args') ?? ''), s.line);
        if (v instanceof PyClass) throw new PyError(v.name, '', s.line);
        throw new PyError('Exception', str(v, this), s.line);
      }
      case 'Assert': if (!truthy(this.eval(s.test, sc))) throw new PyError('AssertionError', s.msg ? str(this.eval(s.msg, sc), this) : '', s.line); return;
      case 'Del': {
        const targets = s.targets.k === 'Tuple' ? s.targets.items : [s.targets];
        for (const t of targets) {
          if (t.k === 'Name') { this.lookupScope(t.id, sc).vars.delete(t.id); continue; }
          if (t.k === 'Subscript') {
            const o = this.eval(t.value, sc), i = this.eval(t.index, sc);
            if (Array.isArray(o)) o.splice(this.index(o.length, i, t.line), 1);
            else if (o instanceof Map) o.delete(hashKey(i));
            continue;
          }
          if (t.k === 'Attribute') { const o = this.eval(t.value, sc); if (o instanceof PyObject) o.attrs.delete(t.attr); }
        }
        return;
      }
      default: throw new PyError('SyntaxError', `unsupported statement ${s.k}`, s.line);
    }
  }

  private excMatches(e: PyError, t: unknown): boolean {
    const names = t instanceof PyTuple ? t.items : [t];
    return names.some((n) => n instanceof PyClass && (n.name === 'Exception' || n.name === 'BaseException' || n.name === e.type));
  }

  private lookupScope(name: string, sc: Scope): Scope {
    let s: Scope | null = sc;
    while (s) { if (s.vars.has(name)) return s; s = s.parent; }
    return sc;
  }

  private store(name: string, v: unknown, sc: Scope): void {
    if (sc.globals.has(name)) { (sc.module ?? sc).vars.set(name, v); return; }
    if (sc.nonlocals.has(name)) {
      let s = sc.parent;
      while (s && !s.vars.has(name)) s = s.parent;
      (s ?? sc).vars.set(name, v);
      return;
    }
    sc.vars.set(name, v);
  }

  private assign(t: Node, v: unknown, sc: Scope): void {
    switch (t.k) {
      case 'Name': this.store(t.id, v, sc); return;
      case 'Attribute': this.setAttr(this.eval(t.value, sc), t.attr, v, t.line); return;
      case 'Subscript': {
        const o = this.eval(t.value, sc);
        const i = this.eval(t.index, sc);
        if (Array.isArray(o)) {
          if (i instanceof PySliceV) { const [a, b] = sliceBounds(o.length, i); o.splice(a, Math.max(0, b - a), ...this.iterate(v, t.line)); return; }
          o[this.index(o.length, i, t.line)] = v;
          return;
        }
        if (o instanceof Map) { o.set(hashKey(i), v); keyOrig.set(hashKey(i), i); return; }
        if (o instanceof PyObject) { const m = o.cls.lookup('__setitem__'); if (m) { this.call(new PyBound(o, m), [i, v]); return; } }
        throw new PyError('TypeError', `'${typeName(o)}' object does not support item assignment`, t.line);
      }
      case 'Tuple': case 'List': {
        const items = this.iterate(v, t.line);
        const star = t.items.findIndex((x: Node) => x.k === 'Starred');
        if (star < 0) {
          if (items.length !== t.items.length) throw new PyError('ValueError', `${items.length < t.items.length ? 'not enough' : 'too many'} values to unpack (expected ${t.items.length})`, t.line);
          t.items.forEach((x: Node, k: number) => this.assign(x, items[k], sc));
        } else {
          const after = t.items.length - star - 1;
          t.items.slice(0, star).forEach((x: Node, k: number) => this.assign(x, items[k], sc));
          this.assign(t.items[star].value, items.slice(star, items.length - after), sc);
          t.items.slice(star + 1).forEach((x: Node, k: number) => this.assign(x, items[items.length - after + k], sc));
        }
        return;
      }
      default: throw new PyError('SyntaxError', 'cannot assign', t.line);
    }
  }

  // --------------------------------------------------------- expressions
  eval(e: Node, sc: Scope): unknown {
    this.tick(e);
    switch (e.k) {
      case 'Const': if (e.isFloat && typeof e.value === 'number') floatTag.add(e.value); return e.value;
      case 'Name': return this.lookup(e.id, sc, e.line);
      case 'Attribute': return this.getAttr(this.eval(e.value, sc), e.attr, e.line);
      case 'Subscript': return this.subscript(this.eval(e.value, sc), this.eval(e.index, sc), e.line);
      case 'Slice': return new PySliceV(e.lower ? this.eval(e.lower, sc) : null, e.upper ? this.eval(e.upper, sc) : null, e.step ? this.eval(e.step, sc) : null);
      case 'Call': {
        const f = this.eval(e.func, sc);
        const args: unknown[] = e.args.map((a: Node) => this.eval(a, sc));
        if (e.starArgs) args.push(...this.iterate(this.eval(e.starArgs, sc), e.line));
        const kwargs: Record<string, unknown> = {};
        for (const kw of e.kwargs) kwargs[kw.name] = this.eval(kw.value, sc);
        if (e.kwStar) { const m = this.eval(e.kwStar, sc); if (m instanceof Map) for (const [k, v] of m) kwargs[String(keyOrig.get(k) ?? k)] = v; }
        return this.call(f, args, kwargs, e.line);
      }
      case 'Bin': return this.binop(e.op, this.eval(e.left, sc), this.eval(e.right, sc), e.line);
      case 'Unary': {
        const v = this.eval(e.value, sc);
        if (e.op === '-') { if (typeof v === 'number' || typeof v === 'boolean') { const r = -Number(v); if (typeof v === 'number' && floatTag.has(v)) floatTag.add(r); return r; } }
        else if (e.op === '+') { if (typeof v === 'number' || typeof v === 'boolean') return Number(v); }
        else if (e.op === '~') { if (typeof v === 'number' || typeof v === 'boolean') return ~Number(v); }
        throw new PyError('TypeError', `bad operand type for unary ${e.op}: '${typeName(v)}'`, e.line);
      }
      case 'Not': return !truthy(this.eval(e.value, sc));
      case 'And': { const l = this.eval(e.left, sc); return truthy(l) ? this.eval(e.right, sc) : l; }
      case 'Or': { const l = this.eval(e.left, sc); return truthy(l) ? l : this.eval(e.right, sc); }
      case 'Compare': {
        let l = this.eval(e.left, sc);
        for (let k = 0; k < e.ops.length; k++) {
          const r = this.eval(e.rights[k], sc);
          if (!this.compare(e.ops[k], l, r, e.line)) return false;
          l = r;
        }
        return true;
      }
      case 'IfExp': return truthy(this.eval(e.test, sc)) ? this.eval(e.body, sc) : this.eval(e.orelse, sc);
      case 'List': return this.displayItems(e.items, sc);
      case 'Tuple': return new PyTuple(this.displayItems(e.items, sc));
      case 'SetLit': return new PySet(new Set(this.displayItems(e.items, sc).map(hashKey)));
      case 'Dict': {
        const m = new Map<unknown, unknown>();
        e.keys.forEach((k: Node, i: number) => { const kv = this.eval(k, sc); m.set(hashKey(kv), this.eval(e.values[i], sc)); keyOrig.set(hashKey(kv), kv); });
        return m;
      }
      case 'Lambda': return new PyFunc('<lambda>', e.args, e.args.defaults.map((d: Node | null) => (d ? this.eval(d, sc) : undefined)), e.body, sc, true);
      case 'Comp': return this.comprehension(e, sc);
      case 'FStr': {
        let s = '';
        for (const p of e.parts) {
          if (typeof p === 'string') { s += p; continue; }
          const v = this.eval(p.expr, sc);
          s += p.spec ? formatSpec(v, p.spec, this) : p.conv === 'r' ? repr(v, this) : str(v, this);
        }
        return s;
      }
      case 'Starred': throw new PyError('SyntaxError', "can't use starred expression here", e.line);
      default: throw new PyError('SyntaxError', `unsupported expression ${e.k}`, e.line);
    }
  }

  private displayItems(items: Node[], sc: Scope): unknown[] {
    const out: unknown[] = [];
    for (const it of items) {
      if (it.k === 'Starred') out.push(...this.iterate(this.eval(it.value, sc), it.line));
      else out.push(this.eval(it, sc));
    }
    return out;
  }

  private comprehension(e: Node, sc: Scope): unknown {
    const inner = new Scope(sc, sc.module ?? sc);
    const out: unknown[] = [];
    const m = new Map<unknown, unknown>();
    const run = (g: number): void => {
      if (g === e.gens.length) {
        if (e.kind === 'Dict') { const k = this.eval(e.elt, inner); m.set(hashKey(k), this.eval(e.value, inner)); keyOrig.set(hashKey(k), k); }
        else out.push(this.eval(e.elt, inner));
        return;
      }
      const gen = e.gens[g];
      for (const x of this.iterate(this.eval(gen.iter, g === 0 ? sc : inner), e.line)) {
        this.assign(gen.target, x, inner);
        if (gen.ifs.every((c: Node) => truthy(this.eval(c, inner)))) run(g + 1);
      }
    };
    run(0);
    if (e.kind === 'Dict') return m;
    if (e.kind === 'Set') return new PySet(new Set(out.map(hashKey)));
    return out; // lists and generators both materialize
  }

  private lookup(name: string, sc: Scope, line: number): unknown {
    if (sc.globals.has(name)) { const m = sc.module ?? sc; if (m.vars.has(name)) return m.vars.get(name); }
    let s: Scope | null = sc;
    while (s) {
      if (s.vars.has(name)) return s.vars.get(name);
      s = s.parent;
      // class bodies are not visible from methods: skip them when climbing from a function scope
    }
    if (this.globals.vars.has(name)) return this.globals.vars.get(name);
    if (this.builtins.has(name)) return this.builtins.get(name);
    throw new PyError('NameError', `name '${name}' is not defined`, line);
  }

  getAttr(o: unknown, name: string, line: number): unknown {
    if (o instanceof PyObject) {
      if (o.attrs.has(name)) return o.attrs.get(name);
      const v = o.cls.lookup(name);
      if (v !== undefined) return v instanceof PyFunc || v instanceof PyBuiltin ? new PyBound(o, v) : v;
      const nat = o.cls.nativeOf();
      if (nat && name in nat.methods) return new PyBuiltin(name, (args, kw, vm) => nat.methods[name](o, args, kw, vm));
      throw new PyError('AttributeError', `'${o.cls.name}' object has no attribute '${name}'`, line);
    }
    if (o instanceof PyClass) {
      const v = o.lookup(name);
      if (v !== undefined) return v;
      if (name === '__name__') return o.name;
      throw new PyError('AttributeError', `type object '${o.name}' has no attribute '${name}'`, line);
    }
    if (o instanceof PyModule) {
      if (o.attrs.has(name)) return o.attrs.get(name);
      throw new PyError('AttributeError', `module '${o.name}' has no attribute '${name}'`, line);
    }
    const m = builtinMethod(o, name, this);
    if (m) return m;
    throw new PyError('AttributeError', `'${typeName(o)}' object has no attribute '${name}'`, line);
  }

  setAttr(o: unknown, name: string, v: unknown, line: number): void {
    if (o instanceof PyObject) { o.attrs.set(name, v); return; }
    if (o instanceof PyClass) { o.attrs.set(name, v); return; }
    if (o instanceof PyModule) { o.attrs.set(name, v); return; }
    throw new PyError('AttributeError', `'${typeName(o)}' object attribute '${name}' is read-only`, line);
  }

  index(len: number, i: unknown, line: number): number {
    if (typeof i === 'boolean') i = Number(i);
    if (typeof i !== 'number' || !Number.isInteger(i)) throw new PyError('TypeError', 'indices must be integers', line);
    const k = i < 0 ? len + i : i;
    if (k < 0 || k >= len) throw new PyError('IndexError', 'index out of range', line);
    return k;
  }

  private subscript(o: unknown, i: unknown, line: number): unknown {
    if (Array.isArray(o) || o instanceof PyTuple || typeof o === 'string') {
      const arr = Array.isArray(o) ? o : o instanceof PyTuple ? o.items : o;
      if (i instanceof PySliceV) {
        const items = typeof arr === 'string' ? [...arr] : arr;
        const res = sliceItems(items, i);
        return typeof arr === 'string' ? res.join('') : Array.isArray(o) ? res : new PyTuple(res);
      }
      return arr[this.index(arr.length, i, line)];
    }
    if (o instanceof Map) {
      const k = hashKey(i);
      if (!o.has(k)) throw new PyError('KeyError', repr(i, this), line);
      return o.get(k);
    }
    if (o instanceof PyObject) { const m = o.cls.lookup('__getitem__'); if (m) return this.call(new PyBound(o, m), [i]); }
    throw new PyError('TypeError', `'${typeName(o)}' object is not subscriptable`, line);
  }

  iterate(v: unknown, line: number): unknown[] {
    if (Array.isArray(v)) return [...v];
    if (v instanceof PyTuple) return [...v.items];
    if (typeof v === 'string') return [...v];
    if (v instanceof Map) return [...v.keys()].map((k) => keyOrig.get(k) ?? k);
    if (v instanceof PySet) return [...v.items].map((k) => keyOrig.get(k) ?? k);
    if (v instanceof PyRange) return v.values();
    throw new PyError('TypeError', `'${typeName(v)}' object is not iterable`, line);
  }

  binop(op: string, a: unknown, b: unknown, line: number, inplace = false): unknown {
    const num = (x: unknown) => typeof x === 'number' || typeof x === 'boolean';
    if (num(a) && num(b)) {
      const x = Number(a), y = Number(b);
      const fl = (typeof a === 'number' && floatTag.has(a) && !Number.isInteger(a)) || floatTag.has(x) || floatTag.has(y);
      let r: number;
      switch (op) {
        case '+': r = x + y; break;
        case '-': r = x - y; break;
        case '*': r = x * y; break;
        case '/': if (y === 0) throw new PyError('ZeroDivisionError', 'division by zero', line); r = x / y; floatTag.add(r); return r;
        case '//': if (y === 0) throw new PyError('ZeroDivisionError', 'integer division or modulo by zero', line); r = Math.floor(x / y); break;
        case '%': if (y === 0) throw new PyError('ZeroDivisionError', 'integer division or modulo by zero', line); r = ((x % y) + y) % y; break;
        case '**': r = Math.pow(x, y); break;
        case '&': return x & y;
        case '|': return x | y;
        case '^': return x ^ y;
        case '<<': return x << y;
        case '>>': return x >> y;
        default: throw new PyError('TypeError', `unsupported operand ${op}`, line);
      }
      if (fl) floatTag.add(r);
      return r;
    }
    if (op === '+') {
      if (typeof a === 'string' && typeof b === 'string') return a + b;
      if (Array.isArray(a) && Array.isArray(b)) { if (inplace) { a.push(...b); return a; } return [...a, ...b]; }
      if (a instanceof PyTuple && b instanceof PyTuple) return new PyTuple([...a.items, ...b.items]);
    }
    if (op === '*') {
      const rep = (s: unknown, n: unknown) => (typeof n === 'number' || typeof n === 'boolean' ? Math.max(0, Math.floor(Number(n))) : -1);
      if (typeof a === 'string' && rep(a, b) >= 0) return a.repeat(rep(a, b));
      if (typeof b === 'string' && rep(b, a) >= 0) return b.repeat(rep(b, a));
      if (Array.isArray(a) && rep(a, b) >= 0) return Array.from({ length: rep(a, b) }, () => a).flat();
      if (Array.isArray(b) && rep(b, a) >= 0) return Array.from({ length: rep(b, a) }, () => b).flat();
    }
    if (op === '%' && typeof a === 'string') return percentFormat(a, b, this);
    if (a instanceof PyObject) {
      const names: Record<string, string> = { '+': '__add__', '-': '__sub__', '*': '__mul__', '/': '__truediv__' };
      const m = names[op] ? a.cls.lookup(names[op]) : undefined;
      if (m) return this.call(new PyBound(a, m), [b]);
    }
    throw new PyError('TypeError', `unsupported operand type(s) for ${op}: '${typeName(a)}' and '${typeName(b)}'`, line);
  }

  compare(op: string, a: unknown, b: unknown, line: number): boolean {
    switch (op) {
      case '==': return pyEq(a, b);
      case '!=': return !pyEq(a, b);
      case 'is': return a === b || (a == null && b == null);
      case 'is not': return !(a === b || (a == null && b == null));
      case 'in': return this.contains(b, a, line);
      case 'not in': return !this.contains(b, a, line);
    }
    const c = pyCmp(a, b, line);
    switch (op) {
      case '<': return c < 0;
      case '<=': return c <= 0;
      case '>': return c > 0;
      case '>=': return c >= 0;
    }
    return false;
  }

  private contains(container: unknown, x: unknown, line: number): boolean {
    if (typeof container === 'string') return typeof x === 'string' && container.includes(x);
    if (Array.isArray(container)) return container.some((y) => pyEq(y, x));
    if (container instanceof PyTuple) return container.items.some((y) => pyEq(y, x));
    if (container instanceof Map) return container.has(hashKey(x));
    if (container instanceof PySet) return container.items.has(hashKey(x));
    if (container instanceof PyRange) return container.values().includes(x as number);
    throw new PyError('TypeError', `argument of type '${typeName(container)}' is not iterable`, line);
  }

  /** Call any callable with positional and keyword arguments. */
  call(f: unknown, args: unknown[], kwargs: Record<string, unknown> = {}, line = this.line): unknown {
    if (f instanceof PyBuiltin) return f.fn(args, kwargs, this);
    if (f instanceof PyBound) {
      if (f.fn instanceof PyBuiltin) return f.fn.fn([f.self, ...args], kwargs, this);
      return this.call(f.fn, [f.self, ...args], kwargs, line);
    }
    if (f instanceof PyFunc) return this.callFunc(f, args, kwargs, line);
    if (f instanceof PyClass) {
      if (f.attrs.get('__exc__') || f.bases.some((b) => b.lookup('__exc__'))) {
        const o = new PyObject(f);
        o.attrs.set('args', args.length === 1 ? args[0] : new PyTuple(args));
        return o;
      }
      const o = new PyObject(f);
      const nat = f.nativeOf();
      if (nat) nat.init(o, args, kwargs, this);
      const init = f.lookup('__init__');
      if (init instanceof PyFunc) this.callFunc(init, [o, ...args], kwargs, line);
      return o;
    }
    throw new PyError('TypeError', `'${typeName(f)}' object is not callable`, line);
  }

  private callFunc(f: PyFunc, args: unknown[], kwargs: Record<string, unknown>, line: number): unknown {
    const sc = new Scope(f.closure, f.closure.module ?? f.closure);
    const { names, star, kw } = f.args;
    const extra: unknown[] = [];
    names.forEach((n, i) => {
      if (i < args.length) sc.vars.set(n, args[i]);
      else if (n in kwargs) sc.vars.set(n, kwargs[n]);
      else if (f.defaults[i] !== undefined) sc.vars.set(n, f.defaults[i]);
      else throw new PyError('TypeError', `${f.name}() missing required argument: '${n}'`, line);
    });
    if (args.length > names.length) {
      if (!star) throw new PyError('TypeError', `${f.name}() takes ${names.length} positional arguments but ${args.length} were given`, line);
      extra.push(...args.slice(names.length));
    }
    if (star) sc.vars.set(star, new PyTuple(extra));
    const unknown = Object.keys(kwargs).filter((k) => !names.includes(k));
    if (kw) { const m = new Map<unknown, unknown>(); for (const k of unknown) { m.set(k, kwargs[k]); keyOrig.set(k, k); } sc.vars.set(kw, m); }
    else if (unknown.length) throw new PyError('TypeError', `${f.name}() got an unexpected keyword argument '${unknown[0]}'`, line);
    if (f.isLambda) return this.eval(f.body as Node, sc);
    try { this.execBlock(f.body as Node[], sc); }
    catch (e) { if (e instanceof ReturnSig) return e.value; throw e; }
    return null;
  }
}

class PySliceV { constructor(public start: unknown, public stop: unknown, public step: unknown) {} }

export class PyRange {
  constructor(public start: number, public stop: number, public step: number) {}
  values(): number[] {
    const out: number[] = [];
    if (this.step > 0) for (let i = this.start; i < this.stop; i += this.step) out.push(i);
    else if (this.step < 0) for (let i = this.start; i > this.stop; i += this.step) out.push(i);
    if (out.length > 5_000_000) throw new PyError('MemoryError', 'range too large');
    return out;
  }
}

function sliceBounds(len: number, s: PySliceV): [number, number, number] {
  const step = s.step == null ? 1 : Number(s.step);
  const norm = (v: unknown, d: number) => { if (v == null) return d; let x = Number(v); if (x < 0) x += len; return Math.max(step < 0 ? -1 : 0, Math.min(step < 0 ? len - 1 : len, x)); };
  const a = norm(s.start, step < 0 ? len - 1 : 0), b = norm(s.stop, step < 0 ? -1 : len);
  return [a, b, step];
}

function sliceItems<T>(items: T[], s: PySliceV): T[] {
  const [a, b, step] = sliceBounds(items.length, s);
  const out: T[] = [];
  if (step > 0) for (let i = a; i < b; i += step) out.push(items[i]);
  else for (let i = a; i > b; i += step) out.push(items[i]);
  return out;
}

/** Hashable key for dict / set storage (tuples and numbers compare by value). */
const keyOrig = new Map<unknown, unknown>();
function hashKey(v: unknown): unknown {
  if (v instanceof PyTuple) { const k = 'tuple:' + v.items.map((x) => String(hashKey(x))).join('\u0001'); keyOrig.set(k, v); return k; }
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
}

export function pyEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if ((typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean')) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => pyEq(x, b[i]));
  if (a instanceof PyTuple && b instanceof PyTuple) return a.items.length === b.items.length && a.items.every((x, i) => pyEq(x, b.items[i]));
  if (a == null && b == null) return true;
  return false;
}

function pyCmp(a: unknown, b: unknown, line: number): number {
  if ((typeof a === 'number' || typeof a === 'boolean') && (typeof b === 'number' || typeof b === 'boolean')) return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  const seq = (x: unknown) => (Array.isArray(x) ? x : x instanceof PyTuple ? x.items : null);
  const sa = seq(a), sb = seq(b);
  if (sa && sb) {
    for (let i = 0; i < Math.min(sa.length, sb.length); i++) { if (!pyEq(sa[i], sb[i])) return pyCmp(sa[i], sb[i], line); }
    return sa.length - sb.length;
  }
  throw new PyError('TypeError', `'<' not supported between instances of '${typeName(a)}' and '${typeName(b)}'`, line);
}

function makeExc(e: PyError): PyObject {
  const cls = new PyClass(e.type, [], new Map<string, unknown>([['__exc__', true]]));
  const o = new PyObject(cls);
  o.attrs.set('args', new PyTuple([e.message]));
  cls.attrs.set('__str__', new PyBuiltin('__str__', () => e.message));
  return o;
}

function formatSpec(v: unknown, spec: string, vm: VM): string {
  const m = /^(.?[<>^=])?([+\- ]?)(#?)(0?)(\d*)(,?)(?:\.(\d+))?([bcdeEfFgGnosxX%]?)$/.exec(spec);
  if (!m) return str(v, vm);
  const [, align = '', sign, , zero, width, comma, prec, type] = m;
  let s: string;
  const n = typeof v === 'number' || typeof v === 'boolean' ? Number(v) : NaN;
  switch (type) {
    case 'f': case 'F': s = n.toFixed(prec ? Number(prec) : 6); break;
    case 'e': case 'E': s = n.toExponential(prec ? Number(prec) : 6); break;
    case 'g': case 'G': s = String(Number(n.toPrecision(prec ? Number(prec) || 1 : 6))); break;
    case 'd': s = String(Math.trunc(n)); break;
    case 'x': s = Math.trunc(n).toString(16); break;
    case 'X': s = Math.trunc(n).toString(16).toUpperCase(); break;
    case 'b': s = Math.trunc(n).toString(2); break;
    case 'o': s = Math.trunc(n).toString(8); break;
    case '%': s = (n * 100).toFixed(prec ? Number(prec) : 6) + '%'; break;
    case 's': s = str(v, vm); break;
    default: s = prec && !Number.isNaN(n) ? n.toFixed(Number(prec)) : str(v, vm);
  }
  if (comma && !Number.isNaN(n)) s = s.replace(/^(-?\d+)/, (d) => d.replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  if (sign === '+' && !Number.isNaN(n) && n >= 0) s = '+' + s;
  else if (sign === ' ' && !Number.isNaN(n) && n >= 0) s = ' ' + s;
  const w = Number(width || 0);
  if (s.length < w) {
    const fill = align.length === 2 ? align[0] : zero ? '0' : ' ';
    const a = align ? align[align.length - 1] : typeof v === 'string' ? '<' : '>';
    const pad = w - s.length;
    if (a === '<') s = s + fill.repeat(pad);
    else if (a === '^') s = fill.repeat(Math.floor(pad / 2)) + s + fill.repeat(Math.ceil(pad / 2));
    else if (zero && !align && /^[+-]/.test(s)) s = s[0] + '0'.repeat(pad) + s.slice(1);
    else s = fill.repeat(pad) + s;
  }
  return s;
}

function percentFormat(fmt: string, args: unknown, vm: VM): string {
  const list = args instanceof PyTuple ? args.items : [args];
  let k = 0;
  return fmt.replace(/%([-+ 0#]*)(\d*)(?:\.(\d+))?([sdifgeExXr%])/g, (_m, flags: string, width: string, prec: string, t: string) => {
    if (t === '%') return '%';
    const v = list[k++];
    let s: string;
    if (t === 's') s = str(v, vm);
    else if (t === 'r') s = repr(v, vm);
    else if (t === 'd' || t === 'i') s = String(Math.trunc(Number(v)));
    else if (t === 'f') s = Number(v).toFixed(prec ? Number(prec) : 6);
    else if (t === 'e' || t === 'E') s = Number(v).toExponential(prec ? Number(prec) : 6);
    else if (t === 'x' || t === 'X') { s = Math.trunc(Number(v)).toString(16); if (t === 'X') s = s.toUpperCase(); }
    else s = String(Number(Number(v).toPrecision(prec ? Number(prec) : 6)));
    if (flags.includes('+') && Number(v) >= 0 && t !== 's') s = '+' + s;
    const w = Number(width || 0);
    if (s.length < w) s = flags.includes('-') ? s + ' '.repeat(w - s.length) : (flags.includes('0') ? '0' : ' ').repeat(w - s.length) + s;
    return s;
  });
}

// ---------------------------------------------------------------- builtins

const fn = (name: string, f: NativeFn) => new PyBuiltin(name, f);
const num = (v: unknown, what = 'argument'): number => {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new PyError('TypeError', `${what} must be a number, not '${typeName(v)}'`);
};

function installBuiltins(vm: VM): void {
  const b = vm.builtins;
  const excClass = (name: string) => new PyClass(name, [], new Map<string, unknown>([['__exc__', true]]));
  for (const n of ['Exception', 'BaseException', 'ValueError', 'TypeError', 'KeyError', 'IndexError', 'ZeroDivisionError', 'NameError', 'AttributeError', 'RuntimeError', 'StopIteration', 'AssertionError', 'NotImplementedError']) b.set(n, excClass(n));
  b.set('object', new PyClass('object', [], new Map()));
  b.set('print', fn('print', (args, kw) => {
    const sep = kw.sep !== undefined ? str(kw.sep, vm) : ' ';
    const end = kw.end !== undefined ? str(kw.end, vm) : '\n';
    (vm as unknown as { print: (s: string) => void }).print(args.map((a) => str(a, vm)).join(sep) + end);
    return null;
  }));
  b.set('len', fn('len', ([x]) => {
    if (typeof x === 'string' || Array.isArray(x)) return x.length;
    if (x instanceof PyTuple) return x.items.length;
    if (x instanceof Map) return x.size;
    if (x instanceof PySet) return x.items.size;
    if (x instanceof PyRange) return x.values().length;
    throw new PyError('TypeError', `object of type '${typeName(x)}' has no len()`);
  }));
  b.set('range', fn('range', (args) => {
    const [a, c, d] = args.map((x) => num(x));
    return args.length === 1 ? new PyRange(0, a, 1) : new PyRange(a, c, d ?? 1);
  }));
  b.set('int', fn('int', ([x, base]) => {
    if (x === undefined) return 0;
    if (typeof x === 'string') { const v = parseInt(x.trim(), base === undefined ? 10 : num(base)); if (Number.isNaN(v)) throw new PyError('ValueError', `invalid literal for int(): '${x}'`); return v; }
    return Math.trunc(num(x));
  }));
  b.set('float', fn('float', ([x]) => {
    let v: number;
    if (x === undefined) v = 0;
    else if (typeof x === 'string') { v = Number(x.trim()); if (Number.isNaN(v) && !/^nan$/i.test(x.trim())) throw new PyError('ValueError', `could not convert string to float: '${x}'`); }
    else v = num(x);
    floatTag.add(v);
    return v;
  }));
  b.set('str', fn('str', ([x]) => (x === undefined ? '' : str(x, vm))));
  b.set('repr', fn('repr', ([x]) => repr(x, vm)));
  b.set('bool', fn('bool', ([x]) => truthy(x)));
  b.set('abs', fn('abs', ([x]) => Math.abs(num(x))));
  b.set('round', fn('round', ([x, nd]) => {
    const v = num(x);
    if (nd === undefined || nd === null) { const r = Math.round(v); return Math.abs(v % 1) === 0.5 ? (r % 2 === 0 ? r : r - 1) : r; }
    const p = Math.pow(10, num(nd));
    const r = Math.round(v * p) / p;
    floatTag.add(r);
    return r;
  }));
  const minmax = (isMax: boolean) => fn(isMax ? 'max' : 'min', (args, kw) => {
    const items = args.length === 1 ? vm.iterate(args[0], 0) : args;
    if (!items.length) { if ('default' in kw) return kw.default; throw new PyError('ValueError', `${isMax ? 'max' : 'min'}() arg is an empty sequence`); }
    const key = kw.key;
    let best = items[0], bk = key ? vm.call(key, [best]) : best;
    for (const it of items.slice(1)) {
      const k = key ? vm.call(key, [it]) : it;
      if (isMax ? vm.compare('>', k, bk, 0) : vm.compare('<', k, bk, 0)) { best = it; bk = k; }
    }
    return best;
  });
  b.set('max', minmax(true));
  b.set('min', minmax(false));
  b.set('sum', fn('sum', ([it, start]) => vm.iterate(it, 0).reduce((a: number, x) => a + num(x), start === undefined ? 0 : num(start))));
  b.set('list', fn('list', ([x]) => (x === undefined ? [] : vm.iterate(x, 0))));
  b.set('tuple', fn('tuple', ([x]) => new PyTuple(x === undefined ? [] : vm.iterate(x, 0))));
  b.set('set', fn('set', ([x]) => new PySet(new Set(x === undefined ? [] : vm.iterate(x, 0).map(hashKey)))));
  b.set('dict', fn('dict', ([x], kw) => {
    const m = new Map<unknown, unknown>();
    if (x instanceof Map) for (const [k, v] of x) m.set(k, v);
    else if (x !== undefined) for (const pair of vm.iterate(x, 0)) { const [k, v] = vm.iterate(pair, 0); m.set(hashKey(k), v); keyOrig.set(hashKey(k), k); }
    for (const [k, v] of Object.entries(kw)) { m.set(k, v); keyOrig.set(k, k); }
    return m;
  }));
  b.set('enumerate', fn('enumerate', ([x, start]) => vm.iterate(x, 0).map((v, i) => new PyTuple([i + (start === undefined ? 0 : num(start)), v]))));
  b.set('zip', fn('zip', (args) => {
    const lists = args.map((a) => vm.iterate(a, 0));
    const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
    return Array.from({ length: n }, (_, i) => new PyTuple(lists.map((l) => l[i])));
  }));
  b.set('sorted', fn('sorted', ([x], kw) => sortList(vm.iterate(x, 0), kw, vm)));
  b.set('reversed', fn('reversed', ([x]) => vm.iterate(x, 0).reverse()));
  b.set('any', fn('any', ([x]) => vm.iterate(x, 0).some(truthy)));
  b.set('all', fn('all', ([x]) => vm.iterate(x, 0).every(truthy)));
  b.set('map', fn('map', ([f, ...its]) => {
    const lists = its.map((a) => vm.iterate(a, 0));
    const n = lists.length ? Math.min(...lists.map((l) => l.length)) : 0;
    return Array.from({ length: n }, (_, i) => vm.call(f, lists.map((l) => l[i])));
  }));
  b.set('filter', fn('filter', ([f, it]) => vm.iterate(it, 0).filter((x) => truthy(f === null ? x : vm.call(f, [x])))));
  b.set('pow', fn('pow', ([x, y, m]) => { const r = Math.pow(num(x), num(y)); return m === undefined ? r : ((r % num(m)) + num(m)) % num(m); }));
  b.set('divmod', fn('divmod', ([x, y]) => new PyTuple([Math.floor(num(x) / num(y)), ((num(x) % num(y)) + num(y)) % num(y)])));
  b.set('chr', fn('chr', ([x]) => String.fromCharCode(num(x))));
  b.set('ord', fn('ord', ([x]) => String(x).charCodeAt(0)));
  b.set('isinstance', fn('isinstance', ([o, c]) => {
    const cs = c instanceof PyTuple ? c.items : [c];
    return cs.some((k) => {
      if (k instanceof PyClass && o instanceof PyObject) return o.cls.isSub(k);
      if (k instanceof PyBuiltin) return typeName(o) === k.name || (k.name === 'float' && typeof o === 'number') || (k.name === 'int' && typeof o === 'number' && Number.isInteger(o));
      return false;
    });
  }));
  b.set('hasattr', fn('hasattr', ([o, n]) => { try { vm.getAttr(o, String(n), 0); return true; } catch { return false; } }));
  b.set('getattr', fn('getattr', ([o, n, d]) => { try { return vm.getAttr(o, String(n), 0); } catch (e) { if (d !== undefined) return d; throw e; } }));
  b.set('setattr', fn('setattr', ([o, n, v]) => { vm.setAttr(o, String(n), v, 0); return null; }));
  b.set('type', fn('type', ([o]) => (o instanceof PyObject ? o.cls : vm.builtins.get(typeName(o)) ?? null)));
  b.set('id', fn('id', () => Math.floor(vm.random() * 1e9)));
}

function sortList(items: unknown[], kw: Record<string, unknown>, vm: VM): unknown[] {
  const key = kw.key as unknown;
  const keyed = items.map((v) => ({ v, k: key ? vm.call(key, [v]) : v }));
  keyed.sort((a, b) => (vm.compare('<', a.k, b.k, 0) ? -1 : vm.compare('>', a.k, b.k, 0) ? 1 : 0));
  if (truthy(kw.reverse)) keyed.reverse();
  return keyed.map((x) => x.v);
}

function builtinMethod(o: unknown, name: string, vm: VM): PyBuiltin | null {
  const m = (f: NativeFn) => new PyBuiltin(name, f);
  if (typeof o === 'string') {
    switch (name) {
      case 'upper': return m(() => o.toUpperCase());
      case 'lower': return m(() => o.toLowerCase());
      case 'strip': return m(([c]) => (c === undefined || c === null ? o.trim() : trimChars(o, String(c), 3)));
      case 'lstrip': return m(([c]) => (c === undefined || c === null ? o.replace(/^\s+/, '') : trimChars(o, String(c), 1)));
      case 'rstrip': return m(([c]) => (c === undefined || c === null ? o.replace(/\s+$/, '') : trimChars(o, String(c), 2)));
      case 'split': return m(([sep, max]) => {
        const parts = sep === undefined || sep === null ? o.trim().split(/\s+/).filter((x) => x) : o.split(String(sep));
        if (max !== undefined && num(max) >= 0 && parts.length > num(max) + 1) return [...parts.slice(0, num(max)), parts.slice(num(max)).join(sep === undefined || sep === null ? ' ' : String(sep))];
        return parts;
      });
      case 'join': return m(([it]) => vm.iterate(it, 0).map((x) => { if (typeof x !== 'string') throw new PyError('TypeError', 'sequence item: expected str instance'); return x; }).join(o));
      case 'replace': return m(([a, b2]) => o.split(String(a)).join(String(b2)));
      case 'startswith': return m(([p]) => o.startsWith(String(p)));
      case 'endswith': return m(([p]) => o.endsWith(String(p)));
      case 'find': return m(([p]) => o.indexOf(String(p)));
      case 'index': return m(([p]) => { const i = o.indexOf(String(p)); if (i < 0) throw new PyError('ValueError', 'substring not found'); return i; });
      case 'count': return m(([p]) => o.split(String(p)).length - 1);
      case 'format': return m((args, kw) => {
        let auto = 0;
        return o.replace(/\{\{|\}\}|\{([^{}]*)\}/g, (all, inner: string | undefined) => {
          if (all === '{{') return '{';
          if (all === '}}') return '}';
          const [field, spec] = (inner ?? '').split(':');
          const v = field === '' ? args[auto++] : /^\d+$/.test(field) ? args[Number(field)] : kw[field];
          return spec ? formatSpec(v, spec, vm) : str(v, vm);
        });
      });
      case 'isdigit': return m(() => /^\d+$/.test(o));
      case 'title': return m(() => o.replace(/\b\w/g, (c) => c.toUpperCase()));
      case 'capitalize': return m(() => o.charAt(0).toUpperCase() + o.slice(1).toLowerCase());
      case 'zfill': return m(([w]) => o.padStart(num(w), '0'));
    }
    return null;
  }
  if (Array.isArray(o)) {
    switch (name) {
      case 'append': return m(([x]) => { o.push(x); return null; });
      case 'extend': return m(([x]) => { o.push(...vm.iterate(x, 0)); return null; });
      case 'insert': return m(([i, x]) => { let k = num(i); if (k < 0) k = Math.max(0, o.length + k); o.splice(Math.min(k, o.length), 0, x); return null; });
      case 'pop': return m(([i]) => { if (!o.length) throw new PyError('IndexError', 'pop from empty list'); const k = i === undefined ? o.length - 1 : vm.index(o.length, i, 0); return o.splice(k, 1)[0]; });
      case 'remove': return m(([x]) => { const k = o.findIndex((y) => pyEq(y, x)); if (k < 0) throw new PyError('ValueError', 'list.remove(x): x not in list'); o.splice(k, 1); return null; });
      case 'index': return m(([x]) => { const k = o.findIndex((y) => pyEq(y, x)); if (k < 0) throw new PyError('ValueError', `${repr(x, vm)} is not in list`); return k; });
      case 'count': return m(([x]) => o.filter((y) => pyEq(y, x)).length);
      case 'sort': return m((_a, kw) => { const s = sortList(o, kw, vm); o.splice(0, o.length, ...s); return null; });
      case 'reverse': return m(() => { o.reverse(); return null; });
      case 'clear': return m(() => { o.length = 0; return null; });
      case 'copy': return m(() => [...o]);
    }
    return null;
  }
  if (o instanceof Map) {
    const orig = (k: unknown) => keyOrig.get(k) ?? k;
    switch (name) {
      case 'get': return m(([k, d]) => (o.has(hashKey(k)) ? o.get(hashKey(k)) : d === undefined ? null : d));
      case 'keys': return m(() => [...o.keys()].map(orig));
      case 'values': return m(() => [...o.values()]);
      case 'items': return m(() => [...o.entries()].map(([k, v]) => new PyTuple([orig(k), v])));
      case 'pop': return m(([k, d]) => { const h = hashKey(k); if (o.has(h)) { const v = o.get(h); o.delete(h); return v; } if (d !== undefined) return d; throw new PyError('KeyError', repr(k, vm)); });
      case 'update': return m(([x], kw) => { if (x instanceof Map) for (const [k, v] of x) o.set(k, v); for (const [k, v] of Object.entries(kw)) { o.set(k, v); keyOrig.set(k, k); } return null; });
      case 'setdefault': return m(([k, d]) => { const h = hashKey(k); if (!o.has(h)) { o.set(h, d === undefined ? null : d); keyOrig.set(h, k); } return o.get(h); });
      case 'clear': return m(() => { o.clear(); return null; });
      case 'copy': return m(() => new Map(o));
    }
    return null;
  }
  if (o instanceof PySet) {
    switch (name) {
      case 'add': return m(([x]) => { o.items.add(hashKey(x)); keyOrig.set(hashKey(x), x); return null; });
      case 'discard': case 'remove': return m(([x]) => { o.items.delete(hashKey(x)); return null; });
      case 'clear': return m(() => { o.items.clear(); return null; });
    }
    return null;
  }
  if (typeof o === 'number' && name === 'is_integer') return m(() => Number.isInteger(o));
  return null;
}

function trimChars(s: string, chars: string, side: number): string {
  let a = 0, b = s.length;
  if (side & 1) while (a < b && chars.includes(s[a])) a++;
  if (side & 2) while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

function mathModule(): PyModule {
  const m = new Map<string, unknown>();
  const f1 = (name: string, f: (x: number) => number) => m.set(name, fn(name, ([x]) => { const r = f(num(x)); floatTag.add(r); return r; }));
  f1('sin', Math.sin); f1('cos', Math.cos); f1('tan', Math.tan); f1('asin', Math.asin); f1('acos', Math.acos); f1('atan', Math.atan);
  f1('sinh', Math.sinh); f1('cosh', Math.cosh); f1('tanh', Math.tanh); f1('exp', Math.exp); f1('sqrt', Math.sqrt);
  f1('fabs', Math.abs); f1('log10', Math.log10); f1('log2', Math.log2); f1('degrees', (x) => (x * 180) / Math.PI); f1('radians', (x) => (x * Math.PI) / 180);
  m.set('floor', fn('floor', ([x]) => Math.floor(num(x))));
  m.set('ceil', fn('ceil', ([x]) => Math.ceil(num(x))));
  m.set('trunc', fn('trunc', ([x]) => Math.trunc(num(x))));
  m.set('log', fn('log', ([x, base]) => { const r = base === undefined ? Math.log(num(x)) : Math.log(num(x)) / Math.log(num(base)); floatTag.add(r); return r; }));
  m.set('pow', fn('pow', ([x, y]) => { const r = Math.pow(num(x), num(y)); floatTag.add(r); return r; }));
  m.set('atan2', fn('atan2', ([y, x]) => Math.atan2(num(y), num(x))));
  m.set('hypot', fn('hypot', (args) => Math.hypot(...args.map((a) => num(a)))));
  m.set('fmod', fn('fmod', ([x, y]) => num(x) % num(y)));
  m.set('copysign', fn('copysign', ([x, y]) => Math.abs(num(x)) * (num(y) < 0 || Object.is(num(y), -0) ? -1 : 1)));
  m.set('isclose', fn('isclose', ([a, b2], kw) => Math.abs(num(a) - num(b2)) <= Math.max((kw.rel_tol as number) ?? 1e-9 * Math.max(Math.abs(num(a)), Math.abs(num(b2))), (kw.abs_tol as number) ?? 0)));
  m.set('pi', Math.PI); m.set('e', Math.E); m.set('tau', 2 * Math.PI); m.set('inf', Infinity); m.set('nan', NaN);
  floatTag.add(Math.PI); floatTag.add(Math.E); floatTag.add(2 * Math.PI);
  return new PyModule('math', m);
}

function randomModule(vm: VM): PyModule {
  const m = new Map<string, unknown>();
  const r = () => vm.random();
  m.set('random', fn('random', () => { const v = r(); floatTag.add(v); return v; }));
  m.set('uniform', fn('uniform', ([a, b]) => { const v = num(a) + (num(b) - num(a)) * r(); floatTag.add(v); return v; }));
  m.set('randint', fn('randint', ([a, b]) => num(a) + Math.floor(r() * (num(b) - num(a) + 1))));
  m.set('randrange', fn('randrange', ([a, b, s]) => { const lo = b === undefined ? 0 : num(a), hi = b === undefined ? num(a) : num(b), st = s === undefined ? 1 : num(s); const n = Math.max(0, Math.ceil((hi - lo) / st)); return lo + st * Math.floor(r() * n); }));
  m.set('choice', fn('choice', ([seq]) => { const it = vm.iterate(seq, 0); if (!it.length) throw new PyError('IndexError', 'Cannot choose from an empty sequence'); return it[Math.floor(r() * it.length)]; }));
  m.set('shuffle', fn('shuffle', ([seq]) => { if (Array.isArray(seq)) for (let i = seq.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [seq[i], seq[j]] = [seq[j], seq[i]]; } return null; }));
  m.set('gauss', fn('gauss', ([mu, sigma]) => { const u = 1 - r(), v = r(); const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); return num(mu ?? 0) + num(sigma ?? 1) * z; }));
  m.set('seed', fn('seed', () => null));
  return new PyModule('random', m);
}
