// Kepler / Kepler Exo plugin core: FL's plugin layer around the shared synth engine (FL wrapper + "MyPlugin"):
// - notes: every note is a voice of FL's wrapper keyed by (colour, key); a note on a key and colour that
//   already sounds first releases the old one (with the new note's velocity); key = trunc(Init.Pitch / 100),
//   velocity = trunc(127 ln(10 Init.Vol + 1) / ln 21); right after a note starts the wrapper sends the note's
//   InitLevels as expressions (pan, Mod X, Mod Y) and, at the start of every block, the FinalLevels that
//   changed (Mod X, Mod Y, pitch cents beyond the key, pan); release velocity = trunc(127 RelVelocity);
// - the channel volume / pan reach the engine as FPE_MIDI_Vol (an integer 0..127) / FPE_MIDI_Pan events;
// - parameters: the engine's normalised floats ((v - Min) / (Max - Min)); the smoother glides most of them
//   (0.2 s), a state load applies them at once;
// - time: the engine runs on the song position in beats while the transport plays and free-runs at the
//   tempo otherwise;
// - the plugin keeps processing one second after its output falls below 1e-6.

import type { GenContext, GenEnv, GenInstance, GenNote } from '../../types';
import { flFinalPitch } from '../../levels';
import { KeplerEngine } from './engine';
import { kpUnpackTables } from './fltables';
import {
  KEPLER_ENGINE_ID, KEPLER_PARAM_KEYS, KEPLER_DEFAULT_ROW, KEPLER_OPTION_DEFAULT, keplerEngineValue, keplerOptionEngineValues,
  type KeplerOptions,
} from '../../../../model/gen/plugins/kepler/data';
import {
  KEPLEREXO_PARAM_KEYS, KEPLEREXO_DEFAULT_ROW, KEPLEREXO_OPTION_DEFAULT, keplerExoEngineValue, keplerExoDefaultMatrix,
  keplerExoNormalizeMatrix, type KeplerExoOptions,
} from '../../../../model/gen/plugins/keplerexo/data';

const f32 = Math.fround;
const NSLOT = 64;

interface Voice { key: number; color: number; ref: GenNote | null; fcut: number; fres: number; pitch: number; pan: number }

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : typeof v === 'number' && Number.isFinite(v) ? v !== 0 : d);

export class KeplerPlugin implements GenInstance {
  readonly sr: number;
  readonly exo: boolean;
  readonly engine: KeplerEngine;
  /** Last state received. */
  state: Record<string, unknown> | null = null;
  /** Engine values (by engine id) the state last asked for: change detection for the smoother. */
  private readonly want = new Float32Array(260).fill(NaN);
  private opts: Record<string, boolean> = {};
  private voices: Voice[] = [];
  private tailLeft = 0;
  private chanVol127 = 127;
  private chanPan = 0;
  private lastMidiVol = -1;
  private lastMidiPan = NaN;
  private midiKnown = false;
  private settled = false;
  /** samples the engine has run since it was created */
  private rendered = 0;
  // song time: beats (engine 0x1418) and seconds (0x1420)
  private beats = 0;
  private seconds = 0;
  private lastPos = -1;
  private readonly out = new Float32Array(2);

  // events of the next render() call
  private readonly evFrame = new Int32Array(NSLOT);
  private readonly evOn = new Uint8Array(NSLOT);
  private readonly evKey = new Int32Array(NSLOT);
  private readonly evColor = new Int32Array(NSLOT);
  private readonly evVel = new Int32Array(NSLOT);
  private readonly evRel = new Int32Array(NSLOT);
  private readonly evNote: (GenNote | null)[] = new Array(NSLOT).fill(null);
  private evCount = 0;

  private readonly env: GenEnv | undefined;
  /** pool sample holding the user's FL tables (state key flTablesSample) and whether it is applied */
  private tablesId = '';
  private tablesApplied = false;
  private tablesPoll = 0;

  constructor(sampleRate: number, _blockSize: number, exo: boolean, env?: GenEnv) {
    this.sr = sampleRate;
    this.exo = exo;
    this.env = env;
    this.engine = new KeplerEngine(sampleRate, exo);
    this.tailLeft = sampleRate;
  }

