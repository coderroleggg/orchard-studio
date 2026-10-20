// Vocodex carrier synthesizer controls: the tone selector and the latching
// keyboard (click a key to hold it on or off, as with FL's mouse latching).
// MIDI notes (a MIDI Out channel on the slot's MIDI input port) latch the
// keyboard too, like FL's controller input; the engine mirrors them into
// `notes`, so the keys light up.

import * as A from '../../../../store/actions';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { VCX_TONES } from '../../../../model/fx/plugins/vocodex';
import { Display, useFxEditor } from '../../kit';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** FL's note names: key 60 is C5. */
const noteName = (n: number) => `${NOTE_NAMES[n % 12]}${Math.floor(n / 12)}`;
const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

export function ToneSelect({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId, params } = useFxEditor();
  const tone = typeof params.tone === 'number' ? params.tone : 0;
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box', background: '#0c1214', borderRadius: 1,
      display: 'flex', alignItems: 'center', color: '#c9d6db', fontSize: 10, cursor: 'default', paddingLeft: 4,
    }}
      onPointerEnter={() => setHint(`Carrier tone: ${tone === 0 ? 'use external carrier source instead' : VCX_TONES[tone]}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = e.currentTarget.getBoundingClientRect();
        openMenu(r.left, r.bottom, VCX_TONES.map((t, i) => ({
          label: t, checked: i === tone, radio: true,
          onClick: () => A.editFx(slotId, 'Carrier tone', (p) => {
            p.tone = i;
            // selecting an internal tone blocks the external carrier input (FL sets CAR to '---')
            if (i > 0 && typeof p.carIn === 'number' && p.carIn === 0) p.carIn = -1;
            if (i === 0 && p.carIn === -1) p.carIn = 0;
            if (i > 0 && (!Array.isArray(p.notes) || (p.notes as number[]).length === 0)) p.notes = [60];
          }),
        })), { minWidth: 150 });
      }}>
      <svg width={12} height={10} style={{ marginRight: 8 }}>
        <rect x={0.5} y={0.5} width={11} height={9} fill="none" stroke="#c9d6db" strokeWidth={1} />
        <rect x={3} y={0.5} width={1.6} height={5.5} fill="#c9d6db" /><rect x={7.4} y={0.5} width={1.6} height={5.5} fill="#c9d6db" />
      </svg>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}>{VCX_TONES[tone]}</span>
      <svg width={10} height={6} style={{ marginRight: 8 }}><path d="M0 0 L10 0 L5 6 Z" fill="#7d8b90" /></svg>
    </div>
  );
}

/** Latching keyboard: C3 .. C6 (FL names; key 36 .. 72), held notes lit orange. */
export function Keyboard({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId, params } = useFxEditor();
  const notes = Array.isArray(params.notes) ? (params.notes as number[]) : [];
  const lo = 41, hi = 76; // F3 .. E6: 21 white keys as in FL's panel
  const whites: number[] = [];
  for (let n = lo; n <= hi; n++) if (!BLACK[n % 12]) whites.push(n);
  const kw = w / whites.length;
  const keyAt = (sx: number, sy: number): number => {
    if (sy < h * 0.62) {
      for (let n = lo; n <= hi; n++) {
        if (!BLACK[n % 12]) continue;
        const wi = whites.indexOf(n - 1);
        const bx = (wi + 1) * kw - kw * 0.3;
        if (sx >= bx && sx < bx + kw * 0.6) return n;
      }
    }
    return whites[Math.min(whites.length - 1, Math.max(0, Math.floor(sx / kw)))];
  };
  return (
    <Display x={x} y={y} w={w} h={h} deps={[notes.join(',')]}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = e.currentTarget.getBoundingClientRect();
        const n = keyAt(((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h);
        A.editFx(slotId, 'Carrier note', (p) => {
          const cur = Array.isArray(p.notes) ? (p.notes as number[]).slice() : [];
          const i = cur.indexOf(n);
          if (i >= 0) cur.splice(i, 1); else cur.push(n);
          p.notes = cur;
        });
      }}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setHint(`Carrier note ${noteName(keyAt(((e.clientX - r.left) / r.width) * w, ((e.clientY - r.top) / r.height) * h))}`);
      }}
      draw={(g, W, H) => {
        g.fillStyle = '#10181b'; g.fillRect(0, 0, W, H);
        whites.forEach((n, i) => {
          const on = notes.includes(n);
          const gr = g.createLinearGradient(0, 0, 0, H);
          gr.addColorStop(0, on ? '#ffc067' : '#f4f7fb'); gr.addColorStop(1, on ? '#ffad3d' : '#dfe4ee');
          g.fillStyle = gr;
          g.fillRect(i * kw + 0.5, 0, kw - 1, H);
        });
        for (let n = lo; n <= hi; n++) {
          if (!BLACK[n % 12]) continue;
          const wi = whites.indexOf(n - 1);
          const bx = (wi + 1) * kw - kw * 0.3;
          const on = notes.includes(n);
          const gr = g.createLinearGradient(0, 0, 0, H * 0.62);
          gr.addColorStop(0, on ? '#ff7a1e' : '#3a3f44'); gr.addColorStop(1, on ? '#e85d10' : '#16191c');
          g.fillStyle = gr;
          g.fillRect(bx, 0, kw * 0.6, H * 0.62);
        }
      }} />
  );
}
