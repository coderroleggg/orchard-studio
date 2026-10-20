// Sytrus harmonics editor (FL: HarmPanel at 5, 148, shown for an operator's OSC
// target): the big waveform scope, the harmonics' magnitudes and phases (paint
// with the left button, erase with the right; 64 shown at a time, the scroller
// moves through the 256), the options menu (a subset of FL's) and SMOOTH.

import { useRef } from 'react';
import { store } from '../../../../store';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { Display } from '../../kit';
import type { Draft } from 'immer';
import type { SyOp } from '../../../../model/gen/plugins/sytrus/types';
import { OpScope } from './OpPage';
import { useSy, useSyEdit, useSyView } from './state';
import { C, FONT } from './theme';

const W = 533, ROW_H = 59, N = 64, MAXH = 256;
const BW = W / N;

const trim = (a: number[]) => { while (a.length && a[a.length - 1] === 0) a.pop(); return a; };

/** Lanczos sigma per harmonic (attenuates the high harmonics' ringing). */
function sigma(n: number, k: number): number {
  const x = (Math.PI * (k + 1)) / (n + 1);
  return Math.sin(x) / x;
}

function Bars({ y, values, color, off, label, onPaint }: {
  y: number; values: number[]; color: string; off: number; label: string;
  onPaint: (from: [number, number], to: [number, number]) => void;
}) {
  const last = useRef<[number, number] | null>(null);
  const erase = useRef(false);
  const at = (e: React.PointerEvent): [number, number] => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const k = r.width / W || 1;
    const px = (e.clientX - r.left) / k, py = (e.clientY - r.top) / k;
    const h = Math.max(0, Math.min(MAXH - 1, off + Math.floor(px / BW)));
    return [h, erase.current ? 0 : Math.max(0, Math.min(1, 1 - py / ROW_H))];
  };
  const hint = (h: number) => setHint(`Harmonic ${h + 1} ${label}: ${Math.round(Math.abs(values[h] ?? 0) * 100)}%`);
  return (
    <Display x={0} y={y} w={W} h={ROW_H} deps={[values, off, color]}
      draw={(g) => {
        g.fillStyle = C.harmBg;
        g.fillRect(0, 0, W, ROW_H);
        for (let i = 0; i < N; i++) {
          const h = off + i;
          if ((h + 1) % 8 === 0) { g.fillStyle = '#1d1f24'; g.fillRect(i * BW, 0, BW, ROW_H); }
          const v = Math.min(1, Math.abs(values[h] ?? 0));
          if (v > 0) {
            g.fillStyle = color;
            g.fillRect(Math.round(i * BW) + 1, Math.round(ROW_H * (1 - v)), Math.max(1, Math.round(BW) - 2), Math.round(ROW_H * v));
          }
        }
      }}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        erase.current = e.button === 2;
        store.beginGesture(`Harmonics ${label}`);
        const p = at(e);
        last.current = p;
        onPaint(p, p);
        hint(p[0]);
      }}
      onPointerMove={(e) => {
        const p = at(e);
        if (last.current) { onPaint(last.current, p); last.current = p; }
        hint(p[0]);
      }}
      onPointerUp={() => { if (last.current) { last.current = null; store.endGesture(); } }}
      onContextMenu={(e) => e.preventDefault()} />
  );
}

