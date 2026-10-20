// Vintage Chorus editor (FL: Vintage Chorus, 747 x 217): the Juno-style panel
// with the striped title bar, four coloured sections (MODE, DELAYS, MODULATION,
// LEVELS), the I / II / EDIT pads with LEDs (shift-click for I + II), vector
// faders with tick scales, dotted-ring knobs, the LFO type toggle and LED
// switches. Geometry from FL's form (control boxes) and its 1.5x screenshot
// (decoration); everything is drawn with SVG.

import { memo, type ReactElement, type ReactNode } from 'react';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { FxPanel, useParam, useFxEdit } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { vchorusSyncText, VCHORUS_MODES } from '../../../../model/fx/plugins/vchorus';

const W = 747, H = 217;
const LABEL = '#c6cacc';
const LED_ON = '#ff4141';
const FONT = 'Arial, Helvetica, sans-serif';
/** Opacity of the controls a mode ignores (FL dims those panels). */
const DIM = 0.42;

/** SVG text forced to FL's measured width (FL's condensed panel font). */
function Txt({ x, y, w, size = 8.6, color = LABEL, weight = 700, anchor = 'middle', children, spacing }: {
  x: number; y: number; w?: number; size?: number; color?: string; weight?: number; anchor?: 'start' | 'middle' | 'end'; children: ReactNode; spacing?: boolean;
}) {
  return (
    <text x={x} y={y} fill={color} fontFamily={FONT} fontSize={size} fontWeight={weight} textAnchor={anchor} dominantBaseline="central"
      textLength={w} lengthAdjust={spacing ? 'spacing' : 'spacingAndGlyphs'}>{children}</text>
  );
}

// ---- static artwork -------------------------------------------------------

/** Title bar: a solid brown strip ending in slanted stripes ("\" lean). */
function TitleBar() {
  const y0 = 18.67, y1 = 36, yr = 20.33, s = 0.591;
  const xs = (x: number, y: number) => x + (y - yr) * s;
  const bars: [number, number][] = [[11.33, 322], [326, 351.33], [355.33, 377.33], [381.33, 399.33], [403.33, 417.33], [421.33, 431.33], [435.33, 441.33], [445.33, 451.33], [455.33, 459.33]];
  return (
    <g fill="#8f4b2e">
      {bars.map(([a, b], i) => {
        const left0 = i === 0 ? a : xs(a, y0), left1 = i === 0 ? a : xs(a, y1);
        return <polygon key={i} points={`${left0},${y0} ${xs(b, y0)},${y0} ${xs(b, y1)},${y1} ${left1},${y1}`} />;
      })}
    </g>
  );
}

const SECTIONS: { x: number; w: number; title: string; tw: number; bg: string; fg: string; foot: string }[] = [
  { x: 10, w: 175, title: 'MODE', tw: 32.7, bg: '#4096c8', fg: '#eefaff', foot: '#3c93c5' },
  { x: 186.67, w: 174.67, title: 'DELAYS', tw: 34.7, bg: '#cd5d4d', fg: '#fff6f2', foot: '#d76757' },
  { x: 364.67, w: 194.67, title: 'MODULATION', tw: 71.3, bg: '#cd5d4d', fg: '#fff6f2', foot: '#c65646' },
  { x: 562, w: 175.33, title: 'LEVELS', tw: 34, bg: '#fffff6', fg: '#1d1d1d', foot: '#fffff2' },
];

const LABELS: [string, number, number, number][] = [
  // text, centre x, centre y, width
  ['1', 219.3, 188.7, 4], ['TIME', 238.3, 188.7, 16.7], ['2', 256, 188.7, 4.7], ['FEEDBACK', 292.5, 188.7, 37.3], ['H.PASS', 329.5, 188.7, 25.3],
  ['START PHASE', 400, 126, 47], ['L/R PHASE', 400, 188.3, 36.3], ['TYPE', 466, 126, 17.7], ['TEMPO SYNC', 465, 189, 45], ['SPEED', 528, 189, 23],
  ['NOISE', 661, 126, 21.7], ['GAIN', 661, 188.3, 17], ['MIX', 706.7, 189, 13.3],
];

