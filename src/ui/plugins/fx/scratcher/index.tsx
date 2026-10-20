// Scratcher editor (FL: Fruity Scratcher, 247 x 303): Smooth 1-4, Pan and
// Volume on the left, Hold / Mute switches, the record on its platter
// (drag up / down to scratch, right-click for automation), the tone arm whose
// pivot is the Rotations control, Speed / Acc / Sen on the right, the
// transport (reverse / pause / forward), the sample row (browse, name, time
// code options, 2x size) and the waveform (drag horizontally to scratch). The
// options page holds the DVS time code type, RIAA preamp and the signal scope.

import { useEffect, useRef, useState } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import { useControl, automationMenuItems, autoTargetOf } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, flashHint, setHint } from '../../../hint';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import { getRaw, onSamplesChanged } from '../../../../audio/samples';
import { SC_POS_MAX, SC_TIMECODES } from '../../../../model/fx/plugins/scratcher';
import type { SampleInfo } from '../../../../model/types';
import type { FxEditorModule } from '../../registry';
import { deliverSample, importSampleFile } from './samples';
import './scratcher.css';

const W = 247, H = 303;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

let gid = 0;

/** FL's grey faceted vector knob with a white pointer. */
function Knob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 160, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const ang = -135 + 270 * t;
  const c = size / 2, r = c - 0.8;
  const id = `sck${(gid = (gid + 1) % 1e6)}`;
  const [x0, y0] = polar(c, c, r * 0.18, ang);
  const [x1, y1] = polar(c, c, r * 0.86, ang);
  const [f0x, f0y] = polar(c, c, r, ang + 160);
  const [f1x, f1y] = polar(c, c, r, ang + 200);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={id} cx="45%" cy="30%" r="80%">
            <stop offset="0" stopColor="#8c99a1" />
            <stop offset="1" stopColor="#68757d" />
          </radialGradient>
        </defs>
        <circle cx={c} cy={c + 0.8} r={r} fill="rgba(0,0,0,0.35)" />
        <circle cx={c} cy={c} r={r} fill={`url(#${id})`} stroke="#4c565c" strokeWidth={0.7} />
        <path d={`M${c} ${c} L${f0x} ${f0y} A${r} ${r} 0 0 1 ${f1x} ${f1y} Z`} fill="rgba(0,0,0,0.10)" />
        <line x1={c} y1={c} x2={f0x} y2={f0y} stroke="rgba(0,0,0,0.18)" strokeWidth={0.6} />
        <line x1={c} y1={c} x2={f1x} y2={f1y} stroke="rgba(255,255,255,0.12)" strokeWidth={0.6} />
        <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#ffffff" strokeWidth={Math.max(1.2, size * 0.07)} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** HOLD / MUTE switch: a small rectangular LED. Mute's parameter is 0 when muted. */
function Led({ k, x, y, label, invert }: { k: string; x: number; y: number; label: string; invert?: boolean }) {
  const p = useParam(k);
  const on = invert ? p.value < 0.5 : p.value >= 0.5;
  return (
    <div className="fxk-abs sc-led-wrap" style={{ left: x, top: y, width: 24, height: 20 }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); store.beginGesture(p.def.name); p.set(p.value >= 0.5 ? 0 : 1); store.endGesture(); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY)); }}
      onPointerEnter={() => setHint(`${p.def.name}: ${p.def.format?.(p.value) ?? ''}`)} onPointerLeave={clearHint}>
      <div className={'sc-led' + (on ? ' on' : '')} />
      <div className="sc-led-label">{label}</div>
    </div>
  );
}

