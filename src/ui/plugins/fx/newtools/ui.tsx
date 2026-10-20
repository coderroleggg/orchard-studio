// Shared editor parts for Newtone / Newtime at FL's form coordinates: the
// toolbar (transport, slave / auto-scroll, plugin name, title, length /
// selection, tempo + SYNC, icon buttons with menus, master meter), FL's
// metallic ring knobs, and the Sample properties dialog (Tempo, Tempo-sync,
// Default, Accept). Icons are drawn here (no Image-Line artwork).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { store } from '../../../../store';
import { AnimatedDisplay, useFxMonitor } from '../../kit';
import './newtools.css';

export type NtIcon =
  | 'loop' | 'play' | 'pause' | 'stop' | 'slave' | 'scroll' | 'file' | 'edit' | 'select' | 'undo' | 'snap'
  | 'score' | 'saveas' | 'drag' | 'playlist' | 'cut' | 'adv';

export function Icon({ name, size = 16 }: { name: NtIcon; size?: number }) {
  const s = { width: size, height: size, viewBox: '0 0 16 16', style: { display: 'block' } } as const;
  const W = '#f3f6f8';
  switch (name) {
    case 'loop': return <svg {...s}><path d="M4.6 5 C2 5 1.2 6.6 1.2 8 C1.2 9.4 2 11 4.6 11 C6.6 11 7.4 9.6 8 8 C8.6 6.4 9.4 5 11.4 5 C14 5 14.8 6.6 14.8 8 C14.8 9.4 14 11 11.4 11 C9.4 11 8.6 9.6 8 8 C7.4 6.4 6.6 5 4.6 5 Z" fill="none" stroke={W} strokeWidth="1.4" /></svg>;
    case 'play': return <svg {...s}><path d="M5.5 3.5 L11 8 L5.5 12.5 Z" fill={W} /></svg>;
    case 'pause': return <svg {...s}><path d="M4.5 4 H7 V12 H4.5 Z M9 4 H11.5 V12 H9 Z" fill={W} /></svg>;
    case 'stop': return <svg {...s}><rect x="4.5" y="4.5" width="7" height="7" fill={W} /></svg>;
    case 'slave': return <svg {...s} viewBox="0 0 22 10" width={size * 1.6} height={size * 0.75}><path d="M0.5 5 H4 M8.5 5 H13 M17.5 5 H21.5" stroke={W} strokeWidth="1.5" /><rect x="4" y="2.5" width="4.5" height="5" fill="none" stroke={W} strokeWidth="1.5" /><rect x="13" y="2.5" width="4.5" height="5" fill="none" stroke={W} strokeWidth="1.5" /></svg>;
    case 'scroll': return <svg {...s} viewBox="0 0 18 12" width={size * 1.3} height={size * 0.85}><path d="M2 2 H3.6 V10 H2 Z M5 2 H6.6 V10 H5 Z" fill="currentColor" /><path d="M8.5 1.5 L15.5 6 L8.5 10.5 Z" fill="currentColor" /></svg>;
    case 'file': return <svg {...s}><path d="M2.5 1.5 H11.5 L13.5 3.5 V14.5 H2.5 Z" fill={W} /><rect x="4.5" y="1.5" width="6" height="4" fill="#2b3237" /><rect x="8.2" y="2.2" width="1.4" height="2.6" fill={W} /><rect x="4" y="8" width="8" height="5.2" fill="#ffffff" stroke="#c9d1d5" strokeWidth="0.4" /></svg>;
    case 'edit': return <svg {...s}><circle cx="4.6" cy="12" r="2.1" fill="none" stroke={W} strokeWidth="1.4" /><circle cx="11.4" cy="12" r="2.1" fill="none" stroke={W} strokeWidth="1.4" /><path d="M5.8 10.4 L12 1.5 M10.2 10.4 L4 1.5" stroke={W} strokeWidth="1.5" /></svg>;
    case 'select': return <svg {...s}><path d="M2.5 6 V2.5 H6 M10 2.5 H13.5 V6 M13.5 10 V13.5 H10 M6 13.5 H2.5 V10" fill="none" stroke={W} strokeWidth="1.6" /></svg>;
    case 'undo': return <svg {...s}><path d="M3.7 5.6 A5 5 0 1 0 6.6 3.2" fill="none" stroke={W} strokeWidth="1.7" /><path d="M7.6 0.8 L7.6 5.4 L3.6 3.6 Z" fill={W} /></svg>;
    case 'snap': return <svg {...s}><path d="M3.5 13 V7 A4.5 4.5 0 0 1 12.5 7 V13" fill="none" stroke={W} strokeWidth="2.6" /><rect x="2.2" y="10.6" width="2.6" height="2.6" fill="#2b3237" /><rect x="11.2" y="10.6" width="2.6" height="2.6" fill="#2b3237" /></svg>;
    case 'score': return <svg {...s}><path d="M3 12 H5.5 M6.5 9.5 H9 M10 7 H12.5 M5.5 12 H8 M9 9.5 H11.5" stroke={W} strokeWidth="1.5" strokeDasharray="2 1.2" /></svg>;
    case 'saveas': return <svg {...s}><path d="M2.5 1.5 H11.5 L13.5 3.5 V10 H10 V14.5 H2.5 Z" fill={W} /><rect x="4.5" y="1.5" width="6" height="4" fill="#2b3237" /><rect x="4" y="8" width="5" height="5" fill="#ffffff" /><path d="M12.2 10.5 V15.5 M9.7 13 H14.7" stroke={W} strokeWidth="1.6" /></svg>;
    case 'drag': return <svg {...s}><path d="M2 1.5 L2 10 L4.3 7.8 L6 11.5 L7.4 10.8 L5.8 7.2 L8.8 7.2 Z" fill={W} /><rect x="8.5" y="7.5" width="5.5" height="7" fill="none" stroke={W} strokeWidth="1.2" /><path d="M10 10 H12.6 M10 12 H12.6" stroke={W} strokeWidth="1" /></svg>;
    case 'playlist': return <svg {...s}><path d="M6 0.8 H10 L8 2.8 Z" fill={W} /><rect x="1.5" y="4" width="13" height="10" fill="none" stroke={W} strokeWidth="1.3" /><path d="M3 11.5 H6 M6.8 9 H9.8 M10.6 6.6 H13.2" stroke={W} strokeWidth="1.4" /></svg>;
    case 'cut': return <svg {...s}><path d="M3 2 L11 2 L14 13 L6 13 Z" fill="#e9eef0" /><path d="M9.6 2 L11 2 L14 13 L12.6 13 Z" fill="#2b3237" /><path d="M5 5 L8.6 9.8" stroke="#2b3237" strokeWidth="1.2" /></svg>;
    case 'adv': return <svg {...s}><path d="M1.5 11 H4 C4.6 11 4.8 10.6 5 10 L6 6.5 C6.4 5 9.6 5 10 6.5 L11 10 C11.2 10.6 11.4 11 12 11 H14.5" fill="none" stroke="currentColor" strokeWidth="1.8" /></svg>;
  }
}

