// Autogun editor (FL: TSynthEditorForm.SynthPanel2, 282 x 379; the controls at FL's form positions): the master level knob with its LED
// ring (MainVolSlider2, 97,132 88 x 88), the magic dust arc (SGSlider, 105,232 72 x 29, 0 .. 1000, default 430), the previous / next
// preset buttons (PrevPresetBtn 0,10 / NextPresetBtn 231,10, 51 x 156), the info / settings button (InfoBtn, 4,215 67 x 67) that
// opens the options menu, the screen with the preset's title, author and description, and the testing keyboard. Everything is an
// original drawing in the layout and the colours of FL's panel (sampled from the plugin database thumbnail); no Image-Line artwork.
// Docs: docs/research/gen/autogun.md.

import { memo, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import { keyName } from '../../../../model/notes';
import {
  AG_DUST_DEFAULT, AG_DUST_MAX, AG_QUALITIES, AG_QUALITY_DEFAULT, AG_PRESETS, counterOf, counterOfNumber, presetInfo, presetNumber,
} from '../../../../model/gen/plugins/autogun/state';
import { FxPanel, useFxEditor, useNoScrollWheel, useParam } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { useControl, type ControlProps } from '../../../widgets/control';
import { clearHint, flashHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import './autogun.css';

export const PANEL_W = 282;
export const PANEL_H = 379;

/** FL's form coordinates. */
const KNOB = { x: 97, y: 132, s: 88 };
const INFO = { x: 4, y: 215, s: 67 };
const PREV = { x: 0, y: 10, w: 51, h: 156 };
const NEXT = { x: 231, y: 10, w: 51, h: 156 };
const DUST = { x: 105, y: 232, w: 72, h: 29 };
const KB = { x: 22, y: 307, w: 238, h: 72 };
const SCREEN = { x: 54, y: 30, w: 174, h: 112 };

type Params = Record<string, unknown>;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---------------------------------------------------------------------------------------------------------------- state access

/** A different preset (FL: the buttons and "Enter preset number..." generate the preset, no undo): the quality is the template's again. */
function setCounter(slotId: string, n: number, label: string): void {
  A.setFxStateNoHistory(slotId, label, (d) => {
    d.n = counterOf(n);
    d.quality = AG_QUALITY_DEFAULT;
  });
}

const paramsOf = (slotId: string): Params => (A.findFx(store.project, slotId)?.fx.params ?? {}) as Params;

/** Previous (-1) / next (+1) preset: the counter moves by one, 32 bit (FL's RandPadBtnClick of the two buttons). */
export function stepPreset(slotId: string, delta: number): void {
  setCounter(slotId, counterOf(num(paramsOf(slotId).n, 0) + delta), delta < 0 ? 'Previous preset' : 'Next preset');
}

function enterNumber(slotId: string): void {
  const p = paramsOf(slotId);
  const txt = prompt('Current preset number', String(presetNumber(num(p.n, 0))));
  if (txt === null) return;
  const v = Number(txt.trim());
  if (!Number.isInteger(v) || v < 1 || v > AG_PRESETS) {
    flashHint('Autogun: a preset number is 1 to 4294967296');
    return;
  }
  setCounter(slotId, counterOfNumber(v), 'Enter preset number');
}

const about = (() => {
  let open: string | null = null;
  const subs = new Set<() => void>();
  return {
    get: () => open,
    set: (s: string | null) => { open = s; subs.forEach((f) => f()); },
    subscribe: (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; },
  };
})();

/** The options menu (FL: Info / settings button, and the plugin window's menu). */
export function autogunMenu(slotId: string): MenuItem[] {
  const p = paramsOf(slotId);
  const q = num(p.quality, AG_QUALITY_DEFAULT);
  return [
    { label: 'Enter preset number...', onClick: () => enterNumber(slotId) },
    {
      label: 'Processing quality',
      submenu: AG_QUALITIES.map((label, i) => ({
        label, radio: true, checked: q === i,
        onClick: () => A.editFx(slotId, 'Processing quality', (d) => { d.quality = i; }),
      })),
    },
    { separator: true },
    { label: 'About', onClick: () => about.set(slotId) },
    { label: 'Autogun homepage', onClick: () => { window.open('https://www.image-line.com', '_blank', 'noopener'); } },
  ];
}

// ---------------------------------------------------------------------------------------------------------------- drawing

const abs = (b: { x: number; y: number; w?: number; h?: number; s?: number }) => ({ left: b.x, top: b.y, width: b.w ?? b.s, height: b.h ?? b.s });

/** The panel's fixed picture: lid, screen, brushed plate with the engraved name, wood, cables and the keyboard rail. */
const Background = memo(function Background() {
  const grain: ReactNode[] = [];
  for (let i = 0; i < 46; i++) {
    const x = 3 + ((i * 97) % 276);
    grain.push(<rect key={i} x={x} y={150} width={0.6 + (i % 3) * 0.4} height={156} fill={i % 2 ? '#3f2a1d' : '#150d08'} opacity={0.35} />);
  }
  return (
    <svg className="ag-ctl ag-none" width={PANEL_W} height={PANEL_H} viewBox={`0 0 ${PANEL_W} ${PANEL_H}`} style={{ left: 0, top: 0 }}>
      <defs>
        <linearGradient id="agWood" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#120a06" /><stop offset="0.4" stopColor="#2b1b12" /><stop offset="1" stopColor="#1a100a" /></linearGradient>
        <linearGradient id="agPlate" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4e5357" /><stop offset="0.16" stopColor="#d2d5d6" /><stop offset="0.45" stopColor="#a3a7a9" /><stop offset="0.8" stopColor="#8c9092" /><stop offset="1" stopColor="#54595c" />
        </linearGradient>
        <linearGradient id="agLid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#eaecec" /><stop offset="1" stopColor="#8e9294" /></linearGradient>
        <linearGradient id="agScreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#0a1218" /><stop offset="0.08" stopColor="#2f383e" /><stop offset="1" stopColor="#2f383e" /></linearGradient>
        <radialGradient id="agBezel" cx="0.5" cy="0.5" r="0.5"><stop offset="0.8" stopColor="#101416" /><stop offset="0.95" stopColor="#2a3033" /><stop offset="1" stopColor="#0a0d0e" /></radialGradient>
        <linearGradient id="agRail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#242c30" /><stop offset="1" stopColor="#0b0f11" /></linearGradient>
      </defs>
      <rect x={0} y={0} width={PANEL_W} height={PANEL_H} fill="#000" />
      <rect x={0} y={148} width={PANEL_W} height={158} fill="url(#agWood)" />
      {grain}
      {/* cables */}
      <path d="M215 205 C238 225 236 262 262 306" stroke="#050607" strokeWidth={7} fill="none" strokeLinecap="round" />
      <path d="M215 205 C238 225 236 262 262 306" stroke="#2c3236" strokeWidth={1.4} fill="none" transform="translate(-1.6 0)" />
      <path d="M232 208 C258 226 252 262 279 306" stroke="#050607" strokeWidth={7} fill="none" strokeLinecap="round" />
      <path d="M150 232 C158 262 168 280 176 306" stroke="#050607" strokeWidth={7} fill="none" strokeLinecap="round" />
      {/* lid and screen */}
      <path d="M70 28 C70 10 80 2 96 2 H186 C202 2 212 10 212 28 Z" fill="url(#agLid)" />
      <rect x={51} y={28} width={180} height={117} fill="url(#agScreen)" />
      <rect x={51.5} y={28.5} width={179} height={116} fill="none" stroke="#222b31" />
      {/* the plate */}
      <path d="M12 165 L88 150 C97 143 105 130 141 129 C177 130 185 143 194 150 L270 165 L210 217 H72 Z" fill="url(#agPlate)" stroke="#2a2f32" strokeWidth={1} />
      <path d="M72 217 H210 V232 Q141 240 72 232 Z" fill="#585e61" />
      <path d="M78 219 H204" stroke="#c9cccd" strokeWidth={1} opacity={0.6} />
      <text x={61} y={183} fontFamily="'Playfair Display', Georgia, serif" fontSize={20} fontWeight={600} fill="#41474b" letterSpacing="1.5">AUT</text>
      <text x={182} y={183} fontFamily="'Playfair Display', Georgia, serif" fontSize={20} fontWeight={600} fill="#41474b" letterSpacing="1.5">GUN</text>
      <path d="M138 223 l8 0 l-8 -7 z" fill="#3a4044" transform="translate(-1 2)" />
      {/* the knob's dark bezel and the shadow under the plate */}
      <ellipse cx={141} cy={242} rx={22} ry={9} fill="#050607" />
      <circle cx={141} cy={176} r={38} fill="url(#agBezel)" />
      {/* the keyboard rail */}
      <rect x={20} y={296} width={242} height={11} rx={2} fill="url(#agRail)" />
    </svg>
  );
});

/** The master level knob: LED ring (lit clockwise from the top by the value) around a brushed metal cap. */
const MasterKnob = memo(function MasterKnob({ t, lit }: { t: number; lit: boolean }) {
  const dots: ReactNode[] = [];
  const N = 44;
  const on = Math.round(t * N);
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    const x = 44 + Math.cos(a) * 32.5, y = 44 + Math.sin(a) * 32.5;
    const l = i < on;
    dots.push(
      <g key={i}>
        {l && <circle cx={x} cy={y} r={3.2} fill="#2bd0ff" opacity={0.3} />}
        <circle cx={x} cy={y} r={l ? 1.9 : 1.4} fill={l ? '#8defff' : '#1d2629'} />
      </g>,
    );
  }
  const wedges: ReactNode[] = [];
  for (let i = 0; i < 18; i++) {
    const a0 = (i / 18) * Math.PI * 2, a1 = ((i + 1) / 18) * Math.PI * 2;
    const r = 27;
    wedges.push(<path key={i} d={`M44 44 L${44 + Math.cos(a0) * r} ${44 + Math.sin(a0) * r} A${r} ${r} 0 0 1 ${44 + Math.cos(a1) * r} ${44 + Math.sin(a1) * r} Z`} fill={i % 2 ? '#ffffff' : '#000000'} opacity={0.07} />);
  }
  return (
    <svg width={KNOB.s} height={KNOB.s} viewBox="0 0 88 88" style={{ display: 'block', opacity: lit ? 1 : 0.9 }}>
      <defs>
        <radialGradient id="agCap" cx="0.42" cy="0.36" r="0.75"><stop offset="0" stopColor="#fbfcfc" /><stop offset="0.55" stopColor="#bfc3c5" /><stop offset="1" stopColor="#6d7376" /></radialGradient>
      </defs>
      {dots}
      <circle cx={44} cy={44} r={28.5} fill="#0c1012" />
      <circle cx={44} cy={44} r={27} fill="url(#agCap)" />
      {wedges}
      <circle cx={44} cy={44} r={27} fill="none" stroke="#e9ecec" strokeWidth={0.8} opacity={0.5} />
    </svg>
  );
});

function Knob() {
  const { control, value, def } = useParam('level');
  const hnd = useControl({ travel: 220, ...control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="ag-ctl" style={abs(KNOB)} {...hnd}>
      <MasterKnob t={(value - def.min) / (def.max - def.min)} lit />
    </div>
  );
}

/** The magic dust arc (TCircleWheel 72 x 29): dots on a smile, lit orange from the left up to the value. */
const DustArc = memo(function DustArc({ t }: { t: number }) {
  const dots: ReactNode[] = [];
  const N = 19;
  const on = Math.round(t * N);
  for (let i = 0; i < N; i++) {
    const u = i / (N - 1);
    const a = Math.PI * (0.12 + 0.76 * u);
    const x = 36 - Math.cos(a) * 27, y = 6 + Math.sin(a) * 15;
    const l = i < on;
    dots.push(
      <g key={i}>
        {l && <circle cx={x} cy={y} r={3.4} fill="#ff8a1f" opacity={0.3} />}
        <circle cx={x} cy={y} r={1.5} fill={l ? '#ffb04a' : '#3a2a1c'} />
      </g>,
    );
  }
  return <svg width={DUST.w} height={DUST.h} viewBox={`0 0 ${DUST.w} ${DUST.h}`} style={{ display: 'block' }}>{dots}</svg>;
});

function Dust() {
  const { slotId, params } = useFxEditor();
  const v = num(params.dust, AG_DUST_DEFAULT);
  const cp: ControlProps = {
    value: v, min: 0, max: AG_DUST_MAX, defaultValue: AG_DUST_DEFAULT, step: 1, label: 'Magic dust', travel: 160,
    format: (x) => `${Math.round(x / 10)}%`,
    onBegin: () => store.beginGesture('Magic dust'),
    onEnd: () => store.endGesture(),
    onChange: (x) => A.editFx(slotId, 'Magic dust', (d) => { d.dust = Math.round(x); }),
  };
  const hnd = useControl(cp, 'horizontal');
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="ag-ctl" style={abs(DUST)} {...hnd}>
      <DustArc t={v / AG_DUST_MAX} />
    </div>
  );
}

/** The info / settings button: a metal button with a question mark, red while pressed. */
function InfoButton() {
  const { slotId } = useFxEditor();
  const [down, setDown] = useState(false);
  return (
    <div className="ag-ctl" style={{ ...abs(INFO), cursor: 'pointer' }}
      onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); setDown(true); } }}
      onPointerUp={() => setDown(false)}
      onClick={(e) => {
        const r = (e.currentTarget as Element).getBoundingClientRect();
        openMenu(r.left, r.bottom, autogunMenu(slotId));
      }}
      onPointerLeave={() => { setDown(false); clearHint(); }}
      onPointerEnter={() => setHint('Info / settings')}>
      <svg width={INFO.s} height={INFO.s} viewBox="0 0 67 67" style={{ display: 'block' }}>
        <defs>
          <radialGradient id="agInfo" cx="0.4" cy="0.35" r="0.8"><stop offset="0" stopColor="#e9ecec" /><stop offset="1" stopColor="#7c8285" /></radialGradient>
        </defs>
        {down && <circle cx={33.5} cy={33.5} r={31} fill="#ff2a3a" opacity={0.35} />}
        <circle cx={33.5} cy={33.5} r={27} fill="#15191b" />
        <circle cx={33.5} cy={33.5} r={25} fill="url(#agInfo)" />
        <circle cx={33.5} cy={33.5} r={25} fill="none" stroke={down ? '#ff5560' : '#4b5154'} strokeWidth={1.5} />
        <text x={33.5} y={44} textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif" fontSize={30} fontWeight={700} fill={down ? '#b0141f' : '#2f3437'}>?</text>
      </svg>
    </div>
  );
}

