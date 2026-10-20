// Convolver impulse editor: the processed impulse's waveform (or spectrum)
// with the four impulse envelopes (pan, volume, stereo separation, all-purpose
// damping), a time selection, the overview scroller and the envelope bar.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import * as A from '../../../../store/actions';
import { DEFAULT_ENV, type EnvKind, type EnvPoint } from '../../../../model/fx/plugins/convolver';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useFxEditor, useFxState } from '../../kit';
import { drawEnv, useEnvEditing, type EnvView } from './envedit';
import { Icon, type CvIcon } from './icons';

export const ENV_COLORS: Record<EnvKind, string> = { vol: '#b8f05c', pan: '#f2c45c', sep: '#5cd2f2', ap: '#f28a8a' };
export const ENV_NAMES: Record<EnvKind, string> = { pan: 'Pan', vol: 'Volume', sep: 'Stereo separation', ap: 'All-purpose (damping)' };

/** Canvas positioned in editor pixels with every pointer event (dpr-aware). */
export function CvCanvas({ x, y, w, h, draw, deps, style, handlers, children }: {
  x: number; y: number; w: number; h: number;
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void;
  deps: unknown[];
  style?: CSSProperties;
  handlers?: Partial<Record<'onPointerDown' | 'onPointerMove' | 'onPointerUp' | 'onPointerLeave' | 'onContextMenu' | 'onDoubleClick' | 'onWheel', (e: never) => void>>;
  children?: ReactNode;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const dref = useRef(draw);
  dref.current = draw;
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = Math.min(3, (window.devicePixelRatio || 1) * 1.5);
    if (c.width !== Math.round(w * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    dref.current(g, w, h);
  }, [w, h, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, ...style }}>
      <canvas ref={ref} style={{ width: w, height: h, display: 'block', touchAction: 'none' }}
        {...(handlers as Record<string, unknown>)} onContextMenu={(handlers?.onContextMenu as never) ?? ((e: React.MouseEvent) => e.preventDefault())} />
      {children}
    </div>
  );
}

