// Peak Controller DSP, after FL's Fruity Peak Controller (docs/research/fx/peakctrl.md).
// FL runs the controller once per song tick (NewTick, PPQ ticks per beat at
// the current tempo, also while stopped): the audio between two ticks raises
// a peak follower (the larger of the |L| and |R| peaks, no threshold; FL's
// scan skips negative samples in the last n mod 8 frames of each render
// call, reproduced here), each tick computes
//   peak = base + amount * Tension(level, tension)
//   lfo  = lfoBase + lfoAmount * Tension((wave[phase] + 1) / 2, lfoTension)
// and sends Peak+LFO, Peak and LFO, each clamped to 0..1 (with Ramp on a
// value moves at most 1/8 per tick); then the level falls linearly by
// (10001^(decay/128) - 1) * 0.0192 per beat. The LFO reads FL's wavetables
// with a 32-bit phase stepped once per tick; while the song plays its phase
// is locked to the song position (phase knob + position * rate), re-synced
// when playback starts or jumps. Audio passes through unless Mute is on.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { amountFactor, decayPerBeat, tensionSpeed } from '../../../model/fx/plugins/peakctrl';
import { tensionCurve } from '../../../model/fx/ctrl';
import { FL_WAVES } from '../../dsp/flwavetables';

const FULL = 1073741824; // FL's controller resolution (2^30)
const RAMP_STEP = 0.125; // Ramp: at most 2^27 of 2^30 per tick
const HISTORY = 1024;

const shape = tensionCurve;

const q30 = (v: number) => Math.round(v * FULL) / FULL;

class PeakController implements EffectInstance {
  readonly tail = Infinity; // a controller runs all the time
  private readonly sr: number;
  // parameters (derived)
  private base = 0;
  private amount = amountFactor(179, false);
  private tSign = 0;
  private tK = 0;
  private decayBeat = decayPerBeat(66);
  private lfoBase = 0;
  private lfoAmount = 0;
  private lSign = 0;
  private lK = 0;
  private speed = 32950;
  private shapeIdx = 0;
  private phase0 = 0;
  private mute = false;
  private ramp = false;
  // state
  private level = 0;
  private phase = 0; // uint32 LFO phase
  private inc = 0; // phase increment per tick
  private incPpq = 0; // PPQ the increment was computed for
  private tickLeft = 0; // samples until the next tick
  private wasPlaying = false;
  private expectPos = NaN;
  private pos = 0; // song position (ticks) at the current tick
  private readonly out = new Float64Array(3); // sent values: Peak+LFO, Peak, LFO
  private started = false;
  // display history (one record per tick)
  private hLv = new Float32Array(HISTORY);
  private hPk = new Float32Array(HISTORY);
  private hLf = new Float32Array(HISTORY);
  private hSm = new Float32Array(HISTORY);
  private hBt = new Float32Array(HISTORY);
  private hWrite = 0;
  private hRead = 0;

  constructor(sr: number) {
    this.sr = sr;
  }

  setParams(p: unknown): void {
    const q = p as Record<string, number | boolean | undefined>;
    const n = (k: string, d: number) => (typeof q[k] === 'number' ? (q[k] as number) : d);
    this.base = n('base', 0) / 65536;
    this.amount = amountFactor(n('vol', 179), false);
    const t = n('tension', 0);
    this.tSign = Math.sign(t);
    this.tK = tensionSpeed(t);
    this.decayBeat = decayPerBeat(Math.min(128, Math.max(5, n('decay', 66))));
    this.lfoBase = n('lfoBase', 0) / 65536;
    this.lfoAmount = amountFactor(n('lfoVol', 0), true);
    const lt = n('lfoTension', 0);
    this.lSign = Math.sign(lt);
    this.lK = tensionSpeed(lt);
    const speed = n('lfoSpeed', 32950), shp = Math.round(Math.min(4, Math.max(0, n('lfoShape', 0))));
    const ph0 = Math.round(n('lfoPhase', 0));
    const resync = speed !== this.speed || shp !== this.shapeIdx || ph0 !== this.phase0;
    this.speed = speed;
    this.shapeIdx = shp;
    this.phase0 = ph0;
    this.mute = !!q.mute;
    this.ramp = !!q.ramp;
    if (resync) {
      this.incPpq = 0; // recompute the increment at the next block
      if (this.wasPlaying) this.expectPos = NaN; // FL re-syncs the phase to the song while playing
    }
  }