const Artwork = memo(function Artwork() {
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: 'absolute', left: 0, top: 0, pointerEvents: 'none' }}>
      <TitleBar />
      <text x={736.7} y={36.6} fill="#cecbc2" fontFamily={FONT} fontSize={25} fontWeight={700} textAnchor="end" textLength={255.4} lengthAdjust="spacingAndGlyphs">VINTAGE CHORUS</text>
      {SECTIONS.map((s) => (
        <g key={s.title}>
          <rect x={s.x} y={46.67} width={s.w} height={17.33} fill={s.bg} />
          <Txt x={s.x + s.w / 2} y={55.6} w={s.tw} size={11.4} weight={400} color={s.fg}>{s.title}</Txt>
          <rect x={s.x} y={202} width={s.w} height={4.67} fill={s.foot} />
        </g>
      ))}
      {[8.67, 185.33, 363.33, 560.67, 738.67].map((x) => <rect key={x} x={x - 0.33} y={66.67} width={0.67} height={133.33} fill="#b8b4af" />)}
      {LABELS.map(([t, x, y, w]) => <Txt key={t + x} x={x} y={y} w={w}>{t}</Txt>)}
      <Txt x={49.7} y={100.3} w={2.2} size={12} weight={400} color="#c2c6c8">I</Txt>
      <Txt x={96.3} y={100.3} w={5.4} size={12} weight={400} color="#c2c6c8">II</Txt>
      <Txt x={143} y={100.3} w={24.7} size={12} weight={400} color="#c2c6c8">EDIT</Txt>
    </svg>
  );
});

// ---- LEDs -------------------------------------------------------------------

function Led({ cx, cy, on, r = 5 }: { cx: number; cy: number; on: boolean; r?: number }) {
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#18191a" />
      <circle cx={cx} cy={cy} r={r - 0.6} fill="#232526" />
      {on && <circle cx={cx} cy={cy} r={r + 1.5} fill={LED_ON} opacity={0.18} />}
      <circle cx={cx} cy={cy} r={r * 0.62} fill={on ? LED_ON : '#777f82'} />
      <circle cx={cx - r * 0.18} cy={cy - r * 0.2} r={r * 0.26} fill={on ? '#ffb0a8' : '#9aa1a4'} opacity={0.75} />
    </g>
  );
}

/** LED switch (FL's TVectorCheckBox): box from the form, optional caption. */
const LedSwitch = memo(function LedSwitch({ k, x, y, w, h, caption, capW, off }: { k: string; x: number; y: number; w: number; h: number; caption?: string; capW?: number; off?: boolean }) {
  const p = useParam(k);
  const on = p.value >= 0.5;
  const toggle = () => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', opacity: off ? DIM : 1 }}
      onPointerDown={(e) => { if (e.button === 0 && !off) { e.stopPropagation(); toggle(); setHint(`${p.def.name}: ${on ? 'off' : 'on'}`); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        if (off) return;
        openMenu(e.clientX, e.clientY, ['Off', 'On'].map((o, i) => ({ label: o, radio: true, checked: (on ? 1 : 0) === i, onClick: () => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); } })));
      }}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
        <Led cx={caption ? 9 : w / 2} cy={h / 2 + 0.3} on={on} />
        {caption && <Txt x={18} y={h / 2 + 0.3} w={capW} anchor="start">{caption}</Txt>}
      </svg>
    </div>
  );
});

// ---- mode pads --------------------------------------------------------------

