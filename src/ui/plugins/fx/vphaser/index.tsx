// Vintage Phaser editor (FL: Vintage Phaser, 747 x 277 with the advanced
// strip): brushed silver panel, four framed sections (PHASING gold, MODULATION
// and DELAY red, LEVELS grey), white metal knobs with lit dot rings, faders,
// toggles, LED switches, tempo "T" buttons, the tension preview and the gear
// that shows / hides the advanced controls. Geometry from FL's form,
// colours from its 1.5x manual screenshot; drawn with SVG.

import { memo, type ReactElement, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { FxPanel, useFxState, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { vphaserSpeedHz, vphaserSyncText, vphaserDelaySyncText } from '../../../../model/fx/plugins/vphaser';

const W = 747, H = 277;
/** Panel height with the advanced strip hidden (the gear): the four sections and the bottom edge. */
const H_COLLAPSED = 215;
const FONT = 'Arial, Helvetica, sans-serif';
const DARK = '#262b33';
const WHITE = '#ffffff';
const LED_ON = '#ff3b3b';

function Txt({ x, y, w, size = 8.6, color = DARK, weight = 700, anchor = 'middle', children }: {
  x: number; y: number; w?: number; size?: number; color?: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; children: ReactNode;
}) {
  return (
    <text x={x} y={y} fill={color} fontFamily={FONT} fontSize={size} fontWeight={weight} textAnchor={anchor} dominantBaseline="central"
      textLength={w} lengthAdjust="spacingAndGlyphs">{children}</text>
  );
}

// ---- static artwork ---------------------------------------------------------

const FRAMES: { x: number; w: number; panel: string; title: string; tw: number; tc: string }[] = [
  { x: 14.7, w: 155.6, panel: 'url(#vpGold)', title: 'PHASING', tw: 57, tc: '#211c15' },
  { x: 182.7, w: 203.3, panel: 'url(#vpRedL)', title: 'MODULATION', tw: 83, tc: WHITE },
  { x: 398.7, w: 209.3, panel: 'url(#vpRedR)', title: 'DELAY', tw: 45, tc: WHITE },
  { x: 620.7, w: 115.3, panel: 'url(#vpGrey)', title: 'LEVELS', tw: 61, tc: '#1e1e1e' },
];

const LABELS: [string, number, number, number, string][] = [
  // text, centre x, centre y, width, colour
  ['FEEDBACK', 141.7, 186.7, 37, DARK], ['HQ', 102.5, 153.3, 9.5, DARK], ['MANUAL', 102.5, 186.7, 29, DARK],
  ['START PHASE', 218, 119.3, 47, WHITE], ['L/R PHASE', 218, 183.3, 36, WHITE], ['TYPE', 270, 120, 17.5, WHITE], ['TENSION', 279, 183.3, 32, WHITE],
  ['SPEED', 343.5, 186.7, 23, WHITE],
  ['MIX', 428, 119.3, 13, WHITE], ['STEREO', 477, 119.3, 27, WHITE], ['TIME', 566, 140.7, 18, WHITE],
  ['FEEDBACK', 428, 183.3, 37, WHITE], ['LP', 477, 183.3, 9, WHITE], ['HP', 526, 183.3, 10, WHITE], ['KEEP PITCH', 569, 183.3, 42, WHITE],
  ['NOISE', 653, 119.3, 22, DARK], ['NOISE GATE', 653.5, 153.3, 42, DARK], ['MONO INPUT', 653.5, 186.7, 45, DARK], ['MIX', 707, 186.7, 13, DARK],
];

const ADV_LABELS: [string, number, number][] = [
  ['ENGINE', 32, 27], ['DRIVE', 77, 21], ['INV FB', 117.5, 22], ['COLOR GAIN', 299, 43], ['COLOR FREQ', 350.7, 43],
  ['INPUT HP', 428.7, 33], ['FEEDB. HP', 476, 37], ['RATE FREQ1', 526, 43], ['RATE FREQ2', 576, 43], ['LFO SCALE', 653, 39], ['LFO PULL', 706.7, 33],
];

const Artwork = memo(function Artwork({ h }: { h: number }) {
  return (
    <svg width={W} height={h} viewBox={`0 0 ${W} ${h}`} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      <defs>
        <linearGradient id="vpGold" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stopColor="#7f7149" /><stop offset="0.35" stopColor="#9a8a5d" /><stop offset="1" stopColor="#b8a778" /></linearGradient>
        <linearGradient id="vpRedL" x1="0" y1="0.6" x2="1" y2="0"><stop offset="0" stopColor="#8c0a10" /><stop offset="0.55" stopColor="#c0313a" /><stop offset="1" stopColor="#ea4f58" /></linearGradient>
        <linearGradient id="vpRedR" x1="0" y1="0" x2="1" y2="0.8"><stop offset="0" stopColor="#f2525a" /><stop offset="0.45" stopColor="#c62e36" /><stop offset="1" stopColor="#8a0a10" /></linearGradient>
        <linearGradient id="vpGrey" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#c8c6b8" /><stop offset="1" stopColor="#97978a" /></linearGradient>
      </defs>
      {FRAMES.map((f) => (
        <g key={f.title}>
          <rect x={f.x} y={44.7} width={f.w} height={159.3} rx={9} fill="#28303f" />
          <rect x={f.x + 8} y={52.7} width={f.w - 16} height={143.3} rx={5} fill={f.panel} />
          <Txt x={f.x + f.w / 2 + (f.title === 'DELAY' ? 4 : 0)} y={60.8} w={f.tw} size={11.5} weight={700} color={f.tc}>{f.title}</Txt>
        </g>
      ))}
      {/* delay header rule */}
      <rect x={534} y={60} width={39} height={1} fill="#e8e8e8" />
      {LABELS.map(([t, x, y, w, c]) => <Txt key={t + x} x={x} y={y} w={w} color={c}>{t}</Txt>)}
      <text x={736.7} y={36.4} fill="#1b2742" stroke="rgba(255,255,255,0.65)" strokeWidth={0.6} paintOrder="stroke" fontFamily={FONT} fontSize={24} fontWeight={700}
        textAnchor="end" textLength={228} lengthAdjust="spacingAndGlyphs">VINTAGE PHASER</text>
      {/* advanced strip */}
      <rect x={0} y={h - 5} width={W} height={5} fill="#6f7a7c" />
    </svg>
  );
});

// ---- knobs --------------------------------------------------------------------

const SWEEP = 135;
const rad = (a: number) => ((a - 90) * Math.PI) / 180;

/** Dot ring: lit (white) from the minimum up to the value. */
function dotRing(c: number, r: number, t: number, n: number, lit: string, unlit: string, size: number): ReactElement[] {
  const out: ReactElement[] = [];
  const ang = -SWEEP + 2 * SWEEP * t;
  for (let i = 0; i <= n; i++) {
    const a = -SWEEP + (2 * SWEEP * i) / n;
    out.push(<circle key={i} cx={c + r * Math.cos(rad(a))} cy={c + r * Math.sin(rad(a))} r={size} fill={a <= ang + 0.01 ? lit : unlit} />);
  }
  return out;
}

/** White metal knob (MODULATION / DELAY) with a grey dot pointer and a lit dot ring. */
const MetalKnob = memo(function MetalKnob({ k, x, y, size = 42, control, off }: { k: string; x: number; y: number; size?: number; control?: Partial<ControlProps>; off?: boolean }) {
  const p = useParam(k, control);
  const h = useControl({ travel: 200, ...p.control, disabled: off }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min)));
  const c = size / 2, s = size / 42;
  const ang = rad(-SWEEP + 2 * SWEEP * t);
  const pr = 9.6 * s;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size, opacity: off ? 0.45 : 1 }} {...h}>
      <svg width={size} height={size} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id="vpMetal" cx="45%" cy="40%" r="62%">
            <stop offset="0" stopColor="#ffffff" /><stop offset="0.55" stopColor="#dfe2e6" /><stop offset="1" stopColor="#a9adb3" />
          </radialGradient>
          <linearGradient id="vpMetalSheen" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="rgba(255,255,255,0)" /><stop offset="0.45" stopColor="rgba(120,125,132,0.25)" /><stop offset="0.5" stopColor="rgba(255,255,255,0.35)" /><stop offset="0.55" stopColor="rgba(120,125,132,0.25)" /><stop offset="1" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        {dotRing(c, 19.6 * s, t, size > 50 ? 48 : 20, '#ffffff', 'rgba(40,10,12,0.75)', size > 50 ? 0.85 : 0.75)}
        <circle cx={c + 0.6} cy={c + 1.4} r={17.4 * s} fill="rgba(0,0,0,0.35)" />
        <circle cx={c} cy={c} r={17 * s} fill="#161718" />
        <circle cx={c} cy={c} r={14.4 * s} fill="url(#vpMetal)" />
        <circle cx={c} cy={c} r={14.4 * s} fill="url(#vpMetalSheen)" />
        <circle cx={c + pr * Math.cos(ang)} cy={c + pr * Math.sin(ang)} r={1.9 * s} fill="#7b7f84" stroke="#5f6368" strokeWidth={0.5} />
      </svg>
    </div>
  );
});

