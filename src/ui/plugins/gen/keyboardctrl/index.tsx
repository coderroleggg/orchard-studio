// Keyboard Controller editor (FL: Fruity Keyboard Controller, SynthPanel
// 558 x 232): "Note off value" switch and slider, the "Value" slider for the
// current key with the key selector ("for C5"), the Auto map button, the
// Smoothing attack / release sliders with their link switch and the scrolled
// keyboard with the key range ruler. Positions are FL's form coordinates;
// colours were sampled from the manual's screenshot (img_plug/
// KeyboardController.png, 1.5x). Original drawing, no FL assets.

import { useId, useRef } from 'react';
import { FxPanel, Label, useFxEdit, useFxState, useFxView, useParam, useNoScrollWheel } from '../../kit';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { store } from '../../../../store';
import { KB_KEYS, kbAutoMap, kbKeyName } from '../../../../model/gen/plugins/keyboardctrl';
import { PianoKb, KB_TOTAL_W } from './PianoKb';
import type { FxEditorModule } from '../../registry';

const TXT = '#dfe5e8';
const TXT_DIM = '#c9d0d4';
const FILL = '#8cc4ff';

/** A caption in FL's condensed face (squeezed horizontally, never clipped). */
function Txt({ x, y, w, h, align = 'left', size = 12.5, bold, color = TXT, children }: {
  x: number; y: number; w: number; h: number; align?: 'left' | 'center' | 'right'; size?: number; bold?: boolean; color?: string; children: string;
}) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', pointerEvents: 'none', fontSize: size, color, fontWeight: bold ? 600 : undefined,
      justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start',
    }}>
      <span style={{ whiteSpace: 'nowrap', transform: 'scaleX(0.84)', transformOrigin: align === 'right' ? 'right center' : align === 'center' ? 'center' : 'left center' }}>{children}</span>
    </div>
  );
}