type Box = { x: number; y: number; w: number; h: number };

/** A toolbar button (transport, slave, auto-scroll, mode buttons). */
export function NtButton({ x, y, w, h, icon, hint, onClick, onRight, tone, children, iconSize }: Box & {
  icon?: NtIcon; hint: string; onClick: (e: React.PointerEvent) => void; onRight?: (e: React.MouseEvent) => void;
  tone?: 'green' | 'pink' | 'lit' | 'down'; children?: ReactNode; iconSize?: number;
}) {
  return (
    <div className={'ntl-btn' + (tone ? ' ' + tone : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onRight?.(e); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {icon && <Icon name={icon} size={iconSize ?? Math.min(w, h) - 6} />}
      {children}
    </div>
  );
}

export interface ToolButton {
  x: number;
  icon: NtIcon;
  hint: string;
  /** A drop-down menu (left click). */
  menu?: () => MenuItem[];
  onClick?: (e: React.PointerEvent) => void;
  onRight?: (e: React.MouseEvent) => void;
  /** Draggable payload (Drag selection). */
  drag?: (e: React.DragEvent) => void;
}

/** One group of FL's icon buttons (26 x 29 each, at y 11). */
export function ToolGroup({ buttons }: { buttons: ToolButton[] }) {
  if (!buttons.length) return null;
  const x0 = buttons[0].x, x1 = buttons[buttons.length - 1].x + 26;
  return (
    <>
      <div className="ntl-group" style={{ left: x0 - 1, top: 10, width: x1 - x0 + 2, height: 31 }} />
      {buttons.map((b) => (
        <div key={b.x} className="ntl-tbtn" style={{ left: b.x, top: 11, width: 26, height: 29 }}
          draggable={!!b.drag}
          onDragStart={b.drag}
          onPointerDown={(e) => {
            if (e.button !== 0 || b.drag) return;
            e.stopPropagation();
            if (b.menu) {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu(r.left, r.bottom, b.menu(), { minWidth: 190 });
            } else b.onClick?.(e);
          }}
          onClick={(e) => { if (b.drag) b.onClick?.(e as unknown as React.PointerEvent); }}
          onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); b.onRight?.(e); }}
          onPointerEnter={() => setHint(b.hint)} onPointerLeave={clearHint}>
          <Icon name={b.icon} size={16} />
          {b.menu && <div className="tri" />}
        </div>
      ))}
    </>
  );
}