/** Dark knob (LEVELS and the advanced strip) with a light pointer and a tick ring. */
const DarkKnob = memo(function DarkKnob({ k, x, y, w = 42, h: bh = 42, off }: { k: string; x: number; y: number; w?: number; h?: number; off?: boolean }) {
  const p = useParam(k);
  const hd = useControl({ travel: 200, ...p.control, disabled: off }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min)));
  const cx = w / 2, cy = bh / 2;
  const R = Math.min(w, bh) / 2;
  const ang = rad(-SWEEP + 2 * SWEEP * t);
  const nx = Math.cos(ang), ny = Math.sin(ang);
  const ticks: ReactElement[] = [];
  for (let i = 0; i <= 20; i++) {
    const a = rad(-SWEEP + (2 * SWEEP * i) / 20);
    const r0 = R - 3.2, r1 = R - 0.6;
    ticks.push(<line key={i} x1={cx + r0 * Math.cos(a)} y1={cy + r0 * Math.sin(a)} x2={cx + r1 * Math.cos(a)} y2={cy + r1 * Math.sin(a)} stroke="#2f3540" strokeWidth={0.8} />);
  }
  const kr = R - 4.6;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: w, height: bh, opacity: off ? 0.45 : 1 }} {...hd}>
      <svg width={w} height={bh} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="vpDarkCap" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#4b535b" /><stop offset="1" stopColor="#272c31" /></linearGradient>
        </defs>
        {ticks}
        <circle cx={cx} cy={cy + 1} r={kr + 0.6} fill="rgba(0,0,0,0.35)" />
        <circle cx={cx} cy={cy} r={kr} fill="#1c2024" />
        <circle cx={cx} cy={cy} r={kr - 1.6} fill="url(#vpDarkCap)" />
        <line x1={cx + 2 * nx} y1={cy + 2 * ny} x2={cx + (kr - 2.4) * nx} y2={cy + (kr - 2.4) * ny} stroke="#f0f0f0" strokeWidth={1.5} strokeLinecap="round" />
      </svg>
    </div>
  );
});

