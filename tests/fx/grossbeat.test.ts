import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef, formatParam } from '../../src/model/fx/registry';
import {
  gbAttText, gbEval, gbOffsetText, gbPctText, gbRelText, gbShape, gbStepCount, type GbSlot,
} from '../../src/model/fx/plugins/grossbeat';
import { makeCtx, render } from './util';

const SR = 48000;
/** 120 BPM at 48 kHz: 24000 samples per beat. */
const SPB = 24000;

function preset(name: string): Record<string, unknown> {
  const p = fxDef('grossbeat')!.presets!.find((q) => q.name === name);
  if (!p) throw new Error(name);
  return structuredClone(p.params);
}

function ramp(n: number): Float32Array {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = -1 + (2 * i) / n;
  return b;
}

function dc(n: number, v: number): Float32Array {
  return new Float32Array(n).fill(v);
}

function make(params: Record<string, unknown> = {}) {
  const fx = createEffect('grossbeat', SR, 512);
  fx.setParams({ ...defaultFxParams('grossbeat'), ...params });
  fx.reset();
  return fx;
}

/** Momentary (FL's classic bank) without its DC remover, as the measurements used. */
function momentary(extra: Record<string, unknown> = {}): Record<string, unknown> {
  const m = preset('Momentary');
  return { ...m, opt: { ...(m.opt as object), dc: false }, ...extra };
}

