// FL vector widgets shared by the Gain-category editors of this batch
// (PanOMatic, Stereo Enhancer, Stereo Shaper, Send...). They complement the
// kit (src/ui/plugins/kit) and are candidates for it:
// - MetalKnob: FL's TVectorWheel "metal" look of the older Fruity plugins:
//   a static brushed-metal (3-fold conic) cap with a bright rim, dark outline
//   and drop shadow, a coloured pointer, optional tick ring (33 ticks over
//   +-154 deg, every 4th long) and a centre marker dot. FL wheels sweep 300
//   degrees (+-150), not the kit's 270;
// - GlyphSelect: TPaintBoxSelector drawn with glyphs (LFO shapes), the
//   selected glyph in a dark disc;
// - LedRadio: TPaintBoxSelector as a column of LED radio buttons with captions;
// - SoberPanel: TVectorPanel style psSober (flat panel with a slanted title tab).

import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import { useControl, automationMenuItems, autoTargetOf, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { openRouteMenu, useFxEditor, useFxState, useParam, type Route } from '../../kit';
import * as A from '../../../../store/actions';
export const WHEEL_START = -150;
export const WHEEL_SWEEP = 300;

/** Condensed caption font (FL uses Open Sans Condensed Light in these editors). */
export const COND_FONT = '"Open Sans Condensed", "Roboto Condensed", "Arial Narrow", "Avenir Next Condensed", "Helvetica Neue", sans-serif';
/** Extra horizontal squeeze that brings the fallback fonts to Open Sans Condensed Light's width. */
export const COND_SQUEEZE = 0.8;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

export interface MetalLook {
  /** Light and dark tone of the brushed face (3-fold conic pattern, static). */
  light: string;
  dark: string;
  /** Rim around the face: a conic gradient (CSS colour stops) or a colour. */
  rim: string;
  /** Outline ring around the rim. */
  outline: string;
  /** Face, rim and outline radii as fractions of the wheel size. */
  face: number;
  rimR: number;
  ring: number;
}

/** PanOMatic / Stereo Shaper steel cap (colours and radii measured on FL's screenshots). */
export const STEEL: MetalLook = {
  light: '#8a959b', dark: '#4b565c',
  rim: 'conic-gradient(#e4edf2 0deg, #6a767c 38deg, #929da3 75deg, #56626a 112deg, #aab5bb 142deg, #4e5a60 180deg, #b4bfc5 222deg, #6d797f 256deg, #9ba6ac 286deg, #5f6b71 322deg, #e4edf2 360deg)',
  outline: '#182025', face: 0.29, rimR: 0.334, ring: 0.366,
};

export interface MetalKnobViewProps {
  size: number;
  /** Normalised position 0..1. */
  t: number;
  pointer?: string;
  look?: MetalLook;
  ticks?: boolean;
  tickColor?: string;
  /** Centre marker dot at this normalised position (e.g. 0.5 for bipolar wheels). */
  dot?: number;
  dotColor?: string;
  /** Pointer from/to radius as fractions of the wheel size. */
  pointerFrom?: number;
  pointerTo?: number;
  pointerWidth?: number;
  disabled?: boolean;
}

export function MetalKnobView({
  size: S, t, pointer = '#ffc12c', look = STEEL, ticks = true, tickColor = '#2e383e', dot, dotColor,
  pointerFrom = 0.03, pointerTo = 0.27, pointerWidth, disabled,
}: MetalKnobViewProps) {
  const c = S / 2;
  const ang = WHEEL_START + WHEEL_SWEEP * Math.min(1, Math.max(0, t));
  const rRing = S * look.ring;
  const pw = pointerWidth ?? Math.max(1.5, S * 0.062);
  const [p0x, p0y] = polar(c, c, S * pointerFrom, ang);
  const [p1x, p1y] = polar(c, c, S * pointerTo, ang);
  const tickEls: ReactNode[] = [];
  if (ticks) {
    for (let k = 0; k <= 32; k++) {
      const a = -154 + (308 * k) / 32;
      const long = k % 4 === 0;
      const [x0, y0] = polar(c, c, S * 0.41, a);
      const [x1, y1] = polar(c, c, S * (long ? 0.495 : 0.46), a);
      tickEls.push(<line key={k} x1={x0} y1={y0} x2={x1} y2={y1} stroke={tickColor} strokeWidth={Math.max(0.8, S * 0.024)} />);
    }
  }
  let dotEl: ReactNode = null;
  if (dot !== undefined) {
    const da = WHEEL_START + WHEEL_SWEEP * dot;
    const [dx, dy] = polar(c, c, S * 0.59, da);
    const ds = Math.max(1.3, S * 0.042);
    dotEl = <rect x={dx - ds / 2} y={dy - ds / 2} width={ds} height={ds} fill={dotColor ?? pointer} />;
  }
  const disc = (r: number, background: string, extra?: CSSProperties): CSSProperties => ({
    position: 'absolute', left: c - r, top: c - r, width: r * 2, height: r * 2, borderRadius: '50%', background, ...extra,
  });
  const rFace = S * look.face, rRim = S * look.rimR;
  const faceBg = `conic-gradient(${look.light} 0deg, ${look.dark} 60deg, ${look.light} 120deg, ${look.dark} 180deg, ${look.light} 240deg, ${look.dark} 300deg, ${look.light} 360deg)`;
  return (
    <div style={{ position: 'relative', width: S, height: S, opacity: disabled ? 0.5 : 1 }}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        {tickEls}
        {dotEl}
        <circle cx={c} cy={c + S * 0.04} r={rRing + S * 0.012} fill="rgba(0,0,0,0.3)" />
        <circle cx={c} cy={c} r={rRing} fill={look.outline} />
      </svg>
      <div style={disc(rRim, look.rim)} />
      <div style={disc(rFace, faceBg, { boxShadow: `0 0 ${Math.max(0.4, S * 0.012)}px rgba(0,0,0,0.35)` })} />
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={pointer} strokeWidth={pw} strokeLinecap="round" />
      </svg>
    </div>
  );
}

export interface MetalKnobProps extends Omit<MetalKnobViewProps, 't' | 'size'> {
  x: number;
  y: number;
  size: number;
  /** Override control props (e.g. step: 0 for smooth dragging of wide ranges). */
  control?: Partial<ControlProps>;
}

/** A metal wheel bound to plugin parameter `k`. */
export const MetalKnob = memo(function MetalKnob({ k, x, y, size, control: over, ...view }: MetalKnobProps & { k: string }) {
  const p = useParam(k, over);
  return <MetalKnobControl x={x} y={y} size={size} control={p.control} {...view} />;
});

export function MetalKnobControl({ x, y, size, control, ...view }: Omit<MetalKnobProps, 'control'> & { control: ControlProps }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <MetalKnobView size={size} t={t} disabled={control.disabled} {...view} />
    </div>
  );
}

