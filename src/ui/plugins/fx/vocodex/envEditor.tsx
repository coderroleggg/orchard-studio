// Vocodex modulation-mapping editor: the band display (bands as bars on FL's
// frequency axis, a slowly falling peak curve) under the selected mapping
// envelope. Editing follows FL's envelope editors: drag points, right-click
// adds or deletes a point, drag the small circle between two points to bend
// the segment (tension), double-click it to straighten. Freeze, step
// editing (draw points), snap and slide are the toolbar switches.

import { useRef } from 'react';
import * as A from '../../../../store/actions';
import { setHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import {
  VCX_ENVELOPES, VCX_ENV, vcxDefaultEnvelopes, vcxEnvAt, vcxScaleHz, vcxScaleU, type VcxPoint,
} from '../../../../model/fx/plugins/vocodex';
import { AnimatedDisplay, useFxEditor, useFxMonitor } from '../../kit';

type Box = { x: number; y: number; w: number; h: number };
export interface EdTools { freeze: boolean; step: boolean; snap: boolean; slide: boolean }

const HEAD = 34; // header rows (band names, frequencies)
const PAD = 7;   // plot inset

const NAMES: [number, string][] = [[34, 'LOW BASS'], [84, 'BASS'], [258, 'LOW MID'], [500, 'MID'], [2000, 'UPPER MID'], [3900, 'PAS'], [5800, 'TREBLE']];
const FREQS: [number, string][] = [[20, '20'], [47, '50'], [100, '100'], [200, '200'], [500, '500'], [1000, '1k'], [2000, '2k'], [5000, '5k'], [10000, '10k']];

/** Value text of an envelope level for the hint (per target). */
function levelText(env: number, y: number, x: number): string {
  const db = (g: number) => (g <= 1e-6 ? '-inf dB' : `${(20 * Math.log10(g)).toFixed(1)} dB`);
  switch (env) {
    case VCX_ENV.gain: case VCX_ENV.modPass: return db((Math.pow(9, y) - 1) / 2);
    case VCX_ENV.pan: { const p = Math.round((2 * y - 1) * 100); return p === 0 ? 'Centered' : `${Math.abs(p)}% ${p < 0 ? 'left' : 'right'}`; }
    case VCX_ENV.offset: return `${Math.round((2 * y - 1) * 100)}%`;
    case VCX_ENV.noise: return (2 * y - 1).toFixed(2);
    case VCX_ENV.hold: case VCX_ENV.attack: case VCX_ENV.release: case VCX_ENV.width: return `x${Math.pow(8, 2 * y - 1).toFixed(3)}`;
    case VCX_ENV.distribution: return `${Math.round(vcxScaleHz(y))} Hz (band ${Math.round(x * 100)}%)`;
    case VCX_ENV.pitch: return `${((2 * y - 1) * 1200).toFixed(0)} cents`;
    case VCX_ENV.satMix: return `${Math.round(y * 100)}%`;
    default: return `${y.toFixed(3)}`;
  }
}

export function EnvEditor({ x, y, w, h, tools }: Box & { tools: EdTools }) {
  const { slotId, params } = useFxEditor();
  const envs = (params.envs as VcxPoint[][] | undefined) ?? vcxDefaultEnvelopes();
  const sel = typeof params.envSel === 'number' ? params.envSel : 0;
  const pts = envs[sel] ?? vcxDefaultEnvelopes()[sel];
  const nBands = typeof params.bands === 'number' ? params.bands : 47;
  const dist = envs[VCX_ENV.distribution];
  const st = useRef({ env: new Float32Array(100), pk: new Float32Array(100), last: 0 });
  const drag = useRef<{ kind: 'pt' | 'ten' | 'step'; i: number; id: number; x0: number; lastX: number } | null>(null);
  const ptsRef = useRef(pts);
  ptsRef.current = pts;
  useFxMonitor(slotId, (d) => {
    const b = d.bands as ArrayLike<number> | undefined;
    if (b && typeof b === 'object') for (let i = 0; i < Math.min(100, b.length); i++) st.current.env[i] = Number(b[i]) || 0;
  });

  const plotW = w - 2 * PAD, plotH = h - HEAD - PAD - 4;
  const px = (u: number) => PAD + u * plotW;
  const py = (v: number) => HEAD + 2 + (1 - v) * plotH;
  const toXY = (e: React.PointerEvent | React.MouseEvent, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const sx = ((e.clientX - r.left) / r.width) * w, sy = ((e.clientY - r.top) / r.height) * h;
    let u = Math.min(1, Math.max(0, (sx - PAD) / plotW)), v = Math.min(1, Math.max(0, 1 - (sy - HEAD - 2) / plotH));
    if (tools.snap) { u = Math.round(u * 64) / 64; v = Math.round(v * 32) / 32; }
    return { u, v, sx, sy };
  };
  const hitPoint = (sx: number, sy: number): number => {
    let best = -1, bd = 36;
    ptsRef.current.forEach((p, i) => { const d = (px(p[0]) - sx) ** 2 + (py(p[1]) - sy) ** 2; if (d < bd) { bd = d; best = i; } });
    return best;
  };
  const hitTension = (sx: number, sy: number): number => {
    const p = ptsRef.current;
    for (let i = 1; i < p.length; i++) {
      const xm = (p[i - 1][0] + p[i][0]) / 2;
      const ym = vcxEnvAt(p, xm);
      if ((px(xm) - sx) ** 2 + (py(ym) - sy) ** 2 < 30 && Math.abs(p[i][1] - p[i - 1][1]) > 0.01) return i;
    }
    return -1;
  };
  const edit = (label: string, f: (e: VcxPoint[]) => VcxPoint[], merge?: string) => {
    A.editFx(slotId, label, (p) => {
      const all = (Array.isArray(p.envs) ? (p.envs as VcxPoint[][]) : vcxDefaultEnvelopes()).map((e) => e.map((q) => [q[0], q[1], q[2]] as VcxPoint));
      all[sel] = f(all[sel] ?? []);
      p.envs = all;
    }, merge);
  };
  const hint = (u: number, v: number) => setHint(`${VCX_ENVELOPES[sel]}: ${levelText(sel, v, u)}`);

  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h}
      onPointerDown={(e) => {
        const el = e.currentTarget;
        const { u, v, sx, sy } = toXY(e, el);
        if (e.button === 2) {
          if (tools.freeze) return;
          const hp = hitPoint(sx, sy);
          if (hp > 0 && hp < ptsRef.current.length - 1) edit('Delete envelope point', (q) => q.filter((_, i) => i !== hp));
          else if (hp < 0) edit('Add envelope point', (q) => {
            const out = q.slice();
            let i = out.findIndex((p) => p[0] > u);
            if (i < 0) i = out.length;
            out.splice(i, 0, [u, v, 0]);
            return out;
          });
          return;
        }
        if (e.button !== 0 || tools.freeze) return;
        el.setPointerCapture(e.pointerId);
        const id = Date.now();
        const ti = hitTension(sx, sy);
        if (ti > 0) { drag.current = { kind: 'ten', i: ti, id, x0: sy, lastX: u }; return; }
        const hp = hitPoint(sx, sy);
        if (hp >= 0) { drag.current = { kind: 'pt', i: hp, id, x0: u, lastX: u }; hint(u, v); return; }
        if (tools.step) {
          drag.current = { kind: 'step', i: -1, id, x0: u, lastX: u };
          edit('Draw envelope', (q) => insertPoint(q, u, v), `vcx-env:${slotId}:${id}`);
        }
      }}
      onPointerMove={(e) => {
        const el = e.currentTarget;
        const { u, v, sy } = toXY(e, el);
        const d = drag.current;
        if (!d) { hint(u, vcxEnvAt(ptsRef.current, u)); return; }
        const merge = `vcx-env:${slotId}:${d.id}`;
        if (d.kind === 'pt') {
          edit('Move envelope point', (q) => {
            const out = q.map((p) => [p[0], p[1], p[2]] as VcxPoint);
            const i = d.i, last = out.length - 1;
            const lo = i === 0 ? 0 : out[i - 1][0], hi = i === last ? 1 : out[i + 1][0];
            let nx = i === 0 ? 0 : i === last ? 1 : Math.min(hi, Math.max(lo, u));
            if (tools.slide && i > 0 && i < last) {
              const dx = nx - out[i][0];
              const room = 1 - out[last - 1][0];
              const ddx = Math.min(dx, room);
              nx = out[i][0] + ddx;
              for (let j = i + 1; j < last; j++) out[j][0] = Math.min(1, out[j][0] + ddx);
            }
            out[i][0] = nx; out[i][1] = v;
            return out;
          }, merge);
          hint(u, v);
        } else if (d.kind === 'ten') {
          const dy = (d.x0 - sy) / 60;
          edit('Envelope tension', (q) => q.map((p, i) => (i === d.i ? [p[0], p[1], Math.max(-1, Math.min(1, p[2] + (q[i][1] > q[i - 1][1] ? -dy : dy)))] as VcxPoint : p)), merge);
          d.x0 = sy;
        } else if (d.kind === 'step' && Math.abs(u - d.lastX) > 1 / 96) {
          edit('Draw envelope', (q) => insertPoint(q, u, v), merge);
          d.lastX = u;
        }
      }}
      onPointerUp={() => { drag.current = null; }}
      onContextMenu={(e) => e.preventDefault()}
      frame={(g, W, H, t) => {
        const s = st.current;
        const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
        s.last = t;
        // background
        const bg = g.createRadialGradient(W * 0.5, H * 0.15, 10, W * 0.5, H * 0.4, W * 0.75);
        bg.addColorStop(0, '#2c4446'); bg.addColorStop(1, '#162326');
        g.fillStyle = bg; g.fillRect(0, 0, W, H);
        g.strokeStyle = 'rgba(0,0,0,0.6)'; g.strokeRect(0.5, 0.5, W - 1, H - 1);
        // header rows
        g.font = '600 8.5px system-ui, sans-serif'; g.textBaseline = 'middle';
        const cell = (x0: number, x1: number, y0: number, label: string) => {
          g.fillStyle = 'rgba(255,255,255,0.055)'; g.fillRect(x0 + 1, y0, Math.max(0, x1 - x0 - 2), 13);
          g.fillStyle = '#93a7ad'; g.fillText(label, x0 + 4, y0 + 7);
        };
        cell(PAD, px(vcxScaleU(NAMES[0][0])), 4, '');
        for (let i = 0; i < NAMES.length; i++) cell(px(vcxScaleU(NAMES[i][0])), i + 1 < NAMES.length ? px(vcxScaleU(NAMES[i + 1][0])) : W - PAD, 4, NAMES[i][1]);
        cell(PAD, px(vcxScaleU(FREQS[0][0])), 18, '');
        for (let i = 0; i < FREQS.length; i++) cell(px(vcxScaleU(FREQS[i][0])), i + 1 < FREQS.length ? px(vcxScaleU(FREQS[i + 1][0])) : W - PAD, 18, FREQS[i][1]);
        // bands
        const N = nBands;
        const fall = Math.pow(10, (-18 * dt) / 20);
        const us: number[] = [];
        for (let k = 0; k < N; k++) us.push(vcxEnvAt(dist, N > 1 ? k / (N - 1) : 0.5));
        const lvl = (e: number) => (e > 1e-6 ? Math.min(1, Math.max(0, (20 * Math.log10(e) + 54) / 54)) : 0);
        g.beginPath();
        for (let k = 0; k < N; k++) {
          const e = s.env[k] ?? 0;
          s.pk[k] = Math.max(e, (s.pk[k] ?? 0) * fall);
          const u = us[k];
          const ul = k > 0 ? (us[k - 1] + u) / 2 : u - (N > 1 ? (us[1] - us[0]) / 2 : 0.01);
          const ur = k < N - 1 ? (u + us[k + 1]) / 2 : u + (N > 1 ? (us[N - 1] - us[N - 2]) / 2 : 0.01);
          const x0 = px(Math.min(ul, ur)), x1 = px(Math.max(ul, ur));
          const bw = Math.max(1, x1 - x0 - (x1 - x0 > 5 ? 2 : 0));
          const f = lvl(e);
          if (f > 0) {
            const top = py(f * 0.95);
            const col = g.createLinearGradient(0, top, 0, py(0));
            col.addColorStop(0, `rgb(255,${Math.round(45 + 30 * (1 - f))},${Math.round(70 - 20 * f)})`);
            col.addColorStop(1, '#c42a5e');
            g.fillStyle = col;
            g.fillRect(x0 + (x1 - x0 - bw) / 2, top, bw, py(0) - top);
          }
          const pf = lvl(s.pk[k]);
          const pxk = px(u), pyk = py(pf * 0.95);
          if (k === 0) g.moveTo(pxk, pyk); else g.lineTo(pxk, pyk);
        }
        let anyPk = false;
        for (let k = 0; k < N; k++) if (lvl(s.pk[k]) > 0) { anyPk = true; break; }
        if (anyPk) { g.strokeStyle = 'rgba(160,50,95,0.85)'; g.lineWidth = 1.2; g.stroke(); }
        // middle line
        g.strokeStyle = 'rgba(200,230,235,0.18)'; g.lineWidth = 1;
        g.beginPath(); g.moveTo(PAD, py(0.5) + 0.5); g.lineTo(W - PAD, py(0.5) + 0.5); g.stroke();
        // envelope
        const p = ptsRef.current;
        g.fillStyle = 'rgba(110,240,230,0.08)';
        g.beginPath(); g.moveTo(px(0), py(0));
        for (let i = 0; i <= 200; i++) { const u = i / 200; g.lineTo(px(u), py(vcxEnvAt(p, u))); }
        g.lineTo(px(1), py(0)); g.closePath(); g.fill();
        g.strokeStyle = '#78ece5'; g.lineWidth = 1.6;
        g.beginPath();
        for (let i = 0; i <= 300; i++) { const u = i / 300; const yy = py(vcxEnvAt(p, u)); if (i === 0) g.moveTo(px(u), yy); else g.lineTo(px(u), yy); }
        g.stroke();
        for (let i = 1; i < p.length; i++) {
          if (Math.abs(p[i][1] - p[i - 1][1]) <= 0.01) continue;
          const xm = (p[i - 1][0] + p[i][0]) / 2;
          g.strokeStyle = '#78ece5'; g.lineWidth = 1.2;
          g.beginPath(); g.arc(px(xm), py(vcxEnvAt(p, xm)), 3.2, 0, Math.PI * 2); g.stroke();
        }
        g.fillStyle = '#ffffff';
        for (const q of p) { g.beginPath(); g.arc(px(q[0]), py(q[1]), 2.6, 0, Math.PI * 2); g.fill(); }
        if (tools.freeze) { g.fillStyle = 'rgba(160,210,255,0.07)'; g.fillRect(0, HEAD, W, H - HEAD); }
      }} />
  );
}

