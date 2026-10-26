// Mixer: master + insert tracks, each with 10 effect slots, pan / stereo
// separation, volume fader, mute, and routing (sends) to other tracks.

import type { MixerTrack, FxSlot } from '../model/types';
import { faderToGain, mixerPanMatrix, eqFreqHz, eqWidthQ } from '../model/scales';
import { SvfCoefs, SvfMode, SvfState } from './dsp/svf';
import { createEffect, type EffectInstance, type FxContext, type FxEnv, type FxMonitor } from './effects';
import type { PortNote } from './MidiOut';
import type { MonitorMode, RecPickup, TrackInput } from '../model/recording';

export const FX_SLOTS = 10;

/** Stereo delay line used for plugin delay compensation. */
class DelayLine {
  private bufL: Float32Array;
  private bufR: Float32Array;
  private w = 0;
  constructor(size: number) {
    this.bufL = new Float32Array(size);
    this.bufR = new Float32Array(size);
  }
  get size(): number { return this.bufL.length; }
  /** Write n samples and add the signal delayed by d samples (x gain) into outL/outR. */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, n: number, d: number, gain: number): void {
    const N = this.bufL.length;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      this.bufL[w] = inL[i];
      this.bufR[w] = inR[i];
      let r = w - d;
      if (r < 0) r += N;
      outL[i] += this.bufL[r] * gain;
      outR[i] += this.bufR[r] * gain;
      w = w + 1 === N ? 0 : w + 1;
    }
    this.w = w;
  }
}

class Smoothed {
  value: number;
  target: number;
  constructor(v: number) { this.value = v; this.target = v; }
}

interface SlotRuntime {
  id: string;
  plugin: string;
  fx: EffectInstance;
  enabled: boolean;
  mix: number;
  /** MIDI input port (FxSlot.midiPort; -1 = none). */
  midiPort: number;
  /** Ports the slot listens on (input port + the plugin's own), when the plugin takes notes. */
  ports: number[];
  /** This block's note events for the slot (delivered right before it processes). */
  pending: PortNote[];
  /** Note events were missed (slot bypassed): bring the plugin up to date before it runs again. */
  stale: boolean;
  /** Per port: velocity of the notes the plugin was told are held (0 = off), and their channels. */
  held: Map<number, { vel: Float32Array; chan: Uint8Array }>;
  /** Number of notes the plugin was told are held (keeps an idle track running). */
  heldCount: number;
}

/** Held notes per MIDI port, as the note events so far say. */
interface PortState {
  vel: Float32Array;
  chan: Uint8Array;
}

function newSlotRuntime(id: string, plugin: string, fx: EffectInstance, enabled: boolean, mix: number, midiPort: number): SlotRuntime {
  return { id, plugin, fx, enabled, mix, midiPort, ports: [], pending: [], stale: false, held: new Map(), heldCount: 0 };
}

const EMPTY_PORTS: number[] = [];

/**
 * A sidechain input of a track. As in FL, every track routed into this one
 * is a sidechain input (numbered in source track order) carrying the
 * source's full output, whatever the send level ("Sidechain to this track"
 * routes with the level at zero).
 */
interface SidechainIn {
  source: number;
  L: Float32Array;
  R: Float32Array;
}

/** Blocks of silence after which an idle track stops processing (~0.5 s at 128 frames). */
const IDLE_BLOCKS = 200;
/**
 * Seconds a track runs after one of its effects is created, input or not. FL
 * processes plugins all the time, so a new instance's start-up glides
 * (smoothers moving from constructor values) finish in silence; without this
 * they would play over the first audio the idle-skipping mixer sends it.
 */
const SETTLE_SECONDS = 1;

/**
 * Recording taps (engine/Recording.ts): where in the track's signal flow a
 * recorded track hands its audio to the recorder. EXT is the audio input
 * itself, MIX the track input (channels, routes and the input) before the FX
 * slots, FX after the slots, EQ after the built-in EQ, LVL after volume and
 * panning (mute not applied), POST the track's final output.
 */
export const TAP_EXT = 1;
export const TAP_MIX = 2;
export const TAP_FX = 3;
export const TAP_EQ = 4;
export const TAP_LVL = 5;
export const TAP_POST = 6;
const TAP_OF: Record<RecPickup, number> = { ext: TAP_EXT, mix: TAP_MIX, fx: TAP_FX, eq: TAP_EQ, lvl: TAP_LVL, post: TAP_POST };
export type TapFn = (L: Float32Array, R: Float32Array, n: number) => void;

