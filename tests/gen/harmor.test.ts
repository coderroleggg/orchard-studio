// Harmor: registration, factory presets, value texts and the voice engine's
// exactness against values captured from FL 2026's Harmor (test host dumps).
import { describe, it, expect } from 'vitest';
import { GEN_DEFS } from '../../src/model/gen/registry';
import { gen } from '../../src/engine/gen/plugins/harmor';
import { normalizeHarmor, expandDiff, harmorPart } from '../../src/model/gen/plugins/harmor/state';
import { H_PRESET_NAMES } from '../../src/model/gen/plugins/harmor/presets';
import { HARMOR_PARAMS, PARAM_COUNT, artKey } from '../../src/model/gen/plugins/harmor/params';
import { newLevels } from '../../src/engine/gen/levels';
import type { GenNote, GenInstance } from '../../src/engine/gen/types';

const SR = 44100;
const CTX = { sampleRate: SR, blockSize: 88, tempo: 140, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };

function note(key: number, vel = 100): GenNote {
  const lv = newLevels(); lv.pitch = key * 100; lv.vol = (Math.pow(11, vel / 100) - 1) / 10;
  const init = newLevels(); init.pitch = key * 100; init.vol = lv.vol;
  return { id: 1, key, velocity: vel, release: 64, color: 0, length: Infinity, frame: 0, init, levels: lv } as GenNote;
}

function make(state: Record<string, unknown>, block = 88): GenInstance {
  const inst = gen.create(SR, block, { sample: () => undefined });
  inst.setParams(state);
  return inst;
}

/** FL's Default (constructor) state. */
const defaultState = () => normalizeHarmor({ ...expandDiff({}) }) as Record<string, unknown>;

/* eslint-disable @typescript-eslint/no-explicit-any */
const voices = (inst: GenInstance): any[] => (inst as any).live;

describe('Harmor model', () => {
  it('is registered with 825 parameters and the 325 factory presets', () => {
    const d = GEN_DEFS.find((x) => x.id === 'harmor')!;
    expect(d).toBeTruthy();
    expect(d.notes).toBe('events');
    expect(d.params.length).toBe(PARAM_COUNT);
    expect(HARMOR_PARAMS.length).toBe(825);
    expect(d.presets?.length).toBe(325);
    expect(H_PRESET_NAMES[0]).toBe('Default');
    expect(H_PRESET_NAMES).toContain('Arp/Chip');
  });

  it('takes FL states\' articulator envelope / LFO parameters from the curves', () => {
    const st = normalizeHarmor({ __h: H_PRESET_NAMES.indexOf('Arp/Chip') }) as Record<string, unknown>;
    const a1 = harmorPart(st, 'a').arts[1];
    expect(st[artKey('a', 1, 'att')]).toBe(a1.e.a![0]);
    expect(st[artKey('a', 1, 'dec')]).toBe(a1.e.a![1]);
    expect(st[artKey('a', 1, 'lfoSpd')]).toBe(a1.l.l![0]);
  });
});