/** Reverse / pause / forward selector. */
function Transport({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const p = useParam('transport');
  const v = Math.round(p.value);
  const pick = (t: number) => { store.beginGesture(p.def.name); p.set(t); store.endGesture(); };
  const cells = [-1, 0, 1];
  return (
    <div className="fxk-abs sc-transport" style={{ left: x, top: y, width: w, height: h }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY)); }}>
      {cells.map((t) => (
        <div key={t} className={'sc-tcell' + (t === v ? ' on' : '')}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(t); } }}
          onPointerEnter={() => setHint(`Transport: ${['Reverse', 'Pause', 'Forward'][t + 1]}`)} onPointerLeave={clearHint}>
          <svg width={10} height={10} viewBox="0 0 10 10">
            {t === -1 && <path d="M7.5 1.5 L2 5 L7.5 8.5 Z" fill="currentColor" />}
            {t === 0 && <path d="M2.5 1.5 H4.3 V8.5 H2.5 Z M5.7 1.5 H7.5 V8.5 H5.7 Z" fill="currentColor" />}
            {t === 1 && <path d="M2.5 1.5 L8 5 L2.5 8.5 Z" fill="currentColor" />}
          </svg>
        </div>
      ))}
    </div>
  );
}

interface Mon { loaded: boolean; frac: number; sec: number; speed: number; level: number; scope: number[] }

function useScratchMonitor(slotId: string) {
  const ref = useRef<Mon>({ loaded: false, frac: 0, sec: 0, speed: 0, level: 0, scope: [] });
  useFxMonitor(slotId, (d) => {
    ref.current = {
      loaded: !!d.loaded, frac: Number(d.frac) || 0, sec: Number(d.sec) || 0, speed: Number(d.speed) || 0,
      level: Number(d.level) || 0, scope: Array.isArray(d.scope) ? (d.scope as number[]) : [],
    };
  });
  return ref;
}

/** Seconds of audio per turn of the platter: the sample spans `Rotations` turns (at least one). */
function secPerTurn(info: SampleInfo | null, rot: number): number {
  const len = info ? info.frames / info.sampleRate : 1.8;
  return len / Math.max(1, Math.round(rot));
}

/** The record: rotates with the playback position; drag vertically to scratch. */
function Platter({ x, y, size, mon, info }: { x: number; y: number; size: number; mon: React.RefObject<Mon>; info: SampleInfo | null }) {
  const pos = useParam('pos');
  const sens = useParam('sens');
  const rot = useParam('rot');
  const drag = useRef<{ y: number; v: number } | null>(null);
  const angle = useRef(0);
  const lastT = useRef(0);
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    // grab at the record's current position so the platter does not jump
    const v = Math.round((mon.current?.frac ?? pos.value / SC_POS_MAX) * SC_POS_MAX);
    drag.current = { y: e.clientY, v };
    store.beginGesture(pos.def.name);
    pos.set(v);
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) { setHint(`${pos.def.name}: ${pos.def.format?.(pos.value) ?? ''}`); return; }
    const scale = (e.currentTarget as HTMLElement).getBoundingClientRect().height / size || 1;
    const dy = (e.clientY - d.y) / scale;
    d.y = e.clientY;
    // one platter height of mouse travel = one turn of the record (sensitivity 50%), up = forward
    const s = Math.pow(2, (sens.value - 50) / 25);
    const len = info ? info.frames / info.sampleRate : 0;
    if (len <= 0) return;
    const dSec = (-dy / size) * secPerTurn(info, rot.value) * s;
    d.v = ((d.v + (dSec / len) * SC_POS_MAX) % SC_POS_MAX + SC_POS_MAX) % SC_POS_MAX;
    pos.set(Math.round(d.v));
  };
  const onUp = () => { if (drag.current) { drag.current = null; store.endGesture(); } };
  return (
    <AnimatedDisplay x={x} y={y} w={size} h={size} className="sc-platter"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      onContextMenu={(e) => { e.preventDefault(); openMenu(e.clientX, e.clientY, automationMenuItems(autoTargetOf(pos.control), e.clientX, e.clientY)); }}
      frame={(g, w, h, t) => {
        const m = mon.current;
        const spt = secPerTurn(info, rot.value);
        if (m?.loaded) angle.current = (m.sec / spt) * 360;
        else if (lastT.current) angle.current += 0;
        lastT.current = t;
        drawRecord(g, w, h, angle.current);
      }} />
  );
}

