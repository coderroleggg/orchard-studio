// SimSynth (FL: SimSynth Live): FL's engine (SimSynth_eng_x64.dylib) ported line by
// line in ./simsynth/ (docs/research/gen/simsynth.md), driven the way FL drives it.
//
// FL triggers voices with TriggerVoice and calls Gen_Render once per audio block,
// split at note events: the engine renders its 12 voices block by block (each one a
// whole block before the next, in slot order), mixes them with its own gain ramp and
// runs its chorus, and a voice whose amplitude envelope ended is dropped at the end
// of the block. Here the channel's voices only log their trigger / levels / release /
// kill with the frame; render() replays the log in time order once per channel block,
// emulating FL's calls (512-sample blocks re-anchored at every event, like the test
// host), and writes the plugin's output (def.levels 'plugin').

import type { GenContext, GenInstance, GenModule, GenVoice, GenVoiceParams } from '../types';
import { PITCH_C5 } from '../levels';
import { TAGS, tagMax } from '../../../model/gen/plugins/simsynth';
import { NV, PlugVoice, SSPlug } from './simsynth/plug';
import { resetGlobals } from './simsynth/tables';
import { resetScratch } from './simsynth/synth';
import { f32, rint } from './simsynth/fmath';

/** Voice objects: the channel holds up to 128, plus voices whose kill waits for the replay. */
const POOL = 256;
/** FL's audio block in the test host (and a typical FL buffer): the longest Gen_Render call. */
const FL_BLOCK = 512;
const LOG = 8192;
const E_RELEASE = 0, E_KILL = 1, E_TRIGGER = 2, E_LEVELS = 3;

class SSVoice implements GenVoice {
  readonly pv = new PlugVoice();
  params: GenVoiceParams | null = null;
  /** Held by the channel, or with events the replay has not processed yet. */
  busy = false;
  pending = 0;
  /** The levels last logged (FL's TVoiceParams_Old values). */
  lPan = 0;
  lVol = 0;
  lPitch = 0;
  lCut = 0;
  lRes = 0;
  lastEnd = 0;
  lastBlock = -1;
  trigBlock = -1;
  trigFrame = -1;

  constructor(private readonly s: SimSynth) {}

  render(_L: Float32Array, _R: Float32Array, n: number): boolean {
    const p = this.params;
    if (!p || this.pv.dead) return false;
    this.s.levels(this, p, p.frame);
    this.lastEnd = p.frame + n;
    this.lastBlock = this.s.blockNo;
    return true;
  }

  release(): void {
    if (this.params) this.s.log(E_RELEASE, this.params.frame, this);
  }

  kill(): void {
    const f = this.lastBlock === this.s.blockNo ? this.lastEnd : 0;
    this.s.log(E_KILL, f, this);
    this.params = null;
    this.busy = false;
  }
}

export class SimSynth implements GenInstance {
  readonly plug: SSPlug;
  readonly tail = 0.05;
  /** Channel block counter (voices time their kills by it). */
  blockNo = 0;
  private readonly pool: SSVoice[] = [];
  // the event log of the current block
  private ne = 0;
  private readonly evKind = new Int8Array(LOG);
  private readonly evKey = new Float64Array(LOG);
  private readonly evFrame = new Int32Array(LOG);
  private readonly evVoice: (SSVoice | null)[] = new Array(LOG).fill(null);
  private readonly evLv = new Float64Array(LOG * 5);
  private readonly ord = new Int32Array(LOG);
  // FL's Gen_Render call in progress
  private abs = 0;
  private callLeft = FL_BLOCK;
  private callRendered = 0;
  private callActive = false;
  private needStart = true;
  private readonly inCall = new Uint8Array(NV);
  private readonly mono: Float32Array;
  private readonly mixL: Float32Array;
  private readonly mixR: Float32Array;
  private readonly ctl = new Int32Array(58);
  private readonly next = new Int32Array(58);
  private loaded = false;
  private preset: unknown = undefined;

  constructor(sampleRate: number, blockSize: number) {
    this.plug = new SSPlug(sampleRate);
    for (let i = 0; i < POOL; i++) this.pool.push(new SSVoice(this));
    const bs = Math.max(blockSize, 128);
    this.mono = new Float32Array(bs);
    this.mixL = new Float32Array(bs);
    this.mixR = new Float32Array(bs);
    this.ctl.fill(-1);
  }

  // ------------------------------------------------------------ parameters

