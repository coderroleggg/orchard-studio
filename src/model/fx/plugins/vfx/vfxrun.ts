// VFX Script runtime: FL's `flvfx` module (context, Voice, ScriptDialog,
// output controllers) on top of the sandboxed interpreter, and a runner that
// plays note events through a script tick by tick, as FL calls it:
// onTriggerVoice(incoming) at note starts, onReleaseVoice(incoming) at note
// ends, onTick() on every tick; script voices sound from trigger() to
// release() (or `length` ticks).

import { PyBuiltin, PyClass, PyError, PyModule, PyObject, VM, str, truthy, type NativeClass } from './pyvm';
import type { VfxContext, VfxNote } from './notes';

export type ControlKind = 'knob' | 'knobInt' | 'check' | 'combo' | 'text' | 'surface';

export interface ScriptControl {
  kind: ControlKind;
  /** Name as getInputValue sees it ("Group: Name" inside a group). */
  name: string;
  label: string;
  group: string;
  def: number | string;
  min: number;
  max: number;
  options?: string[];
  hint: string;
}

export interface ScriptDialogInfo {
  title: string;
  description: string;
  controls: ScriptControl[];
  surface: boolean;
}

export interface ScriptRun {
  notes: VfxNote[];
  /** Output controller values over time: [tick, value]. */
  controllers: Record<string, [number, number][]>;
  outputs: { name: string; def: number }[];
  dialog: ScriptDialogInfo | null;
  log: string;
  error: string | null;
}

const VOICE_PROPS = ['note', 'finePitch', 'velocity', 'pan', 'length', 'output', 'fcut', 'fres', 'color'] as const;
const VOICE_DEFAULTS: Record<string, number> = { note: 60, finePitch: 0, velocity: 0.8, pan: 0, length: 0, output: 0, fcut: 0, fres: 0, color: 0 };

interface Runtime {
  vm: VM;
  Voice: PyClass;
  ctxObj: PyObject;
  form: PyObject;
  dialog: ScriptDialogInfo;
  values: Record<string, number | string>;
  outputs: { name: string; def: number }[];
  controllers: Record<string, [number, number][]>;
  tick: number;
  active: PyObject[];
  voices: Map<PyObject, { start: number; key0: number; pitch: [number, number][] }>;
  done: VfxNote[];
}

const numOf = (v: unknown, d = 0): number => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : d);

function voiceToNote(rt: Runtime, v: PyObject, end: number): VfxNote {
  const meta = rt.voices.get(v)!;
  const g = (k: string) => numOf(v.attrs.has(k) ? v.attrs.get(k) : v.cls.lookup(k) ?? VOICE_DEFAULTS[k], VOICE_DEFAULTS[k]);
  const key = Math.max(0, Math.min(131, Math.round(meta.key0)));
  const n: VfxNote = {
    key,
    pos: meta.start,
    len: Math.max(1, end - meta.start),
    vel: Math.round(Math.max(0, Math.min(1, g('velocity'))) * 128),
    rel: 64,
    pan: Math.round(64 + Math.max(-1, Math.min(1, g('pan'))) * 64),
    fine: Math.round(Math.max(0, Math.min(240, 120 + (meta.key0 - key) * 100))),
    modX: Math.round(Math.max(0, Math.min(255, 128 + g('fcut') * 128))),
    modY: Math.round(Math.max(0, Math.min(255, 128 + g('fres') * 128))),
    color: Math.max(0, Math.min(15, Math.round(g('color')))),
    port: Math.max(0, Math.round(g('output'))),
  };
  if (meta.pitch.length > 1 || (meta.pitch.length === 1 && meta.pitch[0][1] !== 0)) n.mod = { pitch: meta.pitch };
  return n;
}

