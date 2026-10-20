// Gross Beat: tempo-synced time and volume manipulation of the incoming audio.
//
// The input is written into a ring buffer. A time slot's envelope (one bar
// wide, read at the song position) gives an offset of (1 - y) * 8 beats: the
// output reads the buffer that far back, so flat segments play at normal
// speed, steps jump, slopes change the speed (the safety-line slope pauses,
// steeper slopes reverse). A volume slot's envelope is the output gain, bent
// by the tension curve and smoothed by a two-pole attack / release follower.
// Slot changes wait for the new slot's trigger sync and start its envelope at
// its position sync; HOLD (or a slot's force hold) repeats a bar from the next
// bar line. Calibrated against FL's binary (docs/research/fx/grossbeat.md):
// 15 samples of latency, 12-tap windowed-sinc reads, difference-decay click
// reduction (5.4 / 7.6 ms), linear time and volume mixes, three-pole
// smoothing of the scratch offset and a ~4 Hz DC remover.
//
// MIDI ("Trigger slots from MIDI notes", on by default): notes from a MIDI Out
// channel on the slot's MIDI input port select slots at their sample, as a
// click would: C5.. (key 60..95, FL's octave numbering) the time slots 1..36,
// C2.. (24..59) the volume slots 1..36, with the slot's trigger sync, Link
// slots, and Key-held (back to the previous slot when the key is released).
// The selection is mirrored into the Time / Volume slot parameters.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import {
  GB_BAR, GB_LATENCY, GB_RANGE, GB_SLOTS, GB_SYNC_BEATS, gbOffsetBeats, gbShape, gbSingle, gbSmoothMs,
  type GbOptions, type GbPoint, type GbSlot,
} from '../../../model/fx/plugins/grossbeat';

// ------------------------------------------------------------ envelopes

/** A slot envelope compiled into typed arrays, with a cached segment for sequential reads. */
export class GbEnv {
  n = 0;
  x: Float64Array;
  y: Float64Array;
  t: Float64Array;
  m: Uint8Array;
  private seg = 1;

  constructor(cap = 64) {
    this.x = new Float64Array(cap);
    this.y = new Float64Array(cap);
    this.t = new Float64Array(cap);
    this.m = new Uint8Array(cap);
  }

  /** Load points (allocates only when a slot outgrows its capacity; called from setParams). */
  load(pts: readonly GbPoint[] | undefined): void {
    const src = Array.isArray(pts) && pts.length ? pts : null;
    const n = src ? src.length : 2;
    if (n > this.x.length) {
      const cap = Math.max(n, this.x.length * 2);
      this.x = new Float64Array(cap);
      this.y = new Float64Array(cap);
      this.t = new Float64Array(cap);
      this.m = new Uint8Array(cap);
    }
    if (!src) {
      this.x[0] = 0; this.y[0] = 1; this.t[0] = 0; this.m[0] = 2;
      this.x[1] = GB_BAR; this.y[1] = 1; this.t[1] = 0; this.m[1] = 2;
    } else {
      let px = 0;
      for (let i = 0; i < n; i++) {
        const p = src[i] ?? ({} as GbPoint);
        const x = Number(p.x), y = Number(p.y), t = Number(p.t);
        const xc = Number.isFinite(x) ? Math.min(GB_BAR, Math.max(px, x)) : px;
        this.x[i] = xc;
        this.y[i] = Number.isFinite(y) ? Math.min(1, Math.max(0, y)) : 1;
        this.t[i] = Number.isFinite(t) ? Math.min(1, Math.max(-1, t)) : 0;
        this.m[i] = Number.isInteger(p.m) && p.m >= 0 && p.m <= 12 ? p.m : 0;
        px = xc;
      }
    }
    this.n = n;
    this.seg = 1;
  }

