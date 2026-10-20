// Voltage Controller DSP, after FL's Fruity Voltage Controller (docs/research/gen/voltagectrl.md): a generator
// whose "audio" is control voltage, DC levels on eight channels (Left / Right of Main, Out 2, Out 3, Out 4).
//
// Every channel takes one source (Pitch, Gate, Trigger, Velocity, Volume, Panning, Mod X, Mod Y, Clock, None),
// adds its offset and scales it: voltage = scale x (source + offset). A channel follows the notes of its
// colour: the newest note of that colour is its current note; Pitch, Velocity, Volume, Panning and Mod X / Y keep
// the last note's values after it ends (sample and hold, so an envelope's release stays on its pitch), Gate is high while the
// note is held and Trigger is a short pulse at its start. Clock sends a pulse every 1 / resolution of a quarter note
// while the song plays. The voltage reaches the output as a sample level: voltage / full scale (5 V for the
// +/- 5 V range, else 10 V), clipped to the range. Nothing is sent while ON is off.
// Main goes to the channel's mixer track, Out 2..4 to the mixer tracks the target fields (or Automap) name.

import type { GenContext, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import type { FxMonitor } from '../../effects/types';
import {
  VC_CHANNELS, VC_CLOCK, VC_GATE, VC_MODX, VC_MODY, VC_PANNING, VC_PITCH, VC_TARGET_MAX, VC_TRIGGER, VC_VELOCITY, VC_VOLUME,
  vcFullScale, vcOfsKey, vcSclKey,
} from '../../../model/gen/plugins/voltagectrl';

const MAX_VOICES = 128;
const MAX_EVENTS = 2 * MAX_VOICES + 16;
/** Largest chunk the scratch buffers of the extra outputs hold (render() splits longer blocks). */
const CHUNK = 4096;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

class VcVoice implements GenVoice {
  /** 0 = free, 1 = triggered (queued or running). */
  state = 0;
  params: GenVoiceParams | null = null;
  constructor(private readonly vc: VoltageController) {}
  /** The voice lives until the channel kills it (a controller makes no sound). */
  render(): boolean { return this.state === 1; }
  release(): void { this.vc.queue(2, this); }
  kill(): void { this.vc.queue(3, this); }
}

class VoltageController implements GenInstance {
  /** DC runs all the time. */
  readonly tail = Infinity;
  private readonly sr: number;
  private on = false;
  private readonly src = new Int8Array(VC_CHANNELS);
  private readonly color = new Int8Array(VC_CHANNELS).fill(1);
  private readonly ofsV = new Float64Array(VC_CHANNELS);
  private readonly scale = new Float64Array(VC_CHANNELS).fill(1);
  private readonly bipolar = new Uint8Array(VC_CHANNELS).fill(1);
  private range = 1;
  private fs = 10;
  private pitchScale = 1;
  private ppq = 24;
  private pulseSamples = 220;
  private automap = false;
  private readonly target = [0, 0, 0];
  // voices
  private readonly voices: VcVoice[] = [];
  private readonly cur: (VcVoice | null)[] = new Array(VC_CHANNELS).fill(null);
  // per channel: the held values of the last note
  private readonly hPitch = new Float64Array(VC_CHANNELS);
  private readonly hVel = new Float64Array(VC_CHANNELS);
  private readonly hVol = new Float64Array(VC_CHANNELS);
  private readonly hPan = new Float64Array(VC_CHANNELS);
  private readonly hMx = new Float64Array(VC_CHANNELS);
  private readonly hMy = new Float64Array(VC_CHANNELS);
  private readonly gate = new Uint8Array(VC_CHANNELS);
  private readonly trig = new Int32Array(VC_CHANNELS);
  // clock
  private clockLeft = 0;
  private clockIdx = -1;
  // events of the block
  private readonly evFrame = new Int32Array(MAX_EVENTS);
  private readonly evKind = new Uint8Array(MAX_EVENTS);
  private readonly evVoice: (VcVoice | null)[] = new Array(MAX_EVENTS).fill(null);
  private readonly order = new Int32Array(MAX_EVENTS);
  private nEv = 0;
  // outputs
  private readonly scratch: Float32Array[] = Array.from({ length: 6 }, () => new Float32Array(CHUNK));
  private readonly volts = new Float64Array(VC_CHANNELS);

  constructor(sr: number) {
    this.sr = sr;
    for (let i = 0; i < MAX_VOICES; i++) this.voices.push(new VcVoice(this));
    this.setParams({});
  }

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const num = (k: string, d: number, lo: number, hi: number) => {
      const v = Number(q[k] ?? d);
      return Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
    };
    this.on = !!q.on;
    this.range = Math.round(num('range', 1, 0, 2));
    this.fs = vcFullScale(this.range);
    this.pitchScale = num('pitchScale', 1, 0.01, 100);
    this.ppq = Math.max(1, Math.round(num('ppq', 24, 1, 96)));
    this.pulseSamples = Math.max(1, Math.round((num('pulse', 5, 0.1, 1000) * this.sr) / 1000));
    this.automap = !!q.automap;
    const tg = Array.isArray(q.target) ? q.target : [];
    for (let k = 0; k < 3; k++) this.target[k] = clamp(Math.round(Number(tg[k]) || 0), -VC_TARGET_MAX, VC_TARGET_MAX);
    const srcs = Array.isArray(q.src) ? q.src : [], cols = Array.isArray(q.color) ? q.color : [], bip = Array.isArray(q.bipolar) ? q.bipolar : [];
    const dsrc = [VC_PITCH, VC_GATE, VC_VELOCITY, VC_PANNING, VC_MODX, VC_MODY, 9, 9];
    for (let c = 0; c < VC_CHANNELS; c++) {
      const s = Number(srcs[c]);
      this.src[c] = Number.isFinite(s) ? clamp(Math.round(s), 0, 9) : dsrc[c];
      const col = Number(cols[c]);
      this.color[c] = Number.isFinite(col) ? clamp(Math.round(col), 1, 16) : 1;
      this.bipolar[c] = bip[c] === undefined ? 1 : bip[c] ? 1 : 0;
      const o = num(vcOfsKey(c), 32768, 0, 65536), s2 = num(vcSclKey(c), 65536, 0, 65536);
      let ofs = ((o - 32768) / 32768) * this.fs;
      if (!this.bipolar[c] && ofs < 0) ofs = 0; // unipolar: the offset only adds
      this.ofsV[c] = ofs;
      this.scale[c] = (s2 - 32768) / 32768;
    }
  }

  // ----------------------------------------------------------------- voices

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    // a note of a colour no channel follows is ignored
    let any = false;
    for (let c = 0; c < VC_CHANNELS; c++) if (this.color[c] === p.color + 1) { any = true; break; }
    if (!any) return null;
    let v: VcVoice | null = null;
    for (const c of this.voices) if (c.state === 0) { v = c; break; }
    if (!v) return null;
    v.state = 1;
    v.params = p;
    this.queue(1, v);
    return v;
  }

  queue(kind: number, v: VcVoice): void {
    const frame = v.params ? v.params.frame : 0;
    if (this.nEv >= MAX_EVENTS) { this.apply(kind, v); return; }
    const i = this.nEv++;
    this.evFrame[i] = Math.max(0, Math.floor(frame));
    this.evKind[i] = kind;
    this.evVoice[i] = v;
  }

  /** The held values of channel c from its current note's live levels. */
  private refresh(c: number): void {
    const v = this.cur[c];
    const p = v ? v.params : null;
    if (!p) return;
    this.hPitch[c] = p.key + (p.levels.pitch - p.init.pitch) / 100;
    this.hVel[c] = clamp(p.velocity / 127, 0, 1);
    this.hVol[c] = clamp(p.levels.vol, 0, 1);
    this.hPan[c] = clamp(p.levels.pan, -1, 1);
    this.hMx[c] = clamp(p.levels.fcut, -1, 1);
    this.hMy[c] = clamp(p.levels.fres, -1, 1);
  }

  private apply(kind: number, v: VcVoice): void {
    if (kind === 1) {
      if (v.state !== 1 || !v.params) return;
      for (let c = 0; c < VC_CHANNELS; c++) {
        if (this.color[c] !== v.params.color + 1) continue;
        const old = this.cur[c];
        if (old && old !== v) this.refresh(c);
        this.cur[c] = v;
        this.refresh(c);
        this.gate[c] = 1;
        this.trig[c] = this.pulseSamples;
      }
    } else if (kind === 2) {
      for (let c = 0; c < VC_CHANNELS; c++) if (this.cur[c] === v) { this.refresh(c); this.gate[c] = 0; }
    } else {
      for (let c = 0; c < VC_CHANNELS; c++) if (this.cur[c] === v) { this.refresh(c); this.cur[c] = null; this.gate[c] = 0; }
      v.state = 0;
      v.params = null;
    }
  }

  // ----------------------------------------------------------------- render

  /** A -1..1 source as a voltage: full scale each way, or 0..full scale in the 0 to 10 V range. */
  private bipolarVolts(x: number): number {
    return this.range === 2 ? ((x + 1) / 2) * this.fs : x * this.fs;
  }

  /** The source voltage of channel c right now. */
  private source(c: number): number {
    const fs = this.fs;
    switch (this.src[c]) {
      case VC_PITCH: return (this.hPitch[c] * this.pitchScale) / 12;
      case VC_GATE: return this.gate[c] ? fs : 0;
      case VC_TRIGGER: return this.trig[c] > 0 ? fs : 0;
      case VC_VELOCITY: return this.hVel[c] * fs;
      case VC_VOLUME: return this.hVol[c] * fs;
      case VC_PANNING: return this.bipolarVolts(this.hPan[c]);
      case VC_MODX: return this.bipolarVolts(this.hMx[c]);
      case VC_MODY: return this.bipolarVolts(this.hMy[c]);
      case VC_CLOCK: return this.clockLeft > 0 ? fs : 0;
      default: return 0;
    }
  }

  render(L: Float32Array, R: Float32Array, n: number, ctx: GenContext): void {
    // events in time order
    const ne = this.nEv;
    const order = this.order;
    for (let i = 0; i < ne; i++) {
      let j = i;
      while (j > 0 && this.evFrame[order[j - 1]] > this.evFrame[i]) { order[j] = order[j - 1]; j--; }
      order[j] = i;
    }
    for (let c = 0; c < VC_CHANNELS; c++) if (this.cur[c]) this.refresh(c);
    const sp = (this.sr * 60) / ((ctx.tempo > 0 ? ctx.tempo : 120) * (ctx.ppq > 0 ? ctx.ppq : 96));
    const interval = (ctx.ppq > 0 ? ctx.ppq : 96) / this.ppq;
    const playing = ctx.playing;
    if (!playing) this.clockIdx = -1;
    const fs = this.fs, on = this.on, rng = this.range;
    let e = 0;
    for (let base = 0; base < n; base += CHUNK) {
      const m = Math.min(CHUNK, n - base);
      for (let i = 0; i < m; i++) {
        const t = base + i;
        while (e < ne && this.evFrame[order[e]] <= t) { const k = order[e++]; this.apply(this.evKind[k], this.evVoice[k] as VcVoice); }
        if (playing) {
          const idx = Math.floor((ctx.pos + t / sp) / interval + 1e-9);
          if (idx !== this.clockIdx) { this.clockIdx = idx; this.clockLeft = this.pulseSamples; }
        }
        for (let c = 0; c < VC_CHANNELS; c++) {
          const v = this.scale[c] * (this.source(c) + this.ofsV[c]);
          this.volts[c] = on ? v : 0;
          if (!on) continue;
          const s = rng === 2 ? clamp(v / fs, 0, 1) : clamp(v / fs, -1, 1);
          if (c === 0) L[t] += s;
          else if (c === 1) R[t] += s;
          else this.scratch[c - 2][i] = s;
        }
        if (this.clockLeft > 0) this.clockLeft--;
        for (let c = 0; c < VC_CHANNELS; c++) if (this.trig[c] > 0) this.trig[c]--;
      }
      if (on && ctx.out) {
        for (let k = 1; k < 4; k++) {
          const off = this.automap ? k : this.target[k - 1];
          if (!off) continue;
          const track = clamp(ctx.track + off, 0, VC_TARGET_MAX);
          ctx.out(track, this.scratch[2 * (k - 1)], this.scratch[2 * (k - 1) + 1], m);
        }
      }
    }
    // events behind the block's last frame still apply (frames are clamped to the block by the channel)
    while (e < ne) { const k = order[e++]; this.apply(this.evKind[k], this.evVoice[k] as VcVoice); }
    for (let i = 0; i < ne; i++) this.evVoice[i] = null;
    this.nEv = 0;
  }

  /** Editor data: the voltage of every channel (after scale and offset) at the end of the last block. */
  monitor(): FxMonitor {
    return { volts: Array.from(this.volts), on: this.on };
  }

  allNotesOff(): void {
    for (let c = 0; c < VC_CHANNELS; c++) { this.cur[c] = null; this.gate[c] = 0; this.trig[c] = 0; }
    for (const v of this.voices) { v.state = 0; v.params = null; }
    this.nEv = 0;
  }

  reset(): void {
    this.allNotesOff();
    this.hPitch.fill(0); this.hVel.fill(0); this.hVol.fill(0); this.hPan.fill(0); this.hMx.fill(0); this.hMy.fill(0);
    this.clockLeft = 0;
    this.clockIdx = -1;
  }
}

export const gen: GenModule = {
  id: 'voltagectrl',
  create: (sampleRate) => new VoltageController(sampleRate),
};
