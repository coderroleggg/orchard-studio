// Morphine (FL: Morphine): FL's additive morphing synthesizer, an 'events'
// instrument like FL's own (TriggerVoice / Voice_Release / Gen_Render: one FL
// voice per key, the plugin keeps its own 32 voices, polyphony, mono / glide,
// and mixes them with its effects chain and master gain). The DSP
// (./morphine/*) is a port of FL 2026's Morphine_x64.dylib; this module feeds
// it notes at their sample, the per-key FL levels, the parameters, the program
// structure and the pool samples holding imported FL content.
// See src/model/gen/plugins/morphine.ts and .flref/morphine/NOTES.md.

import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import { AFTERTOUCH, CC0, MOR_KEYS, N_PROG, PROG_DEFAULTS, fOf } from '../../../model/gen/plugins/morphine/params';
import { defaultProgram, normalizeMorphine } from '../../../model/gen/plugins/morphine/state';
import type { RowSource } from '../../../model/gen/plugins/morphine/mrp';
import { compileProgram, makeNoise, type CNoise, type CProgram } from './morphine/program';
import { MorSynth } from './morphine/synth';
import { setExactFma } from './morphine/osc';

const MAX_EVENTS = 256;
/**
 * Master Level (raw) of FL's constructor program, the first factory program (BAS Acoustic 1 FG): a new FL instance
 * snaps its master gain to it, and the state loaded next glides from there.
 */
const CTOR_LEVEL = 126.72000122070312;
const STRUCT = ['gens', 'morph', 'envs', 'mod', 'spectraSample', 'spectraMissing', 'noiseSample', 'noiseRate', 'noiseLoop', 'nzLoop', 'nzFlt'] as const;

export class MorphineInstance implements GenInstance {
  readonly synth: MorSynth;
  private readonly env: GenEnv;
  private readonly f = new Float32Array(N_PROG);
  private readonly changed = new Uint8Array(N_PROG);
  /** Pool buffers the compiled program uses (samples can arrive after the state: re-pushed, compared by identity). */
  private spectraBuf: Float32Array | null = null;
  private noiseBuf: Float32Array | null = null;
  private readonly ccv = new Int32Array(129).fill(-1);
  private readonly prev: Record<string, unknown> = {};
  private poly = -1;
  private glideMode = -1;
  private noiseKey = '';
  private noise: CNoise | null = null;
  /** FL voices: the note holding each key (TriggerVoice uses the key as the voice handle). */
  private readonly fl: (GenNote | null)[] = new Array(128).fill(null);
  private readonly evKind = new Int8Array(MAX_EVENTS);
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evNote: (GenNote | null)[] = new Array(MAX_EVENTS).fill(null);
  private nEv = 0;
  private bufL: Float32Array;
  private bufR: Float32Array;
  tail = 0;

  constructor(sr: number, blockSize: number, env: GenEnv, init?: Record<string, unknown>) {
    this.env = env;
    this.bufL = new Float32Array(Math.max(blockSize, 512));
    this.bufR = new Float32Array(Math.max(blockSize, 512));
    const st = normalizeMorphine(init ?? defaultProgram());
    this.readParams(st);
    const prog = this.compile(st);
    if (init) this.synth = new MorSynth(sr, prog, this.f);
    else {
      const f0 = this.f[0];
      this.f[0] = fOf(CTOR_LEVEL);
      this.synth = new MorSynth(sr, prog, this.f);
      this.f[0] = f0;
      this.synth.paramChanged(0);
    }
    this.poly = prog.poly;
    this.glideMode = prog.glideMode;
    this.readCC(st, true);
    for (const k of STRUCT) this.prev[k] = st[k];
  }

  private readParams(st: Record<string, unknown>): void {
    for (let i = 0; i < N_PROG; i++) {
      const v = st[MOR_KEYS[i]];
      const x = typeof v === 'number' && Number.isFinite(v) ? fOf(v) : PROG_DEFAULTS[i];
      this.changed[i] = x !== this.f[i] ? 1 : 0;
      this.f[i] = x;
    }
  }

  private poolBuf(id: unknown): Float32Array | null {
    return (typeof id === 'string' && id ? this.env.sample(id)?.channels[0] : null) ?? null;
  }