/** Right-click menu of a selector: its options plus FL's automation items. */
function selectorMenu(e: React.MouseEvent, p: ReturnType<typeof useParam>, options: string[], pick: (i: number) => void): void {
  e.preventDefault();
  e.stopPropagation();
  const idx = Math.round(p.value - p.def.min);
  const items: MenuItem[] = [
    ...options.map((o, i) => ({ label: o, checked: i === idx, radio: true, onClick: () => pick(i) } as MenuItem)),
    ...automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY),
  ];
  openMenu(e.clientX, e.clientY, items);
}

export type GlyphName = 'sine' | 'triangle' | 'square';

/** LFO shape glyphs, drawn in a 24 x 21 cell around (12, 10.5). */
function glyphPath(g: GlyphName): string {
  switch (g) {
    case 'sine': {
      let d = '';
      for (let i = 0; i <= 24; i++) {
        const x = -7 + (14 * i) / 24;
        const y = -6 * Math.sin((2 * Math.PI * i) / 24 + 0.35) + 0.5;
        d += (i ? 'L' : 'M') + (12 + x).toFixed(2) + ' ' + (10.5 + y).toFixed(2);
      }
      return d;
    }
    case 'triangle': return 'M5.2 12.4 L9.2 4.9 L14.7 17.1 L18.9 9.6';
    case 'square': return 'M6.5 17.3 L6.5 6.2 L12.1 6.2 L12.1 15.5 L17.7 15.5 L17.7 6.2';
  }
}