  /** Value at phase p (beats). */
  at(p: number): number {
    const n = this.n, x = this.x;
    if (n < 2) return n === 1 ? this.y[0] : 1;
    if (p < x[0]) return this.y[0];
    if (p >= x[n - 1]) return this.y[n - 1];
    // segment hi: x[hi-1] <= p < x[hi]
    let hi = this.seg;
    if (!(hi >= 1 && hi < n && x[hi - 1] <= p && p < x[hi])) {
      if (hi >= 1 && hi < n && p >= x[hi]) {
        while (hi < n - 1 && p >= x[hi]) hi++;
      } else {
        let lo = 0, h = n - 1;
        while (h - lo > 1) {
          const mid = (lo + h) >> 1;
          if (x[mid] <= p) lo = mid; else h = mid;
        }
        hi = h;
      }
      this.seg = hi;
    }
    const x0 = x[hi - 1], x1 = x[hi];
    const y0 = this.y[hi - 1], y1 = this.y[hi];
    if (y0 === y1) return y0;
    const u = x1 > x0 ? (p - x0) / (x1 - x0) : 1;
    const v = y0 + (y1 - y0) * gbShape(this.m[hi], u, this.t[hi]);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }
}

interface SlotRt {
  env: GbEnv;
  trig: number;
  pos: number;
  hold: number;
  link: boolean;
  one: boolean;
  /** Key-held: back to the previous slot when the MIDI key is released. */
  key: boolean;
}

function makeBank(): SlotRt[] {
  return Array.from({ length: GB_SLOTS }, () => ({ env: new GbEnv(), trig: 5, pos: 5, hold: 0, link: false, one: false, key: false }));
}

/** A slot lane (time or volume): the playing slot, a queued slot and where the envelope started. */
class Lane {
  cur = 0;
  pend = -1;
  trigAt = 0;
  /** Song beat at which the current envelope started, and its phase there. */
  start = 0;
  ph0 = 0;

  /** Start `slot` at song beat `at`: position sync picks the envelope phase. */
  begin(slot: number, at: number, bank: SlotRt[]): void {
    this.cur = slot;
    this.pend = -1;
    this.start = at;
    const q = GB_SYNC_BEATS[bank[slot].pos] ?? 0;
    this.ph0 = q > 0 ? at - Math.floor(at / q + 1e-9) * q : 0;
  }

  /** Queue a slot change at song beat b, at the new slot's trigger sync. */
  request(slot: number, b: number, bank: SlotRt[]): void {
    if (slot === this.cur && this.pend < 0) return;
    const q = GB_SYNC_BEATS[bank[slot].trig] ?? 0;
    this.pend = slot;
    this.trigAt = q > 0 ? Math.ceil(b / q - 1e-9) * q : b;
  }

  phase(b: number): number {
    const p = this.ph0 + (b - this.start);
    return p - Math.floor(p / GB_BAR) * GB_BAR;
  }
}

/** MIDI keys of the first time slot (C5) and the first volume slot (C2). */
export const GB_TIME_KEY = 60;
export const GB_VOL_KEY = 24;
const EVQ = 256;

// ---------------------------------------------------------- interpolation

/** 12-tap Kaiser-windowed sinc (beta 7), fitted to FL's measured read kernel. */
const HALF = 6;
const RES = 256;
const BETA = 7;
const KERNEL = (() => {
  const i0 = (x: number) => {
    let s = 1, t = 1;
    for (let k = 1; k < 60; k++) {
      t *= (x / (2 * k)) * (x / (2 * k));
      s += t;
      if (t < 1e-14 * s) break;
    }
    return s;
  };
  const n = HALF * RES + 2;
  const tab = new Float32Array(n);
  const norm = i0(BETA);
  for (let j = 0; j < n; j++) {
    const x = j / RES;
    if (x >= HALF) { tab[j] = 0; continue; }
    const s = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
    const r = x / HALF;
    tab[j] = s * (i0(BETA * Math.sqrt(1 - r * r)) / norm);
  }
  return tab;
})();

function kern(x: number): number {
  const ax = (x < 0 ? -x : x) * RES;
  const i = ax | 0;
  if (i >= KERNEL.length - 1) return 0;
  const f = ax - i;
  return KERNEL[i] + (KERNEL[i + 1] - KERNEL[i]) * f;
}