const PADS = [
  { x: 26, idle: ['#e9cf6f', '#bca142', '#6d5a17'], lit: ['#fff3a6', '#dcc04e', '#7a6418'] },
  { x: 74, idle: ['#bd8631', '#9e6712', '#633c11'], lit: ['#ffc463', '#d78a1c', '#7a4a10'] },
  { x: 122, idle: ['#c8743a', '#a75520', '#833911'], lit: ['#ffc77f', '#e98139', '#8f4013'] },
];

/** FL's ModeSelect: I, II or EDIT; shift-click I or II for I + II (Link). */
const ModeSelect = memo(function ModeSelect() {
  const mode = useParam('mode');
  const link = useParam('link');
  const edit = useFxEdit();
  const m = Math.round(mode.value);
  const linked = m !== 2 && link.value >= 0.5;
  const lit = [m === 0 || linked, m === 1 || linked, m === 2];
  const name = linked ? 'I + II' : ['I', 'II', 'EDIT'][m] ?? 'I';
  const pick = (i: number, shift: boolean) => {
    edit('Mode', (p) => {
      p.mode = i;
      if (i < 2) p.link = shift ? 1 : 0;
    });
    setHint(`Mode: ${shift && i < 2 ? 'I + II' : ['I', 'II', 'EDIT'][i]}`);
  };
  return (
    <div className="fxk-abs" style={{ left: 26, top: 93, width: 141, height: 81, cursor: 'default' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const fx = (e.clientX - r.left) / r.width;
        pick(fx < 47 / 141 ? 0 : fx < 94 / 141 ? 1 : 2, e.shiftKey);
      }}
      onPointerEnter={() => setHint(`Mode: ${name} (shift-click for I + II)`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        const items: MenuItem[] = [...VCHORUS_MODES.map((o, i) => ({ label: o, radio: true, checked: !linked && m === i, onClick: () => pick(i, false) })),
          { label: 'Chorus 1 + 2', radio: true, checked: linked, onClick: () => pick(m === 1 ? 1 : 0, true) }];
        openMenu(e.clientX, e.clientY, items);
      }}>
      <svg width={141} height={81} viewBox="26 93 141 81" style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          {PADS.map((p, i) => {
            const c = lit[i] ? p.lit : p.idle;
            return (
              <radialGradient key={i} id={`vcpad${i}`} cx="50%" cy="50%" r="62%">
                <stop offset="0%" stopColor={c[0]} />
                <stop offset="100%" stopColor={c[1]} />
              </radialGradient>
            );
          })}
        </defs>
        {[49.7, 96.3, 143].map((x, i) => <Led key={i} cx={x} cy={116.3} on={lit[i]} />)}
        {PADS.map((p, i) => (
          <g key={i}>
            <rect x={p.x} y={129} width={44} height={45} rx={3.5} fill={(lit[i] ? p.lit : p.idle)[2]} />
            <rect x={p.x + 0.7} y={129.7} width={42.6} height={43.6} rx={3} fill={`url(#vcpad${i})`} />
            {lit[i] && <rect x={p.x + 0.7} y={129.7} width={42.6} height={43.6} rx={3} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={0.8} />}
          </g>
        ))}
      </svg>
    </div>
  );
});

// ---- faders -----------------------------------------------------------------

const SL_TOP = 7.33, SL_TRAVEL = 91.4;

