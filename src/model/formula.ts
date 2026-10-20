// FL Studio's formula language (Remote control settings > Mapping formula,
// Fruity Formula Controller): a small expression language over doubles.
// The parser and evaluator are written out by hand (no eval / Function):
// a formula is tokenised, parsed by precedence climbing and compiled once into
// a tree of closures that reads its variables from an environment object.
//
// Syntax (FL's tables, docs/research/fx/formulactrl.md):
//   operators   + - * / ^  = in <> < > <= >=  and or xor not  div mod fmod shl shr
//               postfix % (percent: x/100) and ! (factorial)
//   variables   Input (controller value 0..1), a b c (Formula Controller knobs 0..1)
//   constants   Pi
//   functions   Abs ArcCos ArcCosh ArcSin ArcSinh ArcTg ArcTan ArcTanh ATan2 Case Ceil Cos Cosh CoSec
//               Ctg Date DegToRad Exp Floor Fold Frac GetTempo If IfE IfG IfGE IfL IfLE Int Inter
//               Internoswap IntPower Ln Log10 Log2 LogN Map Max Min MouseX MouseY Neg Pow Power
//               RadToDeg Rand Round Sec SeededRand Sin Sinh SongTime Sqr Sqrt Sum Tan Tanh Tension Tg
//               Time Trunc Warp
// Names are case-insensitive. Functions without arguments may be written
// with or without parentheses ("Pi", "Pi()", "SongTime()").
// Precedence (low to high): comparisons; + - or xor; * / div mod fmod and shl
// shr; unary - + not; ^ (right associative); postfix % !.

/** Values a formula can read. All fields are optional; missing ones read 0. */
export interface FormulaEnv {
  /** Controller value (mapping formulas), 0..1. */
  input?: number;
  /** Formula Controller knobs, 0..1. */
  a?: number;
  b?: number;
  c?: number;
  /** Song position in quarter notes (beats). */
  songTime?: number;
  /** Running time in milliseconds. */
  time?: number;
  /** Project tempo (BPM). */
  tempo?: number;
  /** Mouse position 0..1 (Y up). */
  mouseX?: number;
  mouseY?: number;
}

export type FormulaFn = (env: FormulaEnv) => number;

/** Values shared by every formula when the environment does not give them (the engine updates the mouse). */
export const FORMULA_GLOBALS = { mouseX: 0, mouseY: 0 };

export interface CompiledFormula {
  ok: true;
  fn: FormulaFn;
  /** The formula reads time-dependent or random values (SongTime, Time, Rand, Mouse...). */
  dynamic: boolean;
  /** Variables the formula reads. */
  uses: Set<string>;
}

export interface FormulaError {
  ok: false;
  error: string;
  /** Character offset of the problem. */
  pos: number;
}

export type FormulaResult = CompiledFormula | FormulaError;

// --------------------------------------------------------------- tokens
type Tok =
  | { k: 'num'; v: number; p: number }
  | { k: 'id'; v: string; p: number }
  | { k: 'op'; v: string; p: number }
  | { k: 'end'; p: number };

const WORD_OPS = new Set(['and', 'or', 'xor', 'not', 'div', 'mod', 'fmod', 'shl', 'shr', 'in']);