// ---- faders -------------------------------------------------------------------

const SL_TOP = 7.3, SL_TRAVEL = 91.4;

/** FL's TVectorSlider in the phaser skin: dark ticks on the panel, track lit below the cap. */
const Fader = memo(function Fader({ k, x, w, tick, dense, control, off }: { k: string; x: number; w: number; tick: string; dense?: boolean; control?: Partial<ControlProps>; off?: boolean }) {
  const p = useParam(k, control);
  const h = useControl({ travel: SL_TRAVEL, ...p.control, disabled: off }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min)));
  const vy = SL_TOP + (1 - t) * SL_TRAVEL;
  const cx = w / 2;
  const ticks: ReactElement[] = [];
  const n = dense ? 24 : 10;
  for (let i = 0; i <= n; i++) {
    const y = SL_TOP + (i * SL_TRAVEL) / n;
    const long = dense ? i % 6 === 0 : i % 5 === 0;
    const lw = long ? cx - 2.5 : dense ? 6 : cx - 2.5;
    ticks.push(<rect key={`l${i}`} x={1} y={y - 0.45} width={lw} height={0.9} fill={tick} opacity={long ? 1 : 0.8} />);
    ticks.push(<rect key={`r${i}`} x={w - 1 - lw} y={y - 0.45} width={lw} height={0.9} fill={tick} opacity={long ? 1 : 0.8} />);
  }
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: 71, width: w, height: 106, opacity: off ? 0.45 : 1 }} {...h}>
      <svg width={w} height={106} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="vpCap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#8a9297" /><stop offset="0.18" stopColor="#626a6f" /><stop offset="0.3" stopColor="#3b4247" />
            <stop offset="0.62" stopColor="#2b3135" /><stop offset="0.78" stopColor="#4a5257" /><stop offset="1" stopColor="#202427" />
          </linearGradient>
        </defs>
        {ticks}
        <rect x={cx - 0.75} y={SL_TOP} width={1.5} height={SL_TRAVEL} fill="#2c2f34" />
        <rect x={cx - 0.75} y={vy} width={1.5} height={SL_TOP + SL_TRAVEL - vy} fill="#f4f4f4" />
        <rect x={cx - 11.5} y={vy + 5.6} width={23} height={4.5} fill="rgba(0,0,0,0.3)" />
        <rect x={cx - 11.5} y={vy - 6.3} width={23} height={12} rx={1} fill="url(#vpCap)" />
        <rect x={cx - 11.5} y={vy - 0.5} width={23} height={1} fill="#f2f2f2" />
      </svg>
    </div>
  );
});