function sliderTicks(speed: boolean): ReactElement[] {
  const out: ReactElement[] = [];
  if (!speed) {
    for (let i = 0; i <= 10; i++) {
      const y = SL_TOP + i * (SL_TRAVEL / 10);
      const c = i % 5 === 0 ? '#bdbdbd' : '#6a6a6a';
      out.push(<rect key={`l${i}`} x={1} y={y - 0.33} width={15.6} height={0.67} fill={c} />);
      out.push(<rect key={`r${i}`} x={19.7} y={y - 0.33} width={15.6} height={0.67} fill={c} />);
    }
    return out;
  }
  for (let i = 0; i <= 24; i++) {
    const y = SL_TOP + i * (SL_TRAVEL / 24);
    const long = i % 6 === 0;
    const c = long ? '#b4b4b4' : i % 2 ? '#8a8a8a' : '#a4a4a4';
    if (long) {
      out.push(<rect key={`l${i}`} x={0.7} y={y - 0.33} width={15.6} height={0.67} fill={c} />);
      out.push(<rect key={`r${i}`} x={20.3} y={y - 0.33} width={15.7} height={0.67} fill={c} />);
    } else {
      out.push(<rect key={`l${i}`} x={0.7} y={y - 0.4} width={8} height={0.8} fill={c} />);
      out.push(<rect key={`r${i}`} x={28} y={y - 0.4} width={8} height={0.8} fill={c} />);
    }
    if (i === 0 || i === 19 || i === 24) {
      out.push(<rect key={`el${i}`} x={-2} y={y - 0.4} width={2} height={0.8} fill="#8a8a8a" />);
      out.push(<rect key={`er${i}`} x={36.7} y={y - 0.4} width={2} height={0.8} fill="#8a8a8a" />);
    }
  }
  return out;
}

const TICKS = sliderTicks(false);
const SPEED_TICKS = sliderTicks(true);

/** FL's TVectorSlider in the Vintage skin: tick scale, thin track lit below the cap. */
const Fader = memo(function Fader({ k, x, speed, control, off }: { k: string; x: number; speed?: boolean; control?: Partial<ControlProps>; off?: boolean }) {
  const p = useParam(k, control);
  const h = useControl({ travel: SL_TRAVEL, ...p.control, disabled: off }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min)));
  const vy = SL_TOP + (1 - t) * SL_TRAVEL;
  const tx = speed ? 18.3 : 18;
  return (
    <div className="fxk-abs fxk-slider" style={{ left: x, top: 73, width: 35, height: 104, opacity: off ? DIM : 1 }} {...h}>
      <svg width={35} height={104} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="vccap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#7a8287" />
            <stop offset="0.16" stopColor="#5d656a" />
            <stop offset="0.24" stopColor="#3b4247" />
            <stop offset="0.5" stopColor="#31383c" />
            <stop offset="0.62" stopColor="#2b3135" />
            <stop offset="0.76" stopColor="#4a5257" />
            <stop offset="0.88" stopColor="#353b3f" />
            <stop offset="1" stopColor="#202427" />
          </linearGradient>
          <linearGradient id="vccapshadow" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="rgba(0,0,0,0.55)" />
            <stop offset="1" stopColor="rgba(0,0,0,0)" />
          </linearGradient>
        </defs>
        {speed ? SPEED_TICKS : TICKS}
        <rect x={tx - 0.67} y={SL_TOP} width={1.33} height={SL_TRAVEL} fill="#9c9c9c" />
        <rect x={tx - 0.67} y={vy} width={1.33} height={SL_TOP + SL_TRAVEL - vy} fill="#ececec" />
        <rect x={tx - 11.65} y={vy + 5.7} width={23.3} height={4.6} fill="url(#vccapshadow)" />
        <rect x={tx - 11.65} y={vy - 6.3} width={23.3} height={12} rx={1} fill="url(#vccap)" />
        <rect x={tx - 11.65} y={vy - 0.5} width={23.3} height={1} fill="#f2f2f2" />
      </svg>
    </div>
  );
});

// ---- knobs ------------------------------------------------------------------

const SWEEP = 155.6;

