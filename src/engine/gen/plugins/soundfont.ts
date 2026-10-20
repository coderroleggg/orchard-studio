// SoundFont Player (FL: Soundfont Player, Plugin database > Generators > Misc), FL 2026's binary (Soundfont
// Player_x64.dylib, arm64 slice; unit Sobanth) ported: an SF2 synth (./soundfont/synth.ts: voices, envelopes,
// LFOs, filter, banded sinc resampling, modulators, exclusive classes) driven the way FL's plugin drives it: a
// note is a MIDI note on with the FL velocity (1..127), FinalLevels.Vol / Pan / Pitch reach each running voice
// every block, FL's parameters 5..12 override the SF2 generators, the Modulation parameter is CC1. The soundfont
// comes from the sample pool (smpl data as a mono WAV) plus the base64 pdta in the state (see
// model/gen/plugins/soundfont/sf2.ts). See docs/research/gen/soundfont.md.

import type { FxMonitor } from '../../effects/types';
import type { GenContext, GenEnv, GenInstance, GenModule, GenNote } from '../types';
import { G } from '../../../model/gen/plugins/soundfont/gens';
import { currentPreset, fontHydra, presetList, sendLevel, sfState, type SfState } from '../../../model/gen/plugins/soundfont/state';
import { SfSynth } from './soundfont/synth';
import { SfChorus, SfReverb } from './soundfont/fx';
import { OVR_NONE } from './soundfont/voice';

const clampi = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const f32 = Math.fround;
/** FL's denormal guard: every output sample passes (x + 1e-18) - 1e-18 in single precision. */
const GUARD = f32(1.000000045813705e-18);

/** FL's parameters 5..12 -> generator overrides (ProcessParam 0x60780). */
function overrides(p: Record<string, unknown>): Record<number, number> {
  const out: Record<number, number> = {};
  const num = (k: string, d: number): number => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const time = (v: number, scale: number, hi: number): number => {
    if (v === 0) return -12000;
    return clampi(Math.trunc((Math.log(scale * v) / 0.6931471805599453) * 1200), -12000, hi);
  };
  const atk = num('envAtk', -1), dec = num('envDec', -1), sus = num('envSus', -1), rel = num('envRel', -1);
  const ld = num('lfoDelay', -1), la = num('lfoAmt', -128), ls = num('lfoSpeed', -1), cut = num('cutoff', -1);
  out[G.attackVolEnv] = atk === -1 ? OVR_NONE : time(atk, 0.001, 8000);
  out[G.decayVolEnv] = dec === -1 ? OVR_NONE : time(dec, 0.004, 8000);
  out[G.sustainVolEnv] = sus === -1 ? OVR_NONE : sus === 0 ? 1000 : Math.trunc(1000 - Math.pow(Math.fround(sus / 127), 0.2) * 1000);
  out[G.releaseVolEnv] = rel === -1 ? OVR_NONE : time(rel, 0.004, 8000);
  out[G.delayVibLFO] = ld === -1 ? OVR_NONE : time(ld, 0.004, 5000);
  out[G.vibLfoToPitch] = la === -128 ? OVR_NONE : Math.abs(Math.trunc((la * 1000) / 127));
  out[G.freqVibLFO] = ls === -1 ? OVR_NONE : ls === 0 ? -16000 : clampi(Math.trunc((Math.log(0.0102739726027397 * ls) / 0.6931471805599453) * 1200), -16000, 4500);
  out[G.initialFilterFc] = cut === -1 ? OVR_NONE : 1500 + Math.trunc((cut * 12000) / 127);
  return out;
}

class SoundFontPlayer implements GenInstance {
  private readonly synth: SfSynth;
  private readonly chorus: SfChorus;
  private readonly reverb: SfReverb;
  private st: SfState = sfState({});
  private params: Record<string, unknown> = {};
  private fontKey = '';
  private pendingSample = '';
  private readonly held = new Map<number, GenNote>();
  private readonly sr: number;

  constructor(sr: number, private readonly env: GenEnv) {
    this.sr = sr;
    this.synth = new SfSynth(sr);
    this.chorus = new SfChorus(sr);
    this.reverb = new SfReverb(sr);
  }

  /** The voice-end decays; the built-in effects ring on until their silence gate closes (10 s after the last sound). */
  tail = 0.25;