/** A previous / next preset button (51 x 156): a dark bar with an arrow, lit blue while hovered, brighter while pressed. */
function PresetButton({ box, dir, onClick }: { box: { x: number; y: number; w: number; h: number }; dir: -1 | 1; onClick: () => void }) {
  const [hot, setHot] = useState(false);
  const [down, setDown] = useState(false);
  const bar = { x: 7, w: 37 };
  const cx = bar.x + bar.w / 2, cy = box.h / 2;
  return (
    <div className="ag-ctl" style={{ ...abs(box), cursor: 'pointer' }}
      onPointerEnter={() => { setHot(true); setHint(dir < 0 ? 'Previous preset' : 'Next preset'); }}
      onPointerLeave={() => { setHot(false); setDown(false); clearHint(); }}
      onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); setDown(true); } }}
      onPointerUp={(e) => { if (e.button === 0 && down) { setDown(false); onClick(); } }}>
      <svg width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={`agBar${dir}`} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={down ? '#0b6f8d' : hot ? '#18738d' : '#2c3438'} /><stop offset="0.5" stopColor={down ? '#35c6ee' : hot ? '#1d94b8' : '#3a4348'} /><stop offset="1" stopColor={down ? '#0b6f8d' : hot ? '#18738d' : '#262d31'} />
          </linearGradient>
        </defs>
        {(hot || down) && <rect x={bar.x - 3} y={2} width={bar.w + 6} height={box.h - 4} rx={9} fill="#25c8f5" opacity={down ? 0.4 : 0.22} />}
        <rect x={bar.x} y={4} width={bar.w} height={box.h - 8} rx={7} fill={`url(#agBar${dir})`} stroke={hot || down ? '#6ae3ff' : '#12171a'} strokeWidth={1.2} />
        <rect x={bar.x + 12} y={9} width={bar.w - 24} height={box.h - 18} fill="#12181b" opacity={0.5} />
        <path d={dir < 0 ? `M${cx + 4} ${cy - 6} L${cx - 4} ${cy} L${cx + 4} ${cy + 6} Z` : `M${cx - 4} ${cy - 6} L${cx + 4} ${cy} L${cx - 4} ${cy + 6} Z`} fill={hot || down ? '#eafcff' : '#a6b0b5'} />
      </svg>
    </div>
  );
}