/** FL's metallic knob with a coloured value ring (Newtone / Newtime toolbar wheels). */
export function RingKnob({ x, y, size = 40, color, control, bipolar, defaultMark }: { x: number; y: number; size?: number; color: string; control: ControlProps; bipolar?: boolean; defaultMark?: number }) {
  const h = useControl({ travel: 180, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const S = size, c = S / 2;
  const A0 = -135, SW = 270;
  const pol = (r: number, deg: number): [number, number] => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };
  const arc = (r: number, a0: number, a1: number) => {
    if (Math.abs(a1 - a0) < 0.3) return '';
    const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
    const [x0, y0] = pol(r, lo), [x1, y1] = pol(r, hi);
    return `M${x0} ${y0} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const ang = A0 + SW * t;
  const from = bipolar ? 0 : A0;
  const rR = S * 0.43, rB = S * 0.32;
  const [p0x, p0y] = pol(rB * 0.15, ang), [p1x, p1y] = pol(rB * 0.92, ang);
  const id = useRef(`ntk${Math.random().toString(36).slice(2, 8)}`).current;
  const dm = defaultMark !== undefined ? A0 + SW * Math.min(1, Math.max(0, (defaultMark - min) / (max - min || 1))) : null;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id={id} cx="42%" cy="30%" r="78%">
            <stop offset="0" stopColor="#fbfcfc" />
            <stop offset="0.45" stopColor="#d3d8da" />
            <stop offset="1" stopColor="#7f878b" />
          </radialGradient>
        </defs>
        <path d={arc(rR, A0, A0 + SW)} stroke="#3a4247" strokeWidth={S * 0.12} fill="none" strokeLinecap="round" />
        {Math.abs(ang - from) > 0.3 && <path d={arc(rR, from, ang)} stroke={color} strokeWidth={S * 0.11} fill="none" strokeLinecap="butt" />}
        {dm !== null && (() => { const [dx, dy] = pol(S * 0.53, dm); return <circle cx={dx} cy={dy} r={S * 0.025} fill={color} />; })()}
        <circle cx={c} cy={c + S * 0.03} r={rB + 1} fill="rgba(0,0,0,0.45)" />
        <circle cx={c} cy={c} r={rB} fill={`url(#${id})`} stroke="#5d6569" strokeWidth={0.6} />
        <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#3b4246" strokeWidth={S * 0.045} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** Knob control props for a non-parameter state field (undoable through editFx). */
export function stateControl(opts: {
  value: number; min: number; max: number; def: number; label: string; format: (v: number) => string;
  set: (v: number) => void; step?: number;
}): ControlProps {
  return {
    value: opts.value, min: opts.min, max: opts.max, defaultValue: opts.def, step: opts.step ?? 1, label: opts.label,
    format: opts.format, onChange: (v) => opts.set(Math.round(Math.min(opts.max, Math.max(opts.min, v)))),
    onBegin: () => store.beginGesture(opts.label), onEnd: () => store.endGesture(),
  };
}

/** Master meter (FL's TWAVVolumeter): output peaks of the preview. */
export function MasterMeter({ slotId, x, y, w, h }: Box & { slotId: string }) {
  const st = useRef({ l: 0, r: 0 });
  useFxMonitor(slotId, (d) => {
    st.current.l = Math.max(st.current.l, Number(d.peakL) || 0);
    st.current.r = Math.max(st.current.r, Number(d.peakR) || 0);
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h} frame={(g, W, H) => {
      const s = st.current;
      g.fillStyle = '#1a2024';
      g.fillRect(0, 0, W, H);
      const bw = (W - 3) / 2;
      for (const [k, x0] of [['l', 1], ['r', 2 + bw]] as const) {
        const v = s[k];
        const db = v > 1e-5 ? 20 * Math.log10(v) : -100;
        const f = Math.min(1, Math.max(0, (db + 60) / 63));
        const grad = g.createLinearGradient(0, H, 0, 0);
        grad.addColorStop(0, '#3fb34f');
        grad.addColorStop(0.8, '#d5d84a');
        grad.addColorStop(1, '#e8483c');
        g.fillStyle = grad;
        g.fillRect(x0, H - 1 - f * (H - 2), bw, f * (H - 2));
      }
      s.l *= 0.86; s.r *= 0.86;
    }} />
  );
}

export interface ToolbarProps {
  slotId: string;
  logo: string;
  title: string;
  lengthText: string;
  tempoText: string;
  sync: boolean;
  onSync: () => void;
  onProps: () => void;
  playing: boolean;
  loop: boolean;
  slave: boolean;
  autoScroll: boolean;
  onLoop: () => void;
  onPlay: () => void;
  onStop: () => void;
  onSlave: () => void;
  onSlaveMenu: (e: React.MouseEvent) => void;
  onAutoScroll: () => void;
  groups: ToolButton[][];
  children?: ReactNode;
}

/** The common toolbar (FL form ToolbarWP, 727 x 88). */
export function NtToolbar(p: ToolbarProps) {
  return (
    <div className="ntl-toolbar">
      <NtButton x={5} y={11} w={29} h={28} icon="loop" hint="Loop (L)" tone={p.loop ? 'lit' : undefined} onClick={p.onLoop} iconSize={20} />
      <NtButton x={34} y={11} w={29} h={28} icon={p.playing ? 'pause' : 'play'} hint="Play / pause (Space)" onClick={p.onPlay} iconSize={18} />
      <NtButton x={63} y={11} w={29} h={28} icon="stop" hint="Stop (Space)" onClick={p.onStop} iconSize={18} />
      <NtButton x={5} y={41} w={35} h={17} icon="slave" hint="Slave playback to host (H) - right-click for options" tone={p.slave ? 'green' : undefined} onClick={p.onSlave} onRight={p.onSlaveMenu} iconSize={14} />
      <NtButton x={43} y={41} w={35} h={17} icon="scroll" hint="Scroll to follow cursor (A)" tone={p.autoScroll ? 'green' : undefined} onClick={p.onAutoScroll} iconSize={14} />
      <div className="ntl-logo" style={{ left: 110, top: 14 }}>{p.logo}</div>
      <div className="ntl-cap" style={{ left: 5, top: 61, width: 26 }}>Title</div>
      <div className={'ntl-val' + (p.title ? '' : ' dim')} style={{ left: 6, top: 70, width: 301, height: 14 }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onProps(); }}
        onPointerEnter={() => setHint('Title - right-click to edit the sample properties')} onPointerLeave={clearHint}>{p.title || '(no sample)'}</div>
      <div className="ntl-cap" style={{ left: 405, top: 61, width: 62, textAlign: 'center' }}>Length / sel</div>
      <div className="ntl-val" style={{ left: 388, top: 70, width: 78, height: 15, textAlign: 'right' }}>{p.lengthText}</div>
      <div className="ntl-cap" style={{ left: 477, top: 61, width: 37 }}>Tempo</div>
      <div className="ntl-val" style={{ left: 480, top: 70, width: 60, height: 15 }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onProps(); }}
        onPointerEnter={() => setHint('Tempo - right-click to edit the sample properties')} onPointerLeave={clearHint}>{p.tempoText}</div>
      <div className={'ntl-sync' + (p.sync ? ' on' : '')} style={{ left: 514, top: 60, width: 31, height: 12 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.onSync(); } }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.onProps(); }}
        onPointerEnter={() => setHint('Tempo-sync: stretch the sample to the project tempo')} onPointerLeave={clearHint}>SYNC</div>
      {p.groups.map((g, i) => <ToolGroup key={i} buttons={g} />)}
      <MasterMeter slotId={p.slotId} x={710} y={2} w={14} h={84} />
      {p.children}
    </div>
  );
}