export class TrackRuntime {
  readonly index: number;
  readonly inL: Float32Array;
  readonly inR: Float32Array;
  /** Channel-rack input bus (delayed by the track's PDC arrival latency). */
  readonly chL: Float32Array;
  readonly chR: Float32Array;
  hasInput = false;
  hasChannelInput = false;
  // ---- audio input and recording (docs/recording.md)
  /** The audio device channels feeding this track (null: no input). */
  input: TrackInput | null = null;
  armed = false;
  pickup: RecPickup = 'ext';
  monitor: MonitorMode = 'armed';
  /** An Edison on the track is armed to record: it hears the input whatever the monitoring mode. */
  edisonArmed = false;
  /** This block's external input (stereo; a mono input is on both sides). */
  readonly extL: Float32Array;
  readonly extR: Float32Array;
  /** The external input flows into the track this block. */
  extMonitored = false;
  /** Recording tap (null: the track is not being recorded) and where it taps. */
  tap: TapFn | null = null;
  tapAt = 0;
  /** A slot of this track received note events this block. */
  noteWake = false;
  /** Notes the track's plugins were told are held (a held note keeps the track running). */
  heldNotes = 0;
  silentBlocks = 1000;
  /** Blocks still to run regardless of input (a new effect settling, see SETTLE_SECONDS). */
  wakeBlocks = 0;
  enabled = true;
  polarity = false;
  swapLR = false;
  // per-block smoothed parameters
  private vol = new Smoothed(1);
  private mute = new Smoothed(1);
  private pan = new Float64Array([1, 0, 0, 1]); // current matrix
  private panT = new Float64Array([1, 0, 0, 1]); // target matrix
  private sep = new Smoothed(0); // FL separation knob: +1 merged .. -1 separated
  slots: (SlotRuntime | null)[] = new Array(FX_SLOTS).fill(null);
  fxEnabled = true;
  private eqOn = [false, false, false];
  private eqCoefs = [new SvfCoefs(), new SvfCoefs(), new SvfCoefs()];
  private eqL = [new SvfState(), new SvfState(), new SvfState()];
  private eqR = [new SvfState(), new SvfState(), new SvfState()];
  sends: { target: number; gain: number }[] = [];
  /** Sidechain inputs (in source order) and whether any carried audio this block. */
  sidechainIn: SidechainIn[] = [];
  /** Blocks of silent input after which processing stops (longest effect tail). */
  idleBlocks = IDLE_BLOCKS;
  peakL = 0;
  peakR = 0;
  // scratch for dry/wet
  private dryL: Float32Array;
  private dryR: Float32Array;

  /** The mixer that owns the track (note delivery). */
  mixer: MixerEngine | null = null;

  constructor(index: number, blockSize: number) {
    this.index = index;
    this.inL = new Float32Array(blockSize);
    this.inR = new Float32Array(blockSize);
    this.chL = new Float32Array(blockSize);
    this.chR = new Float32Array(blockSize);
    this.dryL = new Float32Array(blockSize);
    this.dryR = new Float32Array(blockSize);
    this.extL = new Float32Array(blockSize);
    this.extR = new Float32Array(blockSize);
  }

  /** Does the audio input play through the track? ("Monitor external input": Off / When armed / On.) */
  monitored(): boolean {
    if (!this.input) return false;
    return this.monitor === 'on' || (this.monitor === 'armed' && (this.armed || this.edisonArmed));
  }

  /** Everything except the effect slots (used by automation every block). */
  applyLevels(tr: MixerTrack, sampleRate: number): void {
    this.enabled = tr.enabled;
    this.polarity = tr.polarity;
    this.swapLR = tr.swapLR;
    this.vol.target = faderToGain(tr.volume);
    this.mute.target = tr.enabled ? 1 : 0;
    mixerPanMatrix(tr.pan, this.panT);
    this.sep.target = tr.stereoSep;
    this.fxEnabled = tr.fxEnabled !== false;
    const modes = [SvfMode.LowShelf, SvfMode.Bell, SvfMode.HighShelf];
    (tr.eq ?? []).forEach((b, i) => {
      if (i > 2) return;
      const on = Math.abs(b.gain) > 0.005;
      if (on && !this.eqOn[i]) { this.eqL[i].reset(); this.eqR[i].reset(); }
      this.eqOn[i] = on;
      if (on) this.eqCoefs[i].set(modes[i], eqFreqHz(b.freq), Math.min(eqWidthQ(b.width), i === 1 ? 40 : 2), b.gain, sampleRate);
    });
    for (const snd of this.sends) {
      const lv = tr.sends[snd.target];
      if (lv !== undefined) snd.gain = faderToGain(lv);
    }
  }