/** Click reduction time constants (s): Off, Low (drums), High (melodic). */
const DECLICK_TAU = [0, 0.00542, 0.00758];
/** A read-position change larger than this within one sample is a jump (samples). */
const JUMP = 32;
/** "Remove DC offset": one-pole DC blocker time constant (s), about 4 Hz. */
const DC_TAU = 0.0397;
/** Two-pole volume smoother: the displayed time is when a step has settled to ~1% (6.5 time constants). */
const SMOOTH_FACTOR = 6.5;
/** Scratch offset smoothing: three one-poles, faster while the offset grows. */
const SCRATCH_TAU_UP = 0.0249;
const SCRATCH_TAU_DOWN = 0.0374;
/** HQ resampling: speed follower time constant (s) and the widest kernel stretch. */
const SPEED_TAU = 0.0007;
const MAX_STRETCH = 4;
/** Ring capacity: two bars at this tempo (slower tempos clamp the reach). */
const MIN_TEMPO = 40;
/** Dry path delay line (latency compensation). */
const DRY_SIZE = 32;

class GrossBeat implements EffectInstance {
  latency = GB_LATENCY;
  tail = 4.5;

  private sr: number;
  private size: number;
  private bufL: Float32Array;
  private bufR: Float32Array;
  private dryL = new Float32Array(DRY_SIZE);
  private dryR = new Float32Array(DRY_SIZE);
  private dryW = 0;
  /** Absolute index of the next sample to write. */
  private w = 0;
  /** Reads before validFrom, or in [staleFrom, staleTo), are silence. */
  private validFrom = 0;
  private staleFrom = 0;
  private staleTo = 0;

  private tBank = makeBank();
  private vBank = makeBank();
  private tLane = new Lane();
  private vLane = new Lane();
  private reqT = 0;
  private reqV = 0;
  private slotsT: unknown = undefined;
  private slotsV: unknown = undefined;

  // parameters
  private tmix = 1;
  private vmix = 1;
  private attMs = 2;
  private relMs = 42.77;
  private tns = 0;
  private holdBtn = false;
  private scratchT = 0;
  private declick = 1;
  private comp = false;
  private dc = false;
  private hq = true;

  // smoothing state
  private kAtt = 1;
  private kRel = 1;
  private g1 = 1;
  private g2 = 1;
  private tmixS = 1;
  private vmixS = 1;
  private sc1 = 0;
  private sc2 = 0;
  private sc3 = 0;
  private kScUp: number;
  private kScDown: number;
  private kParam: number;
  private dclDecay: number[];
  private dclL = 0;
  private dclR = 0;
  private dcDecay: number;
  private dcxL = 0;
  private dcxR = 0;
  private dcyL = 0;
  private dcyR = 0;
  private kSpeed: number;
  private speed = 1;

  // transport
  private wasPlaying = false;
  private nextBeat = NaN;
  private dPrev = 0;
  private outPrevPlaying = false;
  private tempo = 0;

  // hold (bar repeat)
  // MIDI slot triggering
  private midiOn = true;
  private readonly evFrame = new Int32Array(EVQ);
  private readonly evKey = new Int16Array(EVQ);
  private readonly evOn = new Uint8Array(EVQ);
  private nEv = 0;
  /** Key-held slots: per key, the slot to go back to on release (-1 = none). */
  private readonly keyBack = new Int16Array(128).fill(-1);
  private changes: [string, unknown][] = [];

  private holdOn = false;
  private holdPend = 0;
  private holdAt = 0;
  private holdBar = 0;
  private holdW = 0;
  private frozen = false;

  // display
  private monOff = 0;
  private monTPh = -1;
  private monVPh = -1;
  private monGain = 1;
  private rdR = 0;