  // ---------------------------------------------------------------- state
  setParams(raw: unknown): void {
    const st = (raw ?? {}) as Record<string, unknown>;
    const first = this.state === null;
    this.state = st;
    const e = this.engine;
    const tid = typeof st.flTablesSample === 'string' ? st.flTablesSample : '';
    if (tid !== this.tablesId) { this.tablesId = tid; this.tablesApplied = false; this.applyTables(); }
    // collect the engine values the state stands for
    const vals: [number, number][] = [];
    if (this.exo) {
      for (let i = 0; i < KEPLEREXO_PARAM_KEYS.length; i++) {
        vals.push([i, keplerExoEngineValue(i, num(st[KEPLEREXO_PARAM_KEYS[i]], KEPLEREXO_DEFAULT_ROW[i]))]);
      }
    } else {
      for (let i = 0; i < KEPLER_PARAM_KEYS.length; i++) {
        vals.push([KEPLER_ENGINE_ID[i], keplerEngineValue(i, num(st[KEPLER_PARAM_KEYS[i]], KEPLER_DEFAULT_ROW[i]))]);
      }
      const o = this.keplerOptions(st);
      const ov = keplerOptionEngineValues(o);
      vals.push([73, ov.velocityToVolume], [11, ov.subOscPhase], [70, ov.chorusNoise], [71, ov.chorusNoiseGate]);
      e.arpQuantize = o.arpQuantize;
      this.setHq(o.hq);
    }
    if (this.exo) {
      const o = this.exoOptions(st);
      e.arpQuantize = o.arpQuantize;
      // Options > Enhanced Oscillators: FL's JunoOscEx pair instead of the classic oscillators (junoex.ts)
      e.enhOsc = o.enhancedOscillators;
      this.setHq(o.hq);
    }
    // apply: the first state and a wholesale change (a preset) at once, single changes through the smoother
    let changed = 0;
    for (const [id, v] of vals) if (this.want[id] !== f32(v)) changed++;
    const direct = first || changed > 4 || !this.isActive();
    // FL sends every parameter when a state is loaded, and the Mono switch's handler is the engine's reset (the voices are
    // released, the delay line and the reverb emptied): a preset loaded over a playing instrument runs it even with Mono unchanged
    const resetOnLoad = this.exo && !first && changed > 4 && this.isActive();
    for (const [id, v] of vals) {
      const w = f32(v);
      if (this.want[id] === w && !(resetOnLoad && id === 75)) continue;
      this.want[id] = w;
      if (direct) e.setParameterNow(id, w); else e.setParameter(id, w);
    }
    // FL's loader sets the parameters first and the modulation matrix after them: a destination that is routed now
    // has received its plain value already and gets the modulated one at the next control tick
    if (this.exo) {
      const m = keplerExoNormalizeMatrix(st.modMatrix ?? keplerExoDefaultMatrix());
      e.setModMatrix(m.src, m.dst);
    }
  }

  /** FL's LFO sine and noise loop from the pool sample the user imported (the stand-ins when none). */
  private applyTables(): void {
    if (this.tablesApplied) return;
    if (!this.tablesId) { this.engine.setTables(null); this.tablesApplied = true; return; }
    const s = this.env?.sample(this.tablesId);
    const t = s ? kpUnpackTables(s.channels[0]) : null;
    if (t) { this.engine.setTables(t); this.tablesApplied = true; }
  }

  private keplerOptions(st: Record<string, unknown>): KeplerOptions {
    const d = KEPLER_OPTION_DEFAULT;
    return {
      arpQuantize: bool(st.arpQuantize, d.arpQuantize), velocityToVolume: bool(st.velocityToVolume, d.velocityToVolume),
      alignSubPhase: bool(st.alignSubPhase, d.alignSubPhase), chorusNoiseGate: bool(st.chorusNoiseGate, d.chorusNoiseGate),
      chorusNoise: bool(st.chorusNoise, d.chorusNoise), hq: bool(st.hq, d.hq),
    };
  }

  private exoOptions(st: Record<string, unknown>): KeplerExoOptions {
    const d = KEPLEREXO_OPTION_DEFAULT;
    return {
      arpQuantize: bool(st.arpQuantize, d.arpQuantize), hq: bool(st.hq, d.hq),
      enhancedOscillators: bool(st.enhancedOscillators, d.enhancedOscillators),
    };
  }