/** Glyph selector bound to an option parameter (cells of w / n). */
export function GlyphSelect({ k, x, y, w, h, glyphs, on = '#ffc82a', off = '#2c3a42', disc = '#424644', discEdge = '#233138' }: {
  k: string; x: number; y: number; w: number; h: number; glyphs: GlyphName[]; on?: string; off?: string; disc?: string; discEdge?: string;
}) {
  const p = useParam(k);
  const n = glyphs.length;
  const cell = w / n;
  const idx = Math.round(p.value - p.def.min);
  const opts = p.def.options ?? glyphs;
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerEnter={() => setHint(`${p.def.name}: ${opts[idx] ?? ''}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        const i = Math.min(n - 1, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * n)));
        pick(i);
        setHint(`${p.def.name}: ${opts[i] ?? ''}`);
      }}
      onWheel={(e) => { e.stopPropagation(); pick(Math.min(n - 1, Math.max(0, idx + (e.deltaY < 0 ? 1 : -1)))); }}
      onContextMenu={(e) => selectorMenu(e, p, opts, pick)}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible' }}>
        {glyphs.map((g, i) => (
          <g key={g} transform={`translate(${i * cell + (cell - 24) / 2} ${(h - 21) / 2})`}>
            {i === idx && <circle cx={12} cy={10.5} r={9.8} fill={disc} stroke={discEdge} strokeWidth={1.1} />}
            <path d={glyphPath(g)} fill="none" stroke={i === idx ? on : off} strokeWidth={i === idx ? 1.05 : 0.85} strokeLinejoin="miter" />
          </g>
        ))}
      </svg>
    </div>
  );
}

/** LED radio column bound to an option parameter (one row of h / n per option). */
export function LedRadio({ k, x, y, w, h, options, led = 10, font = COND_FONT, size = 10.5, color = '#d2dcdc', gap = 3, ledOn = 'orange', weight = 400, squeeze = COND_SQUEEZE }: {
  k: string; x: number; y: number; w: number; h: number; options?: string[]; led?: number; font?: string; size?: number; color?: string; gap?: number;
  ledOn?: 'orange' | 'red'; weight?: number; squeeze?: number;
}) {
  const p = useParam(k);
  const opts = options ?? p.def.options ?? [];
  const n = Math.max(1, opts.length);
  const row = h / n;
  const idx = Math.round(p.value - p.def.min);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(p.def.min + i); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerEnter={() => setHint(`${p.def.name}: ${opts[idx] ?? ''}`)} onPointerLeave={clearHint}
      onWheel={(e) => { e.stopPropagation(); pick(Math.min(n - 1, Math.max(0, idx + (e.deltaY < 0 ? -1 : 1)))); }}
      onContextMenu={(e) => selectorMenu(e, p, opts, pick)}>
      {opts.map((o, i) => (
        <div key={i} style={{ position: 'absolute', left: 0, top: i * row, width: w, height: row, display: 'flex', alignItems: 'center' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); setHint(`${p.def.name}: ${o}`); } }}>
          <Led on={i === idx} d={led} tone={ledOn} />
          <span style={{ marginLeft: gap, font: `${weight} ${size}px/1 ${font}`, fontStretch: squeeze < 1 ? 'condensed' : undefined, color, whiteSpace: 'nowrap', display: 'inline-block', transform: squeeze !== 1 ? `scaleX(${squeeze})` : undefined, transformOrigin: 'left center' }}>{o}</span>
        </div>
      ))}
    </div>
  );
}

/** FL's round LED (radio and switch buttons). */
export function Led({ on, d = 10, tone = 'orange' }: { on: boolean; d?: number; tone?: 'orange' | 'red' }) {
  const inner = on
    ? (tone === 'orange'
      ? 'radial-gradient(circle at 50% 78%, #ffe0b8 0%, #ffad7c 38%, #ff7144 70%, #e8502a 100%)'
      : 'radial-gradient(circle at 50% 78%, #ffd2c4 0%, #ff8a6e 40%, #f0442c 72%, #c22a16 100%)')
    : 'linear-gradient(180deg, #4f585c 0%, #687175 55%, #8a9397 100%)';
  return (
    <span style={{
      position: 'relative', display: 'inline-block', flex: 'none', width: d, height: d, borderRadius: '50%', boxSizing: 'border-box',
      background: inner,
      border: `${Math.max(1, d * 0.13)}px solid ${on ? '#4a0b06' : '#0b0e10'}`,
      boxShadow: `0 0 0 ${Math.max(0.6, d * 0.08)}px rgba(150,158,163,0.55)${on ? ', inset 0 1px 1px rgba(255,255,255,0.55)' : ''}`,
    }} />
  );
}

/** TVectorPanel psSober: flat panel with an optional slanted title tab. */
export function SoberPanel({ x, y, w, h, title, tabW = 35, tabH = 18, bg = '#4e565b', tab = '#464d52', edge = '#2b3236', titleColor = '#dfe6eb', children }: {
  x: number; y: number; w: number; h: number; title?: string; tabW?: number; tabH?: number; bg?: string; tab?: string; edge?: string; titleColor?: string; children?: ReactNode;
}) {
  const slant = tabH * 0.55;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: bg }}>
      {title !== undefined && (
        <>
          <svg width={tabW + 2} height={tabH + 1} style={{ position: 'absolute', left: 0, top: 0 }}>
            <path d={`M0 0 H${tabW} L${tabW - slant} ${tabH} H0 Z`} fill={tab} />
            <path d={`M${tabW} 0 L${tabW - slant} ${tabH} H0`} fill="none" stroke={edge} strokeWidth={0.9} />
          </svg>
          <div style={{ position: 'absolute', left: 4, top: 0, height: tabH, lineHeight: `${tabH}px`, font: `500 11.5px ${'var(--font-ui)'}`, color: titleColor, letterSpacing: '0.01em' }}>{title}</div>
        </>
      )}
      {children}
    </div>
  );
}

/**
 * FL's flat ring wheel of the newer editors (Send, Balance-era): grey domed
 * cap, dark tyre with a top highlight, and a value ring around it that runs
 * the full circle from the bottom (bipolar wheels: from the top). Geometry
 * and colours measured on FL's Send screenshot (56 px wheel).
 */
export function RingKnobView({ size: S, t, bipolar, color = '#5febff', colorLo = '#46aad3', disabled }: {
  size: number; t: number; bipolar?: boolean; color?: string; colorLo?: string; disabled?: boolean;
}) {
  const c = S / 2;
  const k = S / 56;
  const tc = Math.min(1, Math.max(0, t));
  const rArc = 26.35 * k, wArc = 2.7 * k;
  const a0 = bipolar ? 0 : -180;
  const a1 = bipolar ? (tc - 0.5) * 360 : -180 + tc * 360;
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  let arcPath = '';
  if (hi - lo > 0.3) {
    if (hi - lo >= 359.9) arcPath = 'full';
    else {
      const [x0, y0] = polar(c, c, rArc, lo);
      const [x1, y1] = polar(c, c, rArc, hi);
      arcPath = `M${x0.toFixed(2)} ${y0.toFixed(2)} A${rArc} ${rArc} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
    }
  }
  const id = `rk${(ringId = (ringId + 1) % 1e6)}`;
  const disc = (r: number, background: string): CSSProperties => ({
    position: 'absolute', left: c - r, top: c - r, width: r * 2, height: r * 2, borderRadius: '50%', background,
  });
  return (
    <div style={{ position: 'relative', width: S, height: S, opacity: disabled ? 0.5 : 1 }}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: 'absolute', left: 0, top: 0 }}>
        <defs>
          <linearGradient id={`${id}a`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={color} /><stop offset="1" stopColor={colorLo} /></linearGradient>
          <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3b4246" /><stop offset="1" stopColor="#2d3135" /></linearGradient>
        </defs>
        <circle cx={c} cy={c} r={28 * k} fill="#2b3136" />
        <circle cx={c} cy={c} r={rArc} fill="none" stroke={`url(#${id}t)`} strokeWidth={wArc} />
        {arcPath === 'full'
          ? <circle cx={c} cy={c} r={rArc} fill="none" stroke={`url(#${id}a)`} strokeWidth={wArc} />
          : arcPath && <path d={arcPath} fill="none" stroke={`url(#${id}a)`} strokeWidth={wArc} />}
      </svg>
      <div style={disc(25 * k, '#22282c')} />
      <div style={disc(24.3 * k, 'conic-gradient(#a5afb4 0deg, #858f94 20deg, #677176 40deg, #444e54 60deg, #263036 80deg, #1d272d 100deg, #2a3439 130deg, #2f3940 180deg, #2a3439 230deg, #1d272d 260deg, #263036 280deg, #444e54 300deg, #677176 320deg, #858f94 340deg, #a5afb4 360deg)')} />
      <div style={disc(19 * k, 'linear-gradient(180deg, #3c4042 0%, #101316 30%, #101316 70%, #15191b 100%)')} />
      <div style={disc(17.4 * k, 'linear-gradient(180deg, #a5aaae 0%, #8a9093 6%, #6d7376 50%, #595f62 100%)')} />
    </div>
  );
}

