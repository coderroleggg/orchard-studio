// X-Y-Z Controller editor (FL: Fruity X-Y-Z Controller, 425 x 417): the pad
// (drag for X / Y, mouse wheel for Z; the cursor shows the smoothed position),
// the x / y / z value bars, the axis tabs and page selector (Coordinates /
// Input mapping / Output mapping: the pad becomes the axis' mapping curve
// editor), per-axis speed and acceleration, global and external speeds, the
// colour knob and the options menu.

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../kit';
import { editFx, setFxParam } from '../../../store/actions';
import { store } from '../../../store';
import { useControl, type ControlProps } from '../../widgets/control';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { setHint, clearHint } from '../../hint';
import { evalEnvelope, type AutoPoint } from '../../../model/automation';
import { defaultXYZOptions, linearMap, type XYZOptions } from '../../../model/fx/plugins/xyzctrl';
import { FlKnobControl } from './controllers/kit';
import type { FxEditorModule } from '../registry';

const AXES = ['x', 'y', 'z'] as const;
const BAR_COLORS = ['#ffd94f', '#caff62', '#d3e6f2'];
const PAGES = ['Coordinates', 'Input mapping', 'Output mapping'];

function padColor(hue256: number, l: number): string {
  return `hsl(${Math.round((hue256 / 256) * 360)}, 14%, ${l}%)`;
}

