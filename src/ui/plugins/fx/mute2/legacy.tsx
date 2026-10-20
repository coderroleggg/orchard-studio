// FL's legacy vector look, shared by the legacy editors of this batch (Mute 2,
// Bass Boost, Phase Inverter, Center; FL draws Free Filter and Compressor the
// same way): a dark panel, rounded bevels (TVectorBevel VB_PlainRounded) with
// a header strip (TQuickLabel QL_RoundedSubtle), the 46 x 40 TVectorWheel and
// a value caption in the wheel colour. Geometry and colours were measured on
// FL's manual screenshots (1.5x). Candidates for the kit.

import { memo, type ReactNode } from 'react';
import { useControl, automationMenuItems, autoTargetOf, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import { useParam } from '../../kit';

export const LEGACY = {
  panel: '#444a4f',
  bevel: '#50585b',
  header: '#5a636a',
  headText: '#c8d7df',
  /** Wheel colours: Mute 2 / Bass Boost (pink) and Phase Inverter (lime). */
  pink: '#ffd4dd',
  lime: '#f4ffd4',
};

const START = -135;
const SWEEP = 270;

function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  if (Math.abs(a1 - a0) < 0.05) return '';
  const lo = Math.min(a0, a1), hi = Math.max(a0, a1);
  const [x0, y0] = polar(cx, cy, r, lo);
  const [x1, y1] = polar(cx, cy, r, hi);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${hi - lo > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

let uid = 0;

/**
 * FL's TVectorWheel in a 46 x 40 box: a 270 degree value ring (outline at r 19.6,
 * band r 15..19.2: the value arc in the wheel colour, the rest a light track),
 * a 14.5 px face with a dark edge, top rim light and a drop shadow, a flat
 * facet on the pointer side (the segment beyond a chord at 0.34 r, lit from
 * above: bright near 12 o'clock, shaded elsewhere) and a pointer from the
 * chord to the face edge.
 */
export function LegacyWheelView({ t, color, w = 46, h = 40, disabled }: { t: number; color: string; w?: number; h?: number; disabled?: boolean }) {
  const cx = w / 2, cy = h / 2;
  const rO = 19.6, rBand = 17.1, bandW = 4.2, rF = 14.5;
  const tc = Math.min(1, Math.max(0, Number.isFinite(t) ? t : 0));
  const ang = START + SWEEP * tc;
  const half = (Math.acos(0.34) * 180) / Math.PI;
  const [s0x, s0y] = polar(cx, cy, rF, ang - half);
  const [s1x, s1y] = polar(cx, cy, rF, ang + half);
  const lit = Math.pow(Math.max(0, Math.cos((ang * Math.PI) / 180)), 5);
  const [p0x, p0y] = polar(cx, cy, rF * 0.36, ang);
  const [p1x, p1y] = polar(cx, cy, rF * 0.97, ang);
  const id = `lgw${(uid = (uid + 1) % 1e6)}`;
  const facet = `M${s0x.toFixed(2)} ${s0y.toFixed(2)} A${rF} ${rF} 0 0 1 ${s1x.toFixed(2)} ${s1y.toFixed(2)} Z`;
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.45 : 1 }}>
      <defs>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#505b60" />
          <stop offset="1" stopColor="#424c52" />
        </linearGradient>
      </defs>
      <path d={arcPath(cx, cy, rO - 0.35, START, START + SWEEP)} stroke="#424a4e" strokeWidth={0.9} fill="none" />
      <path d={arcPath(cx, cy, rBand, START, START + SWEEP)} stroke="#545c60" strokeWidth={bandW} fill="none" />
      {ang - START > 0.3 && <path d={arcPath(cx, cy, rBand, START, ang)} stroke={color} strokeWidth={bandW} fill="none" />}
      <circle cx={cx} cy={cy + 2.6} r={rF + 0.6} fill="rgba(0,0,0,0.24)" />
      <circle cx={cx} cy={cy} r={rF + 0.7} fill="#323b41" />
      <circle cx={cx} cy={cy} r={rF} fill={`url(#${id}f)`} />
      <path d={facet} fill={`rgba(0,0,0,${(0.2 * (1 - lit)).toFixed(3)})`} />
      {lit > 0.01 && <path d={facet} fill={`rgba(255,255,255,${(0.2 * lit).toFixed(3)})`} />}
      <path d={arcPath(cx, cy, rF - 0.5, -58, 58)} stroke="rgba(255,255,255,0.2)" strokeWidth={0.9} fill="none" />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={1.6} strokeLinecap="butt" />
    </svg>
  );
}

/** A legacy wheel bound to parameter `k` (FL form Left / Top of the 46 x 40 control). */
export const LegacyWheel = memo(function LegacyWheel({ k, x, y, color }: { k: string; x: number; y: number; color: string }) {
  const p = useParam(k);
  return <LegacyWheelControl x={x} y={y} color={color} control={p.control} />;
});

