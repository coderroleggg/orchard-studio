import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import { processNotes, runNotes, scriptValues } from '../../src/engine/effects/plugins/vfxscript';
import { compiledState, controlValue, ctlKey } from '../../src/model/fx/plugins/vfxscript';
import { VM, PyError, parse } from '../../src/model/fx/plugins/vfx/pyvm';
import { compileScript, runScript } from '../../src/model/fx/plugins/vfx/vfxrun';
import { note, seeded, vfxContext } from '../../src/model/fx/plugins/vfx/notes';
import { makeCtx } from './util';

const py = (src: string) => { let s = ''; new VM({ print: (x) => { s += x; } }).run(src); return s; };
const preset = (name: string) => ({ ...defaultFxParams('vfxscript'), ...structuredClone(fxDef('vfxscript')!.presets!.find((p) => p.name === name)!.params) });
const phrase = () => [note({ key: 60, pos: 0, len: 96, vel: 100 }), note({ key: 64, pos: 96, len: 48, vel: 64 })];

describe('VFX Script', () => {
  it('is registered with 32 automatable script controls, a bypass default and example scripts', () => {
    const d = fxDef('vfxscript')!;
    expect(d.width).toBe(799);
    expect(d.height).toBe(521);
    expect(d.params).toHaveLength(32);
    expect(d.params[0]).toMatchObject({ key: 'c1', min: 0, max: 1 });
    const p = defaultFxParams('vfxscript');
    expect(String(p.code)).toContain('import flvfx as vfx');
    expect(p.compiled).toBe(p.code);
    expect(d.presets!.map((x) => x.name)).toEqual(['Default', 'Transpose', 'Chord', 'Note Gate', 'Arpeggiator', 'Pulse Generator', 'Sine LFO']);
    for (const pr of d.presets!) expect(pr.params.error).toBe(''); // every example compiles
  });

  it('interprets the Python subset scripts use (and never evaluates JavaScript)', () => {
    expect(py('print(1+2*3, 7//2, 7/2, 2**10, -7%3)')).toBe('7 3 3.5 1024 2\n');
    expect(py('a=[1,2,3]\na.append(4)\nprint(a[1:], len(a), a[-1], a[::-1])')).toBe('[2, 3, 4] 4 4 [4, 3, 2, 1]\n');
    expect(py('d={"x":1}\nd["y"]=2\nfor k,v in d.items():\n  print(k,v)')).toBe('x 1\ny 2\n');
    expect(py('def f(a,b=2,*r):\n  return a+b+sum(r)\nprint(f(1), f(1,3), f(1,2,3,4), f(b=5, a=1))')).toBe('3 4 10 6\n');
    expect(py('class A:\n  x=5\n  def __init__(self,y):\n    self.y=y\n  def s(self):\n    return self.x+self.y\nclass B(A):\n  x=10\nprint(A(2).s(), B(2).s())')).toBe('7 12\n');
    expect(py('print([x*x for x in range(5) if x%2==0], {k: k*2 for k in "ab"})')).toBe("[0, 4, 16] {'a': 'aa', 'b': 'bb'}\n");
    expect(py('x=3.14159\nprint(f"v={x:.2f} {int(x)*2}")')).toBe('v=3.14 6\n');
    expect(py('try:\n  1/0\nexcept ZeroDivisionError as e:\n  print("caught", e)\nfinally:\n  print("done")')).toBe('caught division by zero\ndone\n');
    expect(py('g=0\ndef inc():\n  global g\n  g+=1\ninc();inc()\nprint(g)')).toBe('2\n');
    expect(py('print(1 < 2 < 3, 3 > 2 > 5, "a" in "abc", not None, 5 if 0 else 6)')).toBe('True False True True 6\n');
    expect(py('a, *b = [1, 2, 3]\nprint(a, b, sorted([3,1,2], reverse=True), max([3,9,2], key=lambda v: -v))')).toBe('1 [2, 3] [3, 2, 1] 2\n');
    expect(py('s = "a,b,c"\nprint(s.split(","), "-".join(["x","y"]), "%d-%s" % (3, "z"), "{} {}".format(1, 2))')).toBe("['a', 'b', 'c'] x-y 3-z 1 2\n");
    // errors carry Python's types and line numbers
    expect(() => py('x = (1')).toThrow(PyError);
    try { py('x = 1\ny = z + 1'); } catch (e) { expect((e as PyError).text).toBe("NameError: name 'z' is not defined (line 2)"); }
    // sandbox: no access to JS globals, an instruction budget against endless loops
    expect(() => py('import os')).toThrow(/No module named 'os'/);
    expect(() => py('print(globalThis)')).toThrow(/'globalThis' is not defined/);
    expect(() => py('while True:\n  pass')).toThrow(/instruction limit/);
    expect(parse('x = 1\n').length).toBe(1);
  });

  it('passes notes through with the default (bypass) script', () => {
    const out = processNotes(phrase(), defaultFxParams('vfxscript'), vfxContext());
    expect(out.map((n) => [n.key, n.pos, n.len, n.vel])).toEqual([[60, 0, 96, 100], [64, 96, 48, 64]]);
  });

  it('feeds the dialog controls from the automatable script controls (Transpose, Chord)', () => {
    const t = preset('Transpose');
    expect((t.dialog as { controls: unknown[] }).controls).toHaveLength(2);
    const p = { ...t, [ctlKey(0)]: (7 + 12) / 24, [ctlKey(1)]: (1 + 4) / 8 }; // +7 semitones, +1 octave
    expect(scriptValues(p)).toEqual({ Semitones: 7, Octaves: 1 });
    expect(processNotes(phrase(), p, vfxContext()).map((n) => n.key)).toEqual([79, 83]);
    const c = preset('Chord');
    const chord = processNotes([note({ key: 60, len: 96, vel: 128 })], { ...c, [ctlKey(0)]: 1 / 4 }, vfxContext()); // Minor
    expect(chord.map((n) => n.key)).toEqual([60, 63, 67]);
    expect(chord[0].vel).toBeGreaterThan(chord[2].vel);
  });

  it('gates notes with a checkbox and a probability (Note Gate)', () => {
    const g = preset('Note Gate');
    expect(processNotes(phrase(), { ...g, [ctlKey(0)]: 0 }, vfxContext())).toHaveLength(0);
    expect(processNotes(phrase(), g, vfxContext())).toHaveLength(2);
    const many = Array.from({ length: 200 }, (_, i) => note({ key: 60, pos: i * 10, len: 5 }));
    const half = processNotes(many, { ...g, [ctlKey(1)]: 0.5 }, vfxContext({ random: seeded(4) }));
    expect(half.length).toBeGreaterThan(70);
    expect(half.length).toBeLessThan(130);
  });

  it('arpeggiates held notes and generates notes while playing', () => {
    const arp = preset('Arpeggiator');
    const held = [60, 64, 67].map((k) => note({ key: k, pos: 0, len: 96 }));
    const out = processNotes(held, arp, vfxContext({ ppq: 96 }));
    expect(out.slice(0, 4).map((n) => [n.key, n.pos])).toEqual([[60, 0], [64, 24], [67, 48], [60, 72]]);
    const pulse = runNotes([], preset('Pulse Generator'), { ...vfxContext({ ppq: 96 }), horizon: 383 });
    expect(pulse.error).toBeNull();
    expect(pulse.notes).toHaveLength(8); // every 1/8 note for 4 beats
    expect(pulse.notes[1]).toMatchObject({ key: 60, pos: 48, len: 24, vel: 102 });
  });

  it('drives output controllers (Sine LFO) and reports compile errors with lines', () => {
    const r = runNotes([], preset('Sine LFO'), { ...vfxContext({ ppq: 96 }), horizon: 96 * 4 });
    expect(r.outputs).toEqual([{ name: 'LFO', def: 0.5 }]);
    const v = r.controllers.LFO.map((p) => p[1]);
    expect(Math.max(...v)).toBeGreaterThan(0.99);
    expect(Math.min(...v)).toBeLessThan(0.01);
    const bad = compileScript('import flvfx as vfx\ndef onTick(:\n  pass\n');
    expect(bad.error).toMatch(/^SyntaxError: .*\(line 2\)$/);
    const st = compiledState('x = 1\nprint("hello")\n');
    expect(st.log).toBe('hello\n');
    expect(runScript('def onTick():\n  return undefined_name\n', {}, [], { ...vfxContext(), horizon: 4 }).error).toMatch(/NameError/);
  });

  it('maps control positions to values per control kind', () => {
    const base = { name: 'x', label: 'x', group: '', hint: '', def: 0 };
    expect(controlValue({ ...base, kind: 'knob', min: -1, max: 1 }, 0.75)).toBeCloseTo(0.5, 9);
    expect(controlValue({ ...base, kind: 'knobInt', min: 0, max: 10 }, 0.33)).toBe(3);
    expect(controlValue({ ...base, kind: 'check', min: 0, max: 1 }, 0.6)).toBe(1);
    expect(controlValue({ ...base, kind: 'combo', min: 0, max: 3, options: ['a', 'b', 'c', 'd'] }, 1)).toBe(3);
  });

  it('does nothing to audio in a mixer slot', () => {
    const fx = createEffect('vfxscript', 48000, 128);
    fx.setParams(defaultFxParams('vfxscript'));
    const L = new Float32Array(128).fill(0.7), R = new Float32Array(128).fill(0.7);
    fx.process(L, R, 128, makeCtx());
    expect(L[0]).toBeCloseTo(0.7, 7);
  });
});