/** Peak bins of a channel for a time range (for fast waveform drawing). */
function peaks(x: Float32Array, a: number, b: number, cols: number): [Float32Array, Float32Array] {
  const lo = new Float32Array(cols), hi = new Float32Array(cols);
  const span = Math.max(1, b - a);
  for (let c = 0; c < cols; c++) {
    const s = a + Math.floor((c * span) / cols), e = Math.max(s + 1, a + Math.floor(((c + 1) * span) / cols));
    let mn = 0, mx = 0;
    for (let i = s; i < e && i < x.length; i++) { const v = x[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    lo[c] = mn; hi[c] = mx;
  }
  return [lo, hi];
}

export function BarButton({ x, y, icon, hint, on, dim, onClick, w = 22, h = 17 }: { x: number; y: number; icon: CvIcon; hint: string; on?: boolean; dim?: boolean; onClick: (e: React.PointerEvent) => void; w?: number; h?: number }) {
  return (
    <div className={'cv-btn flat' + (on ? ' on' : '') + (dim ? ' dim' : '')} style={{ left: x, top: y, width: w, height: h, color: on ? '#ffffff' : undefined }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <Icon name={icon} size={15} />
    </div>
  );
}

export interface Selection { a: number; b: number } // fractions of the displayed impulse

export function ImpulseView({ ir, rate, view, setView, sel, setSel, spectrum }: {
  ir: Float32Array[] | null; rate: number; view: EnvView; setView: (v: EnvView) => void;
  sel: Selection | null; setSel: (s: Selection | null) => void; spectrum: boolean;
}) {
  const { slotId } = useFxEditor();
  const env = useFxState<Record<EnvKind, EnvPoint[]>>('env', DEFAULT_ENV);
  const edit = useFxState<EnvKind | null>('envEdit', null);
  const W = 714, H = 127;
  const pts = edit ? env[edit] ?? DEFAULT_ENV[edit] : [];
  const commit = (next: EnvPoint[], label: string, merge: boolean) => {
    if (!edit) return;
    A.editFx(slotId, label, (p) => { (p.env as Record<EnvKind, EnvPoint[]>)[edit] = next; }, merge ? `cv-env-${edit}` : undefined);
  };
  const valueText = (v: number) => {
    if (edit === 'vol') return `Volume: ${Math.round(v * 100)}%`;
    if (edit === 'pan') { const p = Math.round((v - 0.5) * 200); return p === 0 ? 'Pan: centered' : `Pan: ${Math.abs(p)}% ${p < 0 ? 'left' : 'right'}`; }
    if (edit === 'sep') { const p = Math.round((0.5 - v) * 200); return p === 0 ? 'Stereo separation: original' : `Stereo separation: ${Math.abs(p)}% ${p > 0 ? 'separated' : 'merged'}`; }
    return `Damping: ${Math.round(200 * Math.pow(100, v))} Hz`;
  };
  const envH = useEnvEditing({ pts, W, H, view, enabled: !!edit, commit, valueText });
  const selDrag = useRef<number | null>(null);
  const toFrac = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return Math.min(1, Math.max(0, view.t0 + ((e.clientX - r.left) / r.width) * (view.t1 - view.t0)));
  };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      envH.onPointerDown(e);
      if (e.isPropagationStopped() || e.button !== 0 || edit) return;
      const f = toFrac(e);
      selDrag.current = f;
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
      setSel(null);
    },
    onPointerMove: (e: React.PointerEvent) => {
      envH.onPointerMove(e);
      if (selDrag.current !== null) {
        const f = toFrac(e), a = selDrag.current;
        if (Math.abs(f - a) > 0.002) setSel({ a: Math.min(a, f), b: Math.max(a, f) });
      }
    },
    onPointerUp: () => { envH.onPointerUp(); selDrag.current = null; },
    onPointerLeave: envH.onPointerLeave,
    onContextMenu: envH.onContextMenu,
    onDoubleClick: (e: React.MouseEvent) => { envH.onDoubleClick(e); if (!edit) { setSel(null); setView({ t0: 0, t1: 1 }); } },
    onWheel: (e: React.WheelEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const c = view.t0 + ((e.clientX - r.left) / r.width) * (view.t1 - view.t0);
      const k = e.deltaY > 0 ? 1.25 : 0.8;
      const span = Math.min(1, Math.max(0.01, (view.t1 - view.t0) * k));
      let t0 = c - (c - view.t0) * (span / (view.t1 - view.t0));
      t0 = Math.min(1 - span, Math.max(0, t0));
      setView({ t0, t1: t0 + span });
    },
  };
  return (
    <>
      <CvCanvas x={0} y={171} w={W} h={H} deps={[ir, view, sel, edit, env, spectrum]} handlers={handlers as never}
        draw={(g) => {
          g.fillStyle = '#4f545f';
          g.fillRect(0, 0, W, H);
          const len = ir ? ir[0].length : 0;
          const a = Math.floor(view.t0 * len), b = Math.ceil(view.t1 * len);
          // grid: one line per 100 ms (or second when zoomed out)
          if (len) {
            const secs = (b - a) / rate;
            const step = secs > 4 ? 1 : secs > 1.2 ? 0.25 : secs > 0.3 ? 0.1 : 0.01;
            g.strokeStyle = '#5a5f6b';
            g.lineWidth = 1;
            for (let s = Math.ceil(a / rate / step) * step; s * rate < b; s += step) {
              const x = Math.round(((s * rate - a) / (b - a)) * W) + 0.5;
              g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
            }
          }
          if (sel) {
            const x0 = ((sel.a - view.t0) / (view.t1 - view.t0)) * W, x1 = ((sel.b - view.t0) / (view.t1 - view.t0)) * W;
            g.fillStyle = 'rgba(160, 200, 255, 0.16)';
            g.fillRect(x0, 0, x1 - x0, H);
          }
          if (ir && len) {
            if (spectrum) drawSpecStrip(g, ir[0], a, b, W, H, rate);
            else {
              let pk = 0;
              for (const c of ir) for (let i = 0; i < c.length; i += 7) pk = Math.max(pk, Math.abs(c[i]));
              const sc = pk > 0 ? (H * 0.47) / pk : 1;
              for (let ch = ir.length - 1; ch >= 0; ch--) {
                const [lo, hi] = peaks(ir[ch], a, b, W);
                g.fillStyle = ch ? 'rgba(255, 200, 215, 0.75)' : 'rgba(255, 255, 255, 0.95)';
                for (let x = 0; x < W; x++) {
                  const y0 = H / 2 - hi[x] * sc, y1 = H / 2 - lo[x] * sc;
                  g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
                }
              }
            }
          }
          if (edit) for (const k of ['pan', 'vol', 'sep', 'ap'] as EnvKind[]) drawEnv(g, env[k] ?? DEFAULT_ENV[k], W, H, view, ENV_COLORS[k], k === edit);
        }} />
      <Overview ir={ir} view={view} setView={setView} />
      <EnvBar edit={edit} />
    </>
  );
}