  /** MIDI CC 0..127 / aftertouch parameters: forwarded as int(f * 127) when they change (FL never saves them). */
  private readCC(st: Record<string, unknown>, init = false): void {
    for (let k = 0; k <= 128; k++) {
      const v = st[MOR_KEYS[CC0 + k]];
      const x = typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(127, Math.trunc(Math.fround(fOf(v) * 127)))) : 0;
      if (x === this.ccv[k]) continue;
      this.ccv[k] = x;
      if (init && x === 0) continue;
      if (CC0 + k === AFTERTOUCH) this.synth.setAftertouch(x);
      else if (k !== 7 && k !== 10 && k !== 32) this.synth.setCC(k, x);
    }
  }

  private rows(st: Record<string, unknown>): RowSource {
    const data = this.poolBuf(st.spectraSample);
    this.spectraBuf = data;
    if (!data) return null;
    return (r: number) => (r >= 0 && (r + 1) * 128 <= data.length ? data.subarray(r * 128, r * 128 + 128) : null);
  }

  private compile(st: Record<string, unknown>): CProgram {
    const id = typeof st.noiseSample === 'string' ? st.noiseSample : '';
    const key = `${id}|${st.noiseRate ?? ''}|${JSON.stringify(st.noiseLoop ?? null)}`;
    const buf = this.poolBuf(id);
    if (key !== this.noiseKey || buf !== this.noiseBuf) {
      this.noiseKey = key;
      this.noiseBuf = buf;
      this.noise = null;
      const smp = id ? this.env.sample(id) : undefined;
      if (smp && smp.channels.length) {
        const rate = typeof st.noiseRate === 'number' ? st.noiseRate : smp.sampleRate;
        const loop = Array.isArray(st.noiseLoop) ? (st.noiseLoop as [number, number]) : null;
        this.noise = makeNoise(smp.channels, rate, loop);
      }
    }
    return compileProgram(st, this.rows(st), this.noise);
  }

  setParams(p: unknown): void {
    const st = (p ?? {}) as Record<string, unknown>;
    this.readParams(st);
    let structural = this.poolBuf(st.spectraSample) !== this.spectraBuf || this.poolBuf(st.noiseSample) !== this.noiseBuf;
    for (const k of STRUCT) if (st[k] !== this.prev[k]) structural = true;
    // a new program (FL: Synth_LoadProgramData re-applies every parameter: delay / reverb tails reset)
    const load = st.gens !== this.prev.gens && st.envs !== this.prev.envs && st.morph !== this.prev.morph;
    if (structural) {
      const prog = this.compile(normalizeMorphine(st));
      this.synth.setProgram(prog);
      for (const k of STRUCT) this.prev[k] = st[k];
    }
    for (let i = 0; i < N_PROG; i++) if (this.changed[i] || (load && i >= 6 && i <= 29)) this.synth.paramChanged(i);
    const poly = Number(st.poly ?? 31) | 0, gm = Number(st.glideMode ?? 0) | 0;
    if (poly !== this.poly) { this.poly = poly; this.synth.setPoly(poly); }
    if (gm !== this.glideMode) { this.glideMode = gm; this.synth.setGlideMode(gm); }
    this.readCC(st);
  }

  reset(): void {
    this.synth.killAll();
    this.fl.fill(null);
    this.nEv = 0;
    this.synth.fx.reset();
  }

  noteOn(note: GenNote, frameOffset: number): void { this.push(0, note, frameOffset); }
  noteOff(note: GenNote, frameOffset: number): void { this.push(1, note, frameOffset); }

  /** Voice_Kill: the synth gets a note off (its voice releases), the FL voice is gone. */
  killNote(note: GenNote): void {
    const k = this.keyOf(note);
    if (this.fl[k] !== note) return;
    this.fl[k] = null;
    this.synth.noteOff(k);
  }

  /**
   * FL renders the plugin all the time; the channel may stop rendering only while nothing the plugin holds can
   * change: no events or voices, every effect off (their tails, LFOs and the drive glide run like FL's) and the
   * master gain settled.
   */
  isActive(): boolean {
    return this.nEv > 0 || this.synth.active() || this.synth.fx.active() || this.synth.gainMoving();
  }

  setMaxPoly(n: number): void { this.synth.setMaxPoly(n); }

  allNotesOff(): void {
    this.synth.killAll();
    this.fl.fill(null);
    this.nEv = 0;
  }

  private keyOf(note: GenNote): number {
    const k = note.key | 0;
    return k < 0 ? 0 : k > 127 ? 127 : k;
  }

  private push(kind: number, note: GenNote, frame: number): void {
    if (this.nEv >= MAX_EVENTS) return;
    const n = this.nEv++;
    let at = n;
    while (at > 0 && this.evFrame[at - 1] > frame) at--;
    if (kind === 1) {
      // at the same sample a note off goes before other notes' note ons, as in FL (it matters for mono / "Held" glide),
      // whatever order the channel's voice slots send them in; never before its own note on
      let j = at;
      while (j > 0 && this.evFrame[j - 1] === frame && this.evNote[j - 1] !== note) j--;
      while (j < at && this.evKind[j] !== 0) j++;
      at = j;
    }
    for (let i = n; i > at; i--) {
      this.evKind[i] = this.evKind[i - 1]; this.evFrame[i] = this.evFrame[i - 1]; this.evNote[i] = this.evNote[i - 1];
    }
    this.evKind[at] = kind; this.evFrame[at] = frame; this.evNote[at] = note;
  }

  /** TriggerVoice 0x69704 / Voice_Release 0x69814. */
  private event(i: number): void {
    const note = this.evNote[i]!;
    const k = this.keyOf(note);
    if (this.evKind[i] === 0) {
      if (this.fl[k] && this.fl[k] !== note) this.synth.noteOff(k);
      this.fl[k] = note;
      this.synth.noteOn(k, MorSynth.midiVelocity(note.init.vol));
    } else if (this.fl[k] === note) {
      this.synth.noteOff(k);
    }
  }

  /** Gen_Render 0x68940: L / R and pitch offset of every key, propagated from the keys holding FL voices. */
  private levels(): void {
    const s = this.synth, c = s.ctx;
    let first = -1, last = -1;
    for (let k = 0; k < 128; k++) {
      const n = this.fl[k];
      if (n) {
        s.setKeyLevels(k, n.levels.pan, n.levels.vol, n.levels.pitch - 6000);
        if (first < 0) {
          first = k;
          for (let j = 0; j < k; j++) { c.levL[j] = c.levL[k]; c.levR[j] = c.levR[k]; c.levPitch[j] = c.levPitch[k]; }
        }
        last = k;
      } else if (last >= 0) {
        c.levL[k] = c.levL[last]; c.levR[k] = c.levR[last]; c.levPitch[k] = c.levPitch[last];
      }
    }
  }

  /** After Gen_Render: FL voices whose key has no synth voice left and got its note off are killed (0x696ac). */
  private killDone(): void {
    const c = this.synth.ctx;
    for (let k = 0; k < 128; k++) if (this.fl[k] && c.keyVoices[k] === 0 && this.synth.keyVel[k] === 0) this.fl[k] = null;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    this.synth.ctx.tempo = ctx.tempo;
    // bit-exact FMA ties for export and direct renders; the cheaper path only in live playback
    setExactFma(ctx.rendering !== false);
    if (this.bufL.length < n) { this.bufL = new Float32Array(n); this.bufR = new Float32Array(n); }
    let pos = 0, e = 0;
    while (pos < n) {
      while (e < this.nEv && this.evFrame[e] <= pos) this.event(e++);
      let end = n;
      if (e < this.nEv && this.evFrame[e] < end) end = this.evFrame[e];
      if (end > pos) this.block(L, R, pos, end - pos);
      pos = end;
    }
    while (e < this.nEv) this.event(e++);
    for (let i = 0; i < this.nEv; i++) this.evNote[i] = null;
    this.nEv = 0;
  }

  private block(L: Float32Array, R: Float32Array, off: number, n: number): void {
    this.levels();
    const bl = this.bufL, br = this.bufR;
    bl.fill(0, 0, n);
    br.fill(0, 0, n);
    this.synth.render(bl, br, 0, n);
    for (let i = 0; i < n; i++) { L[off + i] += bl[i]; R[off + i] += br[i]; }
    this.killDone();
  }

  monitor() {
    let v = 0;
    for (const x of this.synth.voices) if (x.key >= 0) v++;
    return { voices: v };
  }
}

export const gen: GenModule = {
  id: 'morphine',
  create: (sr, bs, env) => new MorphineInstance(sr, bs, env),
};