function drawRecord(g: CanvasRenderingContext2D, w: number, h: number, ang: number): void {
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 1;
  g.clearRect(0, 0, w, h);
  // shadow and vinyl
  g.beginPath(); g.arc(cx + 1.5, cy + 2, r, 0, Math.PI * 2); g.fillStyle = 'rgba(0,0,0,0.35)'; g.fill();
  const vinyl = g.createRadialGradient(cx, cy, r * 0.2, cx, cy, r);
  vinyl.addColorStop(0, '#1d1f21');
  vinyl.addColorStop(1, '#101112');
  g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fillStyle = vinyl; g.fill();
  // grooves
  g.lineWidth = 0.5;
  for (let k = 0; k < 26; k++) {
    const rr = r * (0.34 + (0.62 * k) / 26);
    g.strokeStyle = k % 5 === 0 ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.035)';
    g.beginPath(); g.arc(cx, cy, rr, 0, Math.PI * 2); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 1;
  g.beginPath(); g.arc(cx, cy, r - 0.6, 0, Math.PI * 2); g.stroke();
  // light reflections (fixed: the light does not turn with the record)
  for (const base of [-45, 135]) {
    const grad = g.createRadialGradient(cx, cy, r * 0.3, cx, cy, r);
    grad.addColorStop(0, 'rgba(255,255,255,0)');
    grad.addColorStop(0.55, 'rgba(255,255,255,0.22)');
    grad.addColorStop(0.85, 'rgba(255,255,255,0.12)');
    grad.addColorStop(1, 'rgba(255,255,255,0.03)');
    g.beginPath();
    g.moveTo(cx, cy);
    g.arc(cx, cy, r * 0.97, ((base - 22 - 90) * Math.PI) / 180, ((base + 22 - 90) * Math.PI) / 180);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
  }
  // label (turns with the record)
  g.save();
  g.translate(cx, cy);
  g.rotate((ang * Math.PI) / 180);
  const lr = r * 0.3;
  const lab = g.createRadialGradient(0, 0, lr * 0.2, 0, 0, lr);
  lab.addColorStop(0, '#ffb43c');
  lab.addColorStop(1, '#f2901f');
  g.beginPath(); g.arc(0, 0, lr, 0, Math.PI * 2); g.fillStyle = lab; g.fill();
  g.strokeStyle = 'rgba(120,60,0,0.35)'; g.lineWidth = 0.8;
  g.beginPath(); g.arc(0, 0, lr * 0.72, 0, Math.PI * 2); g.stroke();
  // a simple mark on the label shows the rotation
  g.fillStyle = 'rgba(60,30,0,0.75)';
  g.beginPath();
  g.moveTo(0, -lr * 0.85); g.lineTo(lr * 0.16, -lr * 0.42); g.lineTo(-lr * 0.16, -lr * 0.42); g.closePath();
  g.fill();
  g.font = `bold ${Math.round(lr * 0.28)}px sans-serif`;
  g.textAlign = 'center';
  g.fillText('33', 0, lr * 0.55);
  g.restore();
  // spindle
  g.beginPath(); g.arc(cx, cy, 2.2, 0, Math.PI * 2); g.fillStyle = '#d7dde0'; g.fill();
  g.strokeStyle = '#6b7378'; g.lineWidth = 0.6; g.stroke();
}