  constructor(sampleRate: number) {
    this.sr = sampleRate;
    this.size = Math.ceil(sampleRate * (60 / MIN_TEMPO) * GB_RANGE) + 4096;
    this.bufL = new Float32Array(this.size);
    this.bufR = new Float32Array(this.size);
    const k = (tau: number) => 1 - Math.exp(-1 / (tau * sampleRate));
    this.kParam = k(0.01);
    this.kScUp = k(SCRATCH_TAU_UP);
    this.kScDown = k(SCRATCH_TAU_DOWN);
    this.kSpeed = k(SPEED_TAU);
    this.dcDecay = 1 - 1 / (DC_TAU * sampleRate);
    this.dclDecay = DECLICK_TAU.map((tau) => (tau > 0 ? Math.exp(-1 / (tau * sampleRate)) : 0));
    this.updateSmoothers();
  }

  private updateSmoothers(): void {
    const k = (ms: number) => {
      const tau = (ms * this.sr) / 1000 / SMOOTH_FACTOR;
      return tau > 0.5 ? 1 - Math.exp(-1 / tau) : 1;
    };
    this.kAtt = k(this.attMs);
    this.kRel = k(this.relMs);
  }

  setParams(p: unknown): void {
    const q = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
    const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
    if (q.tslots !== this.slotsT) { this.slotsT = q.tslots; this.loadBank(this.tBank, q.tslots as GbSlot[] | undefined); }
    if (q.vslots !== this.slotsV) { this.slotsV = q.vslots; this.loadBank(this.vBank, q.vslots as GbSlot[] | undefined); }
    this.tmix = Math.min(1, Math.max(0, num(q.tmix, 256) / 256));
    this.vmix = Math.min(1, Math.max(0, num(q.vmix, 256) / 256));
    this.attMs = gbSmoothMs(num(q.att, 1765), 500);
    this.relMs = gbSmoothMs(num(q.rel, 5000), 1000);
    this.tns = Math.min(1, Math.max(-1, num(q.tns, 0) / 256));
    this.holdBtn = num(q.hold, 0) >= 0.5;
    this.scratchT = gbOffsetBeats(num(q.offset, 65536));
    const o = (q.opt && typeof q.opt === 'object' ? q.opt : {}) as Partial<GbOptions>;
    this.declick = o.declick === 0 || o.declick === 2 ? o.declick : 1;
    this.midiOn = o.midi !== false;
    this.comp = !!o.comp;
    this.dc = !!o.dc;
    this.hq = o.hq !== false;
    this.updateSmoothers();
    const ts = Math.min(GB_SLOTS - 1, Math.max(0, Math.round(num(q.tslot, 0))));
    const vs = Math.min(GB_SLOTS - 1, Math.max(0, Math.round(num(q.vslot, 0))));
    const tChanged = ts !== this.reqT, vChanged = vs !== this.reqV;
    if (tChanged) {
      this.reqT = ts;
      this.request(this.tLane, this.tBank, ts);
      // a linked time slot also picks the volume slot with its number
      if (this.tBank[ts].link && !vChanged && this.reqV !== ts) { this.reqV = ts; this.request(this.vLane, this.vBank, ts); }
    }
    if (vChanged) {
      this.reqV = vs;
      this.request(this.vLane, this.vBank, vs);
      if (this.vBank[vs].link && !tChanged && this.reqT !== vs) { this.reqT = vs; this.request(this.tLane, this.tBank, vs); }
    }
  }

  private request(lane: Lane, bank: SlotRt[], slot: number): void {
    if (!this.wasPlaying || !Number.isFinite(this.nextBeat)) { lane.cur = slot; lane.pend = -1; return; }
    lane.request(slot, this.nextBeat, bank);
  }

  private loadBank(bank: SlotRt[], slots: GbSlot[] | undefined): void {
    for (let i = 0; i < GB_SLOTS; i++) {
      const s = Array.isArray(slots) ? slots[i] : undefined;
      const b = bank[i];
      b.env.load(s?.pts);
      const idx = (v: unknown, hi: number, d: number) => (Number.isInteger(v) ? Math.min(hi, Math.max(0, v as number)) : d);
      b.trig = idx(s?.trig, 5, 5);
      b.pos = idx(s?.pos, 5, 5);
      b.hold = idx(s?.hold, 2, 0);
      b.link = !!s?.link;
      b.one = !!s?.one;
      b.key = !!s?.key;
    }
  }

