// ZGameEditor Visualizer (reduced) effect renderers: Canvas 2D stand-ins for
// FL's ZGameEditor effects of the same names and parameter lists. Each layer
// draws into the shared frame (layer A first). Parameters are 0..1; "Alpha"
// is a transparency (0 = opaque) as in ZGameEditor's effects.

export interface ZgeAudio {
  bands: Float32Array; // 64 smoothed band levels 0..1
  wave: Float32Array; // 512 L then 512 R
  peak: number;
  rms: number;
  bass: number;
  mid: number;
  high: number;
}

export interface ZgeFrame {
  g: CanvasRenderingContext2D;
  w: number;
  h: number;
  t: number; // seconds
  dt: number;
  /** Pixel unit: frame height / 360 (effects are designed at 360 lines). */
  u: number;
  audio: ZgeAudio;
  text: string[];
  /** Scratch canvases shared by post-processing effects. */
  tmp: () => HTMLCanvasElement;
  tmp2: () => HTMLCanvasElement;
}

type Mem = Record<string, unknown>;
export type ZgeRenderer = (f: ZgeFrame, p: number[], mem: Mem) => void;

const TAU = Math.PI * 2;

function color(p: number[], alphaMul = 1, dl = 0): string {
  const a = Math.max(0, Math.min(1, (1 - (p[0] ?? 0)) * alphaMul));
  const h = ((p[1] ?? 0) * 360) % 360, s = (p[2] ?? 0) * 100, l = Math.max(0, Math.min(100, (p[3] ?? 0.5) * 100 + dl));
  return `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a.toFixed(3)})`;
}
const opacity = (p: number[]) => Math.max(0, Math.min(1, 1 - (p[0] ?? 0)));

/** Band level at fraction x (0..1) of the spectrum, interpolated. */
function band(a: ZgeAudio, x: number): number {
  const f = Math.max(0, Math.min(1, x)) * (a.bands.length - 1);
  const i = Math.floor(f), t = f - i;
  return a.bands[i] + ((a.bands[Math.min(a.bands.length - 1, i + 1)] ?? 0) - a.bands[i]) * t;
}

