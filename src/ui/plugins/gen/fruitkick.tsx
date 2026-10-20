// Fruit Kick editor (FL: Fruit Kick, SynthPanel 380 x 80): four bevelled
// groups (MAX / MIN / DECAY, AMP DECAY, CLICK, DIST) with FL's dark knobs
// turning 300 degrees, an orange value arc on the ring and an orange dot.
// Positions are FL's form coordinates; colours were sampled from the manual's
// screenshot (img_plug/fruitkick.png, 2x). Original drawing, no FL assets.

import { useId } from 'react';
import { useNoScrollWheel, useParam, FxPanel, Label } from '../kit';
import { useControl } from '../../widgets/control';
import type { FxEditorModule } from '../registry';

const ARC = '#ffb43c';
const LABEL = '#cdd3d7';
const SWEEP = 300;

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** The knob drawing: outlined dark ring, orange arc from the minimum, shaded body, orange dot. */
function KickKnobView({ size, t }: { size: number; t: number }) {
  const c = size / 2;
  const rOut = c - 0.5;
  const ringW = size * 0.06;
  const rRing = rOut - 0.5 - ringW / 2;
  const rBody = rRing - ringW / 2 - 1;
  const a0 = -SWEEP / 2;
  const a1 = a0 + SWEEP * Math.min(1, Math.max(0, t));
  const [x0, y0] = polar(c, rRing, a0);
  const [x1, y1] = polar(c, rRing, a1);
  const [dx, dy] = polar(c, rBody * 0.75, a1);
  const id = 'fk' + useId().replace(/:/g, '');
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#626b70" />
          <stop offset="0.5" stopColor="#4b5459" />
          <stop offset="1" stopColor="#353e43" />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={rOut} fill="#434c51" stroke="#363f44" strokeWidth={1} />
      {a1 - a0 > 0.5 && (
        <path d={`M${x0.toFixed(2)} ${y0.toFixed(2)} A${rRing} ${rRing} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`}
          fill="none" stroke={ARC} strokeWidth={ringW + 0.4} />
      )}
      <circle cx={c} cy={c} r={rBody + 0.5} fill="#363f44" />
      <circle cx={c} cy={c} r={rBody} fill={`url(#${id})`} />
      <path d={`M${(c - rBody * 0.8).toFixed(2)} ${(c - rBody * 0.6).toFixed(2)} A${rBody} ${rBody} 0 0 1 ${(c + rBody * 0.8).toFixed(2)} ${(c - rBody * 0.6).toFixed(2)}`}
        fill="none" stroke="#7e878c" strokeWidth={0.6} opacity={0.8} />
      <circle cx={dx} cy={dy} r={size * 0.032} fill={ARC} />
    </svg>
  );
}

/** A Fruit Kick knob bound to parameter `k` at FL's form position. */
function KickKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 40, height: 40 }} {...h}>
      <KickKnobView size={40} t={t} />
    </div>
  );
}

/** FL's TVectorBevel here: a 1 px lighter outline, no fill. */
function Group({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, boxSizing: 'border-box', border: '1px solid #515a60' }} />;
}

function Cap({ x, w, children }: { x: number; w: number; children: string }) {
  // FL's P_SmallBold is a condensed face: squeeze the caption horizontally (unclipped)
  return (
    <Label x={x - 10} y={58} w={w + 20} h={13} size={9} bold color={LABEL} style={{ overflow: 'visible' }}>
      <span style={{ display: 'inline-block', transform: 'scaleX(0.84)' }}>{children}</span>
    </Label>
  );
}

function FruitKickEditor() {
  return (
    <FxPanel width={380} height={80} style={{ background: 'radial-gradient(130% 150% at 50% 0%, #66727a 0%, #59636a 38%, #485055 75%, #3c4246 100%)' }}>
      <Group x={5} y={5} w={178} h={70} />
      <Group x={188} y={5} w={59} h={70} />
      <Group x={252} y={5} w={59} h={70} />
      <Group x={316} y={5} w={59} h={70} />
      <KickKnob k="max" x={17} y={13} />
      <KickKnob k="min" x={74} y={13} />
      <KickKnob k="freqDecay" x={132} y={13} />
      <KickKnob k="ampDecay" x={198} y={12} />
      <KickKnob k="click" x={261} y={12} />
      <KickKnob k="dist" x={325} y={12} />
      <Cap x={18} w={38}>MAX</Cap>
      <Cap x={75} w={38}>MIN</Cap>
      <Cap x={135} w={35}>DECAY</Cap>
      <Cap x={192} w={53}>AMP DECAY</Cap>
      <Cap x={262} w={38}>CLICK</Cap>
      <Cap x={328} w={35}>DIST</Cap>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'fruitkick', Editor: FruitKickEditor };
