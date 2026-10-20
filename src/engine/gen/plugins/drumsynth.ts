// DrumSynth Live (FL: Fruity DrumSynth Live). A port of FL 2026's own code
// (docs/research/gen/drumsynth.md): the wrapper (Fruity DrumSynth Live_x64.dylib:
// TriggerVoice 0x5f3a0, Gen_Render 0x5f800, patch preparation 0x5ffb0) and the
// engine (libDrumSynth_Eng_x64.dylib: TriggerVoice 0x3178, Voice_Render 0x4040,
// Voice_Release 0x3ed4), in their single precision and operation order.
//
// - Each key plays its own patch (key = patch, 0..119). A note prepares the
//   engine's parameters from the patch, morphed toward its "Morph To" patch by
//   the Morph To Modulation curve, and starts an engine voice: osc 1 (a swept
//   sine from a two-pole resonator, or band-passed noise), osc 2 (band-passed
//   noise / sample with attack / decay and ring modulation by osc 1), the
//   generator (FL's 64-bit LCG noise and the waveform samples), the re-trigger
//   envelope, a clip, the tone filter and the level.
// - Voice modes: Mono cuts the patch's previous voices, Group 1..4 cut every
//   voice of the group; cut voices fade with FL's AddWave ramp (at most 0.001
//   of gain per sample at 44.1 kHz) and are then dropped.
// - Each voice goes to the channel's track with FL's pan law (patch pan + note
//   pan, volume = note volume x patch level) and to "Send track number" (relative
//   to the channel's track) with the send level; both through FL's AddWave ramp
//   per block. Velocity reaches the sound twice (engine gain and wrapper volume),
//   as in FL: the level follows the note volume squared.
// - FL's 18 waveform samples are not shipped (FL's engine embeds them): a
//   synthesized substitute plays unless the user imported FL's own from their
//   FL installation (state wavesSample: one pool sample holding FL's data block).

import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import type { FxMonitor } from '../../effects/types';
import { DS_PATCHES, dsKey } from '../../../model/gen/plugins/drumsynth';

const f32 = Math.fround;
const fma = (a: number, b: number, c: number) => f32(a * b + c);
const expf = (x: number) => f32(Math.exp(x));

// ---- FL's constants (single precision as in the engine)
const K127 = f32(0.007873999886214733);
const K001 = f32(0.01);
const K0001 = f32(0.001);
const K2_16 = 1.52587890625e-5;
const LN1000 = f32(6.907770156860352);
const VELK = f32(2.2300000190734863);
const TWO_PI = f32(6.2831854820251465);
const LVLK = f32(6.900000095367432);
const LVLO = f32(-4.699999809265137);
const DECA = 8.15999984741211;
const DECB = -9.21;
const ATTK = f32(8.516900062561035);
const M921 = f32(-9.210000038146973);
const N09 = f32(0.8999999761581421);
const RANDK = f32(0.003599999938160181);
const C004 = f32(0.03999999910593033);
const CM007 = f32(-0.07000000029802322);
const C03 = f32(0.30000001192092896);
const C198 = f32(1.9800000190734863);
const C0999 = f32(0.9990000128746033);
const FLOOR = f32(9.999999747378752e-6);
const ENDLVL = f32(9.999999747378752e-5);
const C001F = f32(0.004999999888241291);
const R0995 = f32(0.9950000047683716);
const REL095 = f32(0.949999988079071);
/** The engine's random generator state at construction (FL derives it from its wave data). */
const RNG_SEED = 0xfff9f854;
/** The engine's Patch Level input: FL's wrapper always sets 45000 (the level is applied by the wrapper). */
const ENGINE_LEVEL = 45000;
/** Most voices one instance plays (FL keeps a list without limit). */
const MAX_VOICES = 256;
const MAX_EVENTS = 256;

/** FL's waveform table: start / end / loop length in samples of FL's data block (22.05 kHz, 16 bit). */
export const DS_WAVE_TABLE: [number, number, number][] = [
  [108557, 130146, 21589], [102915, 108593, 3159], [130195, 151293, 21099], [0, 6030, 16], [6031, 28797, 16], [28798, 61066, 29387],
  [61072, 102885, 27536], [151305, 156375, 16], [156406, 164036, 16], [164036, 168747, 16], [168748, 203026, 16], [203026, 210015, 16],
  [210015, 219280, 16], [219307, 233573, 16], [233573, 248845, 16], [248845, 264536, 16], [264536, 279788, 16], [279788, 293174, 16],
];
/** Samples in FL's data block (int16). */
export const DS_WAVE_FRAMES = 293174;