let ringId = 0;

/** A ring wheel bound to plugin parameter `k`. */
export const RingKnob = memo(function RingKnob({ k, x, y, size, color, colorLo, control: over }: {
  k: string; x: number; y: number; size: number; color?: string; colorLo?: string; control?: Partial<ControlProps>;
}) {
  const p = useParam(k, over);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <RingKnobView size={size} t={t} bipolar={p.def.bipolar} color={color} colorLo={colorLo} disabled={p.control.disabled} />
    </div>
  );
});

/** Colours of FL's collar wheel (Stereo Enhancer): cap, rings, marker, ticks and track band. */
export interface CollarLook {
  cap: string;
  rim: string;
  line: string;
  collar: string;
  marker: string;
  ticks: string | null;
  track: string;
  dot: string;
  /** Optional geometry (in units of a 58 px wheel): radii and track width; thin tracks get end marks. */
  capR?: number;
  lineR?: number;
  collarR?: number;
  trackR?: number;
  trackW?: number;
  markerFrom?: number;
  markerTo?: number;
  markerW?: number;
  dotR?: number;
  /** Extra layer over the cap (CSS background), e.g. a radial shade. */
  capShade?: string;
}

/** Dark collar wheel (Stereo Enhancer STEREO SEP). */
export const COLLAR_DARK: CollarLook = {
  cap: 'linear-gradient(180deg, #4d5356 0%, #3a3f42 50%, #222629 100%)', rim: '#666d71', line: '#17191c',
  collar: '#3c4349', marker: '#f0f0ef', ticks: '#3c4349', track: 'rgba(0,0,0,0.13)', dot: '#f5f5f4',
};