describe('Gross Beat', () => {
  it('is registered with FL parameters, ranges and value texts', () => {
    const d = fxDef('grossbeat')!;
    expect(d.name).toBe('Gross Beat');
    expect(d.category).toBe('Misc');
    expect(d.params.map((p) => p.name)).toEqual([
      'Time slot', 'Volume slot', 'Time mix', 'Volume mix', 'Volume smoothing attack', 'Volume smoothing release',
      'Volume envelope tension', 'Hold delay (bar repeat)', 'Time offset (scratching)',
    ]);
    expect(d.params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const p = defaultFxParams('grossbeat');
    expect([p.tslot, p.vslot, p.tmix, p.vmix, p.att, p.rel, p.tns, p.hold, p.offset]).toEqual([0, 0, 256, 256, 1765, 5000, 0, 0, 65536]);
    // value texts read from FL's GetName
    expect(formatParam(d.params[0], 0)).toBe('Slot 1');
    expect(formatParam(d.params[0], 35)).toBe('Slot 36');
    expect(gbPctText(96)).toBe('38%');
    expect(gbPctText(16)).toBe('6%');
    expect(gbPctText(-32)).toBe('-13%');
    expect(gbPctText(-160)).toBe('-63%');
    expect(gbAttText(1765)).toBe('2.00ms');
    expect(gbAttText(1750)).toBe('1.97ms');
    expect(gbAttText(7500)).toBe('104.90ms');
    expect(gbAttText(10000)).toBe('500.00ms');
    expect(gbRelText(5000)).toBe('42.77ms');
    expect(gbRelText(5250)).toBe('50.29ms');
    expect(gbRelText(9750)).toBe('855.77ms');
    expect(gbOffsetText(65536)).toBe('-000:00:000');
    expect(gbOffsetText(0)).toBe('-002:00:000');
    expect(gbOffsetText(2048)).toBe('-001:03:072');
    expect(gbOffsetText(57344)).toBe('-000:01:000');
    expect(gbOffsetText(57345)).toBe('-000:00:096');
    expect(gbOffsetText(57340)).toBe('-000:01:000');
  });

  it('ships FL\'s factory presets with their slot banks', () => {
    const names = fxDef('grossbeat')!.presets!.map((p) => p.name);
    expect(names).toEqual(['Default', 'Flanging', 'Juggling Science', 'Momentary', 'Patterns', 'Pitch shifter', 'Repeater', 'Stutter', 'Turntablist']);
    const m = preset('Momentary');
    const t = m.tslots as GbSlot[], v = m.vslots as GbSlot[];
    expect(t).toHaveLength(36);
    expect(v).toHaveLength(36);
    expect(t[15].name).toBe('Spd Up Rpt');
    expect(t[1].name).toBe('2 Beat Rpt');
    expect(v[35].name).toBe('Mute');
    expect(m.rel).toBe(1640);
    // 2 Beat Rpt: offset 2 beats from beat 2
    expect(gbEval(t[1].pts, 1)).toBe(1);
    expect(gbEval(t[1].pts, 2.5)).toBeCloseTo(0.75, 4);
    // the Default preset is FL's empty bank
    const d = preset('Default');
    expect((d.tslots as GbSlot[]).every((s) => s.name === '' && s.trig === 5 && s.pos === 5)).toBe(true);
  });

  it('uses FL\'s envelope point maths (stepped modes count like FL)', () => {
    // "1/8 Bt Gate" (pulse, tension 0.39) gives 40 pulses a bar in FL
    expect(gbStepCount(0.39)).toBe(39);
    expect(gbStepCount(0.425)).toBe(30); // 1/8 Repeat: 32 stairs
    expect(gbStepCount(0)).toBe(1000);
    expect(gbShape(0, 0.5, -0.5)).toBeCloseTo(0.0307, 4);
    expect(gbShape(0, 0.5, 0.5)).toBeCloseTo(0.9693, 4);
    expect(gbShape(2, 0.7, 0)).toBe(0);
    expect(gbShape(9, 0.5, 0.5)).toBeCloseTo(0.6036, 4);
  });

  it('passes audio through with 15 samples of latency when the slots are empty', () => {
    const fx = make();
    expect(fx.latency).toBe(15);
    const x = ramp(SR);
    const [L] = render(fx, x, x, 512, { tempo: 120 });
    for (const i of [100, 5000, 30000, 47000]) expect(L[i]).toBeCloseTo(x[i - 15], 5);
  });

  it('reads the buffer one beat back for a 1 beat time offset, and mixes linearly (FL measurement)', () => {
    const x = ramp(8 * SR);
    const [a] = render(make({ offset: 57344 }), x, x, 512, { tempo: 120 });
    // FL: silence until the buffer holds a beat, then delay 24015 samples
    expect(a[12000]).toBe(0);
    expect(a[48000]).toBeCloseTo(x[48000 - 24015], 3);
    const [b] = render(make({ offset: 57344, tmix: 128 }), x, x, 512, { tempo: 120 });
    // FL: -0.937328 at 0.501 s on this ramp (half dry, half one beat late)
    expect(b[24048]).toBeCloseTo(0.5 * x[24048 - 15] + 0.5 * x[24048 - 24015], 3);
    expect(b[12000]).toBeCloseTo(0.5 * x[12000 - 15], 3);
  });

  it('repeats the first half of the bar with "2 Beat Rpt" (FL values on a ramp)', () => {
    const x = ramp(8 * SR);
    const [L] = render(make(momentary({ tslot: 1 })), x, x, 512, { tempo: 120 });
    // values FL rendered (8 s ramp, 120 BPM): after the click reduction has settled
    expect(L[6000]).toBeCloseTo(-0.968828, 3);
    expect(L[54000]).toBeCloseTo(-0.968828, 3);
    expect(L[66000]).toBeCloseTo(-0.906328, 3);
    expect(L[102000]).toBeCloseTo(-0.468827, 3);
    expect(L[150000]).toBeCloseTo(-0.468827, 3);
  });

  it('follows the trigger sync of the new slot (Momentary: next 1/4 beat, envelope from its start)', () => {
    const x = ramp(6 * SR);
    const fx = make(momentary({ tslot: 0 }));
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const c = makeCtx({ tempo: 120, ppq: 96, playing: true, pos: 0 });
    const switchAt = Math.round(2.3 * SR);
    for (let i = 0; i < L.length;) {
      let n = Math.min(512, L.length - i);
      if (i < switchAt && i + n > switchAt) n = switchAt - i;
      if (i === switchAt) fx.setParams({ ...defaultFxParams('grossbeat'), ...momentary({ tslot: 1 }) });
      fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, c);
      c.pos += (n / SR) * 2 * 96;
      i += n;
    }
    // FL: the slot starts at beat 4.75, its jump (phase 2) comes at beat 6.75
    const delay = (i: number) => i - ((L[i] + 1) / 2) * x.length;
    expect(delay(Math.round(6.7 * SPB))).toBeCloseTo(15, 0);
    expect(delay(Math.round(7.2 * SPB))).toBeCloseTo(48015, -1);
    expect(delay(Math.round(9.0 * SPB))).toBeCloseTo(15, 0);
  });

  it('switches slots from MIDI notes at their sample, like a click (C5.. time, C2.. volume)', () => {
    const x = ramp(6 * SR);
    const fx = make(momentary({ tslot: 0 }));
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const c = makeCtx({ tempo: 120, ppq: 96, playing: true, pos: 0 });
    const switchAt = Math.round(2.3 * SR);
    let changes: [string, unknown][] | null = null;
    for (let i = 0; i < L.length; i += 512) {
      const n = Math.min(512, L.length - i);
      // key 61 = C#5: time slot 2, delivered inside the block at its offset
      if (switchAt >= i && switchAt < i + n) fx.noteOn?.(61, 100, switchAt - i, 0, 1);
      fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, c);
      c.pos += (n / SR) * 2 * 96;
      changes = fx.takeStateChanges?.() ?? changes;
    }
    // the same as selecting the slot at 2.3 s (FL: the slot starts at beat 4.75, its jump comes at beat 6.75)
    const delay = (i: number) => i - ((L[i] + 1) / 2) * x.length;
    expect(delay(Math.round(6.7 * SPB))).toBeCloseTo(15, 0);
    expect(delay(Math.round(7.2 * SPB))).toBeCloseTo(48015, -1);
    expect(delay(Math.round(9.0 * SPB))).toBeCloseTo(15, 0);
    // mirrored into the Time slot parameter
    expect(changes).toEqual([['tslot', 1]]);
    // volume slots from C2 (24); notes outside both ranges do nothing
    fx.noteOn?.(24 + 5, 100, 0, 0, 1);
    fx.noteOn?.(100, 100, 0, 0, 1);
    fx.process(new Float32Array(512), new Float32Array(512), 512, c);
    expect(fx.takeStateChanges?.()).toEqual([['vslot', 5]]);
    expect(fx.monitor?.()?.vPlay === 5 || fx.monitor?.()?.vPend === 5).toBe(true);
  });

  it('holds a Key-held slot while its key is down, ignores notes with MIDI triggering off', () => {
    const m = momentary({ tslot: 0 });
    const ts = structuredClone(m.tslots) as GbSlot[];
    ts[3] = { ...ts[3], key: true, trig: 0 };
    ts[0] = { ...ts[0], trig: 0 }; // trigger sync off: the switches happen at once
    const fx = make({ ...m, tslots: ts });
    const c = makeCtx({ tempo: 120, ppq: 96, playing: true, pos: 0 });
    const blk = () => { fx.process(new Float32Array(512), new Float32Array(512), 512, c); c.pos += (512 / SR) * 2 * 96; };
    blk();
    fx.noteOn?.(63, 100, 10, 0, 1); // time slot 4, trigger sync off: at once
    blk();
    expect(fx.monitor?.()?.tPlay).toBe(3);
    fx.noteOff?.(63, 20, 0, 1);
    blk();
    expect(fx.monitor?.()?.tPlay).toBe(0);
    expect(fx.takeStateChanges?.()).toEqual([['tslot', 0]]);
    const off = make({ ...m, opt: { ...(m.opt as object), midi: false } });
    off.noteOn?.(61, 100, 0, 0, 1);
    off.process(new Float32Array(512), new Float32Array(512), 512, c);
    expect(off.takeStateChanges?.() ?? null).toBeNull();
  });

  it('gates with the volume envelope through FL\'s two-pole smoother', () => {
    const x = dc(4 * SR, 0.5);
    // att = rel = 0: hard 1/2 beat gate, edges exactly at the 1/4 beat
    const [h] = render(make(momentary({ vslot: 3, att: 0, rel: 0 })), x, x, 512, { tempo: 120 });
    expect(h[5999]).toBeCloseTo(0.5, 5);
    expect(h[6000]).toBeCloseTo(0, 5);
    expect(h[12000]).toBeCloseTo(0.5, 5);
    // Momentary's 2.00 ms attack / 3.54 ms release, values FL rendered (normalised to the 0.5 input)
    const [s] = render(make(momentary({ vslot: 3 })), x, x, 512, { tempo: 120 });
    expect(s[6020] / 0.5).toBeCloseTo(0.8005, 2);
    expect(s[6060] / 0.5).toBeCloseTo(0.3185, 2);
    expect(s[12020] / 0.5).toBeCloseTo(0.4290, 2);
    expect(s[12060] / 0.5).toBeCloseTo(0.9208, 2);
    // 104.9 ms / 209.8 ms
    const [l] = render(make(momentary({ vslot: 3, att: 7500, rel: 7500 })), x, x, 512, { tempo: 120 });
    expect(l[7000] / 0.5).toBeCloseTo(0.8622, 2);
    expect(l[12000] / 0.5).toBeCloseTo(0.1007, 2);
    expect(l[14000] / 0.5).toBeCloseTo(0.7422, 2);
  });

  it('bends the volume envelope with the tension knob and mixes it linearly', () => {
    const x = dc(4 * SR, 0.5);
    // Fade In (linear 0..1) at 2 beats: 0.5 -> 0.9694 at +100%, 0.0306 at -100% (FL)
    const [up] = render(make(momentary({ vslot: 32, att: 0, rel: 0, tns: 256 })), x, x, 512, { tempo: 120 });
    expect(up[2 * SPB] / 0.5).toBeCloseTo(0.9694, 3);
    const [dn] = render(make(momentary({ vslot: 32, att: 0, rel: 0, tns: -256 })), x, x, 512, { tempo: 120 });
    expect(dn[2 * SPB] / 0.5).toBeCloseTo(0.0306, 3);
    // volume mix 50%: the closed gate leaves half the level
    const [mx] = render(make(momentary({ vslot: 3, att: 0, rel: 0, vmix: 128 })), x, x, 512, { tempo: 120 });
    expect(mx[9000] / 0.5).toBeCloseTo(0.5, 2);
    // the volume envelope also applies with time mix 0%
    const [t0] = render(make(momentary({ vslot: 3, att: 0, rel: 0, tmix: 0 })), x, x, 512, { tempo: 120 });
    expect(t0[9000]).toBeCloseTo(0, 4);
  });

  it('reduces clicks at jumps by a decaying difference (FL: 5.4 ms Low, 7.6 ms High)', () => {
    // DC +0.5 then -0.5 from 2.5 s: at 3 s "2 Beat Rpt" jumps from -0.5 back to +0.5
    const x = new Float32Array(4 * SR);
    x.fill(0.5, 0, 2.5 * SR);
    x.fill(-0.5, 2.5 * SR);
    const run = (declick: number) => {
      const m = momentary({ tslot: 1 });
      m.opt = { ...(m.opt as object), hq: false, declick };
      return render(make(m), x, x, 512, { tempo: 120 })[0];
    };
    const off = run(0), low = run(1), high = run(2);
    const j = 3 * SR;
    expect(off[j + 5]).toBeCloseTo(0.5, 3);
    // FL: -0.1787 / +0.2854 at 100 / 400 samples (Low), -0.2582 / +0.1669 (High)
    expect(low[j + 100]).toBeCloseTo(-0.1787, 2);
    expect(low[j + 400]).toBeCloseTo(0.2854, 2);
    expect(high[j + 100]).toBeCloseTo(-0.2582, 2);
    expect(high[j + 400]).toBeCloseTo(0.1669, 2);
  });

  it('repeats the previous bar from the next bar line while HOLD is on (FL: offset 4, 8, 12 beats)', () => {
    const x = ramp(12 * SR);
    const fx = make();
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const c = makeCtx({ tempo: 120, ppq: 96, playing: true, pos: 0 });
    for (let i = 0; i < L.length; i += 512) {
      const n = Math.min(512, L.length - i);
      const t = i / SR;
      fx.setParams({ ...defaultFxParams('grossbeat'), hold: t >= 2.3 && t < 9.5 ? 1 : 0 });
      fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, c);
      c.pos += (n / SR) * 2 * 96;
    }
    const delayBeats = (beat: number) => {
      const i = Math.round(beat * SPB);
      return (i - ((L[i] + 1) / 2) * x.length) / SPB;
    };
    expect(delayBeats(6)).toBeCloseTo(0, 2);
    expect(delayBeats(10)).toBeCloseTo(4, 2);
    expect(delayBeats(14)).toBeCloseTo(8, 2);
    expect(delayBeats(18)).toBeCloseTo(12, 2);
    expect(delayBeats(22)).toBeCloseTo(0, 2);
  });

  it('smooths the scratch offset with three poles (FL: 50% of a beat after 3200 samples)', () => {
    const x = ramp(3 * SR);
    const fx = make();
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const c = makeCtx({ tempo: 120, ppq: 96, playing: true, pos: 0 });
    for (let i = 0; i < L.length; i += 512) {
      const n = Math.min(512, L.length - i);
      fx.setParams({ ...defaultFxParams('grossbeat'), offset: i >= SR ? 57344 : 65536 });
      fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, c);
      c.pos += (n / SR) * 2 * 96;
    }
    const delay = (i: number) => i - ((L[i] + 1) / 2) * x.length;
    expect(delay(SR + 3200) / 24000).toBeGreaterThan(0.45);
    expect(delay(SR + 3200) / 24000).toBeLessThan(0.56);
    expect(delay(SR + 12800)).toBeCloseTo(24015, -2);
  });

  it('keeps its buffer across a loop jump but forgets it when playback starts', () => {
    const fx = make({ offset: 57344 }); // 1 beat late
    const x = ramp(2 * SR);
    const L = Float32Array.from(x), R = Float32Array.from(x);
    const c = makeCtx({ tempo: 120, ppq: 96, playing: true, pos: 0 });
    for (let i = 0; i < L.length; i += 512) {
      const n = Math.min(512, L.length - i);
      if (i === SR) c.pos = 0; // loop back to the song start after a second
      fx.process(L.subarray(i, i + n), R.subarray(i, i + n), n, c);
      c.pos += (n / SR) * 2 * 96;
    }
    // right after the loop the output is the audio of one beat earlier, not silence
    expect(L[SR + 6000]).toBeCloseTo(x[SR + 6000 - 24015], 2);
    // stop, then start again: the past is silence
    fx.process(new Float32Array(512), new Float32Array(512), 512, makeCtx({ playing: false }));
    const y = ramp(512);
    const a = Float32Array.from(y), b = Float32Array.from(y);
    fx.process(a, b, 512, makeCtx({ tempo: 120, playing: true, pos: 0 }));
    expect(Math.abs(a[400])).toBeLessThan(0.05);
  });

  it('passes audio through while the transport is stopped', () => {
    const x = ramp(SR);
    const [L] = render(make(momentary({ tslot: 20, vslot: 35 })), x, x, 512, { tempo: 120, playing: false });
    for (const i of [1000, 20000, 40000]) expect(L[i]).toBeCloseTo(x[i - 15], 4);
  });

  it('ramps mix changes (no zipper) and keeps silence silent', () => {
    const fx = make({ offset: 57344 });
    const x = ramp(SR);
    render(fx, x, x, 512, { tempo: 120 });
    fx.setParams({ ...defaultFxParams('grossbeat'), offset: 57344, tmix: 0 });
    const y = ramp(512);
    const L = Float32Array.from(y), R = Float32Array.from(y);
    const before = new Float32Array(L);
    fx.process(L, R, 512, makeCtx({ tempo: 120, pos: (SR / SR) * 2 * 96 }));
    // the first samples still carry most of the wet signal
    expect(Math.abs(L[1] - before[1])).toBeGreaterThan(0.01);
    const s = make(momentary({ tslot: 5, vslot: 8 }));
    const z = new Float32Array(2 * SR);
    const [o] = render(s, z, z, 512, { tempo: 120 });
    expect(o.every((v) => v === 0)).toBe(true);
  });

  it('stays finite at extreme settings and with odd input', () => {
    const banks = ['Turntablist', 'Pitch shifter', 'Juggling Science', 'Patterns', 'Stutter'];
    for (const name of banks) {
      for (const tslot of [3, 17, 33]) {
        const p: Record<string, unknown> = { ...preset(name), tslot, vslot: tslot, att: 10000, rel: 0, tns: -256, offset: 0, hold: 1 };
        (p.opt as Record<string, unknown>).dc = true;
        const fx = make(p);
        const x = new Float32Array(SR);
        for (let i = 0; i < x.length; i++) x[i] = Math.sin(i * 0.01) * (i % 977 === 0 ? 40 : 1);
        x[5000] = NaN;
        const [L, R] = render(fx, x, x, 300, { tempo: 199 });
        for (let i = 0; i < L.length; i++) expect(Number.isFinite(L[i]) && Number.isFinite(R[i])).toBe(true);
      }
    }
    // garbage state
    const fx = createEffect('grossbeat', SR, 128);
    fx.setParams({ tslots: [{ pts: [{ x: 'a', y: NaN, m: 99 }] }, null], vslots: 5, tslot: 1e9, tmix: -5, opt: null });
    const [L] = render(fx, ramp(4800), ramp(4800), 128, { tempo: 0, ppq: 0 });
    expect(L.every((v) => Number.isFinite(v))).toBe(true);
  });

  it('bounds its tail to two bars at the current tempo', () => {
    const fx = make();
    render(fx, ramp(4800), ramp(4800), 512, { tempo: 120 });
    expect(fx.tail).toBeGreaterThan(4);
    expect(fx.tail).toBeLessThan(5);
    render(fx, ramp(4800), ramp(4800), 512, { tempo: 20 });
    expect(fx.tail).toBeLessThanOrEqual(12.5);
  });
});
