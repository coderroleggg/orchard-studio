// X-Y Controller DSP, after FL's Fruity X-Y Controller (docs/research/fx/xyctrl.md).
// Once per song tick a target (starting in the bottom-left corner) moves
// toward the goal (X / Y Level) like a body with thrust and inertia:
//   thrust  = min((1 - damp) * speed, distance), along the direction to the goal
//   damp    = (1 - (1001^(acc/1024) - 1) / 1000)^(96/PPQ), 0 at full acceleration,
//             faded out within 0.3 of the goal
//   speed   = (1e8^(spd/2304) - 1) * 1e-8 + 1e-4 per tick (x 96/PPQ); full speed jumps
//   velocity = velocity * damp + direction * thrust; position += velocity
// Each axis goes through its tension curve and Min / Max (clamped to Min, then
// Max: a reversed range sticks at Max, as in FL) and is sent at FL's
// resolution. The audio passes through.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { CTRL_FULL, tensionCurve, tensionSpeed } from '../../../model/fx/ctrl';
import { TickClock } from '../../dsp/ticks';

class XYController implements EffectInstance {
  readonly tail = Infinity;
  private readonly sr: number;
  private readonly out = new Float64Array(2);
  private readonly pos = new Float64Array(2); // current target position 0..1 (x, y)
  private readonly vel = new Float64Array(2);
  private readonly goal = new Float64Array([0.5, 0.5]);
  private readonly lo = new Float64Array([0, 0]);
  private readonly hi = new Float64Array([65536, 65536]);
  private readonly tSign = new Float64Array(2);
  private readonly tK = new Float64Array(2);
  private speedRaw = 1536;
  private accelRaw = 1024;
  private thrust = 0;
  private damp = 0;
  private ratePpq = 0;
  private readonly clock = new TickClock();

  constructor(sr: number) {
    this.sr = sr;
  }

  setParams(p: unknown): void {
    const q = p as Record<string, unknown>;
    const n = (k: string, d: number) => (typeof q[k] === 'number' ? (q[k] as number) : d);
    this.goal[0] = n('xLevel', 32768) / 65536;
    this.goal[1] = n('yLevel', 32768) / 65536;
    this.lo[0] = n('xMin', 0); this.hi[0] = n('xMax', 65536);
    this.lo[1] = n('yMin', 0); this.hi[1] = n('yMax', 65536);
    const tx = n('xTension', 0), ty = n('yTension', 0);
    this.tSign[0] = Math.sign(tx); this.tK[0] = tensionSpeed(tx);
    this.tSign[1] = Math.sign(ty); this.tK[1] = tensionSpeed(ty);
    const s = n('speed', 1536), a = n('accel', 1024);
    if (s !== this.speedRaw || a !== this.accelRaw) { this.speedRaw = s; this.accelRaw = a; this.ratePpq = 0; }
  }

  private computeRates(ppq: number): void {
    const s = this.speedRaw, a = this.accelRaw;
    this.thrust = s >= 2048 ? 1 : ((Math.pow(1e8, s / 2304) - 1) * 1e-8 + 0.0001) * (96 / ppq);
    this.damp = a >= 1024 ? 0 : Math.pow(1 - (Math.pow(1001, a / 1024) - 1) * 0.001, 96 / ppq);
    this.ratePpq = ppq;
  }

  private tick(): void {
    const dx = this.goal[0] - this.pos[0], dy = this.goal[1] - this.pos[1];
    const dist = Math.sqrt(dx * dx + dy * dy);
    let damp = this.damp;
    if (dist < 0.3) damp *= 1 - (Math.exp((1 - dist * 3.3333333333333335) * 23.025850929940457) - 1) * 1e-10;
    const thrust = Math.min((1 - this.damp) * this.thrust, dist);
    const ux = dist > 0 ? dx / dist : 0, uy = dist > 0 ? dy / dist : 0;
    this.vel[0] = this.vel[0] * damp + ux * thrust;
    this.vel[1] = this.vel[1] * damp + uy * thrust;
    for (let i = 0; i < 2; i++) {
      this.pos[i] += this.vel[i];
      const lo = this.lo[i], hi = this.hi[i];
      let v = lo + Math.round(tensionCurve(this.pos[i], this.tSign[i], this.tK[i]) * (hi - lo));
      if (!(v > lo)) v = lo;
      if (v > hi) v = hi;
      this.out[i] = Math.round((v * CTRL_FULL) / 65536) / CTRL_FULL;
    }
  }

  process(_L: Float32Array, _R: Float32Array, n: number, ctx: FxContext): void {
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    if (ppq !== this.ratePpq) this.computeRates(ppq);
    const clock = this.clock;
    clock.setRate(this.sr, ctx.tempo, ppq);
    for (let i = 0; i < n;) {
      if (clock.due()) this.tick();
      i += clock.span(n - i);
    }
  }

  controls(): ArrayLike<number> {
    return this.out;
  }

  reset(): void {
    this.clock.reset();
  }

  monitor(): FxMonitor {
    return { x: this.pos[0], y: this.pos[1], ox: this.out[0], oy: this.out[1] };
  }
}

export const effect: EffectModule = {
  id: 'xyctrl',
  create: (sr) => new XYController(sr),
};