/** White collar wheel with a silver cap (Stereo Enhancer PAN / VOL). */
export const COLLAR_WHITE: CollarLook = {
  cap: 'conic-gradient(#ffffff 0deg, #e2e3e3 20deg, #d1d1d1 40deg, #c9c9c9 60deg, #c5c5c5 100deg, #c0c0c0 120deg, #c3c3c3 140deg, #d4d4d4 160deg, #ededed 180deg, #d7d7d7 200deg, #c9c9c9 220deg, #c7c7c7 240deg, #cacaca 260deg, #cecece 300deg, #d7d7d7 320deg, #e6e7e7 340deg, #ffffff 360deg)',
  rim: '#ffffff', line: '#686868', collar: 'linear-gradient(180deg, #ffffff 0%, #f0f0ef 50%, #e6e7e7 100%)',
  marker: '#ff0000', ticks: '#a2a3a3', track: 'rgba(255,255,255,0.08)', dot: '#ff0000',
};

/**
 * FL's collar wheel (Fruity Stereo Enhancer): a cap inside a thick collar
 * carrying the position marker, a track band and 7 ticks around it (over
 * +-154 deg) and a centre dot for bipolar wheels. Geometry measured on the
 * 2x screenshot (58 px wheel); sweep 300 degrees.
 */
