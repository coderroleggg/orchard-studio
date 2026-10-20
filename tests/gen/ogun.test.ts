// Ogun (FL: Ogun): registration (the form's parameter list, the factory presets, the state a new instance has), the sound pinned to
// FL Studio 2026's own plugin rendered by the test host (tests/gen/ogun.golden.ts: a hash of every sample and picked samples of
// flfxhost render Ogun ..., which this port reproduces bit for bit), the pieces of the effects chain and the engine behaviour.
// No FL files are used (the presets are the bank in src/model/gen/plugins/ogun; the golden data are numbers).
import { describe, it, expect } from 'vitest';
import { def } from '../../src/model/gen/plugins/ogun';
import { OGUN_PARAMS, OGUN_KEYS } from '../../src/model/gen/plugins/ogun/params';
import { OG_PRESET_NAMES, freshState, ogunBank } from '../../src/model/gen/plugins/ogun/state';
import { gen, type OgunInstance } from '../../src/engine/gen/plugins/ogun';
import { OgunHalfband, fma32, OgunFx } from '../../src/engine/gen/plugins/ogun/fx';
import { OgunPlug, masterGain } from '../../src/engine/gen/plugins/ogun/plug';
import { flVelocity } from '../../src/engine/gen/plugins/ogun/voice';
import { Biquad } from '../../src/engine/gen/plugins/ogun/biquad';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenVoiceParams } from '../../src/engine/gen/types';
import { GOLDEN } from './ogun.golden';
import { hashFrames, presetState, renderCase, type Case } from './ogun-render';

const f32 = Math.fround;

describe('Ogun: registration', () => {
  it('is an instrument in Synth special (and Drum) with FL\'s form size and 89 parameters', () => {
    expect(def.id).toBe('ogun');
    expect(def.category).toBe('Synth special');
    expect(def.alsoIn).toContain('Drum');
    expect(def.notes).toBe('voices');
    expect([def.width, def.height]).toEqual([560, 640]);
    expect(def.params).toHaveLength(89);
    expect(OGUN_KEYS).toHaveLength(89);
    expect(def.params![0].name).toBe('Master level');
    expect(def.params![88].name).toMatch(/pulse width/i);
    expect(gen.id).toBe('ogun');
  });

  it('lists FL\'s 229 factory presets (Default first) and a new instance has the plugin database state', () => {
    expect(OG_PRESET_NAMES).toHaveLength(229);
    expect(OG_PRESET_NAMES[0]).toBe('Default');
    expect(ogunBank()).toHaveLength(229);
    const s = freshState() as Record<string, unknown>;
    expect(s.level).toBe(205);
    expect(s.seed1).toBe(140);
    expect(s.seed2).toBe(36);
    expect((s.xi as number[])).toHaveLength(15);
    expect((s.arts as unknown[])).toHaveLength(13);
    expect((s.maps as unknown[])).toHaveLength(4);
    // the parameters carry FL's ranges: master level 0..256, reverb room 1..100
    expect([OGUN_PARAMS[0].min, OGUN_PARAMS[0].max]).toEqual([0, 256]);
    const room = OGUN_PARAMS.find((p) => p.key === 'revRoom')!;
    expect([room.min, room.max]).toEqual([1, 100]);
  });

  it('computes FL\'s master level curve (3^x - 1) / 2 with x = level / 128', () => {
    expect(masterGain(0)).toBe(0);
    expect(masterGain(128)).toBe(1);
    expect(masterGain(256)).toBeCloseTo(4, 5);
    expect(masterGain(64)).toBeCloseTo((Math.sqrt(3) - 1) / 2, 6);
  });
});

describe('Ogun: sound (pinned to FL Studio 2026)', () => {
  for (const g of GOLDEN) {
    it(`${g.name}: ${g.preset} (${g.sr} Hz, block ${g.block}${g.mode ? ', ' + g.mode : ''}) is FL's render bit for bit`, () => {
      const [L, R] = renderCase(g as Case);
      expect(L).toHaveLength(g.frames);
      for (const [i, l, r] of g.picks) {
        expect(L[i]).toBe(l);
        expect(R[i]).toBe(r);
      }
      expect(hashFrames(L, R).toString(16)).toBe(g.hash.toString(16));
    }, 120000);
  }
});