function drawSpecStrip(g: CanvasRenderingContext2D, x: Float32Array, a: number, b: number, W: number, H: number, rate: number): void {
  const N = 256;
  const re = new Float64Array(N), im = new Float64Array(N);
  const cols = Math.min(W, 357);
  for (let c = 0; c < cols; c++) {
    const s = a + Math.floor(((b - a) * c) / cols);
    for (let i = 0; i < N; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N); re[i] = (x[s + i] ?? 0) * w; im[i] = 0; }
    // naive DFT of 48 log bands (cheap enough for a static picture)
    for (let k = 0; k < 48; k++) {
      const f = 40 * Math.pow(rate / 2 / 40, k / 48);
      const bin = Math.min(N / 2 - 1, Math.max(1, Math.round((f / rate) * N)));
      let sr = 0, si = 0;
      for (let i = 0; i < N; i++) { const ph = (2 * Math.PI * bin * i) / N; sr += re[i] * Math.cos(ph); si -= re[i] * Math.sin(ph); }
      const db = 10 * Math.log10((sr * sr + si * si) / N + 1e-12);
      const t = Math.min(1, Math.max(0, (db + 60) / 60));
      g.fillStyle = `rgba(${Math.round(80 + 175 * t)}, ${Math.round(110 + 120 * t)}, ${Math.round(140 + 60 * t)}, ${0.15 + 0.85 * t})`;
      g.fillRect((c / cols) * W, H - ((k + 1) / 48) * H, W / cols + 0.5, H / 48 + 0.5);
    }
  }
}

function Overview({ ir, view, setView }: { ir: Float32Array[] | null; view: EnvView; setView: (v: EnvView) => void }) {
  const W = 670, H = 26;
  const drag = useRef<{ x: number; t0: number } | null>(null);
  return (
    <>
      <div className="fxk-abs" style={{ left: 0, top: 298, width: 714, height: 31, background: '#5d616c', borderTop: '1px solid #3b4048', borderBottom: '1px solid #3b4048' }} />
      <BarButton x={2} y={304} icon="left" hint="Scroll left" w={18} h={20} onClick={() => { const s = view.t1 - view.t0; const t0 = Math.max(0, view.t0 - s * 0.25); setView({ t0, t1: t0 + s }); }} />
      <BarButton x={694} y={304} icon="right" hint="Scroll right" w={18} h={20} onClick={() => { const s = view.t1 - view.t0; const t0 = Math.min(1 - s, view.t0 + s * 0.25); setView({ t0, t1: t0 + s }); }} />
      <CvCanvas x={22} y={300} w={W} h={H} deps={[ir, view]}
        handlers={{
          onPointerDown: ((e: React.PointerEvent) => { drag.current = { x: e.clientX, t0: view.t0 }; (e.currentTarget as Element).setPointerCapture(e.pointerId); }) as never,
          onPointerMove: ((e: React.PointerEvent) => {
            const d = drag.current;
            if (!d) return;
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const s = view.t1 - view.t0;
            const t0 = Math.min(1 - s, Math.max(0, d.t0 + (e.clientX - d.x) / r.width));
            setView({ t0, t1: t0 + s });
          }) as never,
          onPointerUp: (() => { drag.current = null; }) as never,
        }}
        draw={(g) => {
          g.fillStyle = '#6b6f7b';
          g.fillRect(0, 0, W, H);
          if (ir) {
            const [lo, hi] = peaks(ir[0], 0, ir[0].length, W);
            let pk = 0;
            for (let i = 0; i < W; i++) pk = Math.max(pk, hi[i], -lo[i]);
            const sc = pk > 0 ? (H * 0.45) / pk : 1;
            g.fillStyle = '#eef1f4';
            for (let x = 0; x < W; x++) g.fillRect(x, H / 2 - hi[x] * sc, 1, Math.max(1, (hi[x] - lo[x]) * sc));
          }
          if (view.t1 - view.t0 < 0.999) {
            g.fillStyle = 'rgba(255,255,255,0.14)';
            g.fillRect(view.t0 * W, 0, (view.t1 - view.t0) * W, H);
          }
        }} />
    </>
  );
}