  apply(tr: MixerTrack, sampleRate: number, blockSize: number, env?: FxEnv): void {
    this.enabled = tr.enabled;
    this.polarity = tr.polarity;
    this.swapLR = tr.swapLR;
    this.vol.target = faderToGain(tr.volume);
    this.mute.target = tr.enabled ? 1 : 0;
    mixerPanMatrix(tr.pan, this.panT);
    this.sep.target = tr.stereoSep;
    this.fxEnabled = tr.fxEnabled !== false;
    const modes = [SvfMode.LowShelf, SvfMode.Bell, SvfMode.HighShelf];
    (tr.eq ?? []).forEach((b, i) => {
      if (i > 2) return;
      const on = Math.abs(b.gain) > 0.005;
      if (on && !this.eqOn[i]) { this.eqL[i].reset(); this.eqR[i].reset(); }
      this.eqOn[i] = on;
      if (on) this.eqCoefs[i].set(modes[i], eqFreqHz(b.freq), Math.min(eqWidthQ(b.width), i === 1 ? 40 : 2), b.gain, sampleRate);
    });
    // effect slots
    for (let i = 0; i < FX_SLOTS; i++) {
      const s: FxSlot | null = tr.slots[i] ?? null;
      const cur = this.slots[i];
      if (!s) { this.slots[i] = null; continue; }
      const port = typeof s.midiPort === 'number' && s.midiPort >= 0 ? Math.min(255, Math.round(s.midiPort)) : -1;
      if (!cur || cur.id !== s.id || cur.plugin !== s.plugin) {
        const fx = createEffect(s.plugin, sampleRate, blockSize, env);
        fx.setMidiPort?.(port);
        fx.setParams(s.params);
        this.slots[i] = newSlotRuntime(s.id, s.plugin, fx, s.enabled, s.mix, port);
        this.wakeBlocks = Math.max(this.wakeBlocks, Math.ceil((SETTLE_SECONDS * sampleRate) / blockSize));
      } else {
        if (cur.midiPort !== port) { cur.midiPort = port; cur.fx.setMidiPort?.(port); }
        cur.fx.setParams(s.params);
        cur.enabled = s.enabled;
        cur.mix = s.mix;
      }
    }
    this.input = tr.input ? { ch: tr.input.ch, mono: !!tr.input.mono } : null;
    this.armed = !!tr.armed;
    this.pickup = tr.pickup ?? 'ext';
    this.monitor = tr.monitor ?? 'armed';
    this.edisonArmed = false;
    for (const s of tr.slots) {
      // Edison on the track, armed to record (its Record parameter): the input flows into the track so it hears it
      if (s && s.plugin === 'edison' && s.enabled && Number((s.params as Record<string, unknown>).rec) >= 0.5) this.edisonArmed = true;
    }
    this.heldNotes = 0;
    for (const s of this.slots) if (s) this.heldNotes += s.heldCount;
    this.sends = [];
    for (const k of Object.keys(tr.sends)) {
      const target = Number(k);
      if (target === this.index) continue;
      this.sends.push({ target, gain: faderToGain(tr.sends[target]) });
    }
    this.updateTail(sampleRate, blockSize);
  }

  /** Idle cut-off from the longest tail of the enabled effects. */
  updateTail(sampleRate: number, blockSize: number): void {
    let tail = 0;
    if (this.fxEnabled) for (const sl of this.slots) if (sl && sl.enabled) tail = Math.max(tail, sl.fx.tail ?? 0);
    this.idleBlocks = !Number.isFinite(tail) ? Number.MAX_SAFE_INTEGER : Math.max(IDLE_BLOCKS, Math.ceil((tail * sampleRate) / blockSize) + 8);
  }

  /** Total processing latency of the enabled effect slots (samples). */
  latency(): number {
    if (!this.fxEnabled) return 0;
    let l = 0;
    for (const sl of this.slots) if (sl && sl.enabled) l += Math.round(sl.fx.latency ?? 0);
    return l;
  }

  hasActiveFx(): boolean {
    if (!this.fxEnabled) return false;
    for (const s of this.slots) if (s && s.enabled) return true;
    return false;
  }

  /**
   * Signal flow (FL order): FX slots 1-10 -> polarity -> swap -> stereo
   * separation -> volume -> pan -> mute -> (meter, sends).
   */
  process(n: number, ctx: FxContext): void {
    const L = this.inL, R = this.inR;
    const tap = this.tap, at = this.tapAt;
    if (tap && at === TAP_MIX) this.tapMix(tap, n);
    for (const s of this.slots) {
      if (!s || !s.enabled || !this.fxEnabled) continue;
      if (s.pending.length || s.stale) this.mixer?.deliverTo(s, this);
      if (s.mix >= 0.9999) {
        s.fx.process(L, R, n, ctx);
      } else {
        this.dryL.set(L.subarray(0, n));
        this.dryR.set(R.subarray(0, n));
        s.fx.process(L, R, n, ctx);
        const w = s.mix, d = 1 - s.mix;
        for (let i = 0; i < n; i++) {
          L[i] = this.dryL[i] * d + L[i] * w;
          R[i] = this.dryR[i] * d + R[i] * w;
        }
      }
    }
    if (tap && at === TAP_FX) tap(L, R, n);
    // built-in EQ (after the FX slots)
    for (let b = 0; b < 3; b++) {
      if (!this.eqOn[b]) continue;
      this.eqL[b].process(this.eqCoefs[b], L, 0, n);
      this.eqR[b].process(this.eqCoefs[b], R, 0, n);
    }
    if (tap && at === TAP_EQ) tap(L, R, n);
    if (this.polarity) for (let i = 0; i < n; i++) { L[i] = -L[i]; R[i] = -R[i]; }
    if (this.swapLR) for (let i = 0; i < n; i++) { const t = L[i]; L[i] = R[i]; R[i] = t; }

    // stereo separation: merge = cross-mix toward 50/50, separate = inverted cross-mix
    const k0 = this.sep.value, k1 = this.sep.target;
    if (k0 !== 0 || k1 !== 0) {
      const dk = (k1 - k0) / n;
      for (let i = 0; i < n; i++) {
        const k = k0 + dk * i;
        const l = L[i], r = R[i];
        if (k >= 0) { const b = k * 0.5; L[i] = (1 - b) * l + b * r; R[i] = (1 - b) * r + b * l; }
        else { const c = -k * 0.5; L[i] = l - c * r; R[i] = r - c * l; }
      }
    }
    this.sep.value = k1;

    if (tap && at === TAP_LVL) this.tapLevel(tap, n);
    // volume x mute, then merge & pan matrix, all ramped across the block
    const g0 = this.vol.value * this.mute.value, g1 = this.vol.target * this.mute.target;
    const dg = (g1 - g0) / n;
    const P = this.pan, T = this.panT;
    const d0 = (T[0] - P[0]) / n, d1 = (T[1] - P[1]) / n, d2 = (T[2] - P[2]) / n, d3 = (T[3] - P[3]) / n;
    let pl = this.peakL, pr = this.peakR;
    for (let i = 0; i < n; i++) {
      const g = g0 + dg * i;
      const l = L[i] * g, r = R[i] * g;
      const ol = (P[0] + d0 * i) * l + (P[1] + d1 * i) * r;
      const or = (P[2] + d2 * i) * l + (P[3] + d3 * i) * r;
      L[i] = ol; R[i] = or;
      const al = ol < 0 ? -ol : ol, ar = or < 0 ? -or : or;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
    }
    this.peakL = pl; this.peakR = pr;
    this.vol.value = this.vol.target;
    this.mute.value = this.mute.target;
    P.set(T);
    if (tap && at === TAP_POST) tap(L, R, n);
  }