// ---- switches -------------------------------------------------------------------

function Led({ cx, cy, on, r = 5 }: { cx: number; cy: number; on: boolean; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="rgba(0,0,0,0.45)" />
      <circle cx={cx} cy={cy} r={r - 0.7} fill="#3b3f45" />
      {on && <circle cx={cx} cy={cy} r={r + 1.6} fill={LED_ON} opacity={0.2} />}
      <circle cx={cx} cy={cy} r={r * 0.62} fill={on ? LED_ON : '#8d9398'} />
      <circle cx={cx - r * 0.18} cy={cy - r * 0.2} r={r * 0.25} fill={on ? '#ffb3ab' : '#c3c8cc'} opacity={0.8} />
    </g>
  );
}

function useToggle(k: string) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  const set = (v: number) => { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); };
  const handlers = {
    onPointerDown: (e: React.PointerEvent) => { if (e.button === 0) { e.stopPropagation(); set(on ? 0 : 1); setHint(`${p.def.name}: ${on ? (p.def.options?.[0] ?? 'off') : (p.def.options?.[1] ?? 'on')}`); } },
    onPointerEnter: () => setHint(`${p.def.name}: ${p.def.options?.[on ? 1 : 0] ?? (on ? 'on' : 'off')}`),
    onPointerLeave: clearHint,
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault();
      const opts = p.def.options ?? ['Off', 'On'];
      openMenu(e.clientX, e.clientY, opts.map((o, i) => ({ label: o, radio: true, checked: (on ? 1 : 0) === i, onClick: () => set(i) } as MenuItem)));
    },
  };
  return { on, handlers };
}

const LedSwitch = memo(function LedSwitch({ k, x, y, w, h, off }: { k: string; x: number; y: number; w: number; h: number; off?: boolean }) {
  const { on, handlers } = useToggle(k);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', opacity: off ? 0.45 : 1 }} {...(off ? {} : handlers)}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}><Led cx={w / 2} cy={h / 2} on={on} /></svg>
    </div>
  );
});