  /** Phase increment per tick: one cycle per period ticks (random: one table step per period). */
  private computeInc(ppq: number): void {
    const f = Math.fround(Math.fround(Math.pow(1001, this.speed / 65536)) - 1);
    let period = Math.round(Math.fround(Math.fround(Math.fround(f * (ppq >> 2)) / 48) * 24576) / 1000);
    if (this.shapeIdx === 4) period *= 16384;
    period = Math.max(3, period);
    this.inc = Math.floor(4294967296 / period) >>> 0;
    this.incPpq = ppq;
  }

  private send(i: number, v: number): void {
    let x = v <= 0 ? 0 : v >= 1 ? 1 : q30(v);
    if (this.ramp && this.started) {
      const last = this.out[i];
      if (x > last + RAMP_STEP) x = last + RAMP_STEP;
      else if (x < last - RAMP_STEP) x = last - RAMP_STEP;
    }
    this.out[i] = x;
  }

  private tick(ppq: number): void {
    const peak = this.base + this.amount * shape(this.level, this.tSign, this.tK);
    const w = FL_WAVES[this.shapeIdx][this.phase >>> 18];
    const lfo = this.lfoBase + this.lfoAmount * shape((w + 1) * 0.5, this.lSign, this.lK);
    this.phase = (this.phase + this.inc) >>> 0;
    this.send(0, peak + lfo);
    this.send(1, peak);
    this.send(2, lfo);
    this.started = true;
    // display record
    const h = this.hWrite;
    this.hLv[h] = this.level;
    this.hPk[h] = this.out[1];
    this.hLf[h] = this.out[2];
    this.hSm[h] = this.out[1] + this.out[2];
    this.hBt[h] = this.pos / ppq;
    this.hWrite = (h + 1) % HISTORY;
    if (this.hWrite === this.hRead) this.hRead = (this.hRead + 1) % HISTORY;
    this.level -= this.decayBeat / ppq;
    if (this.level < 0) this.level = 0;
  }

  process(L: Float32Array, R: Float32Array, n: number, ctx: FxContext): void {
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    if (ppq !== this.incPpq) this.computeInc(ppq);
    const spt = (this.sr * 60) / (Math.max(1, ctx.tempo) * ppq);
    // playback start or a jump: lock the LFO phase to the song position
    if (ctx.playing && (!this.wasPlaying || !(Math.abs(ctx.pos - this.expectPos) < 0.5))) {
      this.phase = ((this.phase0 * 65536) + Math.round(ctx.pos) * this.inc) % 4294967296 >>> 0;
    }
    this.pos = ctx.pos;
    let lv = this.level;
    let i = 0;
    while (i < n) {
      if (this.tickLeft <= 0) {
        this.level = lv;
        this.tick(ppq);
        lv = this.level;
        this.tickLeft += spt;
        if (ctx.playing) this.pos += 1;
      }
      const m = Math.min(n - i, Math.max(1, Math.ceil(this.tickLeft)));
      // FL's peak scan (one call per tick-split render): |x| over whole groups of 8 frames,
      // the remaining frames compared without the absolute value (negative samples are skipped)
      const e8 = i + (m & ~7), e = i + m;
      for (let k = i; k < e8; k++) {
        const a = L[k] < 0 ? -L[k] : L[k];
        const b = R[k] < 0 ? -R[k] : R[k];
        if (a > lv) lv = a;
        if (b > lv) lv = b;
      }
      for (let k = e8; k < e; k++) {
        if (L[k] > lv) lv = L[k];
        if (R[k] > lv) lv = R[k];
      }
      this.tickLeft -= m;
      i += m;
    }
    this.level = Number.isFinite(lv) ? lv : 0;
    this.wasPlaying = ctx.playing;
    this.expectPos = ctx.pos + n / spt;
    if (this.mute) { L.fill(0, 0, n); R.fill(0, 0, n); }
  }

  controls(): ArrayLike<number> {
    return this.out;
  }

  reset(): void {
    this.level = 0;
    this.tickLeft = 0;
  }

  monitor(): FxMonitor {
    const lv: number[] = [], pk: number[] = [], lf: number[] = [], sm: number[] = [], bt: number[] = [];
    let r = this.hRead;
    while (r !== this.hWrite && lv.length < 512) {
      lv.push(this.hLv[r]); pk.push(this.hPk[r]); lf.push(this.hLf[r]); sm.push(this.hSm[r]); bt.push(this.hBt[r]);
      r = (r + 1) % HISTORY;
    }
    this.hRead = r;
    return { lv, pk, lf, sm, bt, out: this.out[0] };
  }
}

export const effect: EffectModule = {
  id: 'peakctrl',
  create: (sr) => new PeakController(sr),
};
