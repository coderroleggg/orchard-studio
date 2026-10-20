// Formula Controller DSP, after FL's Fruity Formula Controller: once per song
// tick the compiled formula is evaluated with a, b, c (knobs / 65536),
// SongTime (song position in quarter notes at the tick), Time (ms), the tempo
// and the mouse; the result is rounded to single precision, clamped to 0..1
// (NaN gives 0) and sent at FL's 2^30 resolution. An invalid formula sends
// nothing. The audio passes through untouched.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { compileFormula, type FormulaEnv, type FormulaFn } from '../../../model/formula';
import { TickClock } from '../../dsp/ticks';

const FULL = 1073741824;
const HISTORY = 1024;

class FormulaController implements EffectInstance {
  readonly tail = Infinity;
  private readonly sr: number;
  private readonly out = new Float64Array(1);
  private fn: FormulaFn | null = null;
  private formula: string | null = null;
  private readonly env: FormulaEnv = { a: 0, b: 0, c: 0, songTime: 0, time: 0, tempo: 120 };
  private clock = new TickClock();
  private hist = new Float32Array(HISTORY);
  private hBeat = new Float32Array(HISTORY);
  private hWrite = 0;
  private hRead = 0;

  constructor(sr: number) {
    this.sr = sr;
  }

  setParams(p: unknown): void {
    const q = p as Record<string, unknown>;
    const n = (k: string) => (typeof q[k] === 'number' ? (q[k] as number) : 0) / 65536;
    this.env.a = n('a');
    this.env.b = n('b');
    this.env.c = n('c');
    const f = typeof q.formula === 'string' ? q.formula : '';
    if (f !== this.formula) {
      this.formula = f;
      const r = compileFormula(f);
      this.fn = r.ok ? r.fn : null;
    }
  }

  process(_L: Float32Array, _R: Float32Array, n: number, ctx: FxContext): void {
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    this.env.tempo = ctx.tempo;
    const clock = this.clock;
    clock.setRate(this.sr, ctx.tempo, ppq);
    for (let i = 0; i < n;) {
      if (clock.due()) this.tick(ctx.playing ? ctx.pos + i / clock.spt : ctx.pos, ppq);
      i += clock.span(n - i);
    }
  }

  private tick(pos: number, ppq: number): void {
    const fn = this.fn;
    if (!fn) return;
    const env = this.env;
    env.songTime = pos / ppq;
    env.time = Date.now();
    const raw = Math.fround(fn(env));
    this.out[0] = raw > 1 ? 1 : raw >= 0 ? Math.round(raw * FULL) / FULL : 0; // NaN -> 0
    const h = this.hWrite;
    this.hist[h] = Number.isFinite(raw) ? raw : 0;
    this.hBeat[h] = env.songTime;
    this.hWrite = (h + 1) % HISTORY;
    if (this.hWrite === this.hRead) this.hRead = (this.hRead + 1) % HISTORY;
  }

  controls(): ArrayLike<number> {
    return this.out;
  }

  reset(): void {
    this.clock.reset();
  }

  monitor(): FxMonitor {
    const v: number[] = [], bt: number[] = [];
    let r = this.hRead;
    while (r !== this.hWrite && v.length < 512) { v.push(this.hist[r]); bt.push(this.hBeat[r]); r = (r + 1) % HISTORY; }
    this.hRead = r;
    return { v, bt, out: this.out[0], ok: this.fn !== null };
  }
}

export const effect: EffectModule = {
  id: 'formulactrl',
  create: (sr) => new FormulaController(sr),
};