/** Tone arm; its pivot is the Rotations control (FL's dummy wheel). */
function ToneArm() {
  const p = useParam('rot');
  const h = useControl({ travel: 120, ...p.control }, 'vertical');
  return (
    <>
      <svg className="fxk-abs" width={W} height={210} viewBox={`0 0 ${W} 210`} style={{ left: 0, top: 0, pointerEvents: 'none' }}>
        <defs>
          <linearGradient id="scArm" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#8b9599" />
            <stop offset="0.45" stopColor="#eef2f3" />
            <stop offset="1" stopColor="#7c868a" />
          </linearGradient>
        </defs>
        {/* arm tube from the pivot to the head shell */}
        <g transform="translate(221 26) rotate(28)">
          <rect x={-2.8} y={-6} width={5.6} height={112} rx={2.6} fill="url(#scArm)" stroke="#5d676b" strokeWidth={0.5} />
          <rect x={-4} y={-20} width={8} height={15} rx={2} fill="url(#scArm)" stroke="#5d676b" strokeWidth={0.5} />
          <rect x={-4.6} y={-24} width={9.2} height={5} rx={1} fill="#9aa4a8" stroke="#5d676b" strokeWidth={0.5} />
        </g>
        <g transform="translate(168.4 124.9) rotate(48)">
          <rect x={-5} y={-2} width={10} height={20} rx={1.5} fill="#cfd6d9" stroke="#5d676b" strokeWidth={0.6} />
          <rect x={-3.5} y={14} width={7} height={5} fill="#3c4347" />
        </g>
      </svg>
      <div className="fxk-abs fxk-wheel sc-pivot" style={{ left: 205, top: 10, width: 32, height: 32 }} {...h}>
        <svg width={32} height={32} viewBox="0 0 32 32">
          <defs>
            <radialGradient id="scPivot" cx="40%" cy="35%" r="70%">
              <stop offset="0" stopColor="#f3f6f7" />
              <stop offset="0.6" stopColor="#b6bfc3" />
              <stop offset="1" stopColor="#7a8488" />
            </radialGradient>
          </defs>
          <circle cx={16} cy={16} r={15.5} fill="#3e4549" />
          <circle cx={16} cy={16} r={13} fill="url(#scPivot)" />
          <circle cx={16} cy={16} r={6} fill="#9ca6aa" stroke="#6c767a" strokeWidth={0.6} />
        </svg>
      </div>
    </>
  );
}

/** Waveform of the loaded sample with the play position; drag horizontally to scratch. */
function WaveScope({ x, y, w, h, info, mon }: { x: number; y: number; w: number; h: number; info: SampleInfo | null; mon: React.RefObject<Mon> }) {
  const pos = useParam('pos');
  const [ver, setVer] = useState(0);
  useEffect(() => onSamplesChanged(() => setVer((v) => v + 1)), []);
  const peaks = useRef<{ id: string; ver: number; lo: Float32Array; hi: Float32Array } | null>(null);
  const getPeaks = () => {
    if (!info) return null;
    if (peaks.current && peaks.current.id === info.id && peaks.current.ver === ver) return peaks.current;
    const raw = getRaw(info.id);
    if (!raw) return null;
    const cols = Math.round(w * 2);
    const lo = new Float32Array(cols), hi = new Float32Array(cols);
    const ch = raw.channels, n = ch[0].length;
    for (let c = 0; c < cols; c++) {
      const a = Math.floor((c * n) / cols), b = Math.max(a + 1, Math.floor(((c + 1) * n) / cols));
      let mn = 1, mx = -1;
      for (let i = a; i < b && i < n; i++) {
        const v = ch.length > 1 ? 0.5 * (ch[0][i] + ch[1][i]) : ch[0][i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      lo[c] = mn; hi[c] = mx;
    }
    peaks.current = { id: info.id, ver, lo, hi };
    return peaks.current;
  };
  const drag = useRef(false);
  const setFromX = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    pos.set(Math.round(f * SC_POS_MAX));
  };
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} className="sc-wave"
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = true; store.beginGesture(pos.def.name); setFromX(e); }}
      onPointerMove={(e) => { if (drag.current) setFromX(e); else setHint('Waveform: drag to scratch'); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } }}
      frame={(g, cw, ch) => {
        g.fillStyle = '#4e616d';
        g.fillRect(0, 0, cw, ch);
        g.strokeStyle = 'rgba(255,255,255,0.05)';
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 1; k < 12; k++) { const gx = Math.round((k * cw) / 12) + 0.5; g.moveTo(gx, 0); g.lineTo(gx, ch); }
        for (let k = 1; k < 4; k++) { const gy = Math.round((k * ch) / 4) + 0.5; g.moveTo(0, gy); g.lineTo(cw, gy); }
        g.stroke();
        const pk = getPeaks();
        const mid = ch / 2;
        if (pk) {
          g.fillStyle = '#c5eae7';
          const cols = pk.lo.length;
          for (let c = 0; c < cols; c++) {
            const px = (c / cols) * cw;
            const top = mid - pk.hi[c] * (ch / 2 - 3), bot = mid - pk.lo[c] * (ch / 2 - 3);
            g.fillRect(px, top, cw / cols + 0.25, Math.max(0.6, bot - top));
          }
          const m = mon.current;
          const f = m?.loaded ? m.frac : pos.value / SC_POS_MAX;
          const lx = Math.round(f * cw) + 0.5;
          g.strokeStyle = '#d6b45a';
          g.beginPath(); g.moveTo(lx, 0); g.lineTo(lx, ch); g.stroke();
        } else {
          g.fillStyle = 'rgba(255,255,255,0.35)';
          g.font = '10px sans-serif';
          g.textAlign = 'center';
          g.fillText(info ? 'Loading sample...' : 'Click the folder or drop an audio file', cw / 2, mid + 3);
        }
        g.save();
        g.font = 'italic 11px sans-serif';
        g.textAlign = 'right';
        g.fillStyle = 'rgba(255,255,255,0.22)';
        g.fillText('SCRATCHER', cw - 4, ch - 4);
        g.restore();
      }} />
  );
}