/**
 * Synthesized substitute for FL's waveform samples: deterministic noise /
 * metallic tones with decays, at FL's sample positions (same lengths and
 * loops), as int16 values like FL's block.
 */
function buildSubstitute(): Int16Array {
  const out = new Int16Array(DS_WAVE_FRAMES + 2);
  let s = 22222;
  const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return (s >>> 8) / 8388608 - 1; };
  // [kind 0 noise / 1 metallic / 2 tone, decay (s), base Hz, brightness]
  const spec: [number, number, number, number][] = [
    [1, 2.0, 540, 0.9], [2, 0.25, 560, 0.4], [1, 2.0, 600, 0.95], [1, 0.08, 7000, 0.98], [1, 0.6, 7000, 0.98], [1, 2.5, 4000, 0.95],
    [1, 3.0, 3200, 0.9], [2, 0.18, 55, 0.2], [0, 0.18, 200, 0.6], [2, 0.05, 1700, 0.7], [1, 0.9, 6500, 0.98], [0, 0.25, 6000, 0.97],
    [2, 0.3, 230, 0.3], [0, 0.3, 300, 0.6], [0, 0.3, 500, 0.7], [0, 0.3, 800, 0.8], [0, 0.3, 1200, 0.85], [0, 0.3, 2000, 0.9],
  ];
  const sr = 22050;
  const ratios = [1, 1.483, 1.932, 2.546, 2.63, 3.897];
  DS_WAVE_TABLE.forEach(([a, b], w) => {
    const [kind, dec, hz, bright] = spec[w];
    let lp = 0;
    const ph = new Float64Array(6);
    for (let i = a; i < b; i++) {
      const t = (i - a) / sr;
      const env = Math.exp(-t / dec);
      let x = 0;
      if (kind === 0) { const n = rnd(); lp += (n - lp) * bright; x = lp; }
      else if (kind === 1) { for (let k = 0; k < 6; k++) { ph[k] += (hz * ratios[k]) / sr; x += ph[k] % 1 < 0.5 ? 0.16 : -0.16; } x = x * 0.7 + rnd() * 0.3 * bright; }
      else { ph[0] += hz * (1 + 0.5 * Math.exp(-t * 40)) / sr; x = Math.sin(2 * Math.PI * ph[0]) + rnd() * 0.05; }
      out[i] = Math.max(-32767, Math.min(32767, Math.round(x * env * 26000)));
    }
  });
  return out;
}
let substitute: Int16Array | null = null;

/** The engine's voice (FL's 0x100-byte voice record; field names after its offsets). */
class DsVoice {
  // wrapper record
  active = false;
  note: GenNote | null = null;
  patch = 0;
  group = 0;
  cut = false;
  /** AddWave ramp state: main L / R, send L / R (-1 = not started). */
  lastL = -1; lastR = -1; lastSL = 0; lastSR = 0;
  // engine record
  counter = 0; retrig = 0; period = 0;
  peak2 = 0; dec2Fin = 0; peak1 = 0; dec1Fin = 0;
  noiseLvl = 0; waveLvl = 0; wpos = 0; wstep = 0; wend = 0; wloop = 0;
  glide = 0; tgt1 = 0; c1 = 0; c1b = 0; q2a = 0; sa = 0; sb = 0; xa = 0; q3a = 0; sc = 0; sd = 0; pa = 0;
  sh0 = 0; sh1 = 0; shPos = 0; shNeg = 0; env1 = 0; dec1 = 0;
  c2a = 0; c2b = 0; q2b = 0; ta = 0; tb = 0; xb = 0; q3b = 0; tc = 0; td = 0; pb = 0;
  env2 = 0; dec2 = 0; tgt2 = 0; att2Inc = 0; att2 = 0; ring = 0;
  lp = 0; toneC = 0; toneMix = 0; gain = 0;
}

class DrumSynth implements GenInstance {
  readonly sampleRate: number;
  private readonly env: GenEnv;
  /** Patch parameters [patch * 38 + local] (FL's integers). */
  private readonly prm = new Int32Array(DS_PATCHES * 38);
  /** Wrapper per-patch gains: LogVol(level / 128), LogVol(send / 128). */
  private readonly lvlGain = new Float32Array(DS_PATCHES);
  private readonly sendGain = new Float32Array(DS_PATCHES);
  /** The engine's parameter array (35 integers) as the wrapper fills it per note. */
  private readonly e = new Int32Array(35);
  private readonly f = new Float32Array(35);
  private rng = RNG_SEED;
  private readonly dt: number;
  private readonly srF: number;
  private waves: Int16Array;
  private wavesId = '';
  private readonly voices: DsVoice[] = [];
  private readonly order: DsVoice[] = [];
  private readonly dead: DsVoice[] = new Array(MAX_VOICES);
  private deadCount = 0;
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly evOn = new Uint8Array(MAX_EVENTS);
  private evCount = 0;
  private readonly buf: Float32Array;
  private readonly sendL: Float32Array;
  private readonly sendR: Float32Array;
  private readonly lr = { l: 0, r: 0 };
  private readonly rampMax: number;

