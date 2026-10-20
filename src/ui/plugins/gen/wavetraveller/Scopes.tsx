// Wave Traveller's waveform displays: the scope (ScopePaintBox 252 x 73) with the START / END markers and the
// patch's path, and the vertical scope next to the spline editor (VertScopePaintBox 61 x 210). Original drawing.

import { useMemo, useRef } from 'react';
import { AnimatedDisplay, Display } from '../../kit';
import { setHint } from '../../../hint';
import { WT_TABLE, WT_SCOPE_W, buildTable, type WtPatch } from '../../../../model/gen/plugins/wavetraveller/state';

const COL = {
  bg: '#3e4657', mid: 'rgba(128,140,160,0.35)', wave: '#c3c9e4', waveOut: '#6b7390', marker: '#d79b32', path: '#d0343a', play: '#ffffff',
  vbg: '#3e4657',
};

export interface WtAudio { channels: Float32Array[]; sampleRate: number }

/** Min / max of the frames [a, b) over both channels. */
function range(ch: readonly Float32Array[], a: number, b: number): [number, number] {
  let lo = 0;
  let hi = 0;
  const n = ch[0]?.length ?? 0;
  const e = Math.min(n, Math.max(a + 1, b));
  for (let c = 0; c < Math.min(2, ch.length); c++) {
    const d = ch[c];
    for (let i = Math.max(0, a); i < e; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  return [lo, hi];
}

/** Per-column peaks of the whole sample (the scope). */
function peaksOf(a: WtAudio | null, w: number): Float32Array {
  const out = new Float32Array(w * 2);
  if (!a) return out;
  const n = a.channels[0].length;
  for (let x = 0; x < w; x++) {
    const [lo, hi] = range(a.channels, Math.floor((x * n) / w), Math.floor(((x + 1) * n) / w));
    out[2 * x] = lo; out[2 * x + 1] = hi;
  }
  return out;
}

export interface ScopeProps {
  x: number;
  y: number;
  audio: WtAudio | null;
  patch: WtPatch;
  /** Playing voices of the selected key: [phrase 0..1, sample position 0..1] pairs (monitor). */
  playing: () => number[];
  /** Move START (which = 0) or END (1) to the fraction v. */
  setRegion: (which: 0 | 1, v: number) => void;
  dropHint?: boolean;
}

export function Scope({ x, y, audio, patch, playing, setRegion }: ScopeProps) {
  const W = WT_SCOPE_W;
  const H = 73;
  const peaks = useMemo(() => peaksOf(audio, W), [audio]);
  const tab = useMemo(() => {
    const t = new Float32Array(WT_TABLE);
    const info = buildTable(patch.wave, t);
    return { t, last: info.last };
  }, [patch.wave]);
  const drag = useRef<0 | 1 | null>(null);
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.bg;
    g.fillRect(0, 0, w, h);
    const sx = patch.start * (w - 1);
    const ex = patch.end * (w - 1);
    if (audio) {
      const mid = h / 2;
      const amp = h / 2 - 2;
      for (let px = 0; px < w; px++) {
        const lo = peaks[2 * px];
        const hi = peaks[2 * px + 1];
        g.fillStyle = px >= Math.min(sx, ex) && px <= Math.max(sx, ex) ? COL.wave : COL.waveOut;
        const t = mid - Math.min(1, hi) * amp;
        const bt = mid - Math.max(-1, lo) * amp;
        g.fillRect(px, t, 1, Math.max(1, bt - t));
      }
    } else {
      g.fillStyle = COL.mid;
      g.fillRect(0, Math.floor(h / 2), w, 1);
      g.fillStyle = '#a7b0c4';
      g.font = '11px Arial, sans-serif';
      g.textAlign = 'center';
      g.fillText('Drop a wave file here', w / 2, h / 2 + 4);
    }
    // the patch's path: sample position (x) against time (up)
    g.strokeStyle = COL.path;
    g.lineWidth = 1.2;
    g.beginPath();
    for (let i = 0; i <= tab.last; i++) {
      const t = i / Math.max(1, tab.last);
      const px = (patch.start + tab.t[i] * (patch.end - patch.start)) * (w - 1);
      const py = (1 - t) * (h - 1);
      if (i === 0) g.moveTo(px + 0.5, py + 0.5); else g.lineTo(px + 0.5, py + 0.5);
    }
    g.stroke();
    // START / END markers
    g.fillStyle = COL.marker;
    g.fillRect(Math.round(sx), 0, 1, h);
    g.fillRect(Math.round(ex), 0, 1, h);
    g.beginPath(); g.moveTo(Math.round(sx), h - 1); g.lineTo(Math.round(sx) + 5, h - 1); g.lineTo(Math.round(sx), h - 6); g.fill();
    g.beginPath(); g.moveTo(Math.round(ex) + 1, h - 1); g.lineTo(Math.round(ex) - 4, h - 1); g.lineTo(Math.round(ex) + 1, h - 6); g.fill();
    // the playing voices
    const pl = playing();
    for (let i = 0; i + 1 < pl.length; i += 2) {
      g.fillStyle = COL.play;
      const px = pl[i + 1] * (w - 1);
      g.fillRect(Math.round(px), 0, 1, h);
      g.beginPath(); g.arc(px + 0.5, (1 - pl[i]) * (h - 1) + 0.5, 2.5, 0, Math.PI * 2); g.fill();
    }
  };
  const posOf = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(W - 1, Math.max(0, ((e.clientX - r.left) / r.width) * W)) / (W - 1);
  };
  const nearest = (e: React.PointerEvent<HTMLCanvasElement>): 0 | 1 | null => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const ds = Math.abs(px - patch.start * (W - 1));
    const de = Math.abs(px - patch.end * (W - 1));
    if (Math.min(ds, de) > 6) return null;
    return ds <= de ? 0 : 1;
  };
  return (
    <AnimatedDisplay x={x} y={y} w={W} h={H} frame={frame}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const m = nearest(e);
        if (m === null) return;
        drag.current = m;
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (drag.current !== null) { setRegion(drag.current, posOf(e)); return; }
        setHint(nearest(e) === null ? 'Waveform' : 'Drag to set the START / END of the region');
        e.currentTarget.style.cursor = nearest(e) === null ? 'default' : 'ew-resize';
      }}
      onPointerUp={(e) => { drag.current = null; try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } }} />
  );
}