/** The screen: the preset's title, its author and its description. */
function Screen({ n }: { n: number }) {
  const info = useMemo(() => {
    try { return presetInfo(n); } catch { return { title: '', author: '', lines: [] as string[] }; }
  }, [n]);
  return (
    <div className="ag-screen" style={abs({ ...SCREEN })}>
      <div className="ag-title">{info.title}</div>
      {info.author && <div className="ag-author">{info.author}</div>}
      {info.lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- keyboard

const WHITE_OF = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];
const isBlack = (k: number) => [1, 3, 6, 8, 10].includes(k % 12);
/** The testing keyboard (FL's Kb.bmp is 238 x 72: two octaves of 17 px white keys; C5 .. B6 here). */
const KEY_LO = 60, KEY_HI = 83, WW = 17, BW = 7, BH = 40;

function Keyboard() {
  const { slotId } = useFxEditor();
  const chId = channelOfSlot(slotId);
  const [pressed, setPressed] = useState<number | null>(null);
  const note = useMemo(() => ({ cur: null as { key: number; tag: number } | null }), []);
  // a window closed while a key is held releases it
  useEffect(() => () => {
    if (note.cur && chId) host.noteOff(chId, note.cur.key, note.cur.tag);
    note.cur = null;
  }, [chId, note]);
  const whiteX = (k: number) => (Math.floor((k - KEY_LO) / 12) * 7 + WHITE_OF[(k - KEY_LO) % 12]) * WW;
  const span = (k: number): [number, number] => (isBlack(k - KEY_LO) ? [whiteX(k) + WW - BW / 2 + 0.5, BW] : [whiteX(k), WW]);
  const keyAt = (x: number, y: number): number => {
    if (y < BH + 10) for (let k = KEY_LO; k <= KEY_HI; k++) if (isBlack(k - KEY_LO)) { const [bx, w] = span(k); if (x >= bx && x < bx + w) return k; }
    for (let k = KEY_LO; k <= KEY_HI; k++) if (!isBlack(k - KEY_LO)) { const [kx, w] = span(k); if (x >= kx && x < kx + w) return k; }
    return x < 0 ? KEY_LO : KEY_HI;
  };
  const locate = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).getBoundingClientRect();
    const x = ((e.clientX - r.left) * KB.w) / r.width, y = ((e.clientY - r.top) * KB.h) / r.height;
    const key = keyAt(x, y);
    return { key, vel: Math.round(Math.max(1, Math.min(127, 30 + 98 * Math.min(1, Math.max(0, y / KB.h))))) };
  };
  const play = (key: number, vel: number) => {
    if (!chId) return;
    if (note.cur) host.noteOff(chId, note.cur.key, note.cur.tag);
    note.cur = { key, tag: host.noteOn(chId, key, vel) };
    setPressed(key);
  };
  const stop = () => {
    if (note.cur && chId) host.noteOff(chId, note.cur.key, note.cur.tag);
    note.cur = null;
    setPressed(null);
  };
  const whites: ReactNode[] = [], blacks: ReactNode[] = [];
  for (let k = KEY_LO; k <= KEY_HI; k++) {
    const [x, w] = span(k);
    const on = k === pressed;
    if (isBlack(k - KEY_LO)) {
      blacks.push(
        <g key={k}>
          <rect x={x} y={10} width={w} height={BH} rx={1.5} fill="#0a0e10" />
          <rect x={x + 1} y={11} width={w - 2} height={BH - 3} rx={1} fill={on ? 'url(#agKeyOn)' : 'url(#agBlack)'} />
        </g>,
      );
    } else {
      whites.push(<rect key={k} x={x + 0.5} y={10} width={w - 1} height={KB.h - 12} rx={2} fill={on ? 'url(#agKeyOn)' : 'url(#agWhite)'} stroke="#05080a" strokeWidth={0.8} />);
    }
  }
  return (
    <div className="ag-ctl" style={abs(KB)}>
      <svg width={KB.w} height={KB.h} viewBox={`0 0 ${KB.w} ${KB.h}`} style={{ display: 'block', touchAction: 'none' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          const L = locate(e);
          play(L.key, L.vel);
          setHint(`${keyName(L.key)} - velocity ${L.vel}`);
        }}
        onPointerMove={(e) => {
          const L = locate(e);
          if (note.cur && (e.buttons & 1)) { if (L.key !== note.cur.key) play(L.key, L.vel); return; }
          setHint(`${keyName(L.key)}: click to play`);
        }}
        onPointerUp={stop} onPointerCancel={stop}
        onPointerLeave={() => { if (!note.cur) clearHint(); }}
        onContextMenu={(e) => e.preventDefault()}>
        <defs>
          <linearGradient id="agWhite" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#151c20" /><stop offset="1" stopColor="#2c373c" /></linearGradient>
          <linearGradient id="agBlack" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#b9c1c5" /><stop offset="1" stopColor="#3f484c" /></linearGradient>
          <linearGradient id="agKeyOn" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#5fa4b8" /><stop offset="1" stopColor="#b5ecfa" /></linearGradient>
        </defs>
        <rect x={0} y={0} width={KB.w} height={KB.h} fill="#06090b" />
        {whites}
        {blacks}
      </svg>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------- the editor

function AboutPanel() {
  return (
    <div className="ag-about" style={abs({ x: 14, y: 30, w: 254, h: 232 })} onClick={() => about.set(null)}>
      <b>Autogun</b>
      <div style={{ marginTop: 4 }}>Based on the Ogun synthesizer engine and the Soundgoodizer effects processor, Autogun holds 4,294,967,296 presets, most of which have never been heard by human ears.</div>
      <div className="ag-small">Code &amp; GUI: Didier Dambrin<br />VSTi port: Reflex<br />Presets: Ginsu, The Enforcer, William P, donatello<br />Inspired by: PADsynth by Nasca Octavian Paul</div>
      <div className="ag-small">A clone of Image-Line's plugin; original drawing, no Image-Line artwork. Click to close.</div>
    </div>
  );
}

function AutogunEditor() {
  const { slotId, params } = useFxEditor();
  const n = counterOf(params.n);
  const aboutFor = useSyncExternalStore(about.subscribe, about.get, about.get);
  const wheel = useNoScrollWheel<HTMLDivElement>();
  // the About panel belongs to the open editor
  useEffect(() => () => { if (about.get() === slotId) about.set(null); }, [slotId]);
  return (
    <FxPanel width={PANEL_W} height={PANEL_H} className="ag-panel" style={{ background: '#000' }}>
      {/* the wheel over the panel steps the preset (SynthPanel2MouseWheel 0x623d0: delta = -sign(WheelDelta), the controls keep their own wheel) */}
      <div ref={wheel} className="ag-ctl" style={{ left: 0, top: 0, width: PANEL_W, height: PANEL_H }}
        onWheel={(e) => { if (e.deltaY !== 0) stepPreset(slotId, e.deltaY < 0 ? -1 : 1); }}>
        <Background />
        <Screen n={n} />
        <PresetButton box={PREV} dir={-1} onClick={() => stepPreset(slotId, -1)} />
        <PresetButton box={NEXT} dir={1} onClick={() => stepPreset(slotId, 1)} />
        <Knob />
        <Dust />
        <InfoButton />
        <Keyboard />
        {aboutFor === slotId ? <AboutPanel /> : null}
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'autogun',
  Editor: AutogunEditor,
  size: () => ({ w: PANEL_W, h: PANEL_H }),
  menu: (slotId) => autogunMenu(slotId),
};