  /** MIX tap: the track input, with the audio input added when it is not already monitored. */
  private tapMix(tap: TapFn, n: number): void {
    if (!this.input || this.extMonitored) { tap(this.inL, this.inR, n); return; }
    const dl = this.dryL, dr = this.dryR, L = this.inL, R = this.inR, el = this.extL, er = this.extR;
    for (let i = 0; i < n; i++) { dl[i] = L[i] + el[i]; dr[i] = R[i] + er[i]; }
    tap(dl, dr, n);
  }

  /** LVL tap: the signal after volume and panning, before the mute switch. */
  private tapLevel(tap: TapFn, n: number): void {
    const L = this.inL, R = this.inR, dl = this.dryL, dr = this.dryR;
    const g0 = this.vol.value, dg = (this.vol.target - g0) / n;
    const P = this.pan, T = this.panT;
    const d0 = (T[0] - P[0]) / n, d1 = (T[1] - P[1]) / n, d2 = (T[2] - P[2]) / n, d3 = (T[3] - P[3]) / n;
    for (let i = 0; i < n; i++) {
      const g = g0 + dg * i;
      const l = L[i] * g, r = R[i] * g;
      dl[i] = (P[0] + d0 * i) * l + (P[1] + d1 * i) * r;
      dr[i] = (P[2] + d2 * i) * l + (P[3] + d3 * i) * r;
    }
    tap(dl, dr, n);
  }
}

export class MixerEngine {
  tracks: TrackRuntime[] = [];
  order: number[] = [];
  /** Plugin delay compensation: arrival latency per track and delay lines. */
  private arrival: number[] = [];
  private chDelay: (DelayLine | null)[] = [];
  private edgeDelay = new Map<string, DelayLine>();
  private latencies: number[] = [];
  pdc = true;
  /** The "Current" track (last index) receives a copy of this track's output. */
  currentSource = 0;
  readonly sampleRate: number;
  readonly blockSize: number;
  /** Sample lookup for effects (Convolver impulses). */
  env: FxEnv = { sample: () => undefined };
  /** Effect slots whose editors are open (monitor data is collected for them). */
  watched = new Set<string>();
  /** Per-block context handed to the effects. */
  private ctx: FxContext;
  /** Held notes per MIDI port (from the note events delivered so far). */
  private portState = new Map<number, PortState>();
  /** Slots listening on each port (rebuilt when slots or ports change). */
  private portSlots = new Map<number, { slot: SlotRuntime; track: TrackRuntime }[]>();
  /** Slots whose plugins report their own state changes. */
  private stateSlots: SlotRuntime[] = [];
  private portsDirty = true;
  /** Note events held back with their track's audio (plugin delay compensation of the track's input). */
  private delayedNotes: { slot: SlotRuntime; track: TrackRuntime; at: number; ev: PortNote }[] = [];
  /** Frames processed so far (start of the current block). */
  private clock = 0;
  /** The audio device's input channels of the current block (null: no input device). */
  private ext: Float32Array[] | null = null;
  /** Tracks with an audio input selected. */
  private inputTracks: TrackRuntime[] = [];
  /** Tracks being recorded (a tap is installed). */
  private capTracks: TrackRuntime[] = [];
  /** "Always show external input levels": the meters show an unmonitored input too. */
  showInputLevels = false;

  /** rendering: offline render (project export); effects see FxContext.rendering. */
  constructor(numTracks: number, sampleRate: number, blockSize: number, rendering = false) {
    this.sampleRate = sampleRate;
    this.blockSize = blockSize;
    for (let i = 0; i < numTracks; i++) {
      const t = new TrackRuntime(i, blockSize);
      t.mixer = this;
      if (i > 0) t.sends = [{ target: 0, gain: 1 }];
      this.tracks.push(t);
    }
    this.ctx = {
      sampleRate, blockSize, tempo: 130, ppq: 96, playing: false, pos: 0, songMode: false, track: 0, sidechain: [], rendering,
      sendTo: (track, L, R, n, gl, gr) => {
        const dst = this.tracks[track];
        if (!dst || track === this.ctx.track) return;
        const dl = dst.inL, dr = dst.inR;
        for (let k = 0; k < n; k++) { dl[k] += L[k] * gl; dr[k] += R[k] * gr; }
        dst.hasInput = true;
      },
    };
    this.computeOrder();
  }

