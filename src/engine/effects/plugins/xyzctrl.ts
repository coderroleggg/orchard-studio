// X-Y-Z Controller DSP, after FL's Fruity X-Y-Z Controller (docs/research/fx/xyzctrl.md).
// Once per song tick, for each axis: target = input mapping(value); a
// smoother of three cascaded one-pole stages follows the target (stage
// coefficient 100^(-1/T), T = time / sqrt(poles), the last stage scaled by the
// fractional pole count, unused stages pass through), snapping onto the
// target when within 1.5e-6; the output mapping curve then gives the sent
// value. time = (17^(global/4096) - 1) * 24 * PPQ/96 ticks * the axis
// smoothing speed factor ((3^(speed/2048) - 1) / 2, 1 at the centre);
// poles = acceleration / 1024 (0..3). Global speed 0 = instant. The audio
// passes through.

import type { EffectInstance, EffectModule, FxContext, FxMonitor } from '../types';
import { CTRL_FULL } from '../../../model/fx/ctrl';
import { evalEnvelope, type AutoPoint } from '../../../model/automation';
import { linearMap } from '../../../model/fx/plugins/xyzctrl';
import { TickClock } from '../../dsp/ticks';

const KEYS = ['x', 'y', 'z'] as const;

interface Axis {
  value: number; // control value 0..1
  target: number;
  out: number; // smoothed (before the output mapping)
  base: number;
  s: Float64Array; // 3 stage states (relative to base)
  c: Float64Array; // 3 stage coefficients
  speed: number;
  acc: number;
  inMap: AutoPoint[];
  outMap: AutoPoint[];
}

function sorted(m: unknown): AutoPoint[] {
  if (!Array.isArray(m) || m.length < 2) return linearMap();
  return (m as AutoPoint[]).map((p) => ({ ...p })).sort((a, b) => a.pos - b.pos);
}

class XYZController implements EffectInstance {
  readonly tail = Infinity;
  private readonly sr: number;
  private readonly sent = new Float64Array(3);
  private readonly axes: Axis[] = KEYS.map(() => ({
    value: 0.5, target: 0.5, out: 0.5, base: 0.5, s: new Float64Array(3), c: new Float64Array(3), speed: 2048, acc: 3072,
    inMap: linearMap(), outMap: linearMap(),
  }));
  private globalSpeed = 2048;
  private coefPpq = 0;
  private started = false;
  private readonly clock = new TickClock();

  constructor(sr: number) {
    this.sr = sr;
  }

  setParams(p: unknown): void {
    const q = p as Record<string, unknown>;
    const n = (k: string, d: number) => (typeof q[k] === 'number' ? (q[k] as number) : d);
    const g = n('globalSpeed', 2048);
    let coefs = g !== this.globalSpeed;
    this.globalSpeed = g;
    const inMaps = Array.isArray(q.inMap) ? q.inMap : [], outMaps = Array.isArray(q.outMap) ? q.outMap : [];
    this.axes.forEach((a, i) => {
      a.value = n(`${KEYS[i]}Value`, 32768) / 65536;
      const sp = n(`${KEYS[i]}Speed`, 2048), ac = n(`${KEYS[i]}Acc`, 3072);
      if (sp !== a.speed || ac !== a.acc) { a.speed = sp; a.acc = ac; coefs = true; }
      a.inMap = sorted(inMaps[i]);
      a.outMap = sorted(outMaps[i]);
      a.target = Math.min(1, Math.max(0, evalEnvelope(a.inMap, a.value)));
      // FL snaps the smoothers onto the targets when a state is loaded
      if (!this.started) this.resetAxis(a, a.target);
    });
    if (coefs) this.coefPpq = 0;
  }

  private resetAxis(a: Axis, v: number): void {
    a.base = v;
    a.out = v;
    a.s.fill(0);
  }

  private computeCoefs(ppq: number): void {
    const tg = (Math.pow(17, this.globalSpeed / 4096) - 1) * 24 * (ppq / 96);
    for (const a of this.axes) {
      const v = a.speed / 2048;
      const f = v === 1 ? 1 : (Math.pow(3, v) - 1) * 0.5;
      const time = tg * f;
      const poles = a.acc / 1024;
      const cnt = Math.round(poles + 0.49999999999999983);
      const per = poles > 0 ? time / Math.sqrt(poles) : 0;
      for (let k = 0; k < 3; k++) {
        const t = k < cnt - 1 ? per : k < cnt ? per * (1 - (cnt - poles)) : 0;
        a.c[k] = t > 0 ? Math.exp(-4.605170185988091 / t) : 0; // 100^(-1/T): T ticks to fall 40 dB
      }
    }
    this.coefPpq = ppq;
  }

  private tick(): void {
    for (let i = 0; i < 3; i++) {
      const a = this.axes[i];
      const d = a.target - a.base;
      const s = a.s, c = a.c;
      s[0] = d + (s[0] - d) * c[0];
      s[1] = s[0] + (s[1] - s[0]) * c[1];
      s[2] = s[1] + (s[2] - s[1]) * c[2];
      a.out = a.base + s[2];
      if (Math.abs(a.out - a.target) < 1.52587890625e-6) this.resetAxis(a, a.target);
      const m = evalEnvelope(a.outMap, a.out);
      const v = Math.round(m * CTRL_FULL);
      this.sent[i] = (v <= 0 ? 0 : v >= CTRL_FULL ? CTRL_FULL : v) / CTRL_FULL;
    }
  }

  process(_L: Float32Array, _R: Float32Array, n: number, ctx: FxContext): void {
    this.started = true;
    const ppq = ctx.ppq > 0 ? ctx.ppq : 96;
    if (ppq !== this.coefPpq) this.computeCoefs(ppq);
    const clock = this.clock;
    clock.setRate(this.sr, ctx.tempo, ppq);
    for (let i = 0; i < n;) {
      if (clock.due()) this.tick();
      i += clock.span(n - i);
    }
  }

  controls(): ArrayLike<number> {
    return this.sent;
  }

  reset(): void {
    for (const a of this.axes) this.resetAxis(a, a.target);
    this.clock.reset();
  }

  monitor(): FxMonitor {
    const [x, y, z] = this.axes;
    return { x: x.out, y: y.out, z: z.out, ox: this.sent[0], oy: this.sent[1], oz: this.sent[2] };
  }
}

export const effect: EffectModule = {
  id: 'xyzctrl',
  create: (sr) => new XYZController(sr),
};