class ParseError extends Error {
  constructor(msg: string, readonly pos: number) { super(msg); }
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') { i++; continue; }
    if ((ch >= '0' && ch <= '9') || (ch === '.' && i + 1 < n && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      if (src[j] === '.') { j++; while (j < n && src[j] >= '0' && src[j] <= '9') j++; }
      if ((src[j] === 'e' || src[j] === 'E') && /[-+]?\d/.test(src.slice(j + 1, j + 3))) {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < n && src[j] >= '0' && src[j] <= '9') j++;
      }
      out.push({ k: 'num', v: parseFloat(src.slice(i, j)), p: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j).toLowerCase();
      out.push(WORD_OPS.has(w) ? { k: 'op', v: w, p: i } : { k: 'id', v: w, p: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '<>' || two === '<=' || two === '>=') { out.push({ k: 'op', v: two, p: i }); i += 2; continue; }
    if ('+-*/^=<>(),%!'.includes(ch)) { out.push({ k: 'op', v: ch, p: i }); i++; continue; }
    throw new ParseError(`Unexpected character '${ch}'`, i);
  }
  out.push({ k: 'end', p: n });
  return out;
}

// --------------------------------------------------------------- AST
type Node =
  | { t: 'num'; v: number }
  | { t: 'var'; name: string }
  | { t: 'call'; name: string; args: Node[]; p: number }
  | { t: 'un'; op: string; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node };

const BIN_LEVEL: Record<string, number> = {
  '=': 1, in: 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1,
  '+': 2, '-': 2, or: 2, xor: 2,
  '*': 3, '/': 3, div: 3, mod: 3, fmod: 3, and: 3, shl: 3, shr: 3,
};

const VARIABLES = new Set(['input', 'a', 'b', 'c']);

/** Built-in functions: [min args, max args (-1 = any)]. */
const ARITY: Record<string, [number, number]> = {
  pi: [0, 0], rand: [0, 0], songtime: [0, 0], time: [0, 0], gettempo: [0, 0], date: [0, 0], mousex: [0, 0], mousey: [0, 0],
  abs: [1, 1], arccos: [1, 1], arccosh: [1, 1], arcsin: [1, 1], arcsinh: [1, 1], arctg: [1, 1], arctan: [1, 1], arctanh: [1, 1],
  ceil: [1, 1], cos: [1, 1], cosh: [1, 1], cosec: [1, 1], ctg: [1, 1], degtorad: [1, 1], exp: [1, 1], floor: [1, 1],
  fold: [1, 1], frac: [1, 1], int: [1, 1], ln: [1, 1], log10: [1, 1], log2: [1, 1], neg: [1, 1], radtodeg: [1, 1],
  round: [1, 1], sec: [1, 1], seededrand: [1, 1], sin: [1, 1], sinh: [1, 1], sqr: [1, 1], sqrt: [1, 1], tan: [1, 1],
  tanh: [1, 1], tg: [1, 1], trunc: [1, 1],
  atan2: [2, 2], ife: [2, 2], ifg: [2, 2], ifge: [2, 2], ifl: [2, 2], ifle: [2, 2], intpower: [2, 2], logn: [2, 2],
  pow: [2, 2], power: [2, 2], tension: [2, 2], warp: [2, 2],
  case: [3, 3], if: [3, 3], inter: [3, 3], internoswap: [3, 3], map: [3, 3],
  max: [1, -1], min: [1, -1], sum: [1, -1],
};

/** Display names of the functions (FL's spelling), for help lists. */
export const FORMULA_FUNCTIONS = [
  'Abs', 'ArcCos', 'ArcCosh', 'ArcSin', 'ArcSinh', 'ArcTg', 'ArcTan', 'ArcTanh', 'ATan2', 'Case', 'Ceil', 'Cos', 'Cosh',
  'CoSec', 'Ctg', 'Date', 'DegToRad', 'Exp', 'Floor', 'Fold', 'Frac', 'GetTempo', 'If', 'IfE', 'IfG', 'IfGE', 'IfL', 'IfLE',
  'Int', 'Inter', 'Internoswap', 'IntPower', 'Ln', 'Log10', 'Log2', 'LogN', 'Map', 'Max', 'Min', 'MouseX', 'MouseY', 'Neg',
  'Pi', 'Pow', 'Power', 'RadToDeg', 'Rand', 'Round', 'Sec', 'SeededRand', 'Sin', 'Sinh', 'SongTime', 'Sqr', 'Sqrt', 'Sum',
  'Tan', 'Tanh', 'Tension', 'Tg', 'Time', 'Trunc', 'Warp',
];

const DYNAMIC = new Set(['rand', 'songtime', 'time', 'gettempo', 'date', 'mousex', 'mousey']);

class Parser {
  private i = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok { return this.toks[this.i]; }
  private next(): Tok { return this.toks[this.i++]; }
  private isOp(v: string): boolean { const t = this.peek(); return t.k === 'op' && t.v === v; }

  parse(): Node {
    const e = this.expr(1);
    const t = this.peek();
    if (t.k !== 'end') throw new ParseError(t.k === 'op' && t.v === ')' ? 'Too many closing parentheses' : 'Operator expected', t.p);
    return e;
  }

  private expr(min: number): Node {
    let left = this.unary();
    for (;;) {
      const t = this.peek();
      if (t.k !== 'op') break;
      const lv = BIN_LEVEL[t.v];
      if (lv === undefined || lv < min) break;
      this.next();
      const right = this.expr(lv + 1);
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }

  private unary(): Node {
    const t = this.peek();
    if (t.k === 'op' && (t.v === '-' || t.v === '+' || t.v === 'not')) {
      this.next();
      const a = this.unary();
      return t.v === '+' ? a : { t: 'un', op: t.v, a };
    }
    return this.power();
  }

  private power(): Node {
    const base = this.postfix();
    if (this.isOp('^')) {
      this.next();
      // right associative; the exponent may carry its own sign (2^-1)
      const exp = this.unary();
      return { t: 'bin', op: '^', a: base, b: exp };
    }
    return base;
  }

  private postfix(): Node {
    let a = this.primary();
    for (;;) {
      if (this.isOp('%')) { this.next(); a = { t: 'un', op: '%', a }; continue; }
      if (this.isOp('!')) { this.next(); a = { t: 'un', op: '!', a }; continue; }
      return a;
    }
  }

  private primary(): Node {
    const t = this.next();
    if (t.k === 'num') return { t: 'num', v: t.v };
    if (t.k === 'op' && t.v === '(') {
      const e = this.expr(1);
      if (!this.isOp(')')) throw new ParseError("')' expected", this.peek().p);
      this.next();
      return e;
    }
    if (t.k === 'id') {
      const name = t.v;
      if (VARIABLES.has(name)) {
        if (this.isOp('(')) {
          // "Input()" is accepted like the zero-argument functions
          this.next();
          if (!this.isOp(')')) throw new ParseError(`'${name}' takes no arguments`, this.peek().p);
          this.next();
        }
        return { t: 'var', name };
      }
      const ar = ARITY[name];
      if (!ar) throw new ParseError(`Unknown identifier '${name}'`, t.p);
      const args: Node[] = [];
      if (this.isOp('(')) {
        this.next();
        if (!this.isOp(')')) {
          for (;;) {
            args.push(this.expr(1));
            if (this.isOp(',')) { this.next(); continue; }
            break;
          }
        }
        if (!this.isOp(')')) throw new ParseError("')' expected", this.peek().p);
        this.next();
      }
      if (args.length < ar[0] || (ar[1] >= 0 && args.length > ar[1])) {
        const want = ar[1] < 0 ? `at least ${ar[0]}` : ar[0] === ar[1] ? String(ar[0]) : `${ar[0]}..${ar[1]}`;
        throw new ParseError(`${name} expects ${want} argument${want === '1' ? '' : 's'}`, t.p);
      }
      return { t: 'call', name, args, p: t.p };
    }
    if (t.k === 'end') throw new ParseError('Unexpected end of formula', t.p);
    throw new ParseError(`Unexpected '${t.v}'`, t.p);
  }
}

// --------------------------------------------------------------- maths helpers
const bool = (x: boolean) => (x ? 1 : 0);
const truthy = (x: number) => x > 0.5;

/** Round half to even (Delphi's Round). */
export function roundEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** FL's Tension(Value, Speed) (docs/research/automation.md §4.7). */
export function tension(x: number, s: number): number {
  if (s === 0) return x;
  if (s > 0) return (s + 1 - Math.pow(s + 1, 1 - x)) / s;
  const k = -s;
  return (Math.pow(1 + k, x) - 1) / k;
}

function factorial(x: number): number {
  const n = Math.trunc(x);
  if (n < 0) return NaN;
  if (n > 170) return Infinity;
  let r = 1;
  for (let k = 2; k <= n; k++) r *= k;
  return r;
}

const hashBuf = new Float64Array(1);
const hashWords = new Uint32Array(hashBuf.buffer);

/** A fixed pseudo-random value 0..1 for a seed (the same seed always gives the same value). */
export function seededRand(seed: number): number {
  hashBuf[0] = seed === 0 ? 0 : seed; // -0 and 0 share a value
  let h = Math.imul(hashWords[0] ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(hashWords[1] ^ 0x7f4a7c15, 0xc2b2ae35);
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Days since 1899-12-30 (Delphi's Date), whole days. */
function delphiDate(): number {
  const ms = Date.now() - new Date().getTimezoneOffset() * 60000;
  return Math.floor(ms / 86400000) + 25569;
}

const toInt = (x: number) => Math.trunc(x);

function binary(op: string, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '^': return Math.pow(a, b);
    case '=': case 'in': return bool(a === b);
    case '<>': return bool(a !== b);
    case '<': return bool(a < b);
    case '>': return bool(a > b);
    case '<=': return bool(a <= b);
    case '>=': return bool(a >= b);
    case 'and': return bool(truthy(a) && truthy(b));
    case 'or': return bool(truthy(a) || truthy(b));
    case 'xor': return bool(truthy(a) !== truthy(b));
    case 'div': { const d = toInt(b); return d === 0 ? NaN : Math.trunc(toInt(a) / d); }
    case 'mod': { const d = toInt(b); return d === 0 ? NaN : toInt(a) % d; }
    case 'fmod': return b === 0 ? NaN : a % b;
    case 'shl': return toInt(a) * Math.pow(2, toInt(b));
    case 'shr': return Math.trunc(toInt(a) / Math.pow(2, toInt(b)));
  }
  return NaN;
}

function call1(name: string, x: number): number {
  switch (name) {
    case 'abs': return Math.abs(x);
    case 'arccos': return Math.acos(x);
    case 'arccosh': return Math.acosh(x);
    case 'arcsin': return Math.asin(x);
    case 'arcsinh': return Math.asinh(x);
    case 'arctg': case 'arctan': return Math.atan(x);
    case 'arctanh': return Math.atanh(x);
    case 'ceil': return Math.ceil(x);
    case 'cos': return Math.cos(x);
    case 'cosh': return Math.cosh(x);
    case 'cosec': return 1 / Math.sin(x);
    case 'ctg': return 1 / Math.tan(x);
    case 'degtorad': return (x * Math.PI) / 180;
    case 'exp': return Math.exp(x);
    case 'floor': return Math.floor(x);
    case 'fold': { const m = x - 2 * Math.floor(x / 2); return 1 - Math.abs(1 - m); }
    case 'frac': return x - Math.trunc(x);
    case 'int': case 'trunc': return Math.trunc(x);
    case 'ln': return Math.log(x);
    case 'log10': return Math.log10(x);
    case 'log2': return Math.log2(x);
    case 'neg': return -x;
    case 'radtodeg': return (x * 180) / Math.PI;
    case 'round': return roundEven(x);
    case 'sec': return 1 / Math.cos(x);
    case 'seededrand': return seededRand(x);
    case 'sin': return Math.sin(x);
    case 'sinh': return Math.sinh(x);
    case 'sqr': return x * x;
    case 'sqrt': return Math.sqrt(x);
    case 'tan': case 'tg': return Math.tan(x);
    case 'tanh': return Math.tanh(x);
  }
  return NaN;
}

function call2(name: string, x: number, y: number): number {
  switch (name) {
    case 'atan2': return Math.atan2(x, y);
    case 'ife': return bool(x === y);
    case 'ifg': return bool(x > y);
    case 'ifge': return bool(x >= y);
    case 'ifl': return bool(x < y);
    case 'ifle': return bool(x <= y);
    case 'intpower': return Math.pow(x, Math.trunc(y));
    case 'logn': return Math.log(y) / Math.log(x);
    case 'pow': case 'power': return Math.pow(x, y);
    case 'tension': return tension(x, y);
    // wrap x around the warp point y (x modulo y, kept in 0..y)
    case 'warp': return y === 0 ? x : x - y * Math.floor(x / y);
  }
  return NaN;
}

function call3(name: string, x: number, y: number, z: number): number {
  switch (name) {
    case 'case': return Math.abs(x - 1) < 1e-9 ? y : z;
    case 'if': return truthy(x) ? y : z;
    case 'inter': { const lo = Math.min(y, z), hi = Math.max(y, z); return bool(x > lo && x < hi); }
    case 'internoswap': return bool(x > y && x < z);
    case 'map': return x * (z - y) + y;
  }
  return NaN;
}

// --------------------------------------------------------------- compiler
function compileNode(n: Node, uses: Set<string>): { fn: FormulaFn; constant: boolean } {
  switch (n.t) {
    case 'num': { const v = n.v; return { fn: () => v, constant: true }; }
    case 'var': {
      uses.add(n.name);
      switch (n.name) {
        case 'input': return { fn: (e) => e.input ?? 0, constant: false };
        case 'a': return { fn: (e) => e.a ?? 0, constant: false };
        case 'b': return { fn: (e) => e.b ?? 0, constant: false };
        default: return { fn: (e) => e.c ?? 0, constant: false };
      }
    }
    case 'un': {
      const a = compileNode(n.a, uses);
      const f = a.fn;
      let fn: FormulaFn;
      switch (n.op) {
        case '-': fn = (e) => -f(e); break;
        case 'not': fn = (e) => (f(e) <= 0.5 ? 1 : 0); break;
        case '%': fn = (e) => f(e) / 100; break;
        default: fn = (e) => factorial(f(e)); break;
      }
      return fold(fn, a.constant);
    }
    case 'bin': {
      const a = compileNode(n.a, uses), b = compileNode(n.b, uses);
      const fa = a.fn, fb = b.fn, op = n.op;
      let fn: FormulaFn;
      switch (op) {
        case '+': fn = (e) => fa(e) + fb(e); break;
        case '-': fn = (e) => fa(e) - fb(e); break;
        case '*': fn = (e) => fa(e) * fb(e); break;
        case '/': fn = (e) => fa(e) / fb(e); break;
        default: fn = (e) => binary(op, fa(e), fb(e)); break;
      }
      return fold(fn, a.constant && b.constant);
    }
    case 'call': {
      const name = n.name;
      const args = n.args.map((x) => compileNode(x, uses));
      const allConst = args.every((x) => x.constant);
      if (DYNAMIC.has(name)) uses.add(name);
      let fn: FormulaFn;
      switch (name) {
        case 'pi': return { fn: () => Math.PI, constant: true };
        case 'rand': return { fn: () => Math.random(), constant: false };
        case 'songtime': return { fn: (e) => e.songTime ?? 0, constant: false };
        case 'time': return { fn: (e) => e.time ?? Date.now(), constant: false };
        case 'gettempo': return { fn: (e) => e.tempo ?? 0, constant: false };
        case 'date': return { fn: () => delphiDate(), constant: false };
        case 'mousex': return { fn: (e) => e.mouseX ?? FORMULA_GLOBALS.mouseX, constant: false };
        case 'mousey': return { fn: (e) => e.mouseY ?? FORMULA_GLOBALS.mouseY, constant: false };
        case 'max': case 'min': case 'sum': {
          const fs = args.map((x) => x.fn);
          if (name === 'sum') fn = (e) => { let s = 0; for (const f of fs) s += f(e); return s; };
          else if (name === 'max') fn = (e) => { let m = -Infinity; for (const f of fs) { const v = f(e); if (v > m || Number.isNaN(v)) m = v; } return m; };
          else fn = (e) => { let m = Infinity; for (const f of fs) { const v = f(e); if (v < m || Number.isNaN(v)) m = v; } return m; };
          return fold(fn, allConst);
        }
      }
      const [x, y, z] = args.map((q) => q.fn);
      if (args.length === 1) fn = (e) => call1(name, x(e));
      else if (args.length === 2) fn = (e) => call2(name, x(e), y(e));
      else if (name === 'if') fn = (e) => (truthy(x(e)) ? y(e) : z(e)); // only the chosen branch runs
      else fn = (e) => call3(name, x(e), y(e), z(e));
      return fold(fn, allConst);
    }
  }
}

/** Constant sub-expressions are evaluated once at compile time. */
function fold(fn: FormulaFn, constant: boolean): { fn: FormulaFn; constant: boolean } {
  if (!constant) return { fn, constant };
  const v = fn({});
  return { fn: () => v, constant: true };
}

/** Compile a formula once; evaluate it with `result.fn(env)`. */
export function compileFormula(source: string): FormulaResult {
  try {
    const text = source.trim();
    if (!text) return { ok: false, error: 'Empty formula', pos: 0 };
    const ast = new Parser(tokenize(text)).parse();
    const uses = new Set<string>();
    const { fn } = compileNode(ast, uses);
    const dynamic = [...uses].some((u) => DYNAMIC.has(u));
    return { ok: true, fn, dynamic, uses };
  } catch (e) {
    if (e instanceof ParseError) return { ok: false, error: e.message, pos: e.pos };
    return { ok: false, error: String((e as Error)?.message ?? e), pos: 0 };
  }
}

const cache = new Map<string, FormulaResult>();

/** compileFormula with a small cache (formulas are shared by many links). */
export function compileCached(source: string): FormulaResult {
  let r = cache.get(source);
  if (!r) {
    r = compileFormula(source);
    if (cache.size > 256) cache.clear();
    cache.set(source, r);
  }
  return r;
}

/** Evaluate a formula string once (UI previews, tests). NaN when it does not compile. */
export function evalFormula(source: string, env: FormulaEnv = {}): number {
  const r = compileCached(source);
  return r.ok ? r.fn(env) : NaN;
}