/** DVS options page: time code type, RIAA preamp and the input signal's scope. */
function OptionsPage({ mon }: { mon: React.RefObject<Mon> }) {
  const { slotId, params } = useFxEditor();
  const tc = typeof params.timecode === 'number' ? params.timecode : 0;
  const riaa = !!params.riaa;
  return (
    <div className="fxk-abs sc-options" style={{ left: 0, top: 0, width: W, height: 205 }}>
      <div className="fxk-abs sc-optlabel" style={{ left: 5, top: 5 }}>TIMECODE TYPE</div>
      <div className="fxk-abs sc-optlabel" style={{ left: 180, top: 5 }}>RIAA PREAMP</div>
      <div className="fxk-abs sc-combo" style={{ left: 3, top: 22, width: 155, height: 20 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, SC_TIMECODES.map((name, i) => ({ label: name, radio: true, checked: i === tc, onClick: () => A.editFx(slotId, 'Time code', (p) => { p.timecode = i; }) } as MenuItem)), { minWidth: r.width });
        }}
        onPointerEnter={() => setHint('Time code support')} onPointerLeave={clearHint}>
        <span>{SC_TIMECODES[tc]}</span>
        <svg width={6} height={8} viewBox="0 0 6 8"><path d="M1 0 L5 4 L1 8 Z" fill="#c9d2d6" /></svg>
      </div>
      <div className="fxk-abs sc-smallbtn disabled" style={{ left: 160, top: 22, width: 19, height: 20 }}
        onPointerEnter={() => setHint('Download timecode cd wav (not available here)')} onPointerLeave={clearHint}>
        <svg width={12} height={12} viewBox="0 0 12 12"><path d="M6 1 V7 M3.5 4.8 L6 7.3 L8.5 4.8 M2 9 V10.5 H10 V9" stroke="#dfe6e9" strokeWidth="1.3" fill="none" /></svg>
      </div>
      <div className="fxk-abs sc-led-wrap" style={{ left: 198, top: 24, width: 22, height: 20 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'RIAA preamp', (p) => { p.riaa = !riaa; }); } }}
        onPointerEnter={() => setHint(`RIAA preamp: ${riaa ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
        <div className={'sc-led' + (riaa ? ' on' : '')} />
      </div>
      <AnimatedDisplay x={3} y={50} w={241} h={151} className="sc-signal" frame={(g, w, h) => {
        g.fillStyle = '#546773';
        g.fillRect(0, 0, w, h);
        g.strokeStyle = 'rgba(255,255,255,0.06)';
        g.beginPath();
        for (let k = 1; k < 8; k++) { const gx = Math.round((k * w) / 8) + 0.5; g.moveTo(gx, 0); g.lineTo(gx, h); }
        for (let k = 1; k < 6; k++) { const gy = Math.round((k * h) / 6) + 0.5; g.moveTo(0, gy); g.lineTo(w, gy); }
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.14)';
        g.beginPath(); g.moveTo(w / 2 + 0.5, 0); g.lineTo(w / 2 + 0.5, h); g.moveTo(0, h / 2 + 0.5); g.lineTo(w, h / 2 + 0.5); g.stroke();
        const s = mon.current?.scope ?? [];
        g.fillStyle = '#f0f6f8';
        for (let i = 0; i + 1 < s.length; i += 2) {
          const px = w / 2 + s[i] * (w * 0.45), py = h / 2 - s[i + 1] * (h * 0.45);
          g.fillRect(px - 0.6, py - 0.6, 1.2, 1.2);
        }
      }} />
    </div>
  );
}

function ScratcherEditor() {
  const { slotId, params } = useFxEditor();
  const mon = useScratchMonitor(slotId);
  const info = (params.sample && typeof params.sample === 'object' ? params.sample : null) as SampleInfo | null;
  const showOptions = !!params.dvs;
  const zoom = !!params.zoom;
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (info) void deliverSample(info); }, [info?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = async (f: File | undefined) => {
    if (!f) return;
    flashHint(`Loading ${f.name}...`);
    const next = await importSampleFile(f);
    if (!next) { flashHint(`Could not decode ${f.name}`); return; }
    A.editFx(slotId, 'Load sample', (p) => { p.sample = next; });
    flashHint(`Loaded ${next.name}`);
  };
  const toggleZoom = () => {
    A.editFx(slotId, 'Toggle Scratcher size', (p) => { p.zoom = !zoom; });
    const id = 'fx:' + slotId;
    const win = store.ui.windows[id];
    if (win) A.updateWindow(id, { w: (zoom ? W : W * 2) + 2, h: (zoom ? H : H * 2) + 26 });
  };

  return (
    <FxPanel width={W} height={H} className="sc-panel">
      <div className="sc-drop" onDragOver={(e) => { e.preventDefault(); }}
        onDrop={(e) => { e.preventDefault(); void load(e.dataTransfer.files[0]); }}>
        {!showOptions && (
          <>
            <div className="fxk-abs sc-group" style={{ left: 3, top: 5, width: 47, height: 53 }} />
            <div className="fxk-abs sc-label" style={{ left: 3, top: 51, width: 47 }}>SMOOTH</div>
            <div className="fxk-abs sc-group" style={{ left: 3, top: 63, width: 37, height: 82 }} />
            <div className="fxk-abs sc-group" style={{ left: 3, top: 147, width: 37, height: 54 }} />
            <div className="fxk-abs sc-group" style={{ left: 207, top: 80, width: 37, height: 121 }} />
            <Knob k="sm1" x={6} y={9} size={20} />
            <Knob k="sm2" x={27} y={9} size={20} />
            <Knob k="sm3" x={6} y={30} size={20} />
            <Knob k="sm4" x={27} y={30} size={20} />
            <Knob k="pan" x={7} y={67} size={28} />
            <Knob k="vol" x={7} y={107} size={28} />
            <div className="fxk-abs sc-label" style={{ left: 3, top: 94, width: 37 }}>PAN</div>
            <div className="fxk-abs sc-label" style={{ left: 3, top: 135, width: 37 }}>VOL</div>
            <Led k="hold" x={10} y={151} label="HOLD" />
            <Led k="mute" x={10} y={177} label="MUTE" invert />
            <Platter x={51} y={12} size={150} mon={mon} info={info} />
            <ToneArm />
            <Knob k="speed" x={211} y={84} size={28} />
            <Knob k="acc" x={211} y={123} size={28} />
            <Knob k="sens" x={211} y={162} size={28} />
            <div className="fxk-abs sc-label" style={{ left: 207, top: 111, width: 37 }}>SPEED</div>
            <div className="fxk-abs sc-label" style={{ left: 207, top: 150, width: 37 }}>ACC</div>
            <div className="fxk-abs sc-label" style={{ left: 207, top: 189, width: 37 }}>SEN</div>
            <Transport x={46} y={171} w={156} h={25} />
          </>
        )}
        {showOptions && <OptionsPage mon={mon} />}
        <div className="fxk-abs sc-smallbtn" style={{ left: 2, top: 205, width: 34, height: 20 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); fileInput.current?.click(); } }}
          onPointerEnter={() => setHint('Select wave file')} onPointerLeave={clearHint}>
          <svg width={14} height={12} viewBox="0 0 14 12"><path d="M1 2 H5 L6.5 3.5 H13 V11 H1 Z" fill="none" stroke="#e1e8eb" strokeWidth="1.2" /></svg>
        </div>
        <input ref={fileInput} type="file" accept="audio/*,.wav,.mp3,.ogg,.flac,.aif,.aiff" style={{ display: 'none' }}
          onChange={(e) => { void load(e.target.files?.[0]); e.target.value = ''; }} />
        <div className="fxk-abs sc-path" style={{ left: 39, top: 206, width: 167, height: 18 }}
          onPointerEnter={() => setHint(info ? `Sample: ${info.name}` : 'Sample path')} onPointerLeave={clearHint}>
          {info?.name ?? ''}
        </div>
        <div className={'fxk-abs sc-smallbtn' + (showOptions ? ' on' : '')} style={{ left: 207, top: 205, width: 19, height: 20 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Time code options', (p) => { p.dvs = !showOptions; }); } }}
          onPointerEnter={() => setHint('Time code suppport')} onPointerLeave={clearHint}>
          <svg width={13} height={13} viewBox="0 0 16 16"><path d="M8 5.2 A2.8 2.8 0 1 0 8 10.8 A2.8 2.8 0 1 0 8 5.2 Z M7 1.5 H9 L9.4 3.4 L11 4.1 L12.6 3 L14 4.4 L12.9 6 L13.6 7.6 L15.5 8 V10 L13.6 10.4 L12.9 12 L14 13.6 L12.6 15 L11 13.9 L9.4 14.6 L9 16.5 H7 L6.6 14.6 L5 13.9 L3.4 15 L2 13.6 L3.1 12 L2.4 10.4 L0.5 10 V8 L2.4 7.6 L3.1 6 L2 4.4 L3.4 3 L5 4.1 L6.6 3.4 Z" transform="translate(0 -1)" fill="#e1e8eb" fillRule="evenodd" /></svg>
        </div>
        <div className={'fxk-abs sc-smallbtn' + (zoom ? ' on' : '')} style={{ left: 226, top: 205, width: 19, height: 20 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggleZoom(); } }}
          onPointerEnter={() => setHint('Toggle Scratcher size')} onPointerLeave={clearHint}>
          <svg width={12} height={12} viewBox="0 0 12 12"><path d="M1.5 4.5 V1.5 H4.5 M7.5 1.5 H10.5 V4.5 M1.5 7.5 V10.5 H4.5 M7.5 10.5 H10.5 V7.5 M3 3 L9 9" stroke="#e1e8eb" strokeWidth="1.2" fill="none" /></svg>
        </div>
        <WaveScope x={3} y={229} w={241} h={71} info={info} mon={mon} />
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'scratcher',
  Editor: ScratcherEditor,
};