/** The flat ring check box FL uses here (red-orange LED left of its caption). */
function NoteOffBox({ x, y, w, h, on, onToggle }: { x: number; y: number; w: number; h: number; on: boolean; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`Auto release (when no key is pressed): ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <span style={{
        width: 12, height: 12, borderRadius: '50%', flex: 'none', boxSizing: 'border-box', marginLeft: 4, border: '1.5px solid #8a9094',
        background: on ? 'radial-gradient(circle at 45% 40%, #ffd8cc 0%, #ff6a4d 55%, #b03b24 100%)' : 'radial-gradient(circle at 45% 40%, #50565a 0%, #2d3234 70%, #121515 100%)',
        boxShadow: on ? '0 0 5px #ff6a4d' : 'inset 0 0 0 1px #121515',
      }} />
      <span style={{ fontSize: 12.5, color: TXT, whiteSpace: 'nowrap', display: 'inline-block', transform: 'scaleX(0.84)', transformOrigin: 'left center', marginLeft: -2 }}>Note off value</span>
    </div>
  );
}

/** FL's horizontal slider (TVectorSlider): a thin rail with a blue fill, a round dark knob and a ruler of cells underneath. */
function HSlider({ x, y, w, h, control, tip }: { x: number; y: number; w: number; h: number; control: ControlProps; tip: string }) {
  const knob = 22;
  const travel = w - knob - 4;
  const hnd = useControl({ ...control, travel }, 'horizontal');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const cx = 2 + knob / 2 + t * travel;
  const id = 'hs' + useId().replace(/:/g, '');
  const railY = 9;
  return (
    <div ref={ref} className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}
      onPointerEnter={() => setHint(tip)} onPointerLeave={clearHint}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <radialGradient id={id} cx="42%" cy="30%" r="80%">
            <stop offset="0" stopColor="#5b646a" />
            <stop offset="0.5" stopColor="#2e3439" />
            <stop offset="1" stopColor="#15191c" />
          </radialGradient>
        </defs>
        {/* ruler cells under the rail */}
        <rect x={knob / 2} y={railY + 7} width={w - knob} height={10} fill="#343a3f" />
        {Array.from({ length: 9 }, (_, i) => <rect key={i} x={knob / 2 + (i * (w - knob)) / 8 - 0.5} y={railY + 7} width={1} height={i % 2 ? 6 : 10} fill="#272c30" />)}
        <rect x={knob / 2} y={railY - 1} width={w - knob} height={2} fill="#262b2f" />
        <rect x={knob / 2} y={railY - 1} width={Math.max(0, cx - knob / 2)} height={2} fill={FILL} />
        <circle cx={cx} cy={railY} r={knob / 2 + 0.5} fill="rgba(0,0,0,0.35)" />
        <circle cx={cx} cy={railY} r={knob / 2 - 1} fill={`url(#${id})`} stroke="#101315" strokeWidth={1} />
        <rect x={cx - 0.8} y={railY - 5} width={1.6} height={10} fill="#dfe9f2" />
      </svg>
    </div>
  );
}

/** FL's vertical slider with the big metallic cap and an orange value line (the smoothing times); `other` follows while linked. */
function SmoothSlider({ k, other, linked, x, y, w, h }: { k: string; other: string; linked: boolean; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const o = useParam(other);
  const capH = 26, capW = 42;
  const travel = h - capH - 4;
  const control: ControlProps = {
    ...p.control, travel,
    onChange: (v) => { p.control.onChange(v); if (linked) o.control.onChange(v); },
    onBegin: () => { store.beginGesture(linked ? 'Smoothing' : p.def.name); },
  };
  const hnd = useControl(control, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const cy = 2 + capH / 2 + (1 - t) * travel;
  const id = 'ss' + useId().replace(/:/g, '');
  const cx = w / 2;
  return (
    <div ref={ref} className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#d5d9de" />
            <stop offset="0.45" stopColor="#a4abb2" />
            <stop offset="0.5" stopColor="#7e868e" />
            <stop offset="1" stopColor="#c3c8ce" />
          </linearGradient>
        </defs>
        {/* track: dark column with horizontal grid lines */}
        <rect x={cx - 21} y={0} width={42} height={h} fill="#2f353a" />
        {Array.from({ length: 6 }, (_, i) => <rect key={i} x={cx - 21} y={Math.round((i * h) / 6)} width={42} height={1} fill="#262b2f" />)}
        <rect x={cx - 0.5} y={0} width={1} height={h} fill="#1f2427" />
        <rect x={cx - 1} y={cy} width={2} height={Math.max(0, h - cy - 2)} fill="#ffa830" />
        <rect x={cx - capW / 2 + 1} y={cy - capH / 2 + 2} width={capW} height={capH} rx={4} fill="rgba(0,0,0,0.4)" />
        <rect x={cx - capW / 2} y={cy - capH / 2} width={capW} height={capH} rx={4} fill={`url(#${id})`} stroke="#222a2f" strokeWidth={1} />
        <rect x={cx - 10} y={cy - 2.5} width={20} height={2} rx={1} fill="#3a4147" />
        <rect x={cx - 10} y={cy + 1.5} width={20} height={1.5} rx={0.75} fill="#e9edf1" opacity={0.8} />
      </svg>
    </div>
  );
}

/** The key selector ("for C5"): a rounded light box with a notched left edge, the note name and arrows. */
function KeySelect({ x, y, w, h, value, onChange }: { x: number; y: number; w: number; h: number; value: number; onChange: (k: number) => void }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  const ref = useNoScrollWheel<HTMLDivElement>();
  return (
    <div ref={ref} className="fxk-abs" style={{ left: x, top: y, width: w, height: h, touchAction: 'none' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) { setHint(`Current key: ${kbKeyName(value)}`); return; }
        const k = Math.max(0, Math.min(KB_KEYS - 1, d.v + Math.round((d.y - e.clientY) / 5)));
        if (k !== value) onChange(k);
      }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { e.stopPropagation(); onChange(Math.max(0, Math.min(KB_KEYS - 1, value + (e.deltaY < 0 ? 1 : -1)))); }}
      onPointerLeave={clearHint}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0 }}>
        <path d={`M${h / 2 - 1} 0.5 H${w - 4} Q${w - 0.5} 0.5 ${w - 0.5} 4 V${h - 4} Q${w - 0.5} ${h - 0.5} ${w - 4} ${h - 0.5} H${h / 2 - 1} L1 ${h / 2} Z`} fill="#b8bcc3" stroke="#8d9299" />
      </svg>
      <div style={{ position: 'absolute', left: h / 2 + 2, top: 0, width: w - h / 2 - 16, height: h, lineHeight: `${h}px`, textAlign: 'center', fontSize: 17, color: '#2c3236', fontWeight: 500 }}>{kbKeyName(value)}</div>
      <svg width={8} height={14} style={{ position: 'absolute', right: 5, top: (h - 14) / 2 }}>
        <path d="M0.5 5 L4 1 L7.5 5 M0.5 9 L4 13 L7.5 9" fill="none" stroke="#7b8087" strokeWidth={1.3} />
      </svg>
    </div>
  );
}