  constructor(sampleRate: number, blockSize: number, env: GenEnv) {
    this.sampleRate = sampleRate;
    this.env = env;
    this.srF = f32(sampleRate);
    this.dt = f32(1 / this.srF);
    this.rampMax = f32(0.001 * (44100 / Math.trunc(sampleRate)));
    this.buf = new Float32Array(Math.max(128, blockSize));
    this.sendL = new Float32Array(Math.max(128, blockSize));
    this.sendR = new Float32Array(Math.max(128, blockSize));
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new DsVoice());
    this.e[0] = 48000; this.e[1] = 32768;
    this.waves = substitute ??= buildSubstitute();
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    for (let p = 0; p < DS_PATCHES; p++) {
      for (let i = 0; i < 38; i++) {
        const v = Number(q[dsKey(p, i)]);
        this.prm[p * 38 + i] = Number.isFinite(v) ? Math.round(v) : this.prm[p * 38 + i];
      }
      this.lvlGain[p] = logVol(this.prm[p * 38]);
      this.sendGain[p] = logVol(this.prm[p * 38 + 35]);
    }
    const id = typeof q.wavesSample === 'string' ? q.wavesSample : '';
    if (id !== this.wavesId) { this.wavesId = id; this.loadWaves(); }
  }

  /** FL's own waveform block, imported by the user (pool sample of FL's int16 data as floats). */
  private loadWaves(): void {
    const smp = this.wavesId ? this.env.sample(this.wavesId) : undefined;
    const ch = smp?.channels[0];
    if (!ch || ch.length < 2) { this.waves = substitute ??= buildSubstitute(); return; }
    const w = new Int16Array(DS_WAVE_FRAMES + 2);
    // exact when the pool kept FL's block as imported; a block the browser resampled is read back linearly
    const r = (ch.length - 1) / (DS_WAVE_FRAMES - 1);
    for (let i = 0; i < DS_WAVE_FRAMES; i++) {
      let x: number;
      if (ch.length === DS_WAVE_FRAMES) x = ch[i];
      else { const t = i * r, k = Math.floor(t), fr = t - k; x = ch[k] + fr * ((ch[k + 1] ?? ch[k]) - ch[k]); }
      w[i] = Math.max(-32768, Math.min(32767, Math.round(x * 32768)));
    }
    this.waves = w;
  }

  // ------------------------------------------------------------ notes
  noteOn(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, 1); }
  noteOff(note: GenNote, frameOffset: number): void { this.queue(note, frameOffset, 0); }

  private queue(note: GenNote, frame: number, on: number): void {
    if (this.evCount >= MAX_EVENTS) return;
    this.evFrame[this.evCount] = frame;
    this.evNote[this.evCount] = note;
    this.evOn[this.evCount++] = on;
  }

  killNote(note: GenNote): void {
    for (let i = 0; i < this.evCount; i++) if (this.evNote[i] === note) this.evNote[i] = null;
    for (let i = this.order.length - 1; i >= 0; i--) if (this.order[i].note === note) this.drop(i);
  }

  isActive(): boolean {
    return this.order.length > 0 || this.evCount > 0;
  }

  /** FL's voice list removal: the last voice takes the removed one's place (render order matters: shared noise generator). */
  private drop(i: number): void {
    const v = this.order[i];
    v.active = false; v.note = null;
    const last = this.order.pop()!;
    if (i < this.order.length) this.order[i] = last;
  }

  /** FL's wrapper (0x5ffb0): the engine parameters of a patch, morphed toward its Morph To patch. */
  private prepare(patch: number): void {
    const e = this.e, P = this.prm, base = patch * 38;
    const to = P[base + 34];
    e[0] = ENGINE_LEVEL;
    if (to > -1 && to !== patch && to < DS_PATCHES) {
      const tb = to * 38;
      let x = f32(P[base + 37] * 0.0078125);
      if (x > 1) x = 1;
      let m = f32(1.6 * x - 0.3);
      if (m > 0.9) m = f32(0.4 * x + 0.6);
      if (m < 0.1) m = f32(0.4 * x);
      for (let i = 2; i <= 33; i++) {
        let v = P[base + i];
        if (i !== 15 && i !== 24) v = rint(f32(v + f32(m * (P[tb + i] - v))));
        if (i === 15 && v === -1) v = 128;
        e[i] = v;
      }
    } else {
      for (let i = 2; i <= 33; i++) {
        if (i === 24) continue;
        let v = P[base + i];
        if (i === 15 && v === -1) v = 128;
        e[i] = v;
      }
    }
    // the engine's float view of its parameters (TriggerVoice's conversion loop)
    const f = this.f;
    for (let i = 0; i < 35; i++) {
      if (i === 15 || i === 18 || i === 22 || i === 24 || i === 32) continue;
      const v = e[i];
      if (i <= 1) f[i] = f32(v * K2_16);
      else if (i === 2 || i === 3 || i === 16 || (i >= 25 && i <= 31) || i === 34) f[i] = f32(v * K001 + 0.5);
      else if (i === 4 || i === 10) f[i] = f32(v * K0001);
      else if (i === 23) f[i] = f32(v * K001);
      else f[i] = f32(v * K127);
    }
  }

  /** FL's decay coefficient: 1 - exp(-dt exp(8.16 - 9.21 x)). */
  private coef(x: number): number {
    return f32(1 - f32(Math.exp(Math.exp(x * DECB + DECA) * -this.dt)));
  }

  /** Engine TriggerVoice (0x3178) for a prepared patch. */
  private start(v: DsVoice, n: GenNote): void {
    const f = this.f, e = this.e, dt = this.dt;
    const key = Math.min(119, Math.max(0, Math.round(n.key)));
    // FL's wrapper rebases the pitch: final pitch - (init pitch - 6000), as integers
    const pitch = Math.round(n.levels.pitch - 6000) - (key * 100 - 6000);
    const noteF = fma(f32(pitch), K001, 60);
    const vel = f32(n.levels.fres + fma(f32(n.init.vol), 2, -1));
    const finalVol = f32(n.levels.vol);
    const ratio = f32(Math.exp(f32(noteF - 60) * 0.0577622650466621));
    v.counter = 0; v.retrig = 0; v.period = 0;
    v.peak2 = 0; v.dec2Fin = 0; v.peak1 = 0; v.dec1Fin = 0; v.wpos = 0; v.wend = 0; v.wloop = 0;
    v.env1 = 0; v.dec1 = f32(0.99); v.dec2 = f32(0.99); v.att2 = 0; v.lp = 0;
    // generator: wave step and levels
    let s0 = f32(f[29] + f[29]);
    s0 = f32(s0 - 1);
    let s2 = f32(vel * 0.5);
    s2 = f32(s2 * s0); s2 = f32(s0 * s2); s0 = f32(s0 * s2);
    const s8w = f32(f32(dt * 22050) * ratio);
    s0 = fma(f[16], f32(1.3862999677658081), s0);
    s0 = f32(s8w * expf(s0));
    if (s0 > 8) s0 = 8;
    v.wstep = Math.trunc(s0 * 4096);
    const w = e[15];
    let nl = 1, wl = 0;
    if (w >= 0 && w <= 17) {
      const t = DS_WAVE_TABLE[w];
      v.wpos = t[0] * 4096; v.wend = t[1] * 4096; v.wloop = t[2] * 4096;
      wl = f32(f[17] * 3);
      nl = f32(f32(1.000100016593933) - f[17]);
    } else v.wstep = 0;
    v.noiseLvl = f32(nl * f32(f32(Math.sqrt(this.srF)) * f32(0.004761899821460247)));
    v.waveLvl = wl;
    // osc 1
    const dt2pi = f32(dt * TWO_PI);
    let s13 = 0;
    if (e[32] !== 0) {
      const s8 = f[5];
      s13 = s8 > 0.5 ? 1 : f32(s8 + s8);
      const s15 = f32(s13 * s13);
      let vt = f32(f32(f[25] - 0.5) * VELK);
      vt = f32(vt * f32(vt * f32(vt * vel)));
      let fr = f32(Math.floor(expf(fma(f[4], LN1000, vt)) * 16));
      fr = f32(ratio * fr);
      if (fr > 16000) fr = 16000;
      const w1 = f32(dt2pi * fr);
      const pc = fma(w1, fma(s15, CM007, C004), f32(s15 * C03));
      let c = fma(f32(w1 * f32(-f32(dt2pi * fr))), pc, w1);
      const lim = f32(C198 - s15);
      if (c > lim) c = lim;
      v.q2a = s15;
      s13 = f32(s13 * s15);
      v.q3a = s13;
      v.c1 = c; v.c1b = 0;
      if (s8 > 0.5) {
        const a = f32(1 - s8);
        const k = fma(f32(a * -4), a, C0999);
        v.c1b = f32(f32(k * -2) * c);
        c = fma(k, c, c);
        v.c1 = c;
      }
      v.tgt1 = c;
    } else {
      v.c1b = 0; v.q2a = 0; v.q3a = 0;
      const f4 = f[4], f5 = f[5];
      const tgtX = f32(f4 * LN1000);
      let s3 = f32(f5 + f5);
      const down = f32(f4 * s3);
      s3 = f32(s3 - 1);
      let st = fma(s3, f32(1 - f4), f4);
      if (f5 < 0.5) st = down;
      let vt = f32(f32(f[25] - 0.5) * VELK);
      vt = f32(vt * f32(vt * f32(vt * vel)));
      const eS = expf(fma(st, LN1000, vt)), eT = expf(tgtX);
      const coefOf = (x: number) => {
        let fr = f32(Math.floor(x * 16));
        fr = f32(fr * ratio);
        if (fr > 16000) fr = 16000;
        const wv = f32(fr * dt2pi);
        const a = f32(C004 * wv);
        return fma(a, f32(wv * f32(-wv)), wv);
      };
      v.tgt1 = coefOf(eT);
      v.c1 = coefOf(eS);
    }
    // osc 2
    {
      const s8 = f[11];
      const s15 = s8 > 0.5 ? 1 : f32(s8 + s8);
      const s12 = f32(s15 * s15);
      const base = fma(f32(n.levels.fcut), 0.5, f[10]);
      let vt = f32(f32(f[27] - 0.5) * VELK);
      vt = f32(vt * f32(vt * f32(vt * vel)));
      let fr = f32(Math.floor(expf(fma(base, LN1000, vt)) * 16));
      fr = f32(ratio * fr);
      if (fr > 16000) fr = 16000;
      const w2 = f32(dt2pi * fr);
      const pc = fma(w2, fma(s12, CM007, C004), f32(s12 * C03));
      let c = fma(f32(w2 * f32(-f32(dt2pi * fr))), pc, w2);
      const lim = f32(C198 - s12);
      if (c > lim) c = lim;
      v.c2b = c; v.q2b = s12; v.q3b = f32(s15 * s12); v.c2a = c;
      if (s8 > 0.5) {
        const a = f32(1 - s8);
        const k = fma(f32(a * -4), a, C0999);
        v.c2b = fma(c, k, c);
        v.c2a = f32(c - c * k);
      }
    }
    // osc 2 level and envelope
    let pk2 = expf(f32(fma(f[14], LVLK, f32(vel * fma(f[28], 3, -1.5))) + LVLO));
    if (f[14] < K001) pk2 = 0;
    v.env2 = pk2;
    const eSh = expf(fma(f[9], 9, -7));
    v.tgt2 = f32(pk2 * f32(-eSh));
    const lg = f32(dt * f32(Math.log(f32(f32(eSh + f32(0.029999999329447746)) / f32(eSh + 1)))));
    const d2 = f32(1 - expf(f32(expf(fma(f[13], M921, f32(6.909999847412109))) * lg)));
    v.dec2 = d2; v.att2 = 0; v.att2Inc = pk2;
    if (f[12] > C001F) v.att2Inc = f32(pk2 / f32(this.srF * expf(fma(f[12], ATTK, M921))));
    // click: the resonators' start state
    let ck = f[23];
    ck = ck > N09 ? f32(((this.rng >>> 8) & 255) * RANDK) : f32(ck * ck);
    const ck3 = fma(f32(ck * ck), ck, -1);
    v.tc = ck; v.td = ck3; v.sc = ck; v.sd = ck3;
    if (e[22] !== 0) { v.q3a = f32(-s13); v.sc = f32(-ck); v.sd = f32(-ck3); }
    v.pb = 0; v.xb = 0; v.ta = 0; v.tb = 0; v.pa = 0; v.xa = 0; v.sa = 0; v.sb = 0;
    // osc 1 level, decay, sweep glide
    let pk1 = expf(f32(fma(f[8], LVLK, f32(vel * fma(f[26], 3, -1.5))) + LVLO));
    if (f[8] < K001) pk1 = 0;
    v.env1 = pk1;
    const d1 = this.coef(f[7]);
    v.dec1 = d1;
    v.glide = this.coef(f[6]);
    // re-trigger envelope
    let cnt = e[18];
    v.retrig = cnt;
    if (cnt < 0) { v.counter = 0; v.retrig = 0; v.period = 0; cnt = -1; }
    else if (cnt > 100) { v.retrig = 100; cnt = 100; }
    else { v.period = 0; v.counter = 0; }
    if (cnt > 0) {
      v.peak2 = pk2; v.dec2Fin = d2; v.peak1 = pk1; v.dec1Fin = d1;
      v.period = Math.trunc(f32(this.srF * expf(fma(f[19], ATTK, M921))));
      v.counter = v.period;
      if (f[20] < R0995) { const c = this.coef(f[20]); v.dec2 = c; v.dec1 = c; }
      else { v.dec2 = 0; v.dec1 = 0; }
    }
    // tone filter
    const t = fma(vel, f32(f[30] - 0.5), f[2]);
    let pos: number;
    if (t > 1) { pos = 0.5; v.toneMix = -1; }
    else {
      v.toneMix = ENDLVL;
      if (t < 0) pos = 0;
      else if (t <= 0.5) pos = t;
      else { pos = f32(t - 0.5); v.toneMix = -1; }
    }
    const d8 = f32(dt * -TWO_PI) * 20;
    v.toneC = f32(1 - f32(Math.exp(d8 * Math.exp(pos * 14))));
    // harmonics: the asymmetric shaper
    let h = fma(vel, f32(f32(f[31] + f[31]) - 1), f32(f32(f[3] + f[3]) - 1));
    if (h < 0) {
      if (h < -1) h = -1;
      const a = f32(h * f32(-6.6666998863220215));
      const s1 = f32(h * a);
      v.shPos = f32(-(h * a)); v.shNeg = s1; v.sh0 = 0; v.sh1 = f32(s1 + 1);
    } else {
      if (h > 1) h = 1;
      const s1 = f32(h * f32(h * f32(4.708000183105469)));
      v.shPos = 0; v.shNeg = s1; v.sh0 = f32(s1 * -0.25); v.sh1 = fma(h, h, 1);
    }
    // output gain (engine part): 2 x final volume x level curve of the fixed 45000
    v.ring = f[33];
    const lv = f[0];
    let g = expf(f32(f32(lv * LVLK) + LVLO));
    if (lv < K001) g = 0;
    v.gain = f32(f32(2 * finalVol) * g);
  }

  /** Engine Voice_Release (0x3ed4) with the patch's (re-prepared) parameters. */
  private releaseVoice(v: DsVoice): void {
    this.prepare(v.patch);
    const e = this.e;
    const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
    const s1 = clamp01(f32(e[7] * K127)), s8 = clamp01(f32(e[13] * K127)), rel = clamp01(f32(e[21] * K127));
    if (v.period >= 1) v.retrig = 0;
    if (!(rel < REL095)) return;
    if (v.env2 > v.att2) v.env2 = v.att2;
    const s9 = fma(rel, 0.5, 0.5);
    const c1 = this.coef(f32(s1 * s9));
    v.dec1 = c1; v.dec1Fin = c1;
    const c2 = this.coef(f32(s8 * s9));
    v.att2Inc = c2; v.dec2 = c2; v.dec2Fin = c2;
  }

  /** Engine Voice_Render (0x4040): n samples of a voice into buf; returns true when finished. */
  private renderVoice(v: DsVoice, buf: Float32Array, n: number): boolean {
    const W = this.waves;
    let rng = this.rng;
    let counter = v.counter;
    for (let i = 0; i < n; i++) {
      counter--;
      if (counter === 0) {
        v.env2 = v.peak2; v.att2 = 0; v.env1 = v.peak1;
        const c = v.retrig;
        v.retrig = c - 1;
        if (c >= 2) counter = v.period;
        else { counter = 0; v.dec2 = v.dec2Fin; v.dec1 = v.dec1Fin; }
      }
      rng = (Math.imul(rng, 0x0bb38435) + 0x3619636b) >>> 0;
      let s3 = f32(v.noiseLvl * f32(intBitsF32(0x40000000 | (rng & 0x7fffff)) - 3));
      if (v.wstep !== 0) {
        let p = v.wpos + v.wstep;
        if (p > v.wend) p -= v.wloop;
        v.wpos = p;
        const k = Math.floor(p / 4096);
        const a = W[k], b = W[k + 1];
        const fr = Math.floor(p / 32) & 127;
        const iv = (b - a) * fr + a * 128;
        s3 = fma(v.waveLvl, f32(intBitsF32(0x40400000 + iv) - 3), s3);
      }
      // osc 1: glide, then the two-pole stages
      const c = fma(v.glide, f32(v.tgt1 - v.c1), v.c1);
      v.c1 = c;
      const q2 = v.q2a;
      let s18 = fma(q2, v.sa, v.sb);
      s18 = f32(s3 + s18);
      const s17 = f32(v.xa + s18);
      const sa = f32(v.sa - c * s17);
      const cb = f32(c + v.c1b);
      const sb = fma(cb, sa, v.sb);
      v.sa = sa; v.sb = sb; v.xa = s3;
      let s5 = fma(q2, v.sc, v.sd);
      s5 = fma(v.q3a, f32(sa + v.pa), s5);
      s5 = f32(v.sc - c * s5);
      v.sd = fma(cb, s5, v.sd);
      v.sc = s5; v.pa = sa;
      // harmonics shaper and osc 1 envelope
      const k = s5 > 0 ? v.shPos : v.shNeg;
      let out = fma(fma(k, s5, v.sh1), s5, v.sh0);
      out = f32(out * v.env1);
      v.env1 = fma(v.dec1, f32(FLOOR - v.env1), v.env1);
      // osc 2
      let e2 = v.env2;
      if (e2 > 0) {
        const q = v.q2b;
        let x = fma(q, v.ta, v.tb);
        x = f32(x + v.xb);
        x = f32(s3 + x);
        const ta = f32(v.ta - v.c2b * x);
        const tb = fma(v.c2a, ta, v.tb);
        v.ta = ta; v.tb = tb; v.xb = s3;
        let y = fma(q, v.tc, v.td);
        y = fma(v.q3b, f32(ta + v.pb), y);
        const tc = f32(v.tc - v.c2b * y);
        v.td = fma(v.c2a, tc, v.td);
        v.tc = tc; v.pb = ta;
        if (e2 > v.att2) { e2 = f32(v.att2 + v.att2Inc); v.att2 = e2; }
        else { e2 = fma(v.dec2, f32(v.tgt2 - e2), e2); v.env2 = e2; }
        const rm = fma(v.ring, f32(s5 - 1), 1);
        out = fma(f32(tc * rm), e2, out);
      }
      if (out > 1) out = 1;
      else if (!(out >= -1)) out = -1;
      const lp = fma(v.toneC, f32(out - v.lp), v.lp);
      v.lp = lp;
      buf[i] = f32(v.gain * fma(v.toneMix, out, lp));
    }
    v.counter = counter;
    this.rng = rng;
    return v.retrig <= 0 && v.env1 < ENDLVL && v.env2 < ENDLVL;
  }

  /** Wrapper TriggerVoice (0x5f3a0). */
  private trigger(n: GenNote): void {
    const patch = Math.round(n.key);
    if (patch < 0 || patch >= DS_PATCHES) return;
    const mode = this.prm[patch * 38 + 24];
    if (mode !== 1) {
      for (const o of this.order) {
        if ((o.group === 0 && o.patch === patch) || (o.group > 1 && o.group === mode)) o.cut = true;
      }
    }
    const v = this.voices.find((x) => !x.active);
    if (!v) return;
    this.prepare(patch);
    v.active = true; v.note = n; v.patch = patch; v.group = mode; v.cut = false;
    v.lastL = -1; v.lastR = -1; v.lastSL = 0; v.lastSR = 0;
    this.start(v, n);
    this.order.push(v);
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (this.wavesId && this.waves === substitute) this.loadWaves();
    let e = 0, i = 0;
    while (i < n) {
      while (e < this.evCount && this.evFrame[e] <= i) {
        const note = this.evNote[e], on = this.evOn[e++];
        if (!note) continue;
        if (on) this.trigger(note);
        else for (const v of this.order) if (v.note === note) this.releaseVoice(v);
      }
      let end = n;
      if (e < this.evCount && this.evFrame[e] < end) end = Math.max(i + 1, this.evFrame[e]);
      this.renderSegment(L, R, i, end - i, ctx);
      i = end;
    }
    this.evCount = 0;
  }

  /** FL's Gen_Render (0x5f800) for one stretch: each voice renders, then mixes to its track and its send. */
  private renderSegment(L: Float32Array, R: Float32Array, off: number, len: number, ctx: GenContext): void {
    const buf = this.buf;
    for (let k = 0; k < this.order.length; k++) {
      const v = this.order[k];
      const finished = this.renderVoice(v, buf, len);
      const base = v.patch * 38;
      let gl = 0, gr = 0;
      const n = v.note;
      if (!v.cut && n) {
        const pan = this.prm[base + 1] + rint(n.levels.pan * 64);
        flLRVol(pan * 0.015625, f32(f32(n.levels.vol) * this.lvlGain[v.patch]), this.lr);
        gl = this.lr.l; gr = this.lr.r;
      }
      // send to "Send track number" (relative to the channel's track)
      const trk = this.prm[base + 36];
      if (trk !== 0 && ctx.out) {
        const s = this.sendGain[v.patch];
        if (v.lastL === -1) { v.lastSL = f32(gl * s); v.lastSR = f32(gr * s); }
        this.sendL.fill(0, 0, len); this.sendR.fill(0, 0, len);
        const st = [v.lastSL, v.lastSR];
        addWaveRamp(buf, this.sendL, this.sendR, 0, len, f32(gl * s), f32(gr * s), st, this.rampMax);
        v.lastSL = st[0]; v.lastSR = st[1];
        const dest = Math.max(0, Math.min(500, ctx.track + trk));
        ctx.out(dest, this.sendL, this.sendR, len);
      }
      if (v.lastL === -1) { v.lastL = gl; v.lastR = gr; }
      const m = [v.lastL, v.lastR];
      addWaveRamp(buf, L, R, off, len, gl, gr, m, this.rampMax);
      v.lastL = m[0]; v.lastR = m[1];
      // FL asks the host to kill the voice; the host calls back after this Gen_Render
      if ((v.cut && v.lastL === 0 && v.lastR === 0) || finished) this.dead[this.deadCount++] = v;
    }
    for (let d = 0; d < this.deadCount; d++) {
      const i = this.order.indexOf(this.dead[d]);
      if (i >= 0) this.drop(i);
    }
    this.deadCount = 0;
  }

  allNotesOff(): void {
    this.evCount = 0;
    while (this.order.length) this.drop(this.order.length - 1);
  }

  private readonly monKeys: number[] = [];
  /** Editor data: the patches that sound (the keyboard lights them; AUTO follows them). */
  monitor(): FxMonitor {
    this.monKeys.length = 0;
    for (const v of this.order) if (!v.cut) this.monKeys.push(v.patch);
    return { keys: this.monKeys.slice() };
  }

  reset(): void {
    this.allNotesOff();
  }
}