/** Tempo sync button ("T"). */
const TButton = memo(function TButton({ k, x, y, off }: { k: string; x: number; y: number; off?: boolean }) {
  const { on, handlers } = useToggle(k);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 12, height: 12, cursor: 'default', opacity: off ? 0.45 : 1 }} {...(off ? {} : handlers)}>
      <svg width={12} height={12} style={{ display: 'block' }}>
        <rect x={0} y={0} width={12} height={12} rx={1} fill={on ? '#f1f3f6' : '#6c7178'} />
        <text x={6} y={6.4} fill={on ? '#c0262e' : '#e6e8eb'} fontFamily={FONT} fontSize={9} fontWeight={700} textAnchor="middle" dominantBaseline="central">T</text>
      </svg>
    </div>
  );
});

/** Vertical toggle (FL's TSwitchSelector): option 0 up, option 1 down, with captions or icons. */
const Toggle = memo(function Toggle({ k, x, y, w, h, labels, icons, labelColor = DARK, off }: {
  k: string; x: number; y: number; w: number; h: number; labels?: [string, string]; icons?: boolean; labelColor?: string; off?: boolean;
}) {
  const { on, handlers } = useToggle(k);
  const by = on ? h - 9 : 9;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', opacity: off ? 0.45 : 1 }} {...(off ? {} : handlers)}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={1} y={0.5} width={18} height={h - 1} rx={9} fill="#1d2126" />
        <rect x={1.8} y={1.3} width={16.4} height={h - 2.6} rx={8.2} fill="#2b3036" />
        <circle cx={10} cy={by} r={7} fill="#0f1113" />
        <circle cx={10} cy={by} r={6.3} fill="#f4f5f6" />
        <circle cx={8.5} cy={by - 1.6} r={2.2} fill="#ffffff" />
        {labels && <>
          <Txt x={24} y={9} anchor="start" color={labelColor} size={8}>{labels[0]}</Txt>
          <Txt x={24} y={h - 9} anchor="start" color={labelColor} size={8}>{labels[1]}</Txt>
        </>}
        {icons && <>
          <path d="M 25 15 L 29 6 L 33 15 L 37 6" fill="none" stroke={WHITE} strokeWidth={1.3} strokeLinejoin="miter" />
          <path d="M 25 26 C 27 17.5, 29.5 17.5, 31 26 S 35 34.5, 37 26" fill="none" stroke={WHITE} strokeWidth={1.3} />
        </>}
      </svg>
    </div>
  );
});

/** Delay on / off: the small lamp right of the DELAY title. */
const DelayLamp = memo(function DelayLamp() {
  const { on, handlers } = useToggle('delayOn');
  return (
    <div className="fxk-abs" style={{ left: 579, top: 53, width: 19, height: 17, cursor: 'default' }} {...handlers}>
      <svg width={19} height={17} style={{ display: 'block', overflow: 'visible' }}>
        {on && <rect x={0.5} y={3.5} width={18} height={10} rx={2} fill={LED_ON} opacity={0.25} />}
        <rect x={2.5} y={5.5} width={14} height={6} rx={1} fill={on ? '#ff5a52' : '#f4f6f8'} stroke={on ? '#ffd0cc' : '#d9dde2'} strokeWidth={0.6} />
      </svg>
    </div>
  );
});

/** Tension preview: the LFO shape after the Tension curve. */
const TensionVis = memo(function TensionVis() {
  const tension = useParam('tension').value / 6000;
  const sine = useParam('lfoType').value >= 0.5;
  // FL's curve constant k(t) (see the engine)
  const T = [0, 0.05, 0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.75, 0.8, 0.9, 1];
  const K = [0, 0.055, 0.1299, 0.3898, 0.5848, 0.8247, 1.4394, 2.1841, 2.9988, 3.8434, 4.2782, 4.708, 5.5827, 6.4523];
  let k = 0;
  for (let i = 1; i < T.length; i++) if (tension <= T[i]) { k = K[i - 1] + ((tension - T[i - 1]) / (T[i] - T[i - 1])) * (K[i] - K[i - 1]); break; }
  const pts: string[] = [];
  for (let i = 0; i <= 40; i++) {
    const ph = i / 40;
    const u = sine ? Math.sin(2 * Math.PI * ph) : ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    let s = 0.5 * (1 + u);
    if (k > 1e-6) s = (1 - Math.exp(-k * s)) / (1 - Math.exp(-k));
    pts.push(`${2 + (19 * i) / 40},${11 - 9 * s}`);
  }
  return (
    <svg className="fxk-abs" width={23} height={13} style={{ left: 301, top: 116, pointerEvents: 'none' }}>
      <rect x={0} y={0} width={23} height={13} rx={2} fill="rgba(70,8,12,0.45)" />
      <polyline points={pts.join(' ')} fill="none" stroke={WHITE} strokeWidth={1.2} strokeLinejoin="round" />
    </svg>
  );
});