  setParams(raw: unknown): void {
    const q = (raw ?? {}) as Record<string, unknown>;
    const next = this.next;
    for (let t = 0; t < 58; t++) {
      const v = Number(q[TAGS[t]]);
      next[t] = Number.isFinite(v) ? Math.min(tagMax(t), Math.max(0, Math.round(v))) : this.ctl[t] >= 0 ? this.ctl[t] : 0;
    }
    const load = !this.loaded || (typeof q.__preset === 'string' && q.__preset !== this.preset);
    let changed = load;
    if (!load) for (let t = 0; t < 58 && !changed; t++) if (next[t] !== this.ctl[t]) changed = true;
    this.preset = q.__preset;
    if (!changed) return;
    // FL: the Gen_Render call in progress ends, the parameter changes, a new call begins
    if (this.callRendered > 0) this.plug.killDead(this.abs + 1);
    this.needStart = true;
    if (load) {
      this.loaded = true;
      this.plug.loadState(next, this.abs + 1);
    } else {
      for (let t = 0; t < 58; t++) if (next[t] !== this.ctl[t]) this.plug.wrapperSet(t, next[t]);
    }
    this.ctl.set(next);
  }

  // ------------------------------------------------------------ voices (logged)

  triggerVoice(p: GenVoiceParams): GenVoice | null {
    let v: SSVoice | null = null;
    for (const x of this.pool) if (!x.busy && x.pending === 0) { v = x; break; }
    if (!v) return null;
    v.busy = true;
    v.params = p;
    v.pv.dead = false;
    v.trigBlock = this.blockNo;
    v.trigFrame = p.frame;
    this.snapshot(v, p);
    this.log(E_TRIGGER, p.frame, v);
    return v;
  }

  /** FL's TVoiceParams_Old values of the voice's current levels. */
  private snapshot(v: SSVoice, p: GenVoiceParams): void {
    const l = p.levels;
    v.lPan = rint(f32(l.pan) * 64);
    v.lVol = f32(l.vol);
    v.lPitch = rint(f32(l.pitch - PITCH_C5));
    v.lCut = f32(l.fcut);
    v.lRes = f32(l.fres);
  }

  /** A level change (logged only when FL's values change). */
  levels(v: SSVoice, p: GenVoiceParams, frame: number): void {
    const l = p.levels;
    const pan = rint(f32(l.pan) * 64), vol = f32(l.vol), pitch = rint(f32(l.pitch - PITCH_C5)), cut = f32(l.fcut), res = f32(l.fres);
    if (pan === v.lPan && vol === v.lVol && pitch === v.lPitch && cut === v.lCut && res === v.lRes) return;
    v.lPan = pan; v.lVol = vol; v.lPitch = pitch; v.lCut = cut; v.lRes = res;
    this.log(E_LEVELS, frame, v);
  }

  log(kind: number, frame: number, v: SSVoice): void {
    const i = this.ne;
    if (i >= LOG) return;
    this.ne = i + 1;
    this.evKind[i] = kind;
    this.evFrame[i] = frame;
    this.evVoice[i] = v;
    // FL's order at one time: note offs before note ons (the test host), levels after;
    // a voice's own release / kill at its trigger frame comes after the trigger
    const own = (kind === E_RELEASE || kind === E_KILL) && v.trigBlock === this.blockNo && v.trigFrame === frame;
    const k = own ? 3 : kind === E_TRIGGER ? 1 : kind === E_LEVELS ? 2 : 0;
    this.evKey[i] = (frame * 4 + k) * LOG + i;
    const o = i * 5;
    this.evLv[o] = v.lPan; this.evLv[o + 1] = v.lVol; this.evLv[o + 2] = v.lPitch; this.evLv[o + 3] = v.lCut; this.evLv[o + 4] = v.lRes;
    v.pending++;
  }

  // ------------------------------------------------------------ FL's Gen_Render calls

  private startCall(): void {
    const plug = this.plug;
    let any = false;
    for (let s = 0; s < NV; s++) {
      const on = !!plug.slots[s] && plug.patches[s].env1.stage !== 4;
      this.inCall[s] = on ? 1 : 0;
      if (on) { plug.callStart(s); any = true; }
    }
    this.callActive = any;
    this.callLeft = FL_BLOCK;
    this.callRendered = 0;
    this.needStart = false;
  }

  private endCall(now: number): void {
    if (this.callRendered > 0) this.plug.killDead(now);
  }