function AutoMapButton({ x, y, w, h, onClick }: { x: number; y: number; w: number; h: number; onClick: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box', background: '#2a2f33', border: '1px solid #4a5156', borderRadius: 3,
      display: 'flex', alignItems: 'center', paddingLeft: 7, fontSize: 12.5, color: TXT, cursor: 'default',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint('Auto mapping for selected keyzone')} onPointerLeave={clearHint}>
      <span style={{ display: 'inline-block', transform: 'scaleX(0.84)', transformOrigin: 'left center' }}>Auto map</span>
      <svg width={8} height={12} style={{ position: 'absolute', right: 5, top: (h - 12) / 2 }}><path d="M1 1 L7 6 L1 11 Z" fill="#8f979d" /></svg>
    </div>
  );
}

function LinkButton({ x, y, w, h, on, onToggle }: { x: number; y: number; w: number; h: number; on: boolean; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint('Link attack & release controls')} onPointerLeave={clearHint}>
      <svg width={22} height={16} viewBox="0 0 22 16" style={{ opacity: on ? 1 : 0.65 }}>
        <g fill="none" stroke={on ? '#ffb83a' : '#e9c26a'} strokeWidth={2.2} strokeLinecap="round" transform="rotate(-35 11 8)">
          <rect x={2} y={4.5} width={10} height={7} rx={3.5} />
          <rect x={10} y={4.5} width={10} height={7} rx={3.5} />
        </g>
      </svg>
    </div>
  );
}