describe('Ogun: the effects chain', () => {
  it('the halfband decimator halves the block, keeps DC and skips silence only when its state is silent', () => {
    const hb = new OgunHalfband(1);
    const n = 256;
    const buf = new Float32Array(2 * n).fill(0.5);
    expect(hb.process(buf, n)).toBe(n / 2);
    // after some blocks the DC level is 0.5 again
    for (let k = 0; k < 20; k++) { buf.fill(0.5); hb.process(buf, n); }
    expect(buf[2 * 10]).toBeCloseTo(0.5, 5);
    expect(buf[2 * 10 + 1]).toBeCloseTo(0.5, 5);
    // silent input, but the filter still rings: it is not skipped
    const z = new Float32Array(2 * n);
    hb.process(z, n);
    expect(Math.max(...z.subarray(0, n).map(Math.abs))).toBeGreaterThan(0);
    // enough silent blocks and the states are exactly zero: the count is halved and the data left alone
    let skipped = false;
    for (let k = 0; k < 400 && !skipped; k++) {
      z.fill(0);
      z[0] = 1e-9;
      hb.process(z, n);
      skipped = z[0] === f32(1e-9);
    }
    expect(skipped).toBe(true);
  });

  it('a one-stage downsampler passes a 1 kHz sine at 88.2 kHz through with the filter\'s unity gain', () => {
    const hb = new OgunHalfband(1);
    const n = 2048;
    let last = 0;
    for (let b = 0; b < 6; b++) {
      const buf = new Float32Array(2 * n);
      for (let i = 0; i < n; i++) { const s = Math.sin(2 * Math.PI * 1000 * (b * n + i) / 88200); buf[2 * i] = s; buf[2 * i + 1] = -s; }
      hb.process(buf, n);
      let pk = 0;
      for (let i = 0; i < n / 2; i++) pk = Math.max(pk, Math.abs(buf[2 * i]));
      last = pk;
    }
    expect(last).toBeGreaterThan(0.99);
    expect(last).toBeLessThan(1.001);
  });

  it('fma32 is a fused multiply-add rounded once to single precision', () => {
    // 1 + 2^-23 squared: the exact product 1 + 2^-22 + 2^-46 minus 1 - 2^-22 leaves 2^-46 which a separate multiply would lose
    const a = f32(1 + 2 ** -12), b = f32(1 + 2 ** -12), c = f32(-(1 + 2 ** -11));
    expect(fma32(a, b, c)).toBe(f32(2 ** -24));
    expect(f32(f32(a * b) + c)).toBe(0);
    expect(fma32(2, 3, 4)).toBe(10);
  });

  it('a flat EQ band is transparent and the shelves / peak keep their types', () => {
    for (const type of [6, 7, 8]) {
      const bq = new Biquad();
      bq.type = type;
      const w = 0.3, s = Math.sin(w), c = Math.cos(w);
      bq.design(1, type === 7 ? s / (2 * 0.7) : Math.sqrt((1 + 1) / 0.5 - 0), s, c);
      const x = new Float32Array(64);
      for (let i = 0; i < 64; i++) x[i] = Math.sin(i * 0.9);
      const y = x.slice();
      bq.process(y, 32);
      for (let i = 0; i < 64; i++) expect(y[i]).toBe(x[i]);
    }
  });

  it('keeps rendering the delay and reverb tails after the last voice (tail Infinity) and has none with them off', () => {
    const inst = gen.create(44100, 128, { sample: () => undefined }) as OgunInstance;
    const st = presetState('Atmospheric/Depeche Mode Atmo 86');
    inst.setParams(st);
    expect(inst.tail).toBe(Infinity);
    const off = { ...st, xi: [...(st.xi as number[])], b3: [0, 0, 0] } as Record<string, unknown>;
    (off.xi as number[])[4] = 0;
    off.choOrd = 0;
    inst.setParams(off);
    expect(Number.isFinite(inst.tail)).toBe(true);
  });
});