/** FL's Sample properties dialog (TWAVPropForm, 348 x 154). */
export function PropsDialog({ bpm, sync, projectTempo, onAccept, onClose, length }: {
  bpm: number; sync: boolean; projectTempo: number; length?: { sec: number };
  onAccept: (bpm: number, sync: boolean) => void; onClose: () => void;
}) {
  const [text, setText] = useState(bpm > 0 ? String(Math.round(bpm * 1000) / 1000) : '');
  const [ts, setTs] = useState(sync);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { inp.current?.focus(); inp.current?.select(); }, []);
  const accept = () => {
    const v = parseFloat(text.replace(',', '.'));
    onAccept(Number.isFinite(v) && v >= 10 && v <= 999 ? v : 0, ts);
  };
  const beats = length && bpm > 0 ? (length.sec * bpm) / 60 : 0;
  return (
    <div className="ntl-dlg-shade" onPointerDown={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) onClose(); }}
      onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); if (e.key === 'Enter') accept(); }}>
      <div className="ntl-dlg" style={{ left: (727 - 348) / 2, top: 150 }}>
        <div className="ntl-dlg-title">Sample properties<span className="ntl-dlg-x" onPointerDown={onClose}>×</span></div>
        <div className="ntl-dlg-panel">
          <div className="ntl-dlg-tab">Tempo</div>
          <div style={{ position: 'absolute', left: 25, top: 21, height: 23, lineHeight: '23px', fontWeight: 600 }}>Tempo <span style={{ color: '#9aa5ab', fontWeight: 400 }}>(BPM)</span></div>
          <input ref={inp} type="text" value={text} style={{ left: 101, top: 23, width: 140, height: 19 }}
            onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') accept(); if (e.key === 'Escape') onClose(); }} />
          <div className={'ntl-dlg-radio' + (ts ? ' on' : '')} style={{ left: 252, top: 22, width: 95, height: 21 }}
            onPointerDown={() => setTs(!ts)} onPointerEnter={() => setHint('Check for rhythmic content')} onPointerLeave={clearHint}><i />Tempo-sync</div>
          <div className="ntl-dlg-btn" style={{ left: 257, top: 50, width: 81, height: 29 }}
            onPointerDown={() => setText(String(projectTempo))} onPointerEnter={() => setHint("Default (project's) tempo")} onPointerLeave={clearHint}>Default</div>
          {beats > 0 && <div style={{ position: 'absolute', left: 101, top: 50, lineHeight: '29px', color: '#9aa5ab', fontSize: 11 }}>{`${Math.round(beats * 100) / 100} beats`}</div>}
        </div>
        <div className="ntl-dlg-btn" style={{ left: 269, top: 117, width: 72, height: 29, clipPath: 'polygon(10px 0, 100% 0, 100% 100%, 10px 100%, 0 50%)' }} onPointerDown={accept}>Accept</div>
      </div>
    </div>
  );
}

/** Format a sample count like FL's Length / sel label. */
export function lengthText(len: number, sel?: [number, number] | null): string {
  if (sel && sel[1] > sel[0]) return `${Math.round(sel[0])} to ${Math.round(sel[1])}`;
  return len > 0 ? String(Math.round(len)) : '';
}

/** Editor-local pointer position (the editor is CSS-scaled inside the plugin window). */
export function localPos(e: { clientX: number; clientY: number }, el: Element, w: number, h: number): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: ((e.clientX - r.left) * w) / (r.width || w), y: ((e.clientY - r.top) * h) / (r.height || h) };
}
