// FL's formula language (link mapping formulas and the Formula Controller).
import { describe, it, expect } from 'vitest';
import { compileFormula, evalFormula, roundEven, seededRand, tension } from '../src/model/formula';

const ev = (f: string, env = {}) => evalFormula(f, env);

describe('formula language', () => {
  it('evaluates arithmetic with the usual precedence', () => {
    expect(ev('1+2*3')).toBe(7);
    expect(ev('(1+2)*3')).toBe(9);
    expect(ev('2^3^2')).toBe(512); // right associative
    expect(ev('-2^2')).toBe(-4);
    expect(ev('2^-1')).toBe(0.5);
    expect(ev('10-4-3')).toBe(3);
    expect(ev('8/4/2')).toBe(1);
    expect(ev('1.5e2+.5')).toBe(150.5);
    expect(ev('50%')).toBe(0.5);
    expect(ev('3!*2')).toBe(12);
  });

  it('compares and combines logically (true = 1, values above 0.5 are true)', () => {
    expect(ev('(a+b)=1', { a: 0.25, b: 0.75 })).toBe(1);
    expect(ev('a in 0.5', { a: 0.5 })).toBe(1);
    expect(ev('2<>2')).toBe(0);
    expect(ev('1<2')).toBe(1);
    expect(ev('2<=2')).toBe(1);
    expect(ev('3>=4')).toBe(0);
    expect(ev('1+1>1')).toBe(1); // comparisons bind loosest
    expect(ev('not 0.4')).toBe(1);
    expect(ev('not 0.6')).toBe(0);
    expect(ev('0.6 and 0.9')).toBe(1);
    expect(ev('0.6 and 0.2')).toBe(0);
    expect(ev('0.2 or 0.7')).toBe(1);
    expect(ev('0.7 xor 0.8')).toBe(0);
    expect(ev('0.7 xor 0.1')).toBe(1);
  });

  it('has integer operators', () => {
    expect(ev('7 div 2')).toBe(3);
    expect(ev('-7 div 2')).toBe(-3);
    expect(ev('7 mod 3')).toBe(1);
    expect(ev('7.5 fmod 2')).toBe(1.5);
    expect(ev('5 shl 2')).toBe(20);
    expect(ev('20 shr 2')).toBe(5);
  });

  it('reads Input, a, b, c, SongTime, Time and GetTempo, case-insensitively', () => {
    expect(ev('Input*2', { input: 0.25 })).toBe(0.5);
    expect(ev('INPUT+input()', { input: 0.25 })).toBe(0.5);
    expect(ev('a+b+c', { a: 0.1, b: 0.2, c: 0.3 })).toBeCloseTo(0.6, 12);
    expect(ev('SongTime', { songTime: 3.5 })).toBe(3.5);
    expect(ev('songtime()*2', { songTime: 1.5 })).toBe(3);
    expect(ev('Time/1000', { time: 2500 })).toBe(2.5);
    expect(ev('GetTempo', { tempo: 140 })).toBe(140);
    expect(ev('pi')).toBeCloseTo(Math.PI, 12);
    expect(ev('Pi()')).toBeCloseTo(Math.PI, 12);
  });

  it('implements the function table', () => {
    const close = (f: string, v: number, env = {}) => expect(ev(f, env), f).toBeCloseTo(v, 9);
    close('Abs(-0.5)', 0.5);
    close('ArcCos(1)', 0);
    close('ArcSin(1)', Math.PI / 2);
    close('ArcTg(1)', Math.PI / 4);
    close('ATan2(1,1)', Math.PI / 4);
    close('Case(1,0.3,0.7)', 0.3);
    close('Case(0,0.3,0.7)', 0.7);
    close('Ceil(1.2)', 2);
    close('Cos(0)', 1);
    close('CoSec(Pi/2)', 1);
    close('Ctg(Pi/4)', 1);
    close('DegToRad(180)', Math.PI);
    close('Exp(0)', 1);
    close('Floor(-1.5)', -2);
    close('Fold(1.25)', 0.75);
    close('Frac(1.75)', 0.75);
    close('Frac(-1.25)', -0.25);
    close('If(0.6,1,2)', 1);
    close('if(0.4,1,2)', 2);
    close('IfE(2,2)', 1);
    close('IfG(3,2)', 1);
    close('IfGE(2,2)', 1);
    close('IfL(1,2)', 1);
    close('IfLE(3,2)', 0);
    close('Int(-1.7)', -1);
    close('Inter(0.5,0.8,0.2)', 1); // swaps the range
    close('Internoswap(0.5,0.8,0.2)', 0);
    close('IntPower(2,3.9)', 8);
    close('Ln(Exp(2))', 2);
    close('Log10(1000)', 3);
    close('Log2(8)', 3);
    close('LogN(2,8)', 3);
    close('Map(0.5,10,20)', 15);
    close('Max(1,3,2)', 3);
    close('Min(1,3,2)', 1);
    close('Neg(2)', -2);
    close('Power(2,0.5)', Math.SQRT2);
    close('Pow(3,2)', 9);
    close('RadToDeg(Pi)', 180);
    close('Round(2.5)', 2); // Delphi: half to even
    close('Round(3.5)', 4);
    close('Sec(0)', 1);
    close('Sin(Pi/2)', 1);
    close('Sinh(0)', 0);
    close('Sqrt(16)', 4);
    close('Sqr(3)', 9);
    close('Sum(1,2,3,4)', 10);
    close('Tg(Pi/4)', 1);
    close('Tan(0)', 0);
    close('Tanh(0)', 0);
    close('Trunc(2.9)', 2);
    close('Warp(1.3,1)', 0.3);
    close('Tension(0.5,0)', 0.5);
  });

  it("Tension follows FL's curve (research doc §4.7)", () => {
    expect(tension(0, 10)).toBeCloseTo(0, 12);
    expect(tension(1, 10)).toBeCloseTo(1, 12);
    expect(tension(0.5, 10)).toBeCloseTo((11 - Math.sqrt(11)) / 10, 12);
    expect(tension(0.5, -10)).toBeCloseTo((Math.sqrt(11) - 1) / 10, 12);
    expect(ev('Tension(Input,10)', { input: 0.5 })).toBeGreaterThan(0.5); // "Log scale"
  });

  it('SeededRand is static per seed, Rand moves', () => {
    expect(seededRand(3)).toBe(seededRand(3));
    expect(seededRand(3)).not.toBe(seededRand(4));
    for (let s = 0; s < 50; s++) { const v = seededRand(s); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
    const r = compileFormula('Rand');
    expect(r.ok && r.dynamic).toBe(true);
    if (r.ok) expect(r.fn({})).not.toBe(r.fn({}));
  });

  it('runs the factory Formula Controller presets', () => {
    const env = { a: 0.5, b: 1, c: 0.5, songTime: 1.25 };
    expect(ev('a+(Sin(SongTime*Pi*2*c)*b)^9*0.5', env)).toBeCloseTo(0.5 + Math.sin(1.25 * Math.PI) ** 9 * 0.5, 12);
    expect(ev('a+Frac(SongTime/(5-c*4.5))*(b*2-1)-b+0.5', env)).toBeCloseTo(0.5 + ((1.25 / 2.75) % 1) - 0.5, 12);
    expect(ev('Case(Round(1-c),a,b)', { a: 0.2, b: 0.9, c: 0.2 })).toBe(0.2);
    expect(ev('Min(Max(a,b),c)', { a: 0.9, b: 0.1, c: 0.6 })).toBe(0.6);
    expect(ev('Round(a*(b*16+1))/(b*16+1)', { a: 0.5, b: 0.25 })).toBeCloseTo(2 / 5, 12);
    expect(ev('IfLE(songtime,32)*(songtime/32)*0.5*sin(2*pi*songtime/4)+0.5', { songTime: 1 })).toBeCloseTo(0.5 + (1 / 32) * 0.5, 12);
  });

  it('reports errors with a position', () => {
    for (const bad of ['', '1+', '(1+2', '1+2)', 'Foo(1)', 'Sin()', 'Sin(1,2)', 'a b', '1 $ 2', 'Max()']) {
      const r = compileFormula(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) { expect(r.error.length).toBeGreaterThan(3); expect(r.pos).toBeGreaterThanOrEqual(0); }
    }
    const r = compileFormula('Sinn(Input)');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('sinn');
  });

  it('folds constants and flags dynamic formulas', () => {
    const c = compileFormula('Sin(Pi/2)*a');
    expect(c.ok && !c.dynamic).toBe(true);
    if (c.ok) { expect(c.uses.has('a')).toBe(true); expect(c.fn({ a: 0.5 })).toBeCloseTo(0.5, 12); }
    const d = compileFormula('SongTime*2');
    expect(d.ok && d.dynamic).toBe(true);
    expect(roundEven(-2.5)).toBe(-2);
  });
});