/** The vertical scope: the START..END region of the sample along the spline editor's value axis. */
export function VertScope({ x, y, audio, patch, page }: { x: number; y: number; audio: WtAudio | null; patch: WtPatch; page: number }) {
  const W = 61;
  const H = 210;
  const rows = useMemo(() => {
    const out = new Float32Array(H * 2);
    if (!audio) return out;
    const n = audio.channels[0].length;
    const a = patch.start * (n - 1);
    const b = patch.end * (n - 1);
    for (let r = 0; r < H; r++) {
      // row 0 is the top = the END of the region
      const p0 = a + ((H - 1 - r) / H) * (b - a);
      const p1 = a + ((H - r) / H) * (b - a);
      const [lo, hi] = range(audio.channels, Math.floor(Math.min(p0, p1)), Math.ceil(Math.max(p0, p1)));
      out[2 * r] = lo; out[2 * r + 1] = hi;
    }
    return out;
  }, [audio, patch.start, patch.end]);
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.vbg;
    g.fillRect(0, 0, w, h);
    if (page !== 0 || !audio) return;
    const cx = w / 2;
    const amp = w / 2 - 2;
    g.fillStyle = COL.wave;
    for (let r = 0; r < H; r++) {
      const lo = Math.max(-1, rows[2 * r]);
      const hi = Math.min(1, rows[2 * r + 1]);
      g.fillRect(cx + lo * amp, r, Math.max(1, (hi - lo) * amp), 1);
    }
  };
  return <Display x={x} y={y} w={W} h={H} draw={frame} deps={[rows, page, audio]} onPointerMove={() => setHint('Waveform')} />;
}