// ---- tempo menus -----------------------------------------------------------------

/** FL's Set submenu values for the Speed slider (from the form; shared with Vintage Chorus). */
const SPEED_SET: [string, number][] = [
  ['1/64', 245760], ['1/32', 244216], ['1/16', 211373], ['1/8', 190725], ['1/4', 164762], ['1/2', 134931],
  ['1/16 dotted', 199737], ['1/8 dotted', 176098], ['1/4 dotted', 147681], ['1/2 dotted', 116283],
  ['1/16 triplet', 220695], ['1/8 triplet', 203210], ['1/4 triplet', 180324], ['1/2 triplet', 152664],
];

function SpeedFader({ off }: { off?: boolean }) {
  const sync = useParam('sync').value >= 0.5;
  const r1 = useParam('rate1').value, r2 = useParam('rate2').value;
  const sp = useParam('speed');
  const setTo = (v: number) => { sp.control.onBegin?.(); sp.set(v); sp.control.onEnd?.(); };
  const extraMenu: MenuItem[] = [{ label: 'Set', submenu: SPEED_SET.map(([label, v]) => ({ label, checked: Math.round(sp.value) === v, onClick: () => setTo(v) })) }];
  const format = sync ? vphaserSyncText : (v: number) => `${vphaserSpeedHz(v, r1, r2).toFixed(3)} Hz`;
  return <Fader k="speed" x={332} w={32} tick="#3d3a42" dense off={off} control={{ extraMenu, format }} />;
}

function TimeKnob() {
  const sync = useParam('delaySync').value >= 0.5;
  return <MetalKnob k="delayTime" x={535} y={71} size={60} control={sync ? { format: vphaserDelaySyncText } : undefined} />;
}

// ---- editor -------------------------------------------------------------------------