  private setHq(on: boolean): void {
    const os = on ? 4 : 2;
    if (this.engine.os !== os) this.engine.setOversampling(os);
  }

  // ---------------------------------------------------------------- notes
  private midiVel(note: GenNote): number {
    const v = f32(f32(Math.log(f32(f32(note.init.vol * 10) + 1))) / f32(3.044522523880005)) * 127;
    return Math.trunc(v < 0 ? 0 : Math.min(v, 127));
  }

  private queue(on: boolean, note: GenNote, frame: number): void {
    if (this.evCount >= NSLOT) this.flushEvents(Infinity);
    const k = this.evCount++;
    this.evFrame[k] = Math.max(0, frame | 0);
    this.evOn[k] = on ? 1 : 0;
    this.evKey[k] = Math.max(0, Math.min(127, Math.trunc(note.init.pitch / 100)));
    this.evColor[k] = note.color | 0;
    this.evVel[k] = on ? this.midiVel(note) : 0;
    this.evRel[k] = on ? 0 : Math.trunc(Math.max(0, Math.min(1, f32(note.release / 128))) * 127);
    this.evNote[k] = note;
  }

  /** Apply the queued events up to (and including) frame `upTo`, in order. */
  private flushEvents(upTo: number): void {
    let w = 0;
    for (let k = 0; k < this.evCount; k++) {
      if (this.evFrame[k] > upTo) {
        this.evFrame[w] = this.evFrame[k]; this.evOn[w] = this.evOn[k]; this.evKey[w] = this.evKey[k];
        this.evColor[w] = this.evColor[k]; this.evVel[w] = this.evVel[k]; this.evRel[w] = this.evRel[k]; this.evNote[w] = this.evNote[k];
        w++;
        continue;
      }
      const key = this.evKey[k], color = this.evColor[k], note = this.evNote[k];
      if (this.evOn[k]) {
        const vel = this.evVel[k];
        // a note on the same key and colour first releases the old one (with the new velocity)
        for (let i = 0; i < this.voices.length; i++) {
          const v = this.voices[i];
          if (v.key === key && v.color === color) { this.engine.hostNoteOff(key, vel); this.voices.splice(i, 1); break; }
        }
        // FL's engine has been running since it was created: its master gain smoother has long converged (unless audio has run for a while already)
        if (!this.settled) { this.settled = true; if (this.rendered < this.sr * 0.2) this.engine.settleGains(); }
        this.engine.hostNoteOn(key, vel);
        if (note) {
          this.engine.noteExpr(key, 4, note.init.pan);
          this.engine.noteExpr(key, 1, note.init.fcut);
          this.engine.noteExpr(key, 2, note.init.fres);
        }
        this.voices.push({ key, color, ref: note, fcut: -10000, fres: -10000, pitch: -10000, pan: -10000 });
        this.tailLeft = this.sr;
      } else {
        const i = this.voices.findIndex((v) => v.ref === note);
        if (i >= 0) {
          const v = this.voices[i];
          this.voices.splice(i, 1);
          this.engine.hostNoteOff(v.key, this.evRel[k]);
        }
      }
      this.evNote[k] = null;
    }
    this.evCount = w;
  }

  noteOn(note: GenNote, frameOffset: number): void {
    this.queue(true, note, frameOffset);
    this.tailLeft = this.sr;
  }

  noteOff(note: GenNote, frameOffset: number): void {
    this.queue(false, note, frameOffset);
  }

  killNote(note: GenNote): void { this.queue(false, note, 0); }

  allNotesOff(): void {
    this.evCount = 0;
    for (const v of this.voices) this.engine.hostNoteOff(v.key, 64);
    this.voices.length = 0;
  }