  /** Transport information for tempo-synced effects (call before process()). */
  setTransport(tempo: number, ppq: number, playing: boolean, pos: number, songMode: boolean): void {
    const c = this.ctx;
    const tempoChanged = c.tempo !== tempo;
    c.tempo = tempo; c.ppq = ppq; c.playing = playing; c.pos = pos; c.songMode = songMode;
    // tempo-synced effects (delays) compute their tails from the tempo
    if (tempoChanged) for (const t of this.tracks) t.updateTail(this.sampleRate, this.blockSize);
  }

  /** Display data of the watched effect slots: [slotId, data] pairs. */
  monitor(): [string, FxMonitor][] {
    const out: [string, FxMonitor][] = [];
    if (this.watched.size === 0) return out;
    // hosted modules (Patcher): "<slot id>#<module id>"
    for (const id of this.watched) {
      const k = id.indexOf('#');
      if (k <= 0) continue;
      const sid = id.slice(0, k), mid = id.slice(k + 1);
      for (const t of this.tracks) {
        const sl = t.slots.find((x) => x?.id === sid);
        if (!sl) continue;
        const d = sl.fx.monitorHosted?.(mid);
        if (d) { d.__active = t.silentBlocks <= t.idleBlocks || t.wakeBlocks > 0; out.push([id, d]); }
        break;
      }
    }
    for (const t of this.tracks) {
      // an idle track is no longer processed: displays should fall rather than freeze
      const active = t.silentBlocks <= t.idleBlocks || t.wakeBlocks > 0;
      for (const sl of t.slots) {
        if (!sl || !this.watched.has(sl.id) || !sl.fx.monitor) continue;
        const d = sl.fx.monitor();
        if (d) { d.__active = active; out.push([sl.id, d]); }
      }
    }
    return out;
  }

  setTrack(tr: MixerTrack): void {
    const t = this.tracks[tr.index];
    if (!t) return;
    t.apply(tr, this.sampleRate, this.blockSize, this.env);
    this.inputTracks = this.tracks.filter((x) => x.input);
    this.portsDirty = true;
    this.computeOrder();
    this.computeSidechains();
    this.computePdc();
  }

  /** Rebuild every track's sidechain input list from the routes into it (source order). */
  computeSidechains(): void {
    const lists: number[][] = this.tracks.map(() => []);
    for (const t of this.tracks) for (const s of t.sends) if (lists[s.target] && s.target !== t.index) lists[s.target].push(t.index);
    for (const t of this.tracks) {
      const want = lists[t.index].sort((a, b) => a - b);
      const have = t.sidechainIn;
      if (have.length === want.length && have.every((x, k) => x.source === want[k])) continue;
      t.sidechainIn = want.map((source) => have.find((x) => x.source === source)
        ?? { source, L: new Float32Array(this.blockSize), R: new Float32Array(this.blockSize) });
    }
  }

  /** Automation: levels / pan / separation / EQ / send gains, no topology change. */
  applyLevels(tr: MixerTrack): void {
    this.tracks[tr.index]?.applyLevels(tr, this.sampleRate);
  }

  /** Automation: one effect slot's parameters, mix and enable switch. */
  applySlot(track: number, slot: number, s: FxSlot): void {
    const rt = this.tracks[track]?.slots[slot];
    if (!rt || rt.id !== s.id) return;
    const lat0 = rt.enabled ? rt.fx.latency ?? 0 : 0;
    rt.fx.setParams(s.params);
    rt.enabled = s.enabled;
    rt.mix = s.mix;
    if (rt.fx.midiPorts) this.portsDirty = true;
    this.tracks[track].updateTail(this.sampleRate, this.blockSize);
    // an automated parameter may change the effect's latency (e.g. a limiter's attack): re-align PDC
    if ((rt.enabled ? rt.fx.latency ?? 0 : 0) !== lat0) this.computePdc();
  }

  /** A(t) = max over routed sources of A(src) + L(src); channels arrive with 0. */
  computePdc(): void {
    const n = this.tracks.length;
    this.latencies = this.tracks.map((t) => (this.pdc ? t.latency() : 0));
    const A = new Array(n).fill(0);
    for (const i of [...this.order, 0]) {
      const t = this.tracks[i];
      for (const s of t.sends) if (s.target < n) A[s.target] = Math.max(A[s.target], A[i] + this.latencies[i]);
    }
    this.arrival = A;
    for (let i = 0; i < n; i++) {
      const need = A[i];
      if (need > 0) {
        const cur = this.chDelay[i];
        if (!cur || cur.size < need + this.blockSize) this.chDelay[i] = new DelayLine(need + this.blockSize + 1);
      } else this.chDelay[i] = null;
    }
  }

  private edgeDelayFor(src: number, dst: number): number {
    return Math.max(0, (this.arrival[dst] ?? 0) - ((this.arrival[src] ?? 0) + (this.latencies[src] ?? 0)));
  }