function KeyboardControllerEditor() {
  const edit = useFxEdit();
  const view = useFxView();
  const values = useFxState<number[]>('values', []);
  const lo = useFxState<number>('lo', 48);
  const hi = useFxState<number>('hi', 71);
  const noteOff = useFxState<number>('noteOff', 0);
  const autoRel = useFxState<boolean>('autoRel', false);
  const link = useFxState<boolean>('link', false);
  const key = useFxState<number>('key', 60);
  const scroll = useFxState<number>('scroll', Math.max(0, Math.round((KB_TOTAL_W / KB_KEYS) * 48 - 100)));
  const cur = Math.max(0, Math.min(KB_KEYS - 1, key));
  const curValue = values[cur] ?? 0;

  const mapMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const run = (white: boolean, interp: boolean) => edit(interp ? 'Interpolate' : 'Auto map', (p) => {
      p.values = kbAutoMap((p.values as number[]) ?? values, lo, hi, white, interp);
    });
    openMenu(r.right, r.top, [
      { label: 'Auto map (white + black)', hint: 'Auto map selection, from 0 to 1, using all keys', onClick: () => run(false, false) },
      { label: 'Auto map (white only)', hint: 'Auto map selection, from 0 to 1, using white keys', onClick: () => run(true, false) },
      { separator: true },
      { label: 'Interpolate (white + black)', hint: 'Auto map selection, from/to existing end values, using all keys', onClick: () => run(false, true) },
      { label: 'Interpolate (white only)', hint: 'Auto map selection, from/to existing end values, using white keys', onClick: () => run(true, true) },
    ]);
  };

  return (
    <FxPanel width={558} height={232} style={{ background: '#3f454a' }}>
      <NoteOffBox x={32} y={59} w={93} h={23} on={autoRel} onToggle={() => edit('Note off value', (p) => { p.autoRel = !autoRel; })} />
      <HSlider x={124} y={61} w={163} h={26} tip={`Value for note off: ${Math.round(noteOff * 100)}%`}
        control={{
          value: Math.round(noteOff * 65536), min: 0, max: 65536, defaultValue: 0, step: 1, label: 'Value for note off',
          format: (v) => `${Math.round((v / 65536) * 100)}%`, onChange: (v) => edit('Note off value', (p) => { p.noteOff = v / 65536; }, 'kbnoteoff'),
          onBegin: () => store.beginGesture('Note off value'), onEnd: () => store.endGesture(),
        }} />
      <AutoMapButton x={6} y={106} w={69} h={31} onClick={mapMenu} />
      <Txt x={92} y={106} w={29} h={31} align="right" size={13.5} bold>Value</Txt>
      <HSlider x={124} y={112} w={163} h={26} tip={`Value for current key (${kbKeyName(cur)}): ${Math.round(curValue * 100)}%`}
        control={{
          value: Math.round(curValue * 65536), min: 0, max: 65536, defaultValue: 0, step: 1, label: `Value for ${kbKeyName(cur)}`,
          format: (v) => `${Math.round((v / 65536) * 100)}%`,
          onChange: (v) => edit('Key value', (p) => { const a = ((p.values as number[]) ?? values).slice(); a[cur] = v / 65536; p.values = a; }, `kbvalue:${cur}`),
          onBegin: () => store.beginGesture('Key value'), onEnd: () => store.endGesture(),
        }} />
      <Txt x={285} y={106} w={26} h={31} align="center" size={13.5} bold>for</Txt>
      <KeySelect x={314} y={108} w={54} h={27} value={cur} onChange={(k) => view('Current key', (p) => { p.key = k; })} />
      <Txt x={369} y={3} w={57} h={23} align="right" size={13.5} bold>Smoothing</Txt>
      <Txt x={433} y={8} w={42} h={14} align="center" size={11} color={TXT_DIM}>Attack</Txt>
      <Txt x={504} y={8} w={42} h={14} align="center" size={11} color={TXT_DIM}>Release</Txt>
      <LinkButton x={473} y={3} w={33} h={25} on={link} onToggle={() => view('Link attack & release', (p) => { p.link = !link; })} />
      <SmoothSlider k="attack" other="release" linked={link} x={427} y={18} w={54} h={121} />
      <SmoothSlider k="release" other="attack" linked={link} x={498} y={18} w={54} h={121} />
      <div className="fxk-abs" style={{ left: 7, top: 144, width: 544, height: 81, boxSizing: 'border-box', background: '#31383c', border: '1px solid #31383c' }}>
        <PianoKb x={0} y={0} w={542} scroll={scroll} onScroll={(s) => view('Keyboard scroll', (p) => { p.scroll = Math.round(s); })}
          lo={lo} hi={hi} selected={cur}
          onRange={(a, b) => edit('Key range', (p) => { p.lo = a; p.hi = b; }, 'kbrange')}
          onKey={(k, down) => { if (down) view('Current key', (p) => { p.key = k; }); }}
          keyHint="Select key" rangeHint="Key range: drag along the ruler to set the limits" />
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'keyboardctrl', Editor: KeyboardControllerEditor };