function insertPoint(q: VcxPoint[], u: number, v: number): VcxPoint[] {
  const out = q.slice();
  const near = out.findIndex((p) => Math.abs(p[0] - u) < 1 / 192);
  if (near > 0 && near < out.length - 1) { out[near] = [out[near][0], v, out[near][2]]; return out; }
  if (near === 0 || near === out.length - 1) { out[near] = [out[near][0], v, out[near][2]]; return out; }
  let i = out.findIndex((p) => p[0] > u);
  if (i < 0) i = out.length;
  out.splice(i, 0, [u, v, 0]);
  return out;
}

let clip: VcxPoint[] | null = null;

/** The envelope options menu (FL's envelope editor menu, the useful subset). */
export function envMenu(slotId: string, sel: number, at: { x: number; y: number }, current: VcxPoint[]): void {
  const edit = (label: string, f: (q: VcxPoint[]) => VcxPoint[]) => A.editFx(slotId, label, (p) => {
    const all = (Array.isArray(p.envs) ? (p.envs as VcxPoint[][]) : vcxDefaultEnvelopes()).map((x) => x.map((q) => [q[0], q[1], q[2]] as VcxPoint));
    all[sel] = f(all[sel] ?? []);
    p.envs = all;
  });
  openMenu(at.x, at.y, [
    { label: 'Copy state', onClick: () => { clip = current.map((q) => [q[0], q[1], q[2]] as VcxPoint); } },
    { label: 'Paste state', disabled: !clip, onClick: () => { const c = clip; if (c) edit('Paste envelope', () => c.map((q) => [q[0], q[1], q[2]] as VcxPoint)); } },
    { separator: true },
    { label: 'Flip vertically', onClick: () => edit('Flip envelope', (q) => q.map((p) => [p[0], 1 - p[1], -p[2]] as VcxPoint)) },
    { label: 'Normalize levels', onClick: () => edit('Normalize envelope', (q) => {
      const lo = Math.min(...q.map((p) => p[1])), hi = Math.max(...q.map((p) => p[1]));
      return hi - lo < 1e-6 ? q : q.map((p) => [p[0], (p[1] - lo) / (hi - lo), p[2]] as VcxPoint);
    }) },
    { label: 'Decimate points', onClick: () => edit('Decimate envelope', (q) => q.filter((_, i) => i === 0 || i === q.length - 1 || i % 2 === 0)) },
    { label: 'Turn all points smooth', onClick: () => edit('Smooth envelope', (q) => q.map((p) => [p[0], p[1], 0] as VcxPoint)) },
    { separator: true },
    { label: 'Reset', onClick: () => edit('Reset envelope', () => vcxDefaultEnvelopes()[sel]) },
  ]);
}