  /** Topological order: a track is processed after every track that sends into it. Master last. */
  computeOrder(): void {
    const n = this.tracks.length;
    // edges: routes plus the targets of routing plugins (Send)
    const edges: number[][] = this.tracks.map((t) => {
      const e = t.sends.map((s) => s.target);
      for (const sl of t.slots) if (sl?.fx.sendTargets) for (const k of sl.fx.sendTargets()) if (k !== t.index && !e.includes(k)) e.push(k);
      return e;
    });
    const indeg = new Array(n).fill(0);
    for (const e of edges) for (const k of e) if (k < n) indeg[k]++;
    const queue: number[] = [];
    const current = n - 1;
    for (let i = 1; i < n; i++) if (indeg[i] === 0 && i !== current) queue.push(i);
    const order: number[] = [];
    while (queue.length) {
      const i = queue.shift()!;
      order.push(i);
      for (const k of edges[i]) {
        if (k === 0 || k >= n) continue;
        if (--indeg[k] === 0) queue.push(k);
      }
    }
    // Any track caught in a cycle (should be prevented by the UI) is appended so it still plays.
    if (order.length < n - 2) for (let i = 1; i < current; i++) if (!order.includes(i)) order.push(i);
    this.order = order;
  }

  beginBlock(n: number): void {
    for (const t of this.tracks) {
      t.inL.fill(0, 0, n);
      t.inR.fill(0, 0, n);
      for (const sc of t.sidechainIn) { sc.L.fill(0, 0, n); sc.R.fill(0, 0, n); }
      if (t.hasChannelInput) { t.chL.fill(0, 0, n); t.chR.fill(0, 0, n); }
      t.hasInput = false;
      t.hasChannelInput = false;
    }
    if (this.inputTracks.length) this.fillExternal(n);
  }

  // ------------------------------------------------------- audio input
  /** The audio device's input channels for the coming block (one array per device channel, null: none). Call before beginBlock(). */
  setInput(channels: Float32Array[] | null): void {
    this.ext = channels && channels.length ? channels : null;
  }

  /** Every track with an input reads its device channels (a mono input is on both sides; a missing channel is silence). */
  private fillExternal(n: number): void {
    const ch = this.ext;
    for (const t of this.inputTracks) {
      const sel = t.input!;
      const a = ch ? ch[sel.ch] : undefined;
      const b = sel.mono ? a : ch ? ch[sel.ch + 1] : undefined;
      const L = t.extL, R = t.extR;
      if (a) L.set(a.subarray(0, n)); else L.fill(0, 0, n);
      if (b) R.set(b.subarray(0, n)); else R.fill(0, 0, n);
    }
  }

  /** Add a track's audio input to its input (when monitored), or only meter it. */
  private takeExternal(t: TrackRuntime, n: number): void {
    const mon = !!this.ext && t.monitored();
    t.extMonitored = mon;
    const L = t.extL, R = t.extR;
    if (mon) {
      const dl = t.inL, dr = t.inR;
      for (let k = 0; k < n; k++) { dl[k] += L[k]; dr[k] += R[k]; }
      t.hasInput = true;
    } else if (this.showInputLevels && this.ext) {
      let pl = t.peakL, pr = t.peakR;
      for (let k = 0; k < n; k++) {
        const l = L[k] < 0 ? -L[k] : L[k], r = R[k] < 0 ? -R[k] : R[k];
        if (l > pl) pl = l;
        if (r > pr) pr = r;
      }
      t.peakL = pl; t.peakR = pr;
    }
  }

  // ------------------------------------------------------- recording
  /** Install (or, with null, remove) the recording tap of a track: its signal at `pickup` goes to `fn` every block. */
  setTap(index: number, pickup: RecPickup | null, fn: TapFn | null): void {
    const t = this.tracks[index];
    if (!t) return;
    t.tap = pickup && fn ? fn : null;
    t.tapAt = pickup && fn ? TAP_OF[pickup] : 0;
    this.capTracks = this.tracks.filter((x) => x.tap);
  }

  /** Frames by which the audible playback lags the transport: the plugin delay compensation up to the master and its own latency. */
  playbackLag(): number {
    return (this.arrival[0] ?? 0) + (this.latencies[0] ?? 0);
  }

  /** Frames by which the channel audio arrives late at a track (plugin delay compensation of the routes into it). */
  trackArrival(index: number): number {
    return this.arrival[index] ?? 0;
  }

  /** Move the channel bus (PDC-delayed) into the track input. */
  private takeChannels(t: TrackRuntime, n: number): void {
    const dl = this.chDelay[t.index];
    if (dl) {
      dl.process(t.chL, t.chR, t.inL, t.inR, n, this.arrival[t.index], 1);
      t.hasInput = true; // delayed content may still be arriving
    } else if (t.hasChannelInput) {
      const L = t.inL, R = t.inR, cl = t.chL, cr = t.chR;
      for (let k = 0; k < n; k++) { L[k] += cl[k]; R[k] += cr[k]; }
    }
    if (t.hasChannelInput) t.hasInput = true;
  }

  /** Process all inserts then master; writes the master output into outL/outR. */
  private runTrack(t: TrackRuntime, n: number): void {
    const c = this.ctx;
    c.track = t.index;
    c.sidechain = t.sidechainIn;
    t.process(n, c);
  }

