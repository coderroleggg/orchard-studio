// Channel rack Graph editor: per-step note properties of the selected channel.

import { useEffect, useRef } from 'react';
import { store, useUi } from '../../store';
import * as A from '../../store/actions';
import type { Note } from '../../model/types';
import { keyName } from '../../model/notes';
import { setHint, clearHint } from '../hint';

type Lane = 'key' | 'vel' | 'rel' | 'fine' | 'pan' | 'modX' | 'modY' | 'shift';

export const LANES: { id: Lane; label: string; min: number; max: number; def: number; bipolar: boolean }[] = [
  { id: 'key', label: 'Note', min: 0, max: 131, def: 60, bipolar: false },
  { id: 'vel', label: 'Velocity', min: 0, max: 128, def: 100, bipolar: false },
  { id: 'rel', label: 'Release', min: 0, max: 128, def: 64, bipolar: false },
  { id: 'fine', label: 'Fine pitch', min: 0, max: 240, def: 120, bipolar: true },
  { id: 'pan', label: 'Pan', min: 0, max: 128, def: 64, bipolar: true },
  { id: 'modX', label: 'Mod X', min: 0, max: 255, def: 128, bipolar: true },
  { id: 'modY', label: 'Mod Y', min: 0, max: 255, def: 128, bipolar: true },
  { id: 'shift', label: 'Shift', min: 0, max: 24, def: 0, bipolar: false },
];

const H = 96;
const STEP = 16;

function valueOf(n: Note, lane: Lane): number {
  return lane === 'shift' ? n.shift ?? 0 : (n[lane] as number);
}

function display(lane: typeof LANES[number], v: number): string {
  switch (lane.id) {
    case 'key': return keyName(Math.round(v));
    case 'fine': return `${Math.round((v - 120) * 10)} cents`;
    case 'pan': return v === 64 ? 'Centered' : `${Math.round(Math.abs(v - 64) / 64 * 100)}% ${v < 64 ? 'left' : 'right'}`;
    case 'shift': return `${Math.round(v)} ticks`;
    default: return `${Math.round(((v - lane.min) / (lane.max - lane.min)) * 100)}%`;
  }
}