  /** Windowed-sinc stereo read at absolute position pos (kernel widened by `stretch`); R goes to rdR. */
  private read(pos: number, stretch: number): number {
    const size = this.size, bl = this.bufL, br = this.bufR;
    const reach = HALF * stretch;
    const j0 = Math.ceil(pos - reach), j1 = Math.floor(pos + reach);
    const inv = 1 / stretch;
    let aL = 0, aR = 0, norm = 0;
    let k = j0 % size;
    if (k < 0) k += size;
    const vf = this.validFrom, s0 = this.staleFrom, s1 = this.staleTo;
    const clean = j0 >= vf && (j1 < s0 || j0 >= s1);
    for (let j = j0; j <= j1; j++) {
      const wgt = kern((j - pos) * inv);
      norm += wgt;
      if (clean || (j >= vf && (j < s0 || j >= s1))) { aL += bl[k] * wgt; aR += br[k] * wgt; }
      if (++k === size) k = 0;
    }
    if (norm === 0) { this.rdR = 0; return 0; }
    this.rdR = aR / norm;
    return aL / norm;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const tempo = ctx.tempo > 1 ? ctx.tempo : 120;
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    const spb = (this.sr * 60) / tempo;
    const ibps = 1 / spb;
    const playing = !!ctx.playing;
    const b0 = ctx.pos / ppq;
    if (tempo !== this.tempo) {
      this.tempo = tempo;
      this.tail = Math.min(12.5, Math.max(1, (GB_RANGE * 60) / tempo + 0.25));
    }
    // transport start: forget the buffered past (keep the last few samples so the
    // dry-aligned read continues); start or relocation: restart the envelopes. A loop
    // or a jump while playing keeps the buffer, which is a continuous audio stream.
    const started = playing && (!this.wasPlaying || !Number.isFinite(this.nextBeat));
    if (started) {
      this.validFrom = this.w - GB_LATENCY - HALF - 2;
      this.staleFrom = this.staleTo = 0;
    }
    if (started || (playing && Math.abs(b0 - this.nextBeat) > 1e-3 + 2 * ibps)) {
      this.tLane.begin(this.reqT, b0, this.tBank);
      this.vLane.begin(this.reqV, b0, this.vBank);
      this.holdOn = false;
      this.holdPend = 0;
      this.frozen = false;
    }
    const size = this.size, bl = this.bufL, br = this.bufR;
    const maxD = Math.max(0, Math.min(2 * GB_RANGE * spb, size - HALF * MAX_STRETCH - GB_LATENCY - 64));
    /** Beats a hold keeps intact behind the held bar: the envelope and scratch reach. */
    const holdKeep = (GB_BAR + 2 * GB_RANGE) * spb + 64;
    const tl = this.tLane, vl = this.vLane, tBank = this.tBank, vBank = this.vBank;
    const dcl = this.dclDecay[this.declick] ?? 0;
    const useDeclick = this.declick > 0;
    const comp = this.comp ? (this.attMs / 1000) * (tempo / 60) : 0;
    const hq = this.hq;
    const tension = this.tns * 0.5;
    const kp = this.kParam, kAtt = this.kAtt, kRel = this.kRel, kUp = this.kScUp, kDown = this.kScDown, kSp = this.kSpeed;
    const tmixT = this.tmix, vmixT = this.vmix, scT = this.scratchT;
    let dPrev = this.dPrev, g1 = this.g1, g2 = this.g2, tmixS = this.tmixS, vmixS = this.vmixS;
    let sc1 = this.sc1, sc2 = this.sc2, sc3 = this.sc3, dclL = this.dclL, dclR = this.dclR, speed = this.speed;
    let wasOut = this.outPrevPlaying;
    let lastOff = this.monOff, lastTPh = this.monTPh, lastVPh = this.monVPh;
    const dl = this.dryL, dr = this.dryR;

    let ev = 0;
    const nEv = this.nEv;
    for (let i = 0; i < n; i++) {
      const b = b0 + i * ibps;
      // MIDI notes select slots at their sample
      while (ev < nEv && this.evFrame[ev] <= i) { this.applyNote(this.evKey[ev], this.evOn[ev] === 1, b, playing); ev++; }
      const now = this.w;
      // dry path: the input delayed by the latency
      const dw = this.dryW;
      dl[dw] = L[i];
      dr[dw] = R[i];
      const di = (dw - GB_LATENCY + DRY_SIZE) % DRY_SIZE;
      this.dryW = (dw + 1) % DRY_SIZE;
      const xL = dl[di], xR = dr[di];
      // ring buffer (frozen while a long hold would overwrite the held bar)
      if (this.holdOn && !this.frozen && now - size >= this.holdW - GB_LATENCY - holdKeep) {
        this.frozen = true;
        this.staleFrom = now;
        this.staleTo = Number.MAX_SAFE_INTEGER;
      }
      if (!this.frozen) {
        const wi = now % size;
        bl[wi] = L[i];
        br[wi] = R[i];
      }
      this.w = now + 1;
      tmixS += (tmixT - tmixS) * kp;
      vmixS += (vmixT - vmixS) * kp;
      // scratch offset: three one-poles
      const ks = scT > sc3 ? kUp : kDown;
      sc1 += (scT - sc1) * ks;
      sc2 += (sc1 - sc2) * ks;
      sc3 += (sc2 - sc3) * ks;

      let d = 0, gainT = 1;
      if (playing) {
        if (tl.pend >= 0 && b >= tl.trigAt) tl.begin(tl.pend, tl.trigAt, tBank);
        if (vl.pend >= 0 && b >= vl.trigAt) vl.begin(vl.pend, vl.trigAt, vBank);
        // one-shot: back to the first slot once the envelope is done
        if (tBank[tl.cur].one && tl.ph0 + (b - tl.start) >= GB_BAR) tl.begin(0, b, tBank);
        if (vBank[vl.cur].one && vl.ph0 + (b - vl.start) >= GB_BAR) vl.begin(0, b, vBank);
        // hold: from the next bar line, repeat the bar before it ("Next": the bar after it)
        const mode = this.holdBtn ? 1 : tBank[tl.cur].hold;
        const want = mode > 0;
        if (want !== this.holdOn) {
          if (this.holdPend === 0) {
            this.holdPend = want ? 1 : -1;
            this.holdAt = Math.ceil(b / GB_BAR - 1e-9) * GB_BAR + (want && mode === 2 ? GB_BAR : 0);
          }
        } else this.holdPend = 0;
        if (this.holdPend !== 0 && b >= this.holdAt) {
          this.holdOn = this.holdPend > 0;
          this.holdPend = 0;
          if (this.holdOn) { this.holdBar = this.holdAt; this.holdW = now; } else if (this.frozen) {
            this.frozen = false;
            this.staleTo = now;
          }
        }
        const tph = tl.phase(b + comp);
        const vph = vl.phase(b);
        lastTPh = tph;
        lastVPh = vph;
        let off = (1 - tBank[tl.cur].env.at(tph)) * GB_RANGE + sc3;
        lastOff = off;
        d = off * spb;
        if (d > maxD) d = maxD;
        // a held bar is read again in every bar (FL's growing offset); the ring stops recording before it is overwritten
        if (this.holdOn) d += GB_BAR * (1 + Math.floor((b - this.holdBar) / GB_BAR + 1e-9)) * spb;
        let vv = vBank[vl.cur].env.at(vph);
        if (tension !== 0) vv = gbSingle(vv, tension);
        gainT = vv;
      }
      // time path
      let wetL: number, wetR: number;
      const delta = d - dPrev;
      if (playing !== wasOut) {
        // transport started / stopped: crossfade by click reduction from the previous output
        const oL = wasOut ? this.read(now - GB_LATENCY - dPrev, 1) : xL;
        const oR = wasOut ? this.rdR : xR;
        if (playing) { wetL = this.read(now - GB_LATENCY - d, 1); wetR = this.rdR; } else { wetL = xL; wetR = xR; }
        const nL = playing ? xL + (wetL - xL) * tmixS : xL, nR = playing ? xR + (wetR - xR) * tmixS : xR;
        const pL = wasOut ? xL + (oL - xL) * tmixS : xL, pR = wasOut ? xR + (oR - xR) * tmixS : xR;
        dclL += pL - nL;
        dclR += pR - nR;
        wasOut = playing;
      } else if (!playing) {
        wetL = xL;
        wetR = xR;
      } else if (delta > JUMP || delta < -JUMP) {
        // jump: the old read position plays one more sample, the difference decays
        const oL = this.read(now - GB_LATENCY - dPrev, 1);
        const oR = this.rdR;
        wetL = this.read(now - GB_LATENCY - d, 1);
        wetR = this.rdR;
        if (useDeclick) { dclL += (oL - wetL) * tmixS; dclR += (oR - wetR) * tmixS; }
      } else {
        let st = 1;
        if (hq) {
          const v = 1 - delta;
          speed += ((v < 0 ? -v : v) - speed) * kSp;
          st = speed > 1 ? (speed < MAX_STRETCH ? speed : MAX_STRETCH) : 1;
        }
        wetL = this.read(now - GB_LATENCY - d, st);
        wetR = this.rdR;
      }
      dPrev = d;
      const tm = playing ? tmixS : 0;
      let outL = xL + (wetL - xL) * tm + dclL;
      let outR = xR + (wetR - xR) * tm + dclR;
      dclL *= dcl;
      dclR *= dcl;
      if (dclL < 1e-10 && dclL > -1e-10) dclL = 0;
      if (dclR < 1e-10 && dclR > -1e-10) dclR = 0;
      // volume: two-pole follower, attack while rising
      const k = gainT > g2 ? kAtt : kRel;
      g1 += (gainT - g1) * k;
      g2 += (g1 - g2) * k;
      const g = 1 - vmixS + vmixS * g2;
      outL *= g;
      outR *= g;
      if (this.dc) {
        const yL = outL - this.dcxL + this.dcDecay * this.dcyL;
        const yR = outR - this.dcxR + this.dcDecay * this.dcyR;
        this.dcxL = outL; this.dcxR = outR;
        this.dcyL = yL < 1e-20 && yL > -1e-20 ? 0 : yL;
        this.dcyR = yR < 1e-20 && yR > -1e-20 ? 0 : yR;
        outL = yL; outR = yR;
      }
      L[i] = Number.isFinite(outL) ? outL : 0;
      R[i] = Number.isFinite(outR) ? outR : 0;
    }
    if (!Number.isFinite(dclL) || !Number.isFinite(dclR)) { dclL = 0; dclR = 0; }
    if (!Number.isFinite(g1) || !Number.isFinite(g2)) { g1 = 1; g2 = 1; }
    if (!Number.isFinite(this.dcyL) || !Number.isFinite(this.dcyR)) { this.dcyL = this.dcyR = this.dcxL = this.dcxR = 0; }
    this.dPrev = dPrev;
    this.g1 = g1; this.g2 = g2;
    this.tmixS = tmixS; this.vmixS = vmixS;
    this.sc1 = sc1; this.sc2 = sc2; this.sc3 = sc3;
    this.dclL = dclL; this.dclR = dclR; this.speed = speed;
    this.outPrevPlaying = wasOut;
    this.wasPlaying = playing;
    this.nextBeat = b0 + n * ibps;
    while (ev < nEv) { this.applyNote(this.evKey[ev], this.evOn[ev] === 1, b0 + n * ibps, playing); ev++; }
    this.nEv = 0;
    this.monOff = lastOff;
    this.monTPh = playing ? lastTPh : -1;
    this.monVPh = playing ? lastVPh : -1;
    this.monGain = g2;
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.dryL.fill(0);
    this.dryR.fill(0);
    this.validFrom = this.w;
    this.staleFrom = this.staleTo = 0;
    this.dPrev = 0;
    this.g1 = this.g2 = 1;
    this.tmixS = this.tmix;
    this.vmixS = this.vmix;
    this.sc1 = this.sc2 = this.sc3 = this.scratchT;
    this.dclL = this.dclR = 0;
    this.dcxL = this.dcxR = this.dcyL = this.dcyR = 0;
    this.speed = 1;
    this.wasPlaying = false;
    this.outPrevPlaying = false;
    this.nextBeat = NaN;
    this.holdOn = false;
    this.holdPend = 0;
    this.frozen = false;
    this.tLane.cur = this.reqT; this.tLane.pend = -1;
    this.vLane.cur = this.reqV; this.vLane.pend = -1;
  }