function EnvBar({ edit }: { edit: EnvKind | null }) {
  const { slotId } = useFxEditor();
  const set = (k: EnvKind | null) => A.editFx(slotId, k ? `Edit ${ENV_NAMES[k]} envelope` : 'Impulse view', (p) => { p.envEdit = k; });
  const reset = (k: EnvKind) => A.editFx(slotId, `Reset ${ENV_NAMES[k]} envelope`, (p) => { (p.env as Record<EnvKind, EnvPoint[]>)[k] = structuredClone(DEFAULT_ENV[k]); });
  return (
    <>
      <div className="cv-bar" style={{ top: 329, height: 17 }} />
      <BarButton x={2} y={329} icon="menu" hint="Envelope options" onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, [
          ...(['pan', 'vol', 'sep', 'ap'] as EnvKind[]).map((k) => ({ label: ENV_NAMES[k], checked: edit === k, radio: true, onClick: () => set(k) })),
          { separator: true },
          { label: 'Reset envelope', disabled: !edit, onClick: () => edit && reset(edit) },
          {
            label: 'Flip vertically', disabled: !edit, onClick: () => edit && A.editFx(slotId, 'Flip envelope', (p) => {
              const e = p.env as Record<EnvKind, EnvPoint[]>;
              e[edit] = (e[edit] ?? DEFAULT_ENV[edit]).map((q) => ({ ...q, v: 1 - q.v }));
            }),
          },
          { label: 'Reset all envelopes', onClick: () => A.editFx(slotId, 'Reset envelopes', (p) => { p.env = structuredClone(DEFAULT_ENV); }) },
        ]);
      }} />
      <BarButton x={26} y={329} icon="reset" hint="Reset current envelope" dim={!edit} onClick={() => edit && reset(edit)} />
      <BarButton x={54} y={329} icon="wave" hint="Select / edit the impulse (no envelope)" on={!edit} onClick={() => set(null)} />
      <BarButton x={80} y={329} icon="stereo" hint="Pan envelope" on={edit === 'pan'} onClick={() => set('pan')} />
      <BarButton x={104} y={329} icon="volume" hint="Volume envelope" on={edit === 'vol'} onClick={() => set('vol')} />
      <BarButton x={128} y={329} icon="stereo" hint="Stereo separation envelope" on={edit === 'sep'} onClick={() => set('sep')} />
      <BarButton x={152} y={329} icon="nodes" hint="All-purpose envelope (damping over time)" on={edit === 'ap'} onClick={() => set('ap')} />
    </>
  );
}

/** Track a value that resets when `key` changes. */
export function useKeyedState<T>(key: string, init: T): [T, (v: T) => void] {
  const [st, setSt] = useState<{ key: string; v: T }>({ key, v: init });
  useEffect(() => { if (st.key !== key) setSt({ key, v: init }); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [st.key === key ? st.v : init, (v: T) => setSt({ key, v })];
}