  process(outL: Float32Array, outR: Float32Array, n: number): void {
    // recorded tracks picking up the audio input itself
    for (const t of this.capTracks) if (t.tapAt === TAP_EXT) t.tap!(t.extL, t.extR, n);
    for (const i of this.order) {
      const t = this.tracks[i];
      this.takeChannels(t, n);
      if (t.input) this.takeExternal(t, n);
      if (t.hasInput || t.noteWake || t.heldNotes > 0) t.silentBlocks = 0; else t.silentBlocks++;
      // Skip idle tracks once their effect tails have surely decayed (new effects settle first).
      // A track being recorded keeps running: its recording must not miss a block.
      if (t.wakeBlocks > 0) t.wakeBlocks--;
      else if (t.silentBlocks > t.idleBlocks && !t.tap) continue;
      this.runTrack(t, n);
      for (const s of t.sends) {
        const dst = this.tracks[s.target];
        if (!dst) continue;
        // the source's full output is available to the target's plugins as a sidechain input
        const sc = dst.sidechainIn.length ? dst.sidechainIn.find((x) => x.source === i) : undefined;
        if (sc) { sc.L.set(t.inL.subarray(0, n)); sc.R.set(t.inR.subarray(0, n)); dst.hasInput = true; }
        if (s.gain === 0) continue;
        const g = s.gain;
        const d = this.edgeDelayFor(i, s.target);
        if (d > 0) {
          const key = i + '>' + s.target;
          let line = this.edgeDelay.get(key);
          if (!line || line.size < d + this.blockSize) { line = new DelayLine(d + this.blockSize + 1); this.edgeDelay.set(key, line); }
          line.process(t.inL, t.inR, dst.inL, dst.inR, n, d, g);
        } else {
          const dl = dst.inL, dr = dst.inR, sl = t.inL, sr = t.inR;
          for (let k = 0; k < n; k++) { dl[k] += sl[k] * g; dr[k] += sr[k] * g; }
        }
        dst.hasInput = true;
      }
    }
    const m = this.tracks[0];
    this.takeChannels(m, n);
    if (m.hasInput || m.noteWake || m.heldNotes > 0) m.silentBlocks = 0; else m.silentBlocks++;
    if (m.wakeBlocks > 0) m.wakeBlocks--;
    if (m.silentBlocks <= m.idleBlocks || m.wakeBlocks > 0) this.runTrack(m, n);
    outL.set(m.inL.subarray(0, n));
    outR.set(m.inR.subarray(0, n));
    // Current: a tap of the selected track's output (metered, never summed into master)
    const cur = this.tracks[this.tracks.length - 1];
    const src = this.tracks[this.currentSource];
    if (cur && src && src !== cur) {
      cur.inL.set(src.inL.subarray(0, n));
      cur.inR.set(src.inR.subarray(0, n));
      this.takeChannels(cur, n);
      this.runTrack(cur, n);
    }
    this.endNoteBlock();
    this.clock += n;
  }

  // ------------------------------------------------------------ MIDI input
  /**
   * Note events of this block (MIDI Out channels, in time order). Call before
   * process(): every slot listening on an event's port gets it right before
   * it processes (TrackRuntime.process -> deliverTo), at the event's frame.
   */
  deliverNotes(events: readonly PortNote[], count: number, n: number): void {
    if (this.portsDirty) this.buildPorts();
    // events held back with a track's delayed input that fall into this block
    if (this.delayedNotes.length) {
      let w = 0;
      for (const d of this.delayedNotes) {
        if (d.at < this.clock + n) {
          d.ev.frame = Math.max(0, d.at - this.clock);
          d.slot.pending.push(d.ev);
          d.track.noteWake = true;
        } else this.delayedNotes[w++] = d;
      }
      this.delayedNotes.length = w;
    }
    for (let i = 0; i < count; i++) {
      const e = events[i];
      let st = this.portState.get(e.port);
      if (!st) { st = { vel: new Float32Array(128), chan: new Uint8Array(128) }; this.portState.set(e.port, st); }
      if (e.on) { st.vel[e.key] = Math.max(1e-3, e.vel); st.chan[e.key] = e.chan; } else st.vel[e.key] = 0;
      const list = this.portSlots.get(e.port);
      if (!list) continue;
      for (const r of list) {
        // a track whose input waits for delay compensation gets its notes as late as its audio
        const lag = this.pdc ? this.arrival[r.track.index] ?? 0 : 0;
        if (lag > 0) { this.delayedNotes.push({ slot: r.slot, track: r.track, at: this.clock + e.frame + lag, ev: { ...e } }); continue; }
        r.slot.pending.push(e);
        r.track.noteWake = true;
      }
    }
  }