export function LegacyWheelControl({ x, y, color, control }: { x: number; y: number; color: string; control: ControlProps }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 46, height: 40 }} {...h}>
      <LegacyWheelView t={(control.value - min) / (max - min || 1)} color={color} disabled={control.disabled} />
    </div>
  );
}

/** TVectorBevel (VB_PlainRounded). */
export function LegacyBevel({ x, y, w = 160, h = 45 }: { x: number; y: number; w?: number; h?: number }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: LEGACY.bevel, borderRadius: 3 }} />;
}

/** Header strip (TQuickLabel QL_RoundedSubtle, 9 px Arial caps). */
export function LegacyHeader({ x, y, w = 106, h = 16, children }: { x: number; y: number; w?: number; h?: number; children: ReactNode }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, background: LEGACY.header, borderRadius: 2, color: LEGACY.headText,
      font: `400 9px/${h}px Arial, "Helvetica Neue", Helvetica, sans-serif`, textAlign: 'center',
      whiteSpace: 'nowrap', pointerEvents: 'none',
    }}>{children}</div>
  );
}

/** Value caption (TQuickLabel, P_Normal) in the wheel colour. */
export function LegacyValue({ x, y, w = 102, h = 14, color, children }: { x: number; y: number; w?: number; h?: number; color: string; children: ReactNode }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y + 1, width: w, height: h, color, font: `400 10.5px/${h}px var(--font-ui)`,
      whiteSpace: 'nowrap', overflow: 'hidden', pointerEvents: 'none',
    }}>{children}</div>
  );
}

/** A bevel with its wheel, header and value caption (FL's standard legacy group). */
export function LegacySection({ k, x, title, color, value }: { k: string; x: number; title: string; color: string; value?: ReactNode }) {
  const p = useParam(k);
  return (
    <>
      <LegacyBevel x={x} y={5} />
      <LegacyHeader x={x + 54} y={5}>{title}</LegacyHeader>
      {value === undefined ? <LegacyValue x={x + 55} y={31} color={color}>{p.control.format?.(p.value)}</LegacyValue> : value}
      <LegacyWheel k={k} x={x + 2} y={8} color={color} />
    </>
  );
}

/**
 * TSwitchSelector: a vertical two-position pill (ball up = the last caption)
 * with its captions to the right, bound to a 0/1 parameter. Clicking the
 * upper or lower half (pill or caption) picks that position.
 */
export function LegacySwitch({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const opts = p.def.options ?? ['Off', 'On'];
  const on = p.value > p.def.min;
  const pick = (v: number) => {
    if (v === p.value) return;
    p.control.onBegin?.();
    p.set(v);
    p.control.onEnd?.();
  };
  const hint = () => setHint(`${p.def.name}: ${opts[on ? 1 : 0]}`);
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items: MenuItem[] = [
      ...[1, 0].map((v) => ({ label: opts[v], radio: true, checked: (on ? 1 : 0) === v, onClick: () => pick(v) } as MenuItem)),
      ...automationMenuItems(autoTargetOf(p.control), e.clientX, e.clientY),
    ];
    openMenu(e.clientX, e.clientY, items);
  };
  const ballY = on ? 7 : 20.2;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default' }}
      onPointerEnter={hint} onPointerLeave={clearHint} onContextMenu={menu}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        pick((e.clientY - r.top) / r.height < 0.5 ? p.def.max : p.def.min);
        setHint(`${p.def.name}: ${opts[(e.clientY - r.top) / r.height < 0.5 ? 1 : 0]}`);
      }}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <defs>
          <radialGradient id="lgsball" cx="45%" cy="38%" r="62%">
            <stop offset="0" stopColor="#c7cdd0" />
            <stop offset="0.75" stopColor="#b8bfc2" />
            <stop offset="1" stopColor="#9aa2a6" />
          </radialGradient>
        </defs>
        <rect x={1.4} y={1.2} width={13.2} height={25.4} rx={6.6} fill="#43494d" stroke="#272a2c" strokeWidth={1.1} />
        <circle cx={8} cy={ballY + 0.9} r={5.1} fill="rgba(0,0,0,0.35)" />
        <circle cx={8} cy={ballY} r={5} fill="url(#lgsball)" />
      </svg>
      {[1, 0].map((v, i) => (
        <div key={v} style={{
          position: 'absolute', left: 17.5, top: i === 0 ? 3.5 : 17, height: 11, lineHeight: '11px', color: '#d6e0e5',
          font: '400 9.5px/11px var(--font-ui)', whiteSpace: 'nowrap', pointerEvents: 'none',
        }}>{opts[v]}</div>
      ))}
    </div>
  );
}