export function GraphEditor({ channelId, steps, tps, barSteps, headWidth }: { channelId: string; steps: number; tps: number; barSteps: number; headWidth: number }) {
  const laneId = useUi((u) => u.graphLane);
  const lane = LANES.find((l) => l.id === laneId) ?? LANES[1];
  const pattern = A.currentPattern();
  const notes = pattern.notes[channelId] ?? [];
  const ref = useRef<HTMLCanvasElement>(null);
  const drag = useRef<{ mode: 'set' | 'ramp' | 'move' | 'reset'; x0: number; v0: number; base?: Map<string, number> } | null>(null);
  const width = steps * STEP + Math.floor(steps / barSteps) * 3;

  const colX = (s: number) => s * STEP + Math.floor(s / barSteps) * 3;
  const stepAt = (x: number) => {
    for (let s = 0; s < steps; s++) if (x >= colX(s) && x < colX(s) + STEP) return s;
    return -1;
  };
  const valAt = (y: number) => lane.min + Math.min(1, Math.max(0, 1 - (y - 4) / (H - 8))) * (lane.max - lane.min);

  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = width * dpr; c.height = H * dpr;
    c.style.width = width + 'px'; c.style.height = H + 'px';
    const g = c.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#23282c';
    g.fillRect(0, 0, width, H);
    const byStep = new Map<number, Note>();
    for (const n of notes) if (n.len === 0 && n.pos % tps === 0) byStep.set(n.pos / tps, n);
    for (let s = 0; s < steps; s++) {
      const x = colX(s);
      g.fillStyle = Math.floor(s / (barSteps / 4)) % 2 ? '#2b2a2e' : '#292e32';
      g.fillRect(x, 0, STEP - 2, H);
      const n = byStep.get(s);
      if (!n) continue;
      const t = (valueOf(n, lane.id) - lane.min) / (lane.max - lane.min);
      const y = 4 + (1 - t) * (H - 8);
      const base = lane.bipolar ? H / 2 : H - 4;
      g.fillStyle = n.muted ? '#5b656c' : '#8fd14f';
      g.fillRect(x + 2, Math.min(y, base), STEP - 6, Math.max(2, Math.abs(base - y)));
    }
    if (lane.bipolar) { g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(0, H / 2, width, 1); }
  }, [notes, lane, steps, tps, barSteps, width]);

  const apply = (fn: (n: Note, s: number) => number | null, label: string) => {
    const cur = A.currentPattern().notes[channelId] ?? [];
    let changed = false;
    const next = cur.map((n) => {
      if (n.len !== 0 || n.pos % tps !== 0) return n;
      const v = fn(n, n.pos / tps);
      if (v === null) return n;
      const vv = Math.round(Math.min(lane.max, Math.max(lane.min, v)));
      if (valueOf(n, lane.id) === vv) return n;
      changed = true;
      return lane.id === 'shift' ? { ...n, shift: vv } : { ...n, [lane.id]: vv };
    });
    if (changed) A.setChannelNotes(A.currentPattern().id, channelId, next, label);
  };

  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className="cr-graph" style={{ ['--head' as string]: headWidth + 'px' }}>
      <div className="cr-graph-lanes">
        {LANES.map((l) => (
          <div key={l.id} className={'cr-graph-lane' + (l.id === lane.id ? ' on' : '')}
            onPointerDown={() => A.setUi((u) => { u.graphLane = l.id; })}>{l.label}</div>
        ))}
      </div>
      <canvas ref={ref}
        onPointerDown={(e) => {
          const { x, y } = local(e);
          (e.currentTarget as Element).setPointerCapture(e.pointerId);
          store.beginGesture(`Edit ${lane.label.toLowerCase()}`);
          const v = valAt(y);
          if (e.altKey) { drag.current = { mode: 'reset', x0: x, v0: v }; const s0 = stepAt(x); apply((_, s) => (s === s0 ? lane.def : null), 'Reset'); return; }
          if (e.button === 2) { drag.current = { mode: 'ramp', x0: x, v0: v }; return; }
          if (e.ctrlKey || e.metaKey) {
            const base = new Map<string, number>();
            for (const n of A.currentPattern().notes[channelId] ?? []) base.set(n.id, valueOf(n, lane.id));
            drag.current = { mode: 'move', x0: x, v0: v, base };
            return;
          }
          drag.current = { mode: 'set', x0: x, v0: v };
          const s0 = stepAt(x);
          apply((_, s) => (s === s0 ? v : null), `Edit ${lane.label.toLowerCase()}`);
        }}
        onPointerMove={(e) => {
          const { x, y } = local(e);
          const v = valAt(y);
          const s = stepAt(x);
          setHint(`${lane.label}${s >= 0 ? ` (step ${s + 1})` : ''}: ${display(lane, v)}`);
          const d = drag.current;
          if (!d) return;
          if (d.mode === 'set') { apply((_, st) => (st === s ? v : null), `Edit ${lane.label.toLowerCase()}`); }
          else if (d.mode === 'reset') { apply((_, st) => (st === s ? lane.def : null), 'Reset'); }
          else if (d.mode === 'move') { const dv = v - d.v0; apply((n) => (d.base!.get(n.id) ?? lane.def) + dv, `Edit ${lane.label.toLowerCase()}`); }
        }}
        onPointerUp={(e) => {
          const d = drag.current;
          drag.current = null;
          if (d?.mode === 'ramp') {
            // right-click and drag to another column draws a linear ramp
            const { x, y } = local(e);
            const v1 = valAt(y);
            const sa = stepAt(Math.min(d.x0, x)), sb = stepAt(Math.max(d.x0, x));
            const va = d.x0 <= x ? d.v0 : v1, vb = d.x0 <= x ? v1 : d.v0;
            apply((_, s) => (s >= sa && s <= sb ? (sb === sa ? vb : va + ((vb - va) * (s - sa)) / (sb - sa)) : null), `Edit ${lane.label.toLowerCase()}`);
          }
          store.endGesture();
        }}
        onContextMenu={(e) => e.preventDefault()}
        onPointerLeave={clearHint} />
    </div>
  );
}