export function CollarKnobView({ size: S, t, look, dot, disabled }: { size: number; t: number; look: CollarLook; dot?: boolean; disabled?: boolean }) {
  const c = S / 2;
  const k = S / 58;
  const ang = WHEEL_START + WHEEL_SWEEP * Math.min(1, Math.max(0, t));
  const capR = (look.capR ?? 16.4) * k, lineR = (look.lineR ?? 17.4) * k, collarR = (look.collarR ?? 21.5) * k;
  const trackR = (look.trackR ?? 27.3) * k, trackW = (look.trackW ?? 2.6) * k;
  const disc = (r: number, background: string, extra?: CSSProperties): CSSProperties => ({
    position: 'absolute', left: c - r, top: c - r, width: r * 2, height: r * 2, borderRadius: '50%', background, ...extra,
  });
  const ticks: ReactNode[] = [];
  if (look.ticks) {
    for (let i = 0; i <= 6; i++) {
      const a = -154 + (308 * i) / 6;
      const [x0, y0] = polar(c, c, 23.5 * k, a);
      const [x1, y1] = polar(c, c, 28.6 * k, a);
      ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke={look.ticks} strokeWidth={Math.max(0.8, 1.1 * k)} />);
    }
  }
  const thin = trackW < 1.5 * k;
  const ends: ReactNode[] = [];
  if (thin) {
    for (const a of [-150, 150]) {
      const [x0, y0] = polar(c, c, trackR, a);
      const [x1, y1] = polar(c, c, trackR - 3.2 * k, a);
      ends.push(<line key={a} x1={x0} y1={y0} x2={x1} y2={y1} stroke={look.track} strokeWidth={trackW} />);
    }
  }
  const a0 = thin ? -150 : -154, a1 = thin ? 150 : 154;
  const [m0x, m0y] = polar(c, c, (look.markerFrom ?? 17.7) * k, ang);
  const [m1x, m1y] = polar(c, c, (look.markerTo ?? 21.3) * k, ang);
  const [dx, dy] = polar(c, c, (look.dotR ?? 32.8) * k, 0);
  return (
    <div style={{ position: 'relative', width: S, height: S, opacity: disabled ? 0.5 : 1 }}>
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <path d={`M${polar(c, c, trackR, a0).join(' ')} A${trackR} ${trackR} 0 1 1 ${polar(c, c, trackR, a1).join(' ')}`} fill="none" stroke={look.track} strokeWidth={trackW} />
        {ends}
        {ticks}
        {dot && <circle cx={dx} cy={dy} r={1.45 * k} fill={look.dot} />}
        <circle cx={c} cy={c + 1.2 * k} r={collarR + 0.3 * k} fill="rgba(0,0,0,0.22)" />
      </svg>
      <div style={disc(collarR, look.collar)} />
      <div style={disc(lineR, look.line)} />
      <div style={disc(capR, look.cap, { boxShadow: `inset 0 ${0.6 * k}px 0 ${look.rim}` })} />
      {look.capShade && <div style={disc(capR, look.capShade)} />}
      <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <line x1={m0x} y1={m0y} x2={m1x} y2={m1y} stroke={look.marker} strokeWidth={(look.markerW ?? 2.3) * k} />
      </svg>
    </div>
  );
}

/** A collar wheel bound to plugin parameter `k`. */
export const CollarKnob = memo(function CollarKnob({ k, x, y, size, look, dot, control: over }: {
  k: string; x: number; y: number; size: number; look: CollarLook; dot?: boolean; control?: Partial<ControlProps>;
}) {
  const p = useParam(k, over);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <CollarKnobView size={size} t={t} look={look} dot={dot} disabled={p.control.disabled} />
    </div>
  );
});




/**
 * FL's red output selector (TVectorDigiWheel bound to a plugin output): the
 * stored state is a mixer track (-1 = none); the display shows FL's number,
 * the target's position among the routed tracks. Drag / wheel step through
 * the routes, right-click opens the menu.
 */