  private segment(L: Float32Array, R: Float32Array, a: number, b: number): void {
    const plug = this.plug;
    const len = b - a;
    if (this.callActive) {
      const mono = this.mono, mL = this.mixL, mR = this.mixR;
      mL.fill(0, a, b);
      mR.fill(0, a, b);
      for (let s = 0; s < NV; s++) {
        if (!this.inCall[s]) continue;
        plug.patches[s].fill(mono, a, len);
        plug.mixVoice(s, mono, a, b, mL, mR);
      }
      if (plug.pre.chorus) {
        for (let k = a; k < b; k++) { L[k] = f32(L[k] + plug.chorus(mL[k])); R[k] = f32(R[k] + mR[k]); }
        plug.ctail = plug.ctailLen;
      } else {
        for (let k = a; k < b; k++) { L[k] = f32(L[k] + mL[k]); R[k] = f32(R[k] + mR[k]); }
        for (let k = a; k < b && plug.ctail > 0; k++) { L[k] = f32(L[k] + plug.chorus(0)); plug.ctail--; }
      }
      plug.time = (plug.time + len) | 0;
    } else if (plug.pre.chorus && plug.ctail > 0) {
      // the chorus tail after the last voice (FL drops the sample on which it ends)
      for (let k = a; k < b; k++) {
        const y = plug.chorus(0);
        if (--plug.ctail === 0) break;
        L[k] = f32(L[k] + y);
        plug.time = (plug.time + 1) | 0;
      }
    }
    this.callRendered += len;
  }

  render(L: Float32Array, R: Float32Array, n: number, _ctx: GenContext): void {
    // events in time order (insertion sort of the block's few events)
    const ne = this.ne, ord = this.ord, key = this.evKey;
    for (let i = 0; i < ne; i++) {
      let j = i;
      while (j > 0 && key[ord[j - 1]] > key[i]) { ord[j] = ord[j - 1]; j--; }
      ord[j] = i;
    }
    const plug = this.plug;
    let ei = 0;
    let t = 0;
    if (this.needStart) this.startCall();
    while (t < n) {
      if (ei < ne && this.evFrame[ord[ei]] <= t) {
        const now = this.abs + t + 1;
        this.endCall(now);
        while (ei < ne && this.evFrame[ord[ei]] <= t) {
          const i = ord[ei++];
          const v = this.evVoice[i]!;
          const o = i * 5;
          const pv = v.pv;
          v.pending--;
          switch (this.evKind[i]) {
            case E_TRIGGER:
            case E_LEVELS:
              pv.pan = this.evLv[o]; pv.vol = this.evLv[o + 1]; pv.pitch = this.evLv[o + 2]; pv.fcut = this.evLv[o + 3]; pv.fres = this.evLv[o + 4];
              if (this.evKind[i] === E_TRIGGER) plug.trigger(pv, now);
              break;
            case E_RELEASE: plug.release(pv, now); break;
            case E_KILL: plug.kill(pv, now); break;
          }
          this.evVoice[i] = null;
        }
        this.startCall();
      }
      let next = Math.min(n, t + this.callLeft);
      if (ei < ne) next = Math.min(next, this.evFrame[ord[ei]]);
      if (next <= t) next = t + 1;
      this.segment(L, R, t, next);
      this.callLeft -= next - t;
      t = next;
      if (this.callLeft <= 0) {
        this.endCall(this.abs + t + 1);
        this.startCall();
      }
    }
    // events past the block end (none expected): replay at its end
    while (ei < ne) {
      const i = ord[ei++];
      const v = this.evVoice[i]!;
      v.pending--;
      if (this.evKind[i] === E_KILL) plug.kill(v.pv, this.abs + n + 1);
      this.evVoice[i] = null;
    }
    this.ne = 0;
    this.abs += n;
    this.blockNo++;
  }

  allNotesOff(): void {}

  reset(): void {
    const plug = this.plug;
    for (let s = 0; s < NV; s++) { const v = plug.slots[s]; if (v) plug.kill(v, this.abs + 1); }
    plug.cbuf.fill(0);
    plug.ctail = 0;
    this.needStart = true;
  }
}

export const gen: GenModule = {
  id: 'simsynth',
  create: (sampleRate, blockSize) => new SimSynth(sampleRate, blockSize),
};

/** Tests / parity: a freshly loaded engine library (FL keeps these globals per process). */
export function resetSimSynthGlobals(): void {
  resetGlobals();
  resetScratch();
}