  // ------------------------------------------------------------ MIDI
  noteOn(key: number, _velocity: number, frameOffset: number): void { this.queueNote(key, frameOffset, true); }

  noteOff(key: number, frameOffset: number): void { this.queueNote(key, frameOffset, false); }

  allNotesOff(): void {
    this.nEv = 0;
    this.keyBack.fill(-1);
  }

  takeStateChanges(): [string, unknown][] | null {
    if (!this.changes.length) return null;
    const c = this.changes;
    this.changes = [];
    return c;
  }

  private queueNote(key: number, frame: number, on: boolean): void {
    if (key < 0 || key > 127) return;
    if (this.nEv >= EVQ) return;
    const i = this.nEv++;
    this.evFrame[i] = Math.max(0, frame | 0); this.evKey[i] = key; this.evOn[i] = on ? 1 : 0;
  }

  /** Note -> slot: C5.. time slots, C2.. volume slots (with trigger sync, Link slots and Key-held). */
  private applyNote(key: number, on: boolean, b: number, playing: boolean): void {
    if (!this.midiOn) return;
    const time = key >= GB_TIME_KEY && key < GB_TIME_KEY + GB_SLOTS;
    const vol = key >= GB_VOL_KEY && key < GB_VOL_KEY + GB_SLOTS;
    if (!time && !vol) return;
    const slot = key - (time ? GB_TIME_KEY : GB_VOL_KEY);
    if (on) {
      const bank = time ? this.tBank : this.vBank;
      const prev = time ? this.reqT : this.reqV;
      this.keyBack[key] = bank[slot].key && prev !== slot ? prev : -1;
      this.select(time, slot, b, playing);
      // a linked slot also picks the other kind's slot with its number
      if (bank[slot].link) this.select(!time, slot, b, playing);
    } else {
      const back = this.keyBack[key];
      this.keyBack[key] = -1;
      if (back < 0) return;
      // Key-held: back to the previous slot, if this key's slot is still the selected one
      if ((time ? this.reqT : this.reqV) !== slot) return;
      this.select(time, back, b, playing);
      if ((time ? this.tBank : this.vBank)[slot].link && (time ? this.reqV : this.reqT) === slot) this.select(!time, back, b, playing);
    }
  }

  private select(time: boolean, slot: number, b: number, playing: boolean): void {
    const lane = time ? this.tLane : this.vLane;
    const bank = time ? this.tBank : this.vBank;
    if (time) this.reqT = slot; else this.reqV = slot;
    if (!playing || !Number.isFinite(b)) { lane.cur = slot; lane.pend = -1; } else lane.request(slot, b, bank);
    const k = time ? 'tslot' : 'vslot';
    const j = this.changes.findIndex((c) => c[0] === k);
    if (j >= 0) this.changes[j][1] = slot; else this.changes.push([k, slot]);
  }

  monitor(): FxMonitor {
    return {
      playing: this.wasPlaying,
      tPlay: this.tLane.cur,
      vPlay: this.vLane.cur,
      tPend: this.tLane.pend,
      vPend: this.vLane.pend,
      tPh: this.monTPh,
      vPh: this.monVPh,
      off: this.monOff,
      gain: this.monGain,
      hold: this.holdOn,
    };
  }
}

export const effect: EffectModule = {
  id: 'grossbeat',
  create: (sampleRate) => new GrossBeat(sampleRate),
};