/** FL's LogVol for a 0..128 knob: (11^(v/128) - 1) / 10 in single precision (exp in double), exactly 1 at 128. */
function logVol(v: number): number {
  const x = f32(v * 0.0078125);
  if (x === 1) return 1;
  return f32((Math.exp(f32(x * f32(Math.log(11)))) - 1) * f32(0.1));
}

/** Round half to even (frintx). */
function rint(x: number): number {
  const fl = Math.floor(x), d = x - fl;
  return d > 0.5 ? fl + 1 : d < 0.5 ? fl : fl % 2 === 0 ? fl : fl + 1;
}

const bitsI = new Int32Array(1);
const bitsF = new Float32Array(bitsI.buffer);
function intBitsF32(i: number): number {
  bitsI[0] = i;
  return bitsF[0];
}

/** FL's circular pan law in single precision (ComputeLRVol). */
function flLRVol(pan: number, vol: number, out: { l: number; r: number }): void {
  const p = !(pan >= -1) ? -1 : pan > 1 ? 1 : pan;
  const a = f32((f32(p + 1)) * 0.7853981633974483);
  out.l = f32(f32(Math.cos(a)) * vol);
  out.r = f32(f32(Math.sin(a)) * vol);
}

/**
 * FL's AddWave_32FM_32FS_Ramp: mono src into L / R from `off`, the gains ramping
 * from last to target over the stretch, at most `maxStep` per sample.
 */