function rand(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

function selfCopy(f: ZgeFrame): HTMLCanvasElement {
  const c = f.tmp();
  const cg = c.getContext('2d')!;
  cg.globalCompositeOperation = 'copy';
  cg.globalAlpha = 1;
  cg.filter = 'none';
  cg.drawImage(f.g.canvas, 0, 0);
  cg.globalCompositeOperation = 'source-over';
  return c;
}

export const RENDERERS: Record<string, ZgeRenderer> = {
  none: () => {},

  solid: (f, p) => {
    f.g.fillStyle = color(p);
    f.g.fillRect(0, 0, f.w, f.h);
  },

  grid: (f, p) => {
    const { g, w, h, audio } = f;
    const cols = 4 + Math.round(p[6] * 60), rows = Math.max(2, Math.round((cols * h) / w));
    g.save();
    g.strokeStyle = color(p, 0.55 + audio.bass * 0.45);
    g.shadowColor = color(p, 1, 10);
    g.lineWidth = f.u;
    g.shadowBlur = (2 + p[4] * 14) * f.u;
    g.beginPath();
    for (let i = 0; i <= cols; i++) { const x = (i / cols) * w; g.moveTo(x, 0); g.lineTo(x, h); }
    g.stroke();
    g.shadowBlur = (2 + p[5] * 14) * f.u;
    g.beginPath();
    for (let j = 0; j <= rows; j++) { const y = (j / rows) * h; g.moveTo(0, y); g.lineTo(w, y); }
    g.stroke();
    g.restore();
  },

  stars: (f, p, mem) => {
    const { g, w, h, audio, dt } = f;
    let stars = mem.stars as Float32Array | undefined;
    const N = 320;
    const r = (mem.rand as (() => number) | undefined) ?? (mem.rand = rand(7)) as () => number;
    const spread = 0.15 + (1 - p[8]) * 0.85;
    if (!stars) {
      stars = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) { stars[i * 3] = (r() * 2 - 1) * spread; stars[i * 3 + 1] = (r() * 2 - 1) * spread; stars[i * 3 + 2] = 0.05 + r() * 0.95; }
      mem.stars = stars;
    }
    const speed = (0.1 + p[7] * 1.6 + audio.peak * p[10] * 3) * dt;
    const cx = p[5] * w, cy = (1 - p[6]) * h, scale = Math.min(w, h) * 0.5;
    g.save();
    g.strokeStyle = color(p);
    g.lineCap = 'round';
    for (let i = 0; i < N; i++) {
      const x = stars[i * 3], y = stars[i * 3 + 1];
      let z = stars[i * 3 + 2];
      const z0 = z;
      z -= speed;
      if (z < 0.03) { stars[i * 3] = (r() * 2 - 1) * spread; stars[i * 3 + 1] = (r() * 2 - 1) * spread; z = 1; stars[i * 3 + 2] = z; continue; }
      stars[i * 3 + 2] = z;
      const sx = cx + (x / z) * scale, sy = cy + (y / z) * scale;
      const tz = Math.min(1, z0 + speed * (1 + p[9] * 6));
      const px = cx + (x / tz) * scale, py = cy + (y / tz) * scale;
      g.lineWidth = Math.max(0.6, (1 - z) * 3 * (0.4 + p[4] * 1.6)) * f.u;
      g.beginPath();
      g.moveTo(px, py);
      g.lineTo(sx, sy);
      g.stroke();
    }
    g.restore();
  },

  linear: (f, p) => {
    const { g, w, h, audio } = f;
    const n = 8 + Math.round(p[7] * 120);
    const W = w * (0.3 + p[4] * 0.9), H = h * (0.2 + p[4] * 0.7);
    const gap = Math.min(0.9, p[10]);
    const power = 0.4 + p[11] * 1.8;
    const mirror = p[12] > 0.5;
    const bars = p[14] > 0.5;
    g.save();
    g.translate(p[5] * w, (1 - p[6]) * h + (mirror ? 0 : H / 2));
    g.rotate((p[8] - 0) * TAU);
    const grad = g.createLinearGradient(0, 0, 0, -H);
    grad.addColorStop(0, color(p));
    grad.addColorStop(1, color(p, 1, p[9] * 45));
    g.fillStyle = grad;
    const bw = W / n;
    const vals: number[] = [];
    for (let i = 0; i < n; i++) vals.push(Math.pow(band(audio, (i + 0.5) / n), 1 / power) * H * Math.min(1, audio.rms * 4 + 0.25));
    if (bars) {
      for (let i = 0; i < n; i++) {
        const x = -W / 2 + i * bw, v = vals[i];
        if (mirror) g.fillRect(x + (bw * gap) / 2, -v / 2, bw * (1 - gap), v);
        else g.fillRect(x + (bw * gap) / 2, -v, bw * (1 - gap), v);
      }
    } else {
      g.beginPath();
      g.moveTo(-W / 2, 0);
      for (let i = 0; i < n; i++) g.lineTo(-W / 2 + (i + 0.5) * bw, mirror ? -vals[i] / 2 : -vals[i]);
      g.lineTo(W / 2, 0);
      if (mirror) for (let i = n - 1; i >= 0; i--) g.lineTo(-W / 2 + (i + 0.5) * bw, vals[i] / 2);
      g.closePath();
      g.fill();
    }
    if (p[13] < 0.5 && !mirror) { g.fillStyle = color(p, 0.8, 20); g.fillRect(-W / 2, 0, W, 1.5 * f.u); }
    g.restore();
  },

  polar: (f, p) => {
    const { g, w, h, audio } = f;
    const n = 16 + Math.round(p[7] * 112);
    const R = p[4] * Math.min(w, h) * 0.5;
    const mag = p[10] * Math.min(w, h) * 0.45;
    g.save();
    g.translate(p[5] * w, (1 - p[6]) * h);
    g.rotate(p[13] * TAU + f.t * 0.1);
    g.strokeStyle = color(p);
    g.lineWidth = (0.5 + p[11] * 6) * f.u;
    g.lineCap = 'round';
    g.shadowColor = color(p, 1, 15);
    g.shadowBlur = p[12] * 18 * f.u;
    g.beginPath();
    for (let i = 0; i < n; i++) {
      let v = band(audio, i / n);
      v = v < p[9] ? 0 : (v - p[9]) / (1 - p[9] || 1);
      const a = (i / n) * TAU;
      const r0 = R, r1 = R + (p[8] > 0.5 ? -1 : 1) * v * mag;
      g.moveTo(Math.cos(a) * r0, Math.sin(a) * r0);
      g.lineTo(Math.cos(a) * r1, Math.sin(a) * r1);
    }
    g.stroke();
    g.restore();
  },

  wave: (f, p) => {
    const { g, w, h, audio } = f;
    const n = audio.wave.length / 2;
    const W = w * (0.3 + p[4] * 0.9), A = h * (0.1 + p[4] * 0.5);
    g.save();
    g.translate(p[5] * w, (1 - p[6]) * h);
    g.rotate(p[8] * TAU);
    g.strokeStyle = color(p);
    g.lineWidth = (0.5 + p[7] * 8) * f.u;
    g.lineJoin = 'round';
    g.beginPath();
    for (let i = 0; i < n; i++) {
      const v = (audio.wave[i] + audio.wave[n + i]) * 0.5;
      const x = -W / 2 + (W * i) / (n - 1), y = -v * A;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    g.stroke();
    g.restore();
  },

  vector: (f, p) => {
    const { g, w, h, audio } = f;
    const n = audio.wave.length / 2;
    const asp = Math.round(p[6] * 2);
    const sx = (asp === 2 ? w : asp === 1 ? Math.min(w, (h * 16) / 9) : Math.min(w, (h * 4) / 3)) * 0.5 * p[4];
    const sy = h * 0.5 * p[4];
    g.save();
    g.translate(w / 2, h / 2);
    g.lineWidth = (0.5 + p[5] * 6) * f.u;
    g.lineJoin = 'round';
    let px = 0, py = 0;
    for (let i = 0; i < n; i++) {
      const L = audio.wave[i], R = audio.wave[n + i];
      const x = (R - L) * 0.7 * sx, y = -(L + R) * 0.7 * sy;
      if (i) {
        const sp = Math.min(1, Math.hypot(x - px, y - py) / (40 * f.u));
        g.strokeStyle = p[7] > 0.5 ? `hsla(${((p[1] + sp * 0.5) * 360) % 360},${p[2] * 100}%,${p[3] * 100}%,${opacity(p)})` : color(p);
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(x, y);
        g.stroke();
      }
      px = x; py = y;
    }
    g.restore();
  },

  sphere: (f, p, mem) => {
    const { g, w, h, audio, dt } = f;
    const rot = ((mem.rot as number) ?? 0) + dt * (0.2 + p[7] * 3);
    mem.rot = rot;
    const react = (p[9] > 0.5 ? 0.3 : 1) * p[8];
    const R = p[4] * Math.min(w, h) * 0.38 * (1 + audio.bass * react * 0.6);
    const cx = p[5] * w, cy = (1 - p[6]) * h;
    g.save();
    g.beginPath();
    const n = 96;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * TAU;
      const r = R * (1 + band(audio, Math.abs(Math.sin(a * 2 + rot))) * react * 0.25);
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i) g.lineTo(x, y); else g.moveTo(x, y);
    }
    const gr = g.createRadialGradient(cx - R * 0.35 * Math.cos(rot), cy - R * 0.35, R * 0.05, cx, cy, R * 1.1);
    gr.addColorStop(0, color(p, 1, 40));
    gr.addColorStop(0.5, color(p));
    gr.addColorStop(1, color(p, 1, -35));
    g.fillStyle = gr;
    g.shadowColor = color(p, 0.8, 10);
    g.shadowBlur = 20 * audio.peak * f.u;
    g.fill();
    g.restore();
  },

  blobs: (f, p, mem) => {
    const { g, w, h, audio, dt } = f;
    const N = 40;
    let b = mem.b as Float32Array | undefined;
    if (!b) {
      const r = rand(13);
      b = new Float32Array(N * 4);
      for (let i = 0; i < N; i++) { b[i * 4] = r(); b[i * 4 + 1] = r(); b[i * 4 + 2] = r() * TAU; b[i * 4 + 3] = r(); }
      mem.b = b;
    }
    const sp = (0.02 + p[9] * 0.4) * dt;
    const S = p[4] * 1.6;
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < N; i++) {
      const o = i * 4;
      b[o + 2] += (b[o + 3] - 0.5) * dt * 2;
      b[o] = (b[o] + Math.cos(b[o + 2]) * sp + 1) % 1;
      b[o + 1] = (b[o + 1] + Math.sin(b[o + 2]) * sp + 1) % 1;
      const lv = band(audio, i / N);
      const rad = (4 + p[7] * 40) * (1 + lv * p[8] * 2.5) * f.u;
      const x = (p[5] - 0.5) * w + w / 2 + (b[o] - 0.5) * w * S, y = (0.5 - p[6]) * h + h / 2 + (b[o + 1] - 0.5) * h * S;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      const hue = [p[0], (p[1] + i * 0.023) % 1, p[2], p[3]];
      gr.addColorStop(0, color(hue, 0.9));
      gr.addColorStop(1, color(hue, 0));
      g.fillStyle = gr;
      g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
    }
    g.restore();
  },

  freqring: (f, p) => {
    const { g, w, h, audio, t } = f;
    const n = 40 + Math.round(p[11] * 220);
    const R = p[4] * Math.min(w, h) * 0.4;
    const lobes = 1 + Math.round(p[10] * 12);
    g.save();
    g.translate(p[5] * w, (1 - p[6]) * h);
    g.rotate(p[8] * TAU + t * 0.15);
    const ps = (0.6 + p[7] * 6) * f.u;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const v = band(audio, (Math.abs(Math.sin(a * lobes * 0.5)) * 0.8));
      const r = R * (1 + v * p[12] * 0.8 * Math.sin(a * lobes + t * 2));
      const hue = (p[1] + p[13] * (i / n) + t * p[14] * 0.2) % 1;
      g.fillStyle = `hsla(${hue * 360},${p[2] * 100}%,${p[3] * 100}%,${opacity(p)})`;
      g.beginPath();
      g.arc(Math.cos(a) * r, Math.sin(a) * r, ps * (0.6 + v), 0, TAU);
      g.fill();
    }
    g.restore();
  },

  tube: (f, p, mem) => {
    // rings of a polygonal tube flying toward the viewer (near ones first), alternating shades
    const { g, w, h, audio, dt } = f;
    let z0 = ((mem.z as number) ?? 0) + dt * (0.15 + p[4] * 1.6 + audio.bass * 0.4);
    let cyc = (mem.cyc as number) ?? 0;
    while (z0 >= 1) { z0 -= 1; cyc++; }
    mem.z = z0;
    mem.cyc = cyc;
    const cx = w / 2, cy = h / 2, maxR = Math.hypot(w, h);
    const rings = 22, sides = 10;
    g.save();
    for (let i = 1; i <= rings; i++) {
      const z = (i - z0) / rings;
      const r = Math.min(maxR, (Math.min(w, h) * 0.07) / Math.max(0.01, z));
      const lv = band(audio, Math.min(1, z * 1.2));
      const shade = (i + cyc) % 2 ? 1 : 0.55;
      const l = Math.min(85, p[3] * 100 * (0.45 + lv * 0.8) * shade * (1 - z * 0.85));
      g.fillStyle = `hsla(${((p[1] + (i + cyc) * 0.015) * 360) % 360},${(p[2] * 100).toFixed(1)}%,${l.toFixed(1)}%,${opacity(p)})`;
      g.beginPath();
      const twist = (i + cyc) * 0.12 + audio.mid * 0.4;
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * TAU + twist;
        const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r * 0.86;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.fill();
    }
    g.restore();
  },

  warpback: (f, p, mem) => {
    // feedback: last frame's image, zoomed / rotated around the position and faded, kept where brighter
    const { g, w, h } = f;
    let prev = mem.prev as HTMLCanvasElement | undefined;
    if (!prev || prev.width !== g.canvas.width || prev.height !== g.canvas.height) {
      prev = document.createElement('canvas');
      prev.width = g.canvas.width;
      prev.height = g.canvas.height;
      mem.prev = prev;
    }
    const k = 1 + (p[6] - 0.3) * 0.08;
    const cx = p[4] * w, cy = (1 - p[5]) * h;
    g.save();
    g.globalCompositeOperation = 'lighten';
    g.globalAlpha = opacity(p) * 0.94;
    g.translate(cx, cy);
    g.rotate((p[6] - 0.5) * 0.04);
    g.scale(k, k);
    g.translate(-cx, -cy);
    g.drawImage(prev, 0, 0, w, h);
    g.restore();
    if (p[2] > 0) { g.save(); g.globalCompositeOperation = 'color'; g.fillStyle = color([0, p[1], p[2], 0.5], p[2] * 0.5); g.fillRect(0, 0, w, h); g.restore(); }
    const pg = prev.getContext('2d')!;
    pg.globalCompositeOperation = 'copy';
    pg.drawImage(g.canvas, 0, 0);
  },

  text: (f, p) => {
    const { g, w, h, audio, text, t } = f;
    if (!text.length) return;
    const line = text[Math.round(p[8] * (text.length - 1))] ?? '';
    const size = Math.max(6, p[4] * h * 0.4);
    g.save();
    g.translate(p[5] * w, (1 - p[6]) * h);
    g.rotate((p[7] - 0.5) * Math.PI);
    g.font = `bold ${size.toFixed(1)}px "Trebuchet MS", Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillStyle = color(p);
    const jit = p[9] * audio.peak * size * 0.25;
    const r = rand(Math.floor(t * 20));
    g.fillText(line, (r() - 0.5) * jit, (r() - 0.5) * jit);
    g.restore();
  },

  blur: (f, p) => {
    if (p[0] <= 0.001) return;
    const c = selfCopy(f);
    f.g.save();
    f.g.globalCompositeOperation = 'copy';
    f.g.filter = `blur(${(p[0] * 12 * f.u).toFixed(2)}px)`;
    f.g.drawImage(c, 0, 0);
    f.g.restore();
  },

  rgbshift: (f, p) => {
    const { g, w, h } = f;
    const d = p[0] * 14 * f.u;
    if (d < 0.2) return;
    const src = selfCopy(f);
    const tmp = f.tmp2(), tg = tmp.getContext('2d')!;
    const a = p[1] * TAU;
    if (p[2] < 0.5) { g.save(); g.globalCompositeOperation = 'copy'; g.fillStyle = '#000'; g.fillRect(0, 0, w, h); g.restore(); } else g.clearRect(0, 0, w, h);
    const chans: [string, number][] = [['#ff0000', 1], ['#00ff00', 0], ['#0000ff', -1]];
    for (const [c, s] of chans) {
      tg.globalCompositeOperation = 'copy';
      tg.drawImage(src, 0, 0);
      tg.globalCompositeOperation = 'multiply';
      tg.fillStyle = c;
      tg.fillRect(0, 0, w, h);
      tg.globalCompositeOperation = 'destination-in';
      tg.drawImage(src, 0, 0);
      g.save();
      g.globalCompositeOperation = 'lighter';
      g.drawImage(tmp, Math.cos(a) * d * s, Math.sin(a) * d * s);
      g.restore();
    }
  },

  scanlines: (f, p) => {
    const { g, w, h } = f;
    const steps = [0, 2, 4, 8, 10, 16, 20, 24, 32, 40, 48, 64, 96, 128];
    const sx = steps[Math.round(p[0] * 13)] * f.u, sy = steps[Math.round(p[1] * 13)] * f.u;
    g.save();
    g.fillStyle = `rgba(0,0,0,${(0.25 + p[4] * 0.6).toFixed(3)})`;
    if (sy >= 1) for (let y = 0; y < h; y += sy) g.fillRect(0, y, w, Math.max(1, sy / 2));
    if (sx >= 1) for (let x = 0; x < w; x += sx) g.fillRect(x, 0, Math.max(1, sx / 2), h);
    for (const [k, horiz] of [[p[2], true], [p[3], false]] as const) {
      if (k <= 0) continue;
      const len = (horiz ? w : h) * k * 0.5;
      for (const side of [0, 1]) {
        const gr = horiz ? g.createLinearGradient(side ? w : 0, 0, side ? w - len : len, 0) : g.createLinearGradient(0, side ? h : 0, 0, side ? h - len : len);
        gr.addColorStop(0, 'rgba(0,0,0,1)');
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gr;
        if (horiz) g.fillRect(side ? w - len : 0, 0, len, h); else g.fillRect(0, side ? h - len : 0, w, len);
      }
    }
    g.restore();
  },

  vignette: (f, p) => {
    const { g, w, h } = f;
    const R = Math.hypot(w, h) / 2;
    const gr = g.createRadialGradient(w / 2, h / 2, Math.min(p[5], p[4]) * R, w / 2, h / 2, Math.max(p[4], p[5] + 0.01) * R);
    gr.addColorStop(0, color(p, 0));
    gr.addColorStop(1, color(p));
    g.fillStyle = gr;
    g.fillRect(0, 0, w, h);
  },
};
