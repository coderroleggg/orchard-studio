// Pitch Shifter X/Y pad (FL's ModVisual, 256 x 256): Pitch on the vertical
// axis, Formant (Voice) or Duration (Music) on the horizontal one. Left-click
// glides to the clicked point (and follows the mouse while held), right-click
// jumps there. The background is a scrolling spectrogram of the input
// (20 Hz .. 20 kHz bottom to top, current time at the right edge) in the
// engine's colours or monochrome; Speed is the time across the pad.

import { useRef } from 'react';
import { AnimatedDisplay, useFxEditor, useFxMonitor } from '../../kit';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { clearHint, setHint } from '../../../hint';
import { psDurationText, psSemiText } from '../../../../model/fx/plugins/pitchshifter';

const BG: [number, number, number] = [58, 68, 73];
const MAPS: Record<string, [number, number, number][]> = {
  voice: [BG, [22, 92, 118], [52, 176, 222], [150, 232, 255], [240, 255, 255]],
  music: [BG, [30, 88, 34], [70, 200, 50], [190, 240, 60], [255, 248, 140]],
  mono: [BG, [90, 98, 102], [150, 158, 162], [210, 214, 216], [250, 250, 250]],
};

function colour(map: [number, number, number][], t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (map.length - 1);
  const i = Math.min(map.length - 2, Math.floor(x)), f = x - i;
  const a = map[i], b = map[i + 1];
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

interface Glide {
  tx: number;
  ty: number;
  held: boolean;
  last: number;
}

export function XYPad({ x, y, size, music, color }: { x: number; y: number; size: number; music: boolean; color: string }) {
  const { slotId, params } = useFxEditor();
  const num = (k: string, d: number) => (typeof params[k] === 'number' ? (params[k] as number) : d);
  const pitch = num('pitch', 0), formant = num('formant', 0), dur = num('dur', 8500);
  const enabled = params.spectrum !== false;
  const mono = params.mono !== false;
  const speed = num('speed', 1000);
  // normalised cursor position
  const cx = music ? (dur - 2000) / 13000 : (formant + 1200) / 2400;
  const cy = 1 - (pitch + 1200) / 2400;
  const view = useRef({ cx, cy, music });
  view.current = { cx, cy, music };

  const spec = useRef<{ data: number[]; seq: number; drawn: number; off: HTMLCanvasElement | null; acc: number; last: number }>({ data: [], seq: 0, drawn: 0, off: null, acc: 0, last: 0 });
  useFxMonitor(slotId, (d) => {
    if (Array.isArray(d.spec) && typeof d.seq === 'number') { spec.current.data = d.spec as number[]; spec.current.seq = d.seq; }
  });

  const glide = useRef<Glide | null>(null);
  const raf = useRef(0);

  const apply = (nx: number, ny: number) => {
    const p = Math.round(Math.max(-1200, Math.min(1200, (1 - ny) * 2400 - 1200)));
    const isMusic = view.current.music;
    const hx = isMusic ? Math.round(2000 + Math.max(0, Math.min(1, nx)) * 13000) : Math.round(Math.max(-1200, Math.min(1200, nx * 2400 - 1200)));
    A.editFx(slotId, 'X / Y modulation', (q) => {
      q.pitch = p;
      if (isMusic) q.dur = hx; else q.formant = hx;
    }, `ps:${slotId}:xy`);
    setHint(`Pitch: ${psSemiText(p)}, ${isMusic ? `Duration: ${psDurationText(hx)}` : `Formant: ${psSemiText(hx)}`}`);
  };

  const step = (t: number) => {
    const g = glide.current;
    if (!g) return;
    const dt = Math.min(0.05, Math.max(0, (t - g.last) / 1000));
    g.last = t;
    const v = view.current;
    const k = 1 - Math.exp(-dt / 0.09);
    let nx = v.cx + (g.tx - v.cx) * k, ny = v.cy + (g.ty - v.cy) * k;
    const done = Math.abs(g.tx - nx) < 0.002 && Math.abs(g.ty - ny) < 0.002;
    if (done) { nx = g.tx; ny = g.ty; }
    view.current = { ...v, cx: nx, cy: ny };
    apply(nx, ny);
    if (done && !g.held) {
      glide.current = null;
      store.endGesture();
      return;
    }
    raf.current = requestAnimationFrame(step);
  };

  const local = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return [Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))];
  };

  return (
    <AnimatedDisplay x={x} y={y} w={size} h={size} className="ps-xy"
      onPointerDown={(e) => {
        e.stopPropagation();
        const [nx, ny] = local(e);
        if (e.button === 2) {
          // jump
          store.beginGesture('X / Y modulation');
          apply(nx, ny);
          store.endGesture();
          return;
        }
        if (e.button !== 0) return;
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        if (!glide.current) store.beginGesture('X / Y modulation');
        glide.current = { tx: nx, ty: ny, held: true, last: performance.now() };
        cancelAnimationFrame(raf.current);
        raf.current = requestAnimationFrame(step);
      }}
      onPointerMove={(e) => {
        const g = glide.current;
        const [nx, ny] = local(e);
        if (g && g.held) { g.tx = nx; g.ty = ny; return; }
        const p = Math.round((1 - ny) * 2400 - 1200);
        setHint(`X / Y modulation (pitch ${psSemiText(p)}): left-click glides, right-click jumps`);
      }}
      onPointerUp={() => { if (glide.current) glide.current.held = false; clearHint(); }}
      onContextMenu={(e) => e.preventDefault()}
      frame={(g, w, h, t) => {
        const s = spec.current;
        if (!s.off) { s.off = document.createElement('canvas'); s.off.width = 256; s.off.height = 256; const og = s.off.getContext('2d')!; og.fillStyle = colour(MAPS.mono, 0); og.fillRect(0, 0, 256, 256); }
        const off = s.off;
        const og = off.getContext('2d')!;
        const dt = s.last ? Math.min(0.2, (t - s.last) / 1000) : 0;
        s.last = t;
        if (enabled) {
          // scroll: Speed (ms) is the time across the pad
          s.acc += (dt * 256 * 1000) / Math.max(250, speed);
          const shift = Math.floor(s.acc);
          if (shift > 0) {
            s.acc -= shift;
            og.drawImage(off, -shift, 0);
            const map = mono ? MAPS.mono : music ? MAPS.music : MAPS.voice;
            const d = s.data;
            const n = d.length;
            if (n && s.seq !== s.drawn) s.drawn = s.seq;
            for (let b = 0; b < (n || 1); b++) {
              const v = n ? (d[b] + 84) / 72 : 0;
              const y0 = 256 - ((b + 1) / (n || 1)) * 256, y1 = 256 - (b / (n || 1)) * 256;
              og.fillStyle = colour(map, v);
              og.fillRect(256 - shift, Math.floor(y0), shift, Math.ceil(y1 - y0) + 1);
            }
          }
          g.imageSmoothingEnabled = true;
          g.drawImage(off, 0, 0, w, h);
        } else {
          g.fillStyle = 'rgb(58,68,73)';
          g.fillRect(0, 0, w, h);
        }
        // grid
        g.strokeStyle = 'rgba(20,26,29,0.55)';
        g.lineWidth = 1;
        g.beginPath();
        for (let i = 1; i < 4; i++) {
          const p = Math.round((i * w) / 4) + 0.5;
          g.moveTo(p, 0); g.lineTo(p, h);
          g.moveTo(0, p); g.lineTo(w, p);
        }
        g.stroke();
        // cursor
        const v = view.current;
        const px = v.cx * w, py = v.cy * h;
        g.beginPath();
        g.arc(px, py, 7, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fill();
        g.lineWidth = 1.6;
        g.strokeStyle = '#f2f6f7';
        g.stroke();
        g.beginPath();
        g.arc(px, py, 2.6, 0, Math.PI * 2);
        g.fillStyle = color;
        g.fill();
      }} />
  );
}