  /** Called by track `t` right before its slot `s` processes: hand it its note events. */
  deliverTo(s: SlotRuntime, t: TrackRuntime): void {
    const fx = s.fx;
    const held0 = s.heldCount;
    if (s.stale) {
      // bring the plugin up to date with the held notes of its ports (this block's events included)
      s.stale = false;
      s.pending.length = 0;
      for (const [port, h] of s.held) {
        if (s.ports.includes(port)) continue;
        for (let k = 0; k < 128; k++) if (h.vel[k] > 0) { h.vel[k] = 0; s.heldCount--; fx.noteOff?.(k, 0, port, h.chan[k] || 1); }
        s.held.delete(port);
      }
      for (const port of s.ports) {
        const st = this.portState.get(port);
        const h = this.heldOf(s, port);
        for (let k = 0; k < 128; k++) {
          const want = st ? st.vel[k] : 0;
          if (h.vel[k] > 0 && !(want > 0)) { h.vel[k] = 0; s.heldCount--; fx.noteOff?.(k, 0, port, h.chan[k] || 1); }
        }
        if (!st) continue;
        for (let k = 0; k < 128; k++) {
          if (st.vel[k] > 0 && !(h.vel[k] > 0)) {
            h.vel[k] = st.vel[k]; h.chan[k] = st.chan[k]; s.heldCount++;
            fx.noteOn?.(k, st.vel[k], 0, port, st.chan[k] || 1);
          }
        }
      }
      t.heldNotes += s.heldCount - held0;
      t.updateTail(this.sampleRate, this.blockSize);
      return;
    }
    for (const e of s.pending) {
      const h = this.heldOf(s, e.port);
      if (e.on) {
        if (!(h.vel[e.key] > 0)) s.heldCount++;
        h.vel[e.key] = Math.max(1e-3, e.vel); h.chan[e.key] = e.chan;
        fx.noteOn?.(e.key, e.vel, e.frame, e.port, e.chan);
      } else if (h.vel[e.key] > 0) {
        h.vel[e.key] = 0; s.heldCount--;
        fx.noteOff?.(e.key, e.frame, e.port, e.chan);
      }
    }
    s.pending.length = 0;
    t.heldNotes += s.heldCount - held0;
    // a plugin's ring time may follow its notes (Vocodex's carrier synth)
    t.updateTail(this.sampleRate, this.blockSize);
  }

  /** Panic: every plugin forgets its notes, and so does the mixer. */
  allNotesOff(): void {
    this.delayedNotes.length = 0;
    for (const st of this.portState.values()) st.vel.fill(0);
    for (const t of this.tracks) {
      t.heldNotes = 0;
      for (const s of t.slots) {
        if (!s) continue;
        s.pending.length = 0;
        s.stale = false;
        s.held.clear();
        s.heldCount = 0;
        s.fx.allNotesOff?.();
      }
    }
  }

  /** State changes the plugins made by themselves since the last call: [slot id, path in params, value]. */
  takeStateChanges(out: [string, string, unknown][]): void {
    if (this.portsDirty) this.buildPorts();
    for (const s of this.stateSlots) {
      const ch = s.fx.takeStateChanges?.();
      if (ch) for (const [path, v] of ch) out.push([s.id, path, v]);
    }
  }

  private heldOf(s: SlotRuntime, port: number): { vel: Float32Array; chan: Uint8Array } {
    let h = s.held.get(port);
    if (!h) { h = { vel: new Float32Array(128), chan: new Uint8Array(128) }; s.held.set(port, h); }
    return h;
  }

  /** Rebuild which slots listen on which ports (after slot, parameter or port changes). */
  private buildPorts(): void {
    this.portsDirty = false;
    this.portSlots.clear();
    this.stateSlots = [];
    for (const t of this.tracks) {
      for (const s of t.slots) {
        if (!s) continue;
        if (s.fx.takeStateChanges) this.stateSlots.push(s);
        let ports = EMPTY_PORTS;
        if (s.fx.noteOn || s.fx.noteOff) {
          const set = new Set<number>();
          if (s.midiPort >= 0) set.add(s.midiPort);
          for (const p of s.fx.midiPorts?.() ?? []) if (Number.isFinite(p) && p >= 0 && p <= 255) set.add(Math.round(p));
          ports = set.size ? [...set].sort((a, b) => a - b) : EMPTY_PORTS;
        }
        const changed = ports.length !== s.ports.length || ports.some((p, k) => p !== s.ports[k]);
        if (changed) {
          s.ports = ports;
          // notes of a port the slot no longer listens on are released, a new port's held notes start
          if (s.heldCount > 0 || ports.some((p) => this.portHolds(p))) s.stale = true;
        }
        for (const p of ports) {
          let list = this.portSlots.get(p);
          if (!list) this.portSlots.set(p, (list = []));
          list.push({ slot: s, track: t });
        }
      }
    }
  }

  private portHolds(port: number): boolean {
    const st = this.portState.get(port);
    if (!st) return false;
    for (let k = 0; k < 128; k++) if (st.vel[k] > 0) return true;
    return false;
  }

  /** End of a block: events of slots that did not run (bypassed) are dropped; they catch up later. */
  private endNoteBlock(): void {
    for (const t of this.tracks) {
      if (t.noteWake) {
        t.noteWake = false;
        for (const s of t.slots) if (s && s.pending.length) { s.pending.length = 0; s.stale = true; }
      }
    }
  }

  /** Collect and reset peak values: [L0, R0, L1, R1, ...]. */
  takePeaks(out: Float32Array): void {
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      out[i * 2] = t.peakL;
      out[i * 2 + 1] = t.peakR;
      t.peakL = 0;
      t.peakR = 0;
    }
  }
}