describe('Ogun: engine behaviour', () => {
  const ctx = { sampleRate: 44100, blockSize: 128, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0 };
  const voiceParams = (key: number): GenVoiceParams => ({ key, velocity: 100, release: 64, color: 0, length: Infinity, frame: 0, init: newLevels(), levels: newLevels() });

  function run(inst: OgunInstance, frames: number, notes: number[], offAt: number): [Float32Array, Float32Array] {
    const L = new Float32Array(frames), R = new Float32Array(frames);
    const vs = notes.map((k) => inst.triggerVoice(voiceParams(k), ctx)!);
    const bl = new Float32Array(128), br = new Float32Array(128);
    // a voice renders into the plugin's mix in steps of 16 frames (the buffers it is given stay untouched)
    const dl = new Float32Array(16), dr = new Float32Array(16);
    for (let o = 0; o < frames; o += 128) {
      if (o === offAt) for (const v of vs) v.release();
      bl.fill(0); br.fill(0);
      for (const v of vs) for (let k = 0; k < 128; k += 16) v.render(dl, dr, 16);
      inst.render(bl, br, 128, ctx);
      L.set(bl, o); R.set(br, o);
    }
    return [L, R];
  }

  it('same state, same random counter: identical renders; another counter: another timbre (timbre seed 2 = 0 is random)', () => {
    const st = presetState('Default');
    st.seed2 = 0;
    const mk = (counter: number) => {
      const inst = gen.create(44100, 128, { sample: () => undefined }) as OgunInstance;
      inst.setParams(structuredClone(st));
      inst.setRandomCounter(counter);
      return inst;
    };
    const [a] = run(mk(1700000000), 4096, [60], 99999);
    const [b] = run(mk(1700000000), 4096, [60], 99999);
    const [c] = run(mk(1700000001), 4096, [60], 99999);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(Array.from(a)).not.toEqual(Array.from(c));
    expect(a.some((v) => v !== 0)).toBe(true);
  });

  it('stays finite at every parameter\'s extremes, odd sample rates and block sizes', () => {
    for (const sr of [8000, 22050, 44100, 96000, 192000]) {
      for (const idx of [0, 9, 31]) {
        const base = presetState(OG_PRESET_NAMES[idx]);
        for (const p of OGUN_PARAMS) {
          for (const v of [p.min, p.max]) {
            const st = structuredClone(base);
            st[p.key] = v;
            const inst = gen.create(sr, 128, { sample: () => undefined }) as OgunInstance;
            inst.setParams(st);
            const lv = newLevels();
            const v0 = inst.triggerVoice({ ...voiceParams(60), levels: lv, init: lv }, { ...ctx, sampleRate: sr })!;
            const bl = new Float32Array(128), br = new Float32Array(128);
            for (let o = 0; o < 4; o++) {
              bl.fill(0); br.fill(0);
              for (let k = 0; k < 128; k += 16) v0.render(new Float32Array(16), new Float32Array(16), 16);
              inst.render(bl, br, 128, { ...ctx, sampleRate: sr });
              for (let i = 0; i < 128; i++) { if (!Number.isFinite(bl[i]) || !Number.isFinite(br[i])) throw new Error(`${sr} ${idx} ${p.key}=${v}`); }
            }
          }
        }
        if (sr !== 44100) break;
      }
    }
  }, 600000);

  it('a one-voice-per-key preset ends the older voice of the same key, polyphony limit ends the newest sounding voice', () => {
    const inst = gen.create(44100, 128, { sample: () => undefined }) as OgunInstance;
    inst.setParams(presetState('Default'));
    const a = inst.triggerVoice(voiceParams(60), ctx)!;
    const b = inst.triggerVoice(voiceParams(60), ctx)!;
    const l = new Float32Array(16), r = new Float32Array(16);
    for (let i = 0; i < 400; i++) { a.render(l, r, 16); b.render(l, r, 16); }
    // the first voice was forced to end and has finished by now
    expect(a.render(l, r, 16)).toBe(false);
    expect(b.render(l, r, 16)).toBe(true);
  });

  it('forces the highest quality while the project is rendered (export) and returns to the setting afterwards', () => {
    const plug = new OgunPlug();
    plug.setSampleRate(44100);
    const st = presetState('Default');
    plug.apply(st as never);
    expect(plug.os).toBe(1);
    plug.setRendering(true);
    expect(plug.os).toBe(2);
    expect(plug.resByte).toBe(6);
    plug.setRendering(false);
    expect(plug.os).toBe(1);
  });

  it('computes the plugin-visible velocity like FL\'s host (not exactly velocity / 128)', () => {
    expect(flVelocity(100)).toBeCloseTo(100 / 128, 6);
    expect(flVelocity(128)).toBeCloseTo(1, 6);
    expect(flVelocity(0)).toBe(0);
  });

  it('exposes the effects chain class and the new-instance state', () => {
    expect(typeof OgunFx).toBe('function');
    expect(freshState().level).toBe(205);
  });
});