describe('Harmor voice engine vs FL 2026', () => {
  it('default patch, key 60: 261.63 Hz saw at FL\'s level', () => {
    const inst = make(defaultState(), 128);
    inst.noteOn!(note(60), 0);
    const n = 44100, L = new Float32Array(n), R = new Float32Array(n);
    const bl = new Float32Array(128), br = new Float32Array(128);
    for (let p = 0; p < n; p += 128) {
      bl.fill(0); br.fill(0);
      inst.render!(bl, br, 128, CTX);
      L.set(bl.subarray(0, Math.min(128, n - p)), p); R.set(br.subarray(0, Math.min(128, n - p)), p);
    }
    let pk = 0, cross = 0;
    for (let i = 0; i < n; i++) { pk = Math.max(pk, Math.abs(L[i])); if (i > 11025 && L[i - 1] < 0 && L[i] >= 0) cross++; }
    expect(Math.abs(pk - 0.913906) / 0.913906).toBeLessThan(0.005); // FL peak 0.913906
    expect(cross).toBeGreaterThanOrEqual(195); // 0.75 s at 261.63 Hz = 196 cycles
    expect(cross).toBeLessThanOrEqual(197);
    for (let i = 0; i < n; i++) expect(L[i]).toBe(R[i]);
  });

  it('sine bank state after the first control block is bit-identical to FL', () => {
    const inst = make(defaultState());
    inst.noteOn!(note(60), 0);
    inst.render!(new Float32Array(88), new Float32Array(88), 88, CTX);
    const v = voices(inst)[0];
    expect(v.sb.count).toBe(80);
    const sb = v.sb;
    // FL dump (block 0, voice 0): lanes 0..7 hold harmonics 1..8
    const FL = {
      amp: [0.23091763257980347, 0.2042560577392578, 0.1816985309123993, 0.16253504157066345, 0.1461857110261917, 0.13217687606811523, 0.12012096494436264, 0.10969977080821991],
      y: [0.10117015242576599, 0.20135657489299774, 0.29947561025619507, 0.3944399058818817, 0.4854007959365845, 0.5713672041893005, 0.6514719724655151, 0.7248995304107666],
      y1: [0.06402446329593658, 0.12784115970134735, 0.19113384187221527, 0.25355786085128784, 0.31498897075653076, 0.3751128613948822, 0.43370071053504944, 0.49051958322525024],
      coef: [1.9986107349395752, 1.994444727897644, 1.9875078201293945, 1.9778099060058594, 1.9653640985488892, 1.9501879215240479, 1.9323023557662964, 1.9117321968078613],
      target: [1.0, 0.5, 0.3333333432674408, 0.25, 0.20000000298023224, 0.1666666716337204, 0.1428571492433548, 0.125],
      smooth: [0.9970208406448364, 0.9940505623817444, 0.9910891652107239, 0.9881365895271301, 0.9851927757263184, 0.9822577834129333, 0.9793314933776855, 0.976413905620575],
    };
    for (const k of Object.keys(FL) as (keyof typeof FL)[]) {
      for (let i = 0; i < 8; i++) expect(sb[k][i], `${k}[${i}]`).toBe(FL[k][i]);
    }
    const phase = [0.26103230006992817, 2.5330969002097845, 3.555161500349641, 2.0220646001398563, 3.0441292002797127, 4.066193800419569, 5.088258400559425];
    for (let i = 1; i < 8; i++) expect(sb.phase[i], `phase[${i}]`).toBe(phase[i - 1]);
  });

  it('unison voices: FL\'s positions, pan and volume compensation', () => {
    const st = defaultState();
    st.a_uniOrder = 4; st.a_uniPitch = 200; st.a_uniPan = 100; st.a_uniPhase = 300;
    const inst = make(st);
    inst.noteOn!(note(60), 0);
    inst.render!(new Float32Array(88), new Float32Array(88), 88, CTX);
    const vs = voices(inst);
    expect(vs.length).toBe(4);
    const FLpos = [0.9572253426799431, -0.2920553410005798, 0.3706124381888181, -1.0357824398681814];
    vs.forEach((v, i) => {
      expect(v.part.uniPos[i]).toBeCloseTo(FLpos[i], 15);
      expect(v.uniVolO).toBe(Math.fround(0.360246479511261));
    });
    expect(vs[0].uniPanO).toBe(Math.fround(-0.5208333134651184));
  });

  it('every factory preset renders finite audio for a chord', () => {
    for (let i = 0; i < H_PRESET_NAMES.length; i += 13) {
      const inst = make(normalizeHarmor({ __h: i }) as Record<string, unknown>, 128);
      const a = note(60), b = { ...note(67), id: 2 } as GenNote;
      inst.noteOn!(a, 0); inst.noteOn!(b, 5);
      const L = new Float32Array(128), R = new Float32Array(128);
      for (let k = 0; k < 20; k++) {
        if (k === 12) { inst.noteOff!(a, 3); inst.noteOff!(b, 7); }
        L.fill(0); R.fill(0);
        inst.render!(L, R, 128, CTX);
        for (let j = 0; j < 128; j++) expect(Number.isFinite(L[j]) && Number.isFinite(R[j]), H_PRESET_NAMES[i]).toBe(true);
      }
    }
  });
});