export function Harmonics({ n }: { n: number }) {
  const sy = useSy();
  const edit = useSyEdit();
  const [view, setView] = useSyView();
  const op = sy.ops[n];
  const off = Math.max(0, Math.min(MAXH - N, view.harm));
  const O = `Operator ${n + 1}`;
  const paint = (field: 'amp' | 'ph') => ([h0, v0]: [number, number], [h1, v1]: [number, number]) => edit(`${O} - harmonics`, (s) => {
    const a = s.ops[n][field];
    const lo = Math.min(h0, h1), hi = Math.max(h0, h1);
    while (a.length <= hi) a.push(0);
    for (let h = lo; h <= hi; h++) a[h] = h0 === h1 ? v1 : Math.round((v0 + ((v1 - v0) * (h - h0)) / (h1 - h0)) * 1e4) / 1e4;
    trim(a);
  });
  const act = (label: string, fn: (o: Draft<SyOp>) => void) => edit(`${O} - ${label}`, (s) => { fn(s.ops[n]); trim(s.ops[n].amp); trim(s.ops[n].ph); });
  const smooth = (hard: boolean) => act(hard ? 'Smooth up (hard)' : 'Smooth up (soft)', (o) => {
    const m = o.amp.length;
    o.amp = o.amp.map((v, k) => v * (hard ? sigma(m, k) ** 2 : sigma(m, k)));
  });
  const menu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { label: 'Reset (sine)', onClick: () => act('Reset harmonics', (o) => { o.amp = [1]; o.ph = []; }) },
    { separator: true },
    {
      label: 'Transpose one octave up', onClick: () => act('Transpose one octave up', (o) => {
        const a: number[] = [], p: number[] = [];
        o.amp.forEach((v, k) => { if (2 * k + 1 < MAXH) a[2 * k + 1] = v; });
        o.ph.forEach((v, k) => { if (2 * k + 1 < MAXH) p[2 * k + 1] = v; });
        o.amp = Array.from(a, (v) => v ?? 0);
        o.ph = Array.from(p, (v) => v ?? 0);
      }),
    },
    { label: 'Shift left', onClick: () => act('Shift left', (o) => { o.amp = o.amp.slice(1); o.ph = o.ph.slice(1); }) },
    { label: 'Shift right', onClick: () => act('Shift right', (o) => { o.amp = [0, ...o.amp].slice(0, MAXH); o.ph = o.ph.length ? [0, ...o.ph].slice(0, MAXH) : []; }) },
    { label: 'Smooth up (soft)', onClick: () => smooth(false) },
    { label: 'Smooth up (hard)', onClick: () => smooth(true) },
    { separator: true },
    { label: 'Reset phases', onClick: () => act('Reset phases', (o) => { o.ph = []; }) },
    { label: 'Randomize phases', onClick: () => act('Randomize phases', (o) => { o.ph = o.amp.map(() => Math.round(Math.random() * 1e4) / 1e4); }) },
  ]);
  const trackW = 456, thumbW = (N / MAXH) * trackW;
  const drag = useRef<{ x0: number; off0: number } | null>(null);
  return (
    <div style={{ position: 'absolute', left: 5, top: 148, width: W, height: 196, background: C.harmBg }}>
      <OpScope x={0} y={0} w={W} h={ROW_H} op={op} gibbs={!!sy.g.gibbs} bg={C.bigScopeBg} />
      <Bars y={60} values={op.amp} color={C.orange} off={off} label="magnitude" onPaint={paint('amp')} />
      <Bars y={120} values={op.ph} color="#9fb4c8" off={off} label="phase" onPaint={paint('ph')} />
      <div style={{ position: 'absolute', left: 0, top: 180, width: 77, height: 16, background: '#353029' }} />
      <div style={{ position: 'absolute', left: 0, top: 180, width: 15, height: 16, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); menu(e); } }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={10} height={8} viewBox="0 0 10 8"><path d="M1 1 L9 1 L5 7 Z" fill="#c7b08f" /></svg>
      </div>
      <div style={{ position: 'absolute', left: 35, top: 181, width: 41, height: 14, borderRadius: 2, background: '#2f3439', color: C.digi, fontSize: 8, fontWeight: 700, fontFamily: FONT, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); smooth(false); } }}
        onPointerEnter={() => setHint('Smooth up harmonics')} onPointerLeave={clearHint}>SMOOTH</div>
      <div style={{ position: 'absolute', left: 77, top: 180, width: trackW, height: 16, background: '#352f29' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const k = r.width / trackW || 1;
          const px = (e.clientX - r.left) / k;
          let o0 = off;
          const tx = (off / MAXH) * trackW;
          if (px < tx || px > tx + thumbW) { o0 = Math.max(0, Math.min(MAXH - N, Math.round(((px - thumbW / 2) / trackW) * MAXH))); setView({ harm: o0 }); }
          drag.current = { x0: e.clientX, off0: o0 };
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          const k = r.width / trackW || 1;
          const o = Math.max(0, Math.min(MAXH - N, Math.round(d.off0 + ((e.clientX - d.x0) / k / trackW) * MAXH)));
          if (o !== off) setView({ harm: o });
        }}
        onPointerUp={() => { drag.current = null; }}
        onPointerEnter={() => setHint(`Harmonics ${off + 1} - ${off + N}`)} onPointerLeave={clearHint}>
        <div style={{ position: 'absolute', left: (off / MAXH) * trackW, top: 2, width: thumbW, height: 12, borderRadius: 2, background: '#5d5448' }} />
      </div>
    </div>
  );
}