function addWaveRamp(src: Float32Array, L: Float32Array, R: Float32Array, off: number, len: number, lv: number, rv: number, last: number[], maxStep: number): void {
  if (len <= 0) return;
  const step = (target: number, j: number): [number, number] => {
    const start = last[j];
    let st = f32(target - start);
    if (st === 0) return [start, 0];
    last[j] = target;
    st = f32(st / len);
    if (Math.abs(st) > maxStep) {
      st = st < 0 ? -maxStep : maxStep;
      let e = f32(start + f32(st * len));
      if (Math.abs(e) < 1e-30) { e = 0; st = f32(-start / len); }
      last[j] = e;
    }
    return [start, st];
  };
  const [sl, stl] = step(lv, 0);
  const [sr, str] = step(rv, 1);
  if (stl === 0 && str === 0) {
    if (lv === 0 && rv === 0) return;
    for (let i = 0; i < len; i++) { L[off + i] = f32(L[off + i] + f32(src[i] * lv)); R[off + i] = f32(R[off + i] + f32(src[i] * rv)); }
    return;
  }
  let gl = sl, gr = sr;
  for (let i = 0; i < len; i++) {
    L[off + i] = f32(L[off + i] + src[i] * gl);
    gl += stl;
    R[off + i] = f32(R[off + i] + src[i] * gr);
    gr += str;
  }
}

export const gen: GenModule = {
  id: 'drumsynth',
  create: (sampleRate, blockSize, env) => new DrumSynth(sampleRate, blockSize, env),
};
