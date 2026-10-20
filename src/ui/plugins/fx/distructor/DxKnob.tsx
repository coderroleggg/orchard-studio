// Distructor's knob (FL vector wheel): dark track ring, value arc in the
// module's accent colour from the minimum, grey cap with a soft highlight and
// an accent pointer. Sizes in editor pixels; all arcs start at the minimum.

import { memo, useId } from 'react';
import { useControl } from '../../../widgets/control';
import { useParam } from '../../kit';

export const KNOB_SWEEP = 152;

function pt(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

function arc(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = pt(cx, cy, r, a0);
  const [x1, y1] = pt(cx, cy, r, a1);
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

export interface KnobGeom {
  /** Cap radius. */
  body: number;
  /** Outer radius of the ring. */
  ring: number;
  /** Ring (arc) thickness. */
  width: number;
}

export const GEOM = {
  std: { body: 17, ring: 22.7, width: 4 } as KnobGeom,
  small: { body: 11.6, ring: 15.4, width: 3.2 } as KnobGeom,
  cutoff: { body: 36, ring: 45.2, width: 8.2 } as KnobGeom,
  res: { body: 23.8, ring: 30.8, width: 5.4 } as KnobGeom,
  big: { body: 31, ring: 38.4, width: 6.6 } as KnobGeom,
};

export const DxKnobView = memo(function DxKnobView({ t, g, color, disabled }: { t: number; g: KnobGeom; color: string; disabled?: boolean }) {
  const id = `dxk${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const S = Math.ceil(g.ring * 2 + 4);
  const c = S / 2;
  const rr = g.ring - g.width / 2;
  const a0 = -KNOB_SWEEP;
  const a = a0 + 2 * KNOB_SWEEP * Math.min(1, Math.max(0, t));
  const [p0x, p0y] = pt(c, c, g.body * 0.38, a);
  const [p1x, p1y] = pt(c, c, g.body * 0.9, a);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible', opacity: disabled ? 0.45 : 1 }}>
      <defs>
        <radialGradient id={`${id}c`} cx="46%" cy="34%" r="72%">
          <stop offset="0" stopColor="#68737a" />
          <stop offset="0.55" stopColor="#566168" />
          <stop offset="1" stopColor="#434d53" />
        </radialGradient>
      </defs>
      {/* track: a dark ring with the gap at the bottom */}
      <circle cx={c} cy={c} r={g.ring} fill="#1f272a" />
      <circle cx={c} cy={c} r={g.ring - g.width} fill="#293035" />
      <path d={arc(c, c, rr, KNOB_SWEEP, 360 - KNOB_SWEEP)} stroke="#242c2f" strokeWidth={g.width + 1.2} fill="none" />
      {t > 0.002 && <path d={arc(c, c, rr, a0, a)} stroke={color} strokeWidth={g.width} fill="none" />}
      {/* cap */}
      <circle cx={c} cy={c + 1.2} r={g.body + 0.6} fill="rgba(0,0,0,0.45)" />
      <circle cx={c} cy={c} r={g.body} fill={`url(#${id}c)`} stroke="#2a3237" strokeWidth={0.8} />
      <circle cx={c} cy={c} r={g.body - 1} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth={0.8} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke={color} strokeWidth={Math.max(1.4, g.body / 9)} strokeLinecap="round" />
    </svg>
  );
});

/** A knob bound to parameter `k`, centred on (x, y). */
export const DxKnob = memo(function DxKnob({ k, x, y, g, color, disabled }: { k: string; x: number; y: number; g: KnobGeom; color: string; disabled?: boolean }) {
  const p = useParam(k, disabled ? { disabled: true } : undefined);
  const h = useControl({ travel: 220, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const S = Math.ceil(g.ring * 2 + 4);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x - S / 2, top: y - S / 2, width: S, height: S, borderRadius: '50%' }} {...h}>
      <DxKnobView t={t} g={g} color={color} disabled={disabled} />
    </div>
  );
});