/** FL's TVectorWheel in the Vintage skin: grey ring, dark cap, light pointer, dotted scale. */
const Knob = memo(function Knob({ k, x, y, off }: { k: string; x: number; y: number; off?: boolean }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control, disabled: off }, 'vertical');
  const t = Math.min(1, Math.max(0, (p.value - p.def.min) / (p.def.max - p.def.min)));
  const ang = -SWEEP + 2 * SWEEP * t;
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  const c = 21;
  const dots: ReactElement[] = [];
  for (let i = 0; i <= 20; i++) {
    const a = -SWEEP + (2 * SWEEP * i) / 20;
    const on = !off && a <= ang + 0.01;
    const col = on ? '#e6e6e6' : '#3a4145';
    const major = i % 4 === 0;
    const r0 = major ? 18.5 : 19.2, r1 = major ? 21 : 20.2;
    dots.push(<line key={i} x1={c + r0 * Math.cos(rad(a))} y1={c + r0 * Math.sin(rad(a))} x2={c + r1 * Math.cos(rad(a))} y2={c + r1 * Math.sin(rad(a))}
      stroke={col} strokeWidth={major ? 1.1 : 1} strokeLinecap="butt" />);
  }
  // the half of the cap away from the pointer is shaded
  const pa = rad(ang);
  const nx = Math.cos(pa), ny = Math.sin(pa);
  const R = 13.1;
  const ex = -ny * R, ey = nx * R;
  const half = `M ${c + ex} ${c + ey} A ${R} ${R} 0 0 1 ${c - ex} ${c - ey} Z`;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 42, height: 42 }} {...h}>
      <svg width={42} height={42} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <linearGradient id="vcknobcap" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#40474c" />
            <stop offset="1" stopColor="#2c3236" />
          </linearGradient>
        </defs>
        {dots}
        <circle cx={c} cy={c + 1.2} r={16.6} fill="rgba(0,0,0,0.35)" />
        <circle cx={c} cy={c} r={16.4} fill="#41494d" />
        <circle cx={c} cy={c} r={14.1} fill="#262b2e" />
        <circle cx={c} cy={c} r={R} fill="url(#vcknobcap)" />
        <path d={half} fill="rgba(0,0,0,0.2)" />
        <line x1={c + 2.4 * nx} y1={c + 2.4 * ny} x2={c + 11.3 * nx} y2={c + 11.3 * ny} stroke={off ? '#a3a3a3' : '#e8e8e8'} strokeWidth={1.4} strokeLinecap="butt" />
      </svg>
    </div>
  );
});

// ---- LFO type toggle --------------------------------------------------------