function VintagePhaserEditor() {
  const manual = useParam('manual').value >= 0.5;
  // the gear shows / hides the advanced strip; the window follows the panel height (editor.size)
  const advanced = useFxState<unknown>('advanced', true) !== false;
  const view = useFxView();
  const setAdvanced = (on: boolean) => view('Advanced options', (p) => { p.advanced = on; });
  const h = advanced ? H : H_COLLAPSED;
  return (
    <FxPanel width={W} height={h} style={{
      background: 'repeating-linear-gradient(180deg, rgba(255,255,255,0.07) 0px, rgba(255,255,255,0.07) 1px, rgba(0,0,0,0.035) 1px, rgba(0,0,0,0.035) 2.5px), linear-gradient(180deg, #d6e3e2 0%, #e9eff8 16%, #d4dae4 60%, #c9d0da 100%)',
    }}>
      <Artwork h={h} />
      {/* PHASING */}
      {manual ? <Fader k="manualFreq" x={23} w={26} tick="#3c372b" /> : <>
        <Fader k="minFreq" x={23} w={26} tick="#3c372b" />
        <Fader k="maxFreq" x={57} w={26} tick="#3c372b" />
      </>}
      <svg className="fxk-abs" width={70} height={15} style={{ left: 20, top: 179, pointerEvents: 'none' }}>
        {manual ? <Txt x={16} y={7.7} w={18} size={8.6}>FREQ</Txt> : <>
          <Txt x={17.7} y={7.7} w={14} size={8.6}>MIN</Txt>
          <Txt x={51.7} y={7.7} w={15} size={8.6}>MAX</Txt>
        </>}
      </svg>
      <LedSwitch k="hq" x={93} y={130} w={19} h={17} />
      <LedSwitch k="manual" x={94} y={163} w={17} h={17} />
      <Fader k="feedback" x={125} w={32} tick="#3c372b" />
      {/* MODULATION */}
      <MetalKnob k="startPhase" x={197} y={71} />
      <MetalKnob k="lrPhase" x={197} y={135} />
      <Toggle k="lfoType" x={259} y={75} w={41} h={34} icons />
      <svg className="fxk-abs" width={8} height={4} style={{ left: 286, top: 118, pointerEvents: 'none' }}><rect x={0} y={1.5} width={6} height={1} fill={WHITE} /></svg>
      <TensionVis />
      <MetalKnob k="tension" x={258} y={135} />
      <SpeedFader />
      <TButton k="sync" x={364} y={180} />
      {/* DELAY */}
      <DelayLamp />
      <MetalKnob k="delayMix" x={407} y={71} />
      <MetalKnob k="delayStereo" x={456} y={71} />
      <TimeKnob />
      <TButton k="delaySync" x={577} y={133} />
      <MetalKnob k="delayFeedback" x={407} y={135} />
      <MetalKnob k="delayLp" x={456} y={135} />
      <MetalKnob k="delayHp" x={505} y={135} />
      <LedSwitch k="keepPitch" x={560} y={163} w={18} h={17} />
      {/* LEVELS */}
      <DarkKnob k="noise" x={632} y={71} />
      <LedSwitch k="gate" x={645} y={130} w={17} h={17} />
      <LedSwitch k="mono" x={644} y={163} w={19} h={17} />
      <Fader k="mix" x={691} w={32} tick="#4a4a44" />
      {/* gear: advanced options */}
      <div className="fxk-abs" style={{ left: 474, top: 17, width: 24, height: 19, cursor: 'default' }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setAdvanced(!advanced); } }}
        onPointerEnter={() => setHint('Advanced options')} onPointerLeave={clearHint}>
        <svg width={24} height={19} style={{ display: 'block' }}>
          <g transform="translate(12 9.5)" fill={advanced ? '#9aa1a8' : '#c3c8cd'}>
            {Array.from({ length: 8 }, (_, i) => <rect key={i} x={-1.6} y={-8} width={3.2} height={4} rx={0.6} transform={`rotate(${i * 45})`} />)}
            <circle r={5.6} />
            <circle r={2.4} fill="#e9eef3" />
          </g>
        </svg>
      </div>
      {/* ADVANCED */}
      {advanced ? <>
        <Toggle k="engine" x={21} y={219} w={34} h={34} labels={['V1', 'V2']} />
        <DarkKnob k="drive" x={56} y={218} w={42} h={36} />
        <Toggle k="invertFb" x={107} y={219} w={40} h={34} labels={['OFF', 'ON']} />
        <DarkKnob k="colorGain" x={278} y={218} w={42} h={36} />
        <DarkKnob k="colorFreq" x={329} y={218} w={42} h={36} />
        <DarkKnob k="inputHp" x={407} y={218} w={42} h={36} />
        <DarkKnob k="feedbackHp" x={456} y={218} w={42} h={36} />
        <DarkKnob k="rate1" x={505} y={218} w={42} h={36} />
        <DarkKnob k="rate2" x={554} y={218} w={42} h={36} />
        <DarkKnob k="lfoScale" x={632} y={218} w={42} h={36} />
        <DarkKnob k="lfoPull" x={686} y={218} w={42} h={36} />
        <svg className="fxk-abs" width={W} height={14} style={{ left: 0, top: 258, pointerEvents: 'none' }}>
          {ADV_LABELS.map(([t, x, w]) => <Txt key={t} x={x} y={6.7} w={w} size={8.2} color="#27304a">{t}</Txt>)}
        </svg>
      </> : null}
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'vphaser', Editor: VintagePhaserEditor,
  size: (p) => ({ w: W, h: p.advanced === false ? H_COLLAPSED : H }),
};