function makeRuntime(values: Record<string, number | string>, ctx: VfxContext, log: (s: string) => void): Runtime {
  const rt = {} as Runtime;
  rt.values = values;
  rt.outputs = [];
  rt.controllers = {};
  rt.tick = 0;
  rt.active = [];
  rt.voices = new Map();
  rt.done = [];
  rt.dialog = { title: '', description: '', controls: [], surface: false };
  const flvfx = new Map<string, unknown>();
  const vm = new VM({ print: log, random: ctx.random, modules: { flvfx: new PyModule('flvfx', flvfx) } });
  rt.vm = vm;

  const getProp = (o: PyObject, k: string) => (o.attrs.has(k) ? o.attrs.get(k) : o.cls.lookup(k) ?? VOICE_DEFAULTS[k]);
  const voiceNative: NativeClass = {
    init(self, args) {
      const src = args[0];
      for (const k of VOICE_PROPS) self.attrs.set(k, src instanceof PyObject ? getProp(src, k) : VOICE_DEFAULTS[k]);
    },
    methods: {
      trigger(self) {
        if (rt.voices.has(self) && rt.active.includes(self)) return null;
        const key0 = numOf(getProp(self, 'note'), 60) + numOf(getProp(self, 'finePitch'), 0);
        rt.voices.set(self, { start: rt.tick, key0, pitch: [] });
        rt.active.push(self);
        return null;
      },
      release(self) {
        const i = rt.active.indexOf(self);
        if (i < 0) return null;
        rt.active.splice(i, 1);
        rt.done.push(voiceToNote(rt, self, rt.tick));
        return null;
      },
      copyFrom(self, args) {
        const o = args[0];
        if (o instanceof PyObject) for (const k of VOICE_PROPS) if (k !== 'length') self.attrs.set(k, getProp(o, k));
        return null;
      },
    },
  };
  const Voice = new PyClass('Voice', [], new Map(), voiceNative);
  flvfx.set('Voice', Voice);
  rt.Voice = Voice;

  // ScriptDialog
  let group = '';
  const add = (kind: ControlKind, label: string, def: number | string, min: number, max: number, hint: unknown, options?: string[]) => {
    const name = group ? `${group}: ${label}` : label;
    rt.dialog.controls = rt.dialog.controls.filter((c) => c.name !== name);
    rt.dialog.controls.push({ kind, name, label, group, def, min, max, options, hint: hint === undefined || hint === null ? '' : String(hint) });
  };
  const dialogNative: NativeClass = {
    init(_self, args) {
      rt.dialog.title = args[0] === undefined ? '' : String(args[0]);
      rt.dialog.description = args[1] === undefined ? '' : String(args[1]);
    },
    methods: {
      addInputKnob(_s, a, kw) { add('knob', String(a[0]), numOf(a[1]), numOf(a[2], 0), numOf(a[3], 1), a[4] ?? kw.hint); return null; },
      addInputKnobInt(_s, a, kw) { add('knobInt', String(a[0]), Math.round(numOf(a[1])), Math.round(numOf(a[2], 0)), Math.round(numOf(a[3], 1)), a[4] ?? kw.hint); return null; },
      addInputCheckbox(_s, a, kw) { add('check', String(a[0]), truthy(a[1]) ? 1 : 0, 0, 1, a[2] ?? kw.hint); return null; },
      addInputCombo(_s, a, kw) {
        const opts = vm.iterate(a[1], 0).map((x) => str(x, vm));
        add('combo', String(a[0]), Math.round(numOf(a[2])), 0, Math.max(0, opts.length - 1), a[3] ?? kw.hint, opts);
        return null;
      },
      addInputText(_s, a, kw) { add('text', String(a[0]), a[1] === undefined ? '' : String(a[1]), 0, 0, a[2] ?? kw.hint); return null; },
      addInputSurface() { rt.dialog.surface = true; return null; },
      addGroup(_s, a) { group = String(a[0] ?? ''); return null; },
      endGroup() { group = ''; return null; },
      getInputValue(_s, a) { return inputValue(rt, String(a[0])); },
      setNormalizedValue(_s, a) {
        const c = rt.dialog.controls.find((x) => x.name === String(a[0]));
        if (c && c.kind !== 'text') rt.values[c.name] = c.min + (c.max - c.min) * Math.max(0, Math.min(1, numOf(a[1])));
        return null;
      },
    },
  };
  const ScriptDialog = new PyClass('ScriptDialog', [], new Map(), dialogNative);
  flvfx.set('ScriptDialog', ScriptDialog);
  rt.form = new PyObject(ScriptDialog);

  flvfx.set('addOutputController', new PyBuiltin('addOutputController', ([name, def]) => {
    const n = String(name);
    if (!rt.outputs.some((o) => o.name === n)) rt.outputs.push({ name: n, def: numOf(def) });
    return null;
  }));
  flvfx.set('setOutputController', new PyBuiltin('setOutputController', ([name, value]) => {
    const n = String(name);
    const v = numOf(value);
    const c = rt.controllers[n] ?? (rt.controllers[n] = []);
    const last = c[c.length - 1];
    if (!last || last[1] !== v) c.push([rt.tick, v]);
    return null;
  }));

  const ctxCls = new PyClass('context', [], new Map());
  rt.ctxObj = new PyObject(ctxCls);
  rt.ctxObj.attrs.set('ticks', 0);
  rt.ctxObj.attrs.set('PPQ', ctx.ppq);
  rt.ctxObj.attrs.set('tempo', ctx.tempo);
  rt.ctxObj.attrs.set('isPlaying', true);
  rt.ctxObj.attrs.set('voices', rt.active);
  rt.ctxObj.attrs.set('form', rt.form);
  flvfx.set('context', rt.ctxObj);
  return rt;
}

function inputValue(rt: Runtime, name: string): unknown {
  const c = rt.dialog.controls.find((x) => x.name === name);
  if (!c) throw new PyError('KeyError', `no input named '${name}'`);
  const v = rt.values[name] ?? c.def;
  switch (c.kind) {
    case 'knobInt': case 'combo': return Math.round(numOf(v));
    case 'check': return numOf(v) >= 0.5 ? 1 : 0;
    case 'text': return String(v);
    default: return numOf(v);
  }
}