/** FL's TSwitchSelector: a toggle with the sine (up) and triangle (down) icons. */
const TypeSwitch = memo(function TypeSwitch({ off }: { off?: boolean }) {
  const p = useParam('lfoType');
  const sine = p.value >= 0.5;
  const set = (v: number) => { p.control.onBegin?.(); p.set(v); p.control.onEnd?.(); setHint(`LFO type: ${v ? 'Sine' : 'Triangle'}`); };
  const by = sine ? 9 : 26;
  return (
    <div className="fxk-abs" style={{ left: 445, top: 77, width: 41, height: 33, cursor: 'default', opacity: off ? DIM : 1 }}
      onPointerDown={(e) => {
        if (e.button !== 0 || off) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const ry = (e.clientY - r.top) / r.height;
        // clicking an icon picks it, clicking the lever toggles
        if ((e.clientX - r.left) / r.width > 0.45) set(ry < 0.5 ? 1 : 0);
        else set(sine ? 0 : 1);
      }}
      onPointerEnter={() => setHint(`LFO type: ${sine ? 'Sine' : 'Triangle'}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        if (off) return;
        openMenu(e.clientX, e.clientY, ['Triangle', 'Sine'].map((o, i) => ({ label: o, radio: true, checked: (sine ? 1 : 0) === i, onClick: () => set(i) })));
      }}>
      <svg width={41} height={33} style={{ display: 'block', overflow: 'visible' }}>
        <defs>
          <radialGradient id="vcball" cx="40%" cy="35%" r="65%">
            <stop offset="0" stopColor="#f4f4f4" />
            <stop offset="0.45" stopColor="#9a9fa2" />
            <stop offset="1" stopColor="#3b3f42" />
          </radialGradient>
        </defs>
        <rect x={2} y={3} width={14} height={29.3} rx={7} fill="#1b1e20" />
        <rect x={2.7} y={3.7} width={12.6} height={27.9} rx={6.3} fill="#272c2e" />
        <circle cx={9} cy={by} r={5.2} fill="#111314" />
        <circle cx={9} cy={by} r={4.6} fill="url(#vcball)" />
        <path d="M 22.3 12 C 24 3.5, 27 3.5, 28.3 12 S 32.6 20.5, 34.3 12" fill="none" stroke={sine ? '#e2e2e2' : '#c9c9c9'} strokeWidth={1.2} transform="translate(0 0)" />
        <path d="M 22.3 30 L 26.3 22 L 30.3 30 L 34.3 22" fill="none" stroke={sine ? '#c9c9c9' : '#e2e2e2'} strokeWidth={1.2} strokeLinejoin="miter" />
      </svg>
    </div>
  );
});

// ---- tempo menu for the Speed fader ----------------------------------------

/** FL's "Set" submenu (speed values for note lengths, from the form). */
const SET_MENU: [string, number][] = [
  ['1/64', 245760], ['1/32', 244216], ['1/16', 211373], ['1/8', 190725], ['1/4', 164762], ['1/2', 134931],
  ['1/16 dotted', 199737], ['1/8 dotted', 176098], ['1/4 dotted', 147681], ['1/2 dotted', 116283],
  ['1/16 triplet', 220695], ['1/8 triplet', 203210], ['1/4 triplet', 180324], ['1/2 triplet', 152664],
];

function SpeedFader({ off }: { off?: boolean }) {
  const sync = useParam('sync').value >= 0.5;
  const sp = useParam('speed');
  const setTo = (v: number) => { sp.control.onBegin?.(); sp.set(v); sp.control.onEnd?.(); };
  const extraMenu: MenuItem[] = [{
    label: 'Set',
    submenu: SET_MENU.map(([label, v]) => ({ label, checked: Math.round(sp.value) === v, onClick: () => setTo(v) })),
  }];
  return <Fader k="speed" x={510} speed off={off} control={{ extraMenu, ...(sync ? { format: vchorusSyncText } : {}) }} />;
}

// ---- editor -----------------------------------------------------------------

function VintageChorusEditor() {
  // FL dims what a mode ignores: the Juno modes use only Gain, Noise and Noise gate,
  // and Start phase only applies to the tempo-synced LFO
  const fixed = Math.round(useParam('mode').value) !== 2;
  const sync = useParam('sync').value >= 0.5;
  return (
    <FxPanel width={W} height={H} style={{
      background: 'repeating-linear-gradient(180deg, #262626 0px, #262626 1px, #282828 1px, #282828 2px, #242424 2px, #242424 3.4px, #272727 3.4px, #272727 4.5px)',
    }}>
      <Artwork />
      <ModeSelect />
      <Fader k="time1" x={201} off={fixed} />
      <Fader k="time2" x={238} off={fixed} />
      <Fader k="feedback" x={275} off={fixed} />
      <Fader k="highPass" x={312} off={fixed} />
      <Knob k="startPhase" x={379} y={73} off={fixed || !sync} />
      <Knob k="lrPhase" x={379} y={135} off={fixed} />
      <TypeSwitch off={fixed} />
      <LedSwitch k="sync" x={455} y={160} w={18} h={17} off={fixed} />
      <SpeedFader off={fixed} />
      <LedSwitch k="mono" x={566} y={117} w={70} h={17} caption="MONO INPUT" capW={44.7} off={fixed} />
      <LedSwitch k="invert" x={566} y={139} w={70} h={17} caption="INVERT WET" capW={42.7} off={fixed} />
      <LedSwitch k="gate" x={566} y={160} w={70} h={17} caption="NOISE GATE" capW={42} />
      <Knob k="noise" x={640} y={73} />
      <Knob k="gain" x={640} y={135} />
      <Fader k="mix" x={688} off={fixed} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vchorus', Editor: VintageChorusEditor };