export function RouteLcd({ x, y, w, h, stateKey, hint, look = 'send', routes }: {
  x: number; y: number; w: number; h: number; stateKey: string; hint: string; look?: 'send' | 'shaper'; routes: Route[];
}) {
  const { slotId } = useFxEditor();
  const target = useFxState<number>(stateKey, -1);
  const pos = routes.findIndex((r) => r.index === target) + 1;
  const setTrack = (t: number) => {
    if (t === target) return;
    A.editFx(slotId, hint, (p) => { p[stateKey] = t; }, `${stateKey}:${slotId}`);
  };
  const setPos = (i: number) => setTrack(i <= 0 ? -1 : routes[i - 1]?.index ?? -1);
  const showHint = () => {
    const name = target < 0 ? '(none)' : routes.find((r) => r.index === target)?.name ?? `track ${target} (not routed)`;
    setHint(`${hint}: ${name}`);
  };
  const drag = useRef<{ y: number; start: number } | null>(null);
  const send = look === 'send';
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box', cursor: 'ns-resize', touchAction: 'none',
      borderRadius: send ? '4px 4px 3px 3px' : 0,
      border: send ? '1px solid #30373b' : '1px solid #7b2931',
      boxShadow: send ? 'inset 0 0 0 1px #7b2931' : undefined,
      background: send
        ? 'linear-gradient(180deg, rgba(0,0,0,0.04), rgba(255,255,255,0.03) 50%, rgba(0,0,0,0.05)), linear-gradient(90deg, #a8565f, #9b4952)'
        : 'linear-gradient(135deg, #9b5159 0%, #8f4a51 55%, #84424a 100%)',
    }}
      onPointerEnter={showHint} onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, start: pos };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        setPos(Math.max(0, Math.min(routes.length, d.start + Math.round((d.y - e.clientY) / 8))));
        showHint();
      }}
      onPointerUp={() => { drag.current = null; }}
      onWheel={(e) => { e.stopPropagation(); setPos(Math.max(0, Math.min(routes.length, pos + (e.deltaY < 0 ? 1 : -1)))); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openRouteMenu(e.clientX, e.clientY, routes, target, setTrack); }}>
      {send ? (
        <>
          <div style={{
            position: 'absolute', right: 10, top: 0, height: h - 2, lineHeight: `${h - 2}px`, color: '#ffffcc', pointerEvents: 'none',
            font: pos > 0 ? '300 19px "Helvetica Neue", Arial, sans-serif' : '700 14px "Helvetica Neue", Arial, sans-serif', letterSpacing: '0.02em',
          }}>{pos > 0 ? String(pos) : '·'}</div>
          <svg width={6} height={18} style={{ position: 'absolute', right: 2, top: (h - 2 - 18) / 2, pointerEvents: 'none' }}>
            <path d="M1.2 1.5 L4.2 4 L1.2 6.5" fill="none" stroke="#7b2931" strokeWidth={1} />
            <path d="M4.8 11.5 L1.8 14 L4.8 16.5" fill="none" stroke="#7b2931" strokeWidth={1} />
          </svg>
        </>
      ) : (
        <>
          <div style={{
            position: 'absolute', right: 9, top: 0, height: h - 2, lineHeight: `${h - 2}px`, color: '#111214', pointerEvents: 'none',
            font: '14px Arial, "Helvetica Neue", sans-serif',
          }}>{pos > 0 ? String(pos) : '·'}</div>
          <svg width={7} height={14} style={{ position: 'absolute', right: 2, top: (h - 2 - 14) / 2, pointerEvents: 'none' }}>
            <path d="M0.5 5 L3.5 1.5 L6.5 5 Z" fill="#7b2931" />
            <path d="M0.5 9 L3.5 12.5 L6.5 9 Z" fill="#7b2931" />
          </svg>
        </>
      )}
    </div>
  );
}

/** LED radio bound to a non-parameter state field (FL selectors with Tag -1). */
export function StateLedRadio({ stateKey, x, y, w, h, options, fallback, label, horizontal, font = 'var(--font-ui)', size = 9, weight = 700, color = '#ffffff', led = 10, gap = 4 }: {
  stateKey: string; x: number; y: number; w: number; h: number; options: string[]; fallback: number; label: string; horizontal?: boolean;
  font?: string; size?: number; weight?: number; color?: string; led?: number; gap?: number;
}) {
  const { slotId } = useFxEditor();
  const value = useFxState<number>(stateKey, fallback);
  const n = options.length;
  const pick = (i: number) => { if (i !== value) A.editFx(slotId, label, (p) => { p[stateKey] = i; }); };
  const cw = horizontal ? w / n : w, ch = horizontal ? h : h / n;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerEnter={() => setHint(`${label}: ${options[value] ?? ''}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); openMenu(e.clientX, e.clientY, options.map((o, i) => ({ label: o, checked: i === value, radio: true, onClick: () => pick(i) } as MenuItem))); }}>
      {options.map((o, i) => (
        <div key={i} style={{ position: 'absolute', left: horizontal ? i * cw : 0, top: horizontal ? 0 : i * ch, width: cw, height: ch, display: 'flex', alignItems: 'center' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); setHint(`${label}: ${o}`); } }}>
          <Led on={i === value} d={led} />
          <span style={{ marginLeft: gap, font: `${weight} ${size}px/1 ${font}`, color, whiteSpace: 'nowrap' }}>{o}</span>
        </div>
      ))}
    </div>
  );
}