function compileInto(rt: Runtime, src: string): void {
  rt.vm.run(src);
  const cd = rt.vm.getGlobal('createDialog');
  if (cd !== undefined) {
    const form = rt.vm.call(cd, []);
    if (form instanceof PyObject) {
      // the dialog the script built becomes vfx.context.form
      rt.form.attrs = form.attrs;
    }
  }
}

/** Run the script's top level and createDialog(): its UI, outputs and errors. */
export function compileScript(src: string, values: Record<string, number | string> = {}, ctx?: Partial<VfxContext>): Omit<ScriptRun, 'notes' | 'controllers'> {
  let log = '';
  const rt = makeRuntime({ ...values }, { ppq: 96, tempo: 120, random: Math.random, ...ctx }, (s) => { log += s; });
  try {
    compileInto(rt, src);
    return { outputs: rt.outputs, dialog: rt.dialog, log, error: null };
  } catch (e) {
    return { outputs: rt.outputs, dialog: rt.dialog, log, error: e instanceof PyError ? e.text : `InternalError: ${(e as Error).message}` };
  }
}

/**
 * Play notes through a script: FL's handlers are called tick by tick from
 * tick 0 to the end of the last note plus `tail` ticks (one bar by default).
 */
export function runScript(src: string, values: Record<string, number | string>, notes: VfxNote[], ctx: VfxContext & { tail?: number; horizon?: number }): ScriptRun {
  let log = '';
  const rt = makeRuntime({ ...values }, ctx, (s) => { log += s; });
  try {
    compileInto(rt, src);
    const vm = rt.vm;
    const onTrigger = vm.getGlobal('onTriggerVoice'), onRelease = vm.getGlobal('onReleaseVoice'), onTick = vm.getGlobal('onTick');
    const Voice = rt.Voice;
    const lastEnd = notes.reduce((m, n) => Math.max(m, n.pos + n.len), 0);
    const end = ctx.horizon ?? lastEnd + (ctx.tail ?? 4 * ctx.ppq);
    const starts = new Map<number, VfxNote[]>(), ends = new Map<number, PyObject[]>();
    for (const n of notes) { const t = Math.max(0, Math.round(n.pos)); (starts.get(t) ?? starts.set(t, []).get(t)!).push(n); }
    const incoming = new Map<VfxNote, PyObject>();
    for (let t = 0; t <= end; t++) {
      rt.tick = t;
      rt.ctxObj.attrs.set('ticks', t);
      // note-offs first, then note-ons, then the tick
      for (const v of ends.get(t) ?? []) if (onRelease !== undefined) vm.call(onRelease, [v]);
      for (const n of starts.get(t) ?? []) {
        const v = vm.call(Voice, []) as PyObject;
        v.attrs.set('note', n.key);
        v.attrs.set('finePitch', (n.fine - 120) / 100);
        v.attrs.set('velocity', n.vel / 128);
        v.attrs.set('pan', (n.pan - 64) / 64);
        v.attrs.set('length', 0);
        v.attrs.set('output', n.port ?? 0);
        v.attrs.set('fcut', (n.modX - 128) / 128);
        v.attrs.set('fres', (n.modY - 128) / 128);
        v.attrs.set('color', n.color);
        incoming.set(n, v);
        const off = Math.max(t + 1, Math.round(n.pos + n.len));
        (ends.get(off) ?? ends.set(off, []).get(off)!).push(v);
        if (onTrigger !== undefined) vm.call(onTrigger, [v]);
      }
      if (onTick !== undefined) vm.call(onTick, []);
      // pitch tracking and auto-release (length)
      for (const v of [...rt.active]) {
        const meta = rt.voices.get(v)!;
        const p = numOf(v.attrs.get('note'), 60) + numOf(v.attrs.get('finePitch'), 0) - meta.key0;
        const last = meta.pitch[meta.pitch.length - 1];
        if (Math.abs(p) > 1e-9 || last) { if (!last || Math.abs(last[1] - p) > 1e-9) meta.pitch.push([t - meta.start, Math.round(p * 1000) / 1000]); }
        const len = numOf(v.attrs.get('length'), 0);
        if (len > 0 && t + 1 >= meta.start + len) {
          rt.tick = meta.start + Math.round(len);
          voiceNativeRelease(rt, v);
          rt.tick = t;
        }
      }
    }
    for (const v of [...rt.active]) { rt.tick = end; voiceNativeRelease(rt, v); }
    return { notes: rt.done.sort((a, b) => a.pos - b.pos || a.key - b.key), controllers: rt.controllers, outputs: rt.outputs, dialog: rt.dialog, log, error: null };
  } catch (e) {
    return { notes: rt.done, controllers: rt.controllers, outputs: rt.outputs, dialog: rt.dialog, log, error: e instanceof PyError ? e.text : `InternalError: ${(e as Error).message}` };
  }
}

function voiceNativeRelease(rt: Runtime, v: PyObject): void {
  const i = rt.active.indexOf(v);
  if (i < 0) return;
  rt.active.splice(i, 1);
  rt.done.push(voiceToNote(rt, v, rt.tick));
}