function MiniSlider({ x, y, w, h, control, fill = '#d6dde1' }: { x: number; y: number; w: number; h: number; control: ControlProps; fill?: string }) {
  const hnd = useControl({ travel: w * 2, ...control }, 'horizontal');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#2d3338', border: '1px solid #3f464b', boxSizing: 'border-box', cursor: 'default', touchAction: 'none' }} {...hnd}>
      <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${t * 100}%`, background: fill }} />
    </div>
  );
}

function ParamSlider({ k, x, y, w, h, fill }: { k: string; x: number; y: number; w: number; h: number; fill?: string }) {
  const p = useParam(k);
  return <MiniSlider x={x} y={y} w={w} h={h} control={p.control} fill={fill} />;
}

function Cap({ x, y, w, children, align = 'left' }: { x: number; y: number; w: number; children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 14, lineHeight: '14px', fontSize: 9.5, fontWeight: 700, color: '#d8dee2', textAlign: align, whiteSpace: 'nowrap', pointerEvents: 'none' }}>{children}</div>;
}

function Gear({ x, y, hint, onClick, arrow }: { x: number; y: number; hint: string; onClick: (e: React.PointerEvent) => void; arrow?: boolean }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: arrow ? 26 : 16, height: 16, cursor: 'default', display: 'flex', alignItems: 'center', gap: 1 }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <svg width="15" height="15" viewBox="0 0 16 16"><path fill="#4cb6f0" d="M6.8 1h2.4l.4 2a5 5 0 0 1 1.4.8l1.9-.7 1.2 2.1-1.5 1.3a5 5 0 0 1 0 1.6l1.5 1.3-1.2 2.1-1.9-.7a5 5 0 0 1-1.4.8l-.4 2H6.8l-.4-2A5 5 0 0 1 5 12.8l-1.9.7-1.2-2.1L3.4 10a5 5 0 0 1 0-1.6L1.9 7.1l1.2-2.1 1.9.7A5 5 0 0 1 6.4 4.9zM8 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4z" /></svg>
      {arrow && <svg width="7" height="5"><path d="M0 0 H7 L3.5 5 Z" fill="#4cb6f0" /></svg>}
    </div>
  );
}

function JoyIcon({ x, y }: { x: number; y: number }) {
  return (
    <svg className="fxk-abs" style={{ left: x, top: y, pointerEvents: 'none' }} width={20} height={16} viewBox="0 0 20 16">
      <circle cx="6" cy="3.5" r="3" fill="#dfe5e8" /><rect x="5" y="5" width="2" height="6" fill="#dfe5e8" /><rect x="1" y="10.5" width="10" height="4" rx="1" fill="#dfe5e8" />
      <path d="M15 5 L19 8 L15 11 Z" fill="#6c7378" />
    </svg>
  );
}

/** The pad: the room view with the cursor (Coordinates) or the selected axis' mapping curve. */
function Pad({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const page = useFxState<number>('page', 0);
  const axis = useFxState<number>('axis', 0);
  const color = useFxState<number>('color', 144);
  const options = { ...defaultXYZOptions(), ...useFxState<Partial<XYZOptions>>('options', {}) };
  const inMap = useFxState<AutoPoint[][]>('inMap', [linearMap(), linearMap(), linearMap()]);
  const outMap = useFxState<AutoPoint[][]>('outMap', [linearMap(), linearMap(), linearMap()]);
  const px = useParam('xValue'), py = useParam('yValue'), pz = useParam('zValue');
  const st = useRef({ x: NaN, y: NaN, z: NaN, drag: null as null | { sx: number; sy: number; vx: number; vy: number; pt?: number; tens?: number; ty?: number } });
  useFxMonitor(slotId, (d) => { st.current.x = Number(d.x); st.current.y = Number(d.y); st.current.z = Number(d.z); });
  const mapKey = page === 1 ? 'inMap' : 'outMap';
  const curMap = (page === 1 ? inMap : outMap)[axis] ?? linearMap();
  const setMap = (pts: AutoPoint[], label: string) => editFx(slotId, label, (p) => {
    const all = ((p[mapKey] as AutoPoint[][]) ?? [linearMap(), linearMap(), linearMap()]).map((m) => m.map((q) => ({ ...q })));
    all[axis] = pts;
    p[mapKey] = all;
  }, `xyzmap:${slotId}:${mapKey}:${axis}`);
  const toXY = (e: React.PointerEvent | React.WheelEvent | React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return { fx: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height)) };
  };
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const { fx, fy } = toXY(e);
        if (page === 0) {
          store.nextGestureIsKnob = true;
          px.control.onBegin?.();
          st.current.drag = { sx: fx, sy: fy, vx: px.value / 65536, vy: py.value / 65536 };
          if (options.absolute) { px.set(Math.round(fx * 65536)); py.set(Math.round(fy * 65536)); }
        } else {
          // grab the nearest point (or add one on a double-click)
          let best = -1, bd = 0.04;
          curMap.forEach((p, i) => { const d = Math.hypot(p.pos - fx, (p.value - fy) * (h / w)); if (d < bd) { bd = d; best = i; } });
          if (best < 0 && e.detail >= 2) {
            const pts = [...curMap.map((q) => ({ ...q })), { pos: fx, value: fy, tension: 0, mode: 'single' as const }].sort((a, b) => a.pos - b.pos);
            setMap(pts, 'Add point');
            best = pts.findIndex((q) => q.pos === fx && q.value === fy);
          }
          if (best >= 0) st.current.drag = { sx: fx, sy: fy, vx: 0, vy: 0, pt: best };
          else {
            // drag between points: the segment's tension
            const seg = curMap.findIndex((p, i) => i > 0 && fx <= p.pos && fx >= curMap[i - 1].pos);
            if (seg > 0) st.current.drag = { sx: fx, sy: fy, vx: 0, vy: 0, tens: seg, ty: curMap[seg].tension };
          }
        }
      }}
      onPointerMove={(e) => {
        const d = st.current.drag;
        const { fx, fy } = toXY(e);
        if (!d) { if (page === 0) setHint(`X: ${Math.round(fx * 100)}%  Y: ${Math.round(fy * 100)}%`); return; }
        if (page === 0) {
          const nx = options.absolute ? fx : d.vx + (fx - d.sx), ny = options.absolute ? fy : d.vy + (fy - d.sy);
          px.set(Math.round(Math.min(1, Math.max(0, nx)) * 65536));
          py.set(Math.round(Math.min(1, Math.max(0, ny)) * 65536));
        } else if (d.pt !== undefined) {
          const pts = curMap.map((q) => ({ ...q }));
          const i = d.pt;
          const lo = i === 0 ? 0 : pts[i - 1].pos, hi = i === pts.length - 1 ? 1 : pts[i + 1].pos;
          pts[i].pos = i === 0 ? 0 : i === pts.length - 1 ? 1 : Math.min(hi, Math.max(lo, fx));
          pts[i].value = fy;
          setMap(pts, 'Move point');
          setHint(`In: ${Math.round(pts[i].pos * 100)}%  Out: ${Math.round(fy * 100)}%`);
        } else if (d.tens !== undefined) {
          const pts = curMap.map((q) => ({ ...q }));
          const dir = pts[d.tens].value >= pts[d.tens - 1].value ? 1 : -1;
          pts[d.tens].tension = Math.min(1, Math.max(-1, (d.ty ?? 0) + (fy - d.sy) * 2 * dir));
          setMap(pts, 'Tension');
        }
      }}
      onPointerUp={() => { if (st.current.drag && page === 0) px.control.onEnd?.(); st.current.drag = null; }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (page === 0) return;
        const { fx, fy } = toXY(e);
        const near = curMap.findIndex((p) => Math.hypot(p.pos - fx, (p.value - fy) * (h / w)) < 0.04);
        const items: MenuItem[] = [];
        if (near > 0 && near < curMap.length - 1) items.push({ label: 'Delete point', onClick: () => setMap(curMap.filter((_, i) => i !== near), 'Delete point') });
        if (near > 0) {
          for (const [label, mode] of [['Single curve', 'single'], ['Double curve', 'double'], ['Hold', 'hold'], ['Stairs', 'stairs'], ['Smooth stairs', 'smoothStairs'], ['Pulse', 'pulse'], ['Wave', 'wave'], ['Smooth', 'smooth']] as const) {
            items.push({ label, radio: true, checked: curMap[near].mode === mode, onClick: () => setMap(curMap.map((q, i) => (i === near ? { ...q, mode } : q)), 'Point mode') });
          }
        }
        items.push({ separator: true }, { label: 'Reset curve', onClick: () => setMap(linearMap(), 'Reset curve') });
        openMenu(e.clientX, e.clientY, items);
      }}
      frame={(g, W, H) => {
        const s = st.current;
        const base = padColor(color, 43);
        g.fillStyle = base;
        g.fillRect(0, 0, W, H);
        // checkerboard back wall
        const cw = W / 5.4, chh = H / 3.5;
        for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
          if ((i + j) % 2) continue;
          g.fillStyle = padColor(color, 39);
          g.fillRect(Math.round(i * cw + W * 0.07), Math.round(j * chh + H * 0.08), Math.round(cw), Math.round(chh));
        }
        g.fillStyle = 'rgba(255,255,255,0.05)';
        g.fillRect(0, 0, W, H * 0.5);
        g.strokeStyle = padColor(color, 52);
        g.lineWidth = 1;
        g.strokeRect(0.5, 0.5, W - 1, H - 1);
        if (page === 0) {
          // the room's edges
          const ix = W * 0.12, iy = H * 0.12;
          g.strokeStyle = padColor(color, 50);
          g.strokeRect(ix + 0.5, iy + 0.5, W - 2 * ix, H - 2 * iy);
          g.beginPath();
          g.moveTo(0, 0); g.lineTo(ix, iy); g.moveTo(W, 0); g.lineTo(W - ix, iy);
          g.moveTo(0, H); g.lineTo(ix, H - iy); g.moveTo(W, H); g.lineTo(W - ix, H - iy);
          g.stroke();
          const cx = (Number.isFinite(s.x) ? s.x : px.value / 65536) * W;
          const cy = (1 - (Number.isFinite(s.y) ? s.y : py.value / 65536)) * H;
          const cz = Number.isFinite(s.z) ? s.z : pz.value / 65536;
          const r = 5 + 9 * cz;
          g.fillStyle = 'rgba(0,0,0,0.18)';
          g.beginPath(); g.ellipse(cx + 2, cy + 3, r, r * 0.9, 0, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#ffb02e';
          g.lineWidth = 2.2;
          g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
          g.fillStyle = '#ffb02e';
          g.beginPath(); g.arc(cx, cy, 2.6, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#ffffff';
          g.lineWidth = 1;
          g.beginPath(); g.moveTo(cx - r - 3, cy); g.lineTo(cx - r + 3, cy); g.moveTo(cx + r - 3, cy); g.lineTo(cx + r + 3, cy); g.stroke();
        } else {
          g.strokeStyle = 'rgba(255,255,255,0.18)';
          g.beginPath(); g.moveTo(W / 2 + 0.5, 0); g.lineTo(W / 2 + 0.5, H); g.moveTo(0, H / 2 + 0.5); g.lineTo(W, H / 2 + 0.5); g.stroke();
          g.strokeStyle = '#eef3f5';
          g.lineWidth = 1.6;
          g.beginPath();
          for (let i = 0; i <= W; i++) {
            const v = evalEnvelope(curMap, i / W);
            const yy = 4 + (1 - v) * (H - 8);
            if (i) g.lineTo(i, yy); else g.moveTo(i, yy);
          }
          g.stroke();
          for (const p of curMap) {
            g.fillStyle = '#ffffff';
            g.beginPath(); g.arc(p.pos * W, 4 + (1 - p.value) * (H - 8), 3.4, 0, Math.PI * 2); g.fill();
          }
          for (let i = 1; i < curMap.length; i++) {
            const mx = (curMap[i - 1].pos + curMap[i].pos) / 2;
            g.strokeStyle = '#ffffff';
            g.lineWidth = 1;
            g.beginPath(); g.arc(mx * W, 4 + (1 - evalEnvelope(curMap, mx)) * (H - 8), 3, 0, Math.PI * 2); g.stroke();
          }
          // the live input / output position
          const v = axis === 0 ? px.value : axis === 1 ? py.value : pz.value;
          const ix = page === 1 ? v / 65536 : Number.isFinite([s.x, s.y, s.z][axis]) ? [s.x, s.y, s.z][axis] : v / 65536;
          g.strokeStyle = 'rgba(255,255,255,0.55)';
          g.beginPath(); g.arc(ix * W, 4 + (1 - evalEnvelope(curMap, ix)) * (H - 8), 8, 0, Math.PI * 2); g.stroke();
        }
      }} />
  );
}

function XYZTabs({ x, y }: { x: number; y: number }) {
  const { slotId } = useFxEditor();
  const axis = useFxState<number>('axis', 0);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 298, height: 25, display: 'flex', gap: 1 }}>
      {AXES.map((a, i) => (
        <div key={a} style={{ flex: 1, background: i === axis ? '#262c30' : 'linear-gradient(180deg, #4b5257, #41484d)', border: '1px solid #2c3236', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, color: i === axis ? '#caff62' : '#dfe5e8', cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); editFx(slotId, 'Current axis', (p) => { p.axis = i; }); } }}
          onPointerEnter={() => setHint('Current axis')} onPointerLeave={clearHint}>{a}</div>
      ))}
    </div>
  );
}

function PageSelect({ x, y }: { x: number; y: number }) {
  const { slotId } = useFxEditor();
  const page = useFxState<number>('page', 0);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 106, height: 25, background: '#2f353a', border: '1px solid #262b2f', borderRadius: 3, display: 'flex', alignItems: 'center', padding: '0 6px', boxSizing: 'border-box', fontSize: 11, color: '#dfe5e8', cursor: 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, PAGES.map((t, i) => ({ label: t, radio: true, checked: i === page, onClick: () => editFx(slotId, 'Settings page', (p) => { p.page = i; }) } as MenuItem)), { minWidth: r.width });
      }}
      onPointerEnter={() => setHint('Current settings page')} onPointerLeave={clearHint}>
      <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden' }}>{PAGES[page]}</span>
      <svg width="6" height="9"><path d="M0 0 L6 4.5 L0 9 Z" fill="#7d868b" /></svg>
    </div>
  );
}

function XYZCtrlEditor() {
  const { slotId } = useFxEditor();
  const axis = useFxState<number>('axis', 0);
  const color = useFxState<number>('color', 144);
  const hide = useFxState<boolean>('hideControls', false);
  const options = { ...defaultXYZOptions(), ...useFxState<Partial<XYZOptions>>('options', {}) };
  const colorCtl: ControlProps = {
    value: color, min: 0, max: 256, defaultValue: 144, step: 1, label: 'Display color', format: (v) => `${Math.round((v / 256) * 100)}%`,
    onChange: (v) => editFx(slotId, 'Display color', (p) => { p.color = v; }, `xyzcolor:${slotId}`),
  };
  const zp = useParam('zValue');
  const setOpt = (patch: Partial<XYZOptions>) => editFx(slotId, 'Options', (p) => { p.options = { ...options, ...patch }; });
  const optionsMenu = (e: React.PointerEvent) => openMenu(e.clientX, e.clientY, [
    { header: true, label: 'Control' },
    { label: 'Absolute mode', checked: options.absolute, hint: 'Click for immediate jump', onClick: () => setOpt({ absolute: !options.absolute }) },
    { header: true, label: 'Multi-touch' },
    { label: 'Fingertip control', checked: options.fingertip, hint: 'Control X-Y using one fingertip', onClick: () => setOpt({ fingertip: !options.fingertip }) },
    { header: true, label: 'Window' },
    { label: 'Round to square', checked: options.roundToSquare, onClick: () => setOpt({ roundToSquare: !options.roundToSquare }) },
  ]);
  const padH = hide ? 405 : 270;
  return (
    <FxPanel width={425} height={417} style={{ background: '#484e53' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 425, height: hide ? 417 : 294, background: padColor(color, 30) }} />
      <div onWheel={(e) => { e.stopPropagation(); zp.control.onBegin?.(); zp.set(Math.min(65536, Math.max(0, zp.value + (e.deltaY < 0 ? 1 : -1) * 2048))); zp.control.onEnd?.(); }}>
        <Pad x={0} y={0} w={425} h={padH} />
      </div>
      {!hide && AXES.map((a, i) => (
        <div key={a}>
          <div className="fxk-abs" style={{ left: 8 + i * 127, top: 276, width: 8, height: 12, fontSize: 9.5, lineHeight: '12px', color: BAR_COLORS[i], pointerEvents: 'none' }}>{a}</div>
          <ParamSlider k={`${a}Value`} x={18 + i * 127} y={277} w={108} h={10} fill={BAR_COLORS[i]} />
        </div>
      ))}
      <Gear x={404} y={hide ? 398 : 274} hint="Hide controls" onClick={() => editFx(slotId, 'Hide controls', (p) => { p.hideControls = !hide; })} />
      {!hide && (
        <>
          <div className="fxk-abs" style={{ left: 0, top: 296, width: 425, height: 1, background: '#363c41' }} />
          <XYZTabs x={6} y={305} />
          <PageSelect x={312} y={305} />
          <JoyIcon x={10} y={337} />
          <Cap x={50} y={339} w={32}>SPEED</Cap>
          <ParamSlider k={`${AXES[axis]}Speed`} x={82} y={341} w={42} h={10} />
          <Cap x={133} y={339} w={22}>ACC</Cap>
          <ParamSlider k={`${AXES[axis]}Acc`} x={154} y={341} w={42} h={10} />
          <div className="fxk-abs" style={{ left: 0, top: 361, width: 425, height: 1, background: '#3a4045' }} />
          <Gear x={8} y={380} hint="Extra options" arrow onClick={optionsMenu} />
          <Cap x={36} y={380} w={74} align="right">GLOBAL SPEED</Cap>
          <ParamSlider k="globalSpeed" x={113} y={382} w={42} h={10} />
          <JoyIcon x={68} y={396} />
          <Cap x={60} y={398} w={50} align="right">SPEED</Cap>
          <ParamSlider k="extSpeed" x={113} y={400} w={42} h={10} />
          <Cap x={385} y={368} w={38} align="center">COLOR</Cap>
          <FlKnobControl x={387} y={382} size={34} color="#c8ced2" control={colorCtl} />
        </>
      )}
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'xyzctrl',
  Editor: XYZCtrlEditor,
  menu: (slotId) => [
    { label: 'Center cursor', onClick: () => { setFxParam(slotId, 'xValue', 32768); setFxParam(slotId, 'yValue', 32768); setFxParam(slotId, 'zValue', 32768); } },
  ],
};