  setParams(raw: unknown): void {
    const p = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    this.params = p;
    const st = sfState(p);
    this.st = st;
    const syn = this.synth;
    syn.setResampling(st.resampling);
    syn.setOptions(st.emu, st.velFc, st.ignoreLinks);
    this.loadFont();
    const ov = overrides(p);
    for (const k of Object.keys(ov)) syn.setOverride(Number(k), ov[Number(k)]);
    const num = (k: string, d: number): number => (typeof p[k] === 'number' ? (p[k] as number) : d);
    syn.setModWheel(clampi(Math.round(num('mod', 0)), 0, 127));
    syn.setSendLevels(st.useRevLevel ? sendLevel(num('revSend', 128)) : -1, st.useChorLevel ? sendLevel(num('chorSend', 128)) : -1);
    this.reverb.enabled = st.revOn;
    this.chorus.enabled = st.chorOn;
    this.tail = st.revOn || st.chorOn ? 10 : 0.25;
    this.selectPreset();
  }

  private loadFont(): void {
    const f = this.st.fonts[this.st.active];
    const key = f ? `${f.sample}|${f.hydra.length}|${f.rate}` : '';
    const hydra = fontHydra(f);
    const rec = f ? this.env.sample(f.sample) : undefined;
    const pcm = rec && rec.channels.length ? rec.channels[0] : null;
    if (f && !pcm) this.pendingSample = f.sample; else this.pendingSample = '';
    const ratio = f && rec && f.rate > 0 ? rec.sampleRate / f.rate : 1;
    this.synth.setFont(hydra, pcm, ratio);
    this.fontKey = key;
  }

  private selectPreset(): void {
    const f = this.st.fonts[this.st.active];
    const h = fontHydra(f);
    // FL's preset list is sorted by bank / program; an unknown patch selects its first entry
    const sel = currentPreset(presetList(h), typeof this.params.patch === 'number' ? this.params.patch : 1, typeof this.params.bank === 'number' ? this.params.bank : 0);
    if (!sel) { this.synth.selectPreset(-1, -1, false); return; }
    const mode = this.st.programMode;
    const drum = mode === 2 ? true : mode === 1 ? false : sel.bank >= 127;
    this.synth.selectPreset(sel.bank, sel.program, drum);
  }

  reset(): void {
    this.synth.killAll();
    this.held.clear();
  }

  allNotesOff(): void {
    this.synth.killAll();
    this.held.clear();
  }

  noteOn(note: GenNote, frameOffset: number): void {
    const levels = note.levels;
    const vel = Math.min(127, Math.round(note.velocity));
    const pitch = levels.pitch / 100 - note.key;
    this.held.set(note.id, note);
    this.synth.noteOn(frameOffset, note.id, note.key, vel, levels.vol, levels.pan, pitch);
  }

  noteOff(note: GenNote, frameOffset: number): void {
    // the note object is reused by the channel after the note off: freeze the levels first
    this.held.delete(note.id);
    this.synth.setNoteLevels(note.id, note.levels.vol, note.levels.pan, note.levels.pitch / 100 - note.key);
    this.synth.noteOff(frameOffset, note.id);
  }

  killNote(note: GenNote): void {
    this.held.delete(note.id);
    this.synth.killNote(Math.max(0, Math.floor(note.frame || 0)), note.id);
  }

  isActive(): boolean {
    return this.synth.activeVoices > 0;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    if (this.pendingSample) {
      // the sample pool delivers the soundfont's audio after the state
      this.loadFont();
      this.selectPreset();
    }
    for (const note of this.held.values()) {
      const lv = note.levels;
      this.synth.setNoteLevels(note.id, lv.vol, lv.pan, lv.pitch / 100 - note.key);
    }
    const syn = this.synth;
    syn.render(L, R, n);
    // built-in effects: the chorus (adds to the output and, by its send, to the reverb bus), then the reverb
    if (this.chorus.enabled) this.chorus.process(syn.chorL, syn.chorR, L, R, syn.revL, syn.revR, n);
    if (this.reverb.enabled) this.reverb.process(syn.revL, syn.revR, L, R, n);
    for (let i = 0; i < n; i++) {
      L[i] = f32(f32(L[i] + GUARD) - GUARD);
      R[i] = f32(f32(R[i] + GUARD) - GUARD);
    }
    // "SEND TO": the buses go to mixer tracks relative to the channel's own
    if (ctx.out) {
      const rt = this.st.revTo, ct = this.st.chorTo;
      if (rt !== 0) ctx.out(clampi(ctx.track + rt, 0, 500), syn.revL, syn.revR, n);
      if (ct !== 0) ctx.out(clampi(ctx.track + ct, 0, 500), syn.chorL, syn.chorR, n);
    }
  }

  monitor(): FxMonitor | null {
    return { voices: this.synth.activeVoices };
  }
}

export const gen: GenModule = {
  id: 'soundfont',
  create(sampleRate, _blockSize, env) {
    return new SoundFontPlayer(sampleRate, env);
  },
};