  /** The voices' FinalLevels (FL's wrapper, every block; only what changed). */
  private expressions(): void {
    const e = this.engine;
    let setMidi = false;
    let panKnown = false;
    for (const v of this.voices) {
      const l = v.ref?.levels;
      if (!l) continue;
      if (l.fcut !== v.fcut) { v.fcut = l.fcut; e.noteExpr(v.key, 1, f32(l.fcut)); }
      if (l.fres !== v.fres) { v.fres = l.fres; e.noteExpr(v.key, 2, f32(l.fres)); }
      const cents = f32(f32(flFinalPitch(l)) - f32((v.key - 60) * 100));
      if (cents !== v.pitch) { v.pitch = cents; e.noteExpr(v.key, 3, cents); }
      if (l.pan !== v.pan) { v.pan = l.pan; e.noteExpr(v.key, 4, f32(l.pan)); }
      if (v.ref) {
        // the channel's volume as FPE_MIDI_Vol (knob / 100), its panning as FPE_MIDI_Pan (FinalLevels.Pan is the note's plus the channel's,
        // clamped: a clamped voice cannot tell the channel part, so the last known value stays)
        if (!setMidi) {
          setMidi = true;
          const vol = l.vol > 0 ? Math.floor(128 * (Math.log(10 * l.vol + 1) / Math.log(11)) + 1e-6) : 0;
          this.chanVol127 = Math.min(127, Math.max(0, vol));
        }
        if (!panKnown && l.pan > -1 && l.pan < 1) {
          panKnown = true;
          this.chanPan = Math.max(-1, Math.min(1, l.pan - v.ref.init.pan));
        }
      }
    }
    const pan64 = Math.max(-64, Math.min(64, Math.trunc(this.chanPan * 64)));
    if (setMidi && (this.chanVol127 !== this.lastMidiVol || pan64 !== this.lastMidiPan)) {
      this.lastMidiVol = this.chanVol127; this.lastMidiPan = pan64;
      // FL sends the channel's volume when the channel is set up, long before a note: the first value found here (or one found
      // after the plugin went idle) takes effect at once, later changes glide as the engine's smoother does
      const jump = !this.midiKnown || this.tailLeft <= 0;
      this.midiKnown = true;
      e.setMidiVolumePan(f32(this.chanVol127 / 127), f32(f32(f32(pan64 / 64) + 1) * 0.5), jump);
    }
  }

  // ---------------------------------------------------------------- render
  isActive(): boolean {
    return this.tailLeft > 0 || this.voices.length > 0 || this.evCount > 0;
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    const e = this.engine;
    const sr = this.sr;
    if (!this.tablesApplied && (this.tablesPoll -= n) <= 0) { this.tablesPoll = 4096; this.applyTables(); }
    // song time: the host's position in samples gives the beats and (through FL's millisecond round trip) the seconds
    const bps = ctx.tempo > 0 ? ctx.tempo / 60 / sr : 0;
    if (ctx.playing) {
      const spt = ctx.tempo > 0 && ctx.ppq > 0 ? (sr * 60) / (ctx.tempo * ctx.ppq) : 0;
      const samples = Math.round(ctx.pos * spt);
      const b = (samples * ctx.tempo) / (60 * sr);
      if (b < this.beats) e.timeJumped(b);
      this.beats = b;
      // the wrapper asks for the milliseconds with the beats still in the TFPTime record, which the test host adds as an offset in
      // samples, and turns them into samples at 44.1 kHz whatever the rate is (the engine divides the count by its own rate)
      this.seconds = Math.trunc(((((samples + b) * 1000) / sr) / 1000) * 44100) / sr;
    }
    e.playing = ctx.playing;
    e.delay.setTempo(ctx.tempo);
    this.expressions();
    const out = this.out;
    let peak = 0;
    const secInc = 1 / sr;
    for (let i = 0; i < n; i++) {
      if (this.evCount) { this.flushEvents(i); this.expressions(); }
      e.tick(this.beats, this.seconds, out);
      this.beats += bps;
      this.seconds += secInc;
      const a = out[0], b = out[1];
      L[i] += a; R[i] += b;
      const m = Math.max(Math.abs(a), Math.abs(b));
      if (m > peak) peak = m;
    }
    this.rendered += n;
    if (peak < f32(9.999999974752427e-07)) this.tailLeft = Math.max(0, this.tailLeft - n);
    else this.tailLeft = sr;
  }

  takeStateChanges(): [string, unknown][] | null { return null; }

  monitor() { return null; }

  reset(): void {
    this.engine.reset();
    this.voices.length = 0;
    this.evCount = 0;
    this.lastMidiVol = -1;
  }

  tail = 0;
}
