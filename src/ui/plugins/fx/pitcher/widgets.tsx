// Pitcher's retro widgets (vector stand-ins for FL's bitmap skin): the big
// dial knobs with engraved scales, small black knobs, toggle switches, glowing
// round buttons, cream push buttons and the gender meter.

import { memo, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

const polar = (cx: number, cy: number, r: number, deg: number): [number, number] => {
  const a = ((deg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
};

/** Big dial (SPEED / FINE TUNE): engraved ring scale, black knob with a grip edge, white index at the top. */
export const DialKnob = memo(function DialKnob({ k, cx, cy, r, labels, sweep = 300, reverse }: {
  k: string; cx: number; cy: number; r: number; labels: { at: number; text: string }[]; sweep?: number; reverse?: boolean;
}) {
  const p = useParam(k);
  const h = useControl({ travel: 220, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const S = 2 * r;
  // the scale ring turns with the value under a fixed index at the top: a label for value tl sits at
  // phi(tl) on the ring and the ring turns by -phi(t), so the current value is always under the index
  const phi = (tl: number) => (reverse ? sweep / 2 - sweep * tl : -sweep / 2 + sweep * tl);
  const rot = -phi(t);
  const ticks: ReactNode[] = [];
  for (let i = 0; i <= 40; i++) {
    const a = -sweep / 2 + (sweep * i) / 40;
    const [x0, y0] = polar(r, r, r * 0.86, a), [x1, y1] = polar(r, r, r * (i % 5 === 0 ? 0.74 : 0.79), a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#e8e2d2" strokeWidth={i % 5 === 0 ? 1.2 : 0.7} opacity={0.9} />);
  }
  return (
    <div className="fxk-abs" style={{ left: cx - r, top: cy - r, width: S, height: S, touchAction: 'none' }} {...h}>
      <svg width={S} height={S} style={{ position: 'absolute', overflow: 'visible' }}>
        <defs>
          <radialGradient id={`pd${k}`} cx="50%" cy="40%" r="70%">
            <stop offset="0" stopColor="#3a3835" /><stop offset="1" stopColor="#141312" />
          </radialGradient>
          <radialGradient id={`pk${k}`} cx="45%" cy="35%" r="70%">
            <stop offset="0" stopColor="#57534d" /><stop offset="0.6" stopColor="#24221f" /><stop offset="1" stopColor="#0d0c0b" />
          </radialGradient>
        </defs>
        <circle cx={r} cy={r} r={r} fill={`url(#pd${k})`} stroke="#0b0a09" strokeWidth={1} />
        <g transform={`rotate(${rot} ${r} ${r})`}>
          {ticks}
          {labels.map((l) => {
            const a = phi(l.at);
            const [x, y] = polar(r, r, r * 0.6, a);
            return <text key={l.text + l.at} x={x} y={y} fill="#e8e2d2" fontSize={r * 0.17} fontWeight={700} textAnchor="middle" dominantBaseline="middle"
              transform={`rotate(${a} ${x} ${y})`} fontFamily="system-ui, sans-serif">{l.text}</text>;
          })}
        </g>
        {/* knob */}
        <circle cx={r} cy={r} r={r * 0.42} fill="#090807" />
        {Array.from({ length: 36 }, (_, i) => {
          const [x0, y0] = polar(r, r, r * 0.42, i * 10), [x1, y1] = polar(r, r, r * 0.36, i * 10);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#3e3b37" strokeWidth={1.4} />;
        })}
        <circle cx={r} cy={r} r={r * 0.34} fill={`url(#pk${k})`} stroke="#000" strokeWidth={0.6} />
      </svg>
      {/* fixed index */}
      <svg width={12} height={10} style={{ position: 'absolute', left: r - 6, top: -9 }}><path d="M1 0 H11 V4 L6 10 L1 4 Z" fill="#f4f1ea" stroke="#5b5850" strokeWidth={0.6} /></svg>
    </div>
  );
});

/** Small black knob with a white line (gender, stereo spread). */
export const SmallKnob = memo(function SmallKnob({ k, cx, cy, r, glow }: { k: string; cx: number; cy: number; r: number; glow?: string }) {
  const p = useParam(k);
  const h = useControl({ travel: 160, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const ang = -135 + 270 * t;
  const [x1, y1] = polar(r, r, r * 0.8, ang);
  return (
    <div className="fxk-abs" style={{ left: cx - r, top: cy - r, width: 2 * r, height: 2 * r, touchAction: 'none', borderRadius: '50%',
      boxShadow: glow ? `0 0 ${r * 0.6}px ${glow}` : undefined }} {...h}>
      <svg width={2 * r} height={2 * r} style={{ position: 'absolute' }}>
        <defs>
          <radialGradient id={`ps${k}`} cx="45%" cy="35%" r="70%">
            <stop offset="0" stopColor={glow ? '#bff7c9' : '#5a5650'} /><stop offset="0.7" stopColor={glow ? '#2e8a4a' : '#211f1c'} /><stop offset="1" stopColor={glow ? '#0d3a1c' : '#0b0a09'} />
          </radialGradient>
        </defs>
        <circle cx={r} cy={r} r={r - 0.5} fill={`url(#ps${k})`} stroke="#050505" strokeWidth={1} />
        <line x1={r} y1={r} x2={x1} y2={y1} stroke="#f0ede5" strokeWidth={1.6} strokeLinecap="round" />
      </svg>
    </div>
  );
});

/** Toggle switch (up / down) bound to a 0/256 parameter. */
export function Toggle({ k, cx, cy, hint, invert }: { k: string; cx: number; cy: number; hint?: string; invert?: boolean }) {
  const p = useParam(k);
  const on = p.value > 0;
  const up = invert ? on : !on;
  return (
    <div className="fxk-abs" style={{ left: cx - 7, top: cy - 10, width: 14, height: 20, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? p.def.min : p.def.max); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${hint ?? p.def.name}: ${p.def.format ? p.def.format(p.value).trim() : on}`)} onPointerLeave={clearHint}>
      <svg width={14} height={20}>
        <circle cx={7} cy={10} r={6} fill="#1a1816" stroke="#6d675d" strokeWidth={1} />
        <circle cx={7} cy={10} r={3.6} fill="#a8a296" />
        <line x1={7} y1={10} x2={7} y2={up ? 1.5 : 18.5} stroke="#dcd6c8" strokeWidth={2.6} strokeLinecap="round" />
        <circle cx={7} cy={up ? 2.2 : 17.8} r={1.8} fill="#f4f0e6" />
      </svg>
    </div>
  );
}

/** Round glowing push button (FORMANT, ENABLE) with an on / off look. */
export function GlowButton({ cx, cy, r, on, onClick, hint }: { cx: number; cy: number; r: number; on: boolean; onClick: () => void; hint?: string }) {
  return (
    <div className="fxk-abs" style={{
      left: cx - r, top: cy - r, width: 2 * r, height: 2 * r, borderRadius: '50%', cursor: 'default', boxSizing: 'border-box',
      border: '2px solid #2a2622',
      background: on ? 'radial-gradient(circle at 45% 40%, #ffe2a6 0%, #ff8f2e 45%, #a8400c 100%)' : 'radial-gradient(circle at 45% 40%, #c27a45 0%, #8a4a22 55%, #3e1f0d 100%)',
      boxShadow: on ? `0 0 ${r}px rgba(255,140,40,0.85)` : 'inset 0 1px 2px rgba(0,0,0,0.6)',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint} />
  );
}

/** Cream push button (MIDI / OCTAVES / HARMONIZE). */
export function CreamButton({ x, y, w, h, on, onClick, hint }: { x: number; y: number; w: number; h: number; on: boolean; onClick: () => void; hint?: string }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, boxSizing: 'border-box', borderRadius: 1.5, cursor: 'default',
      border: '1px solid #3b3832',
      background: on ? 'linear-gradient(180deg, #b9b19c, #e7dfc8 60%, #cfc6ae)' : 'linear-gradient(180deg, #fbf8f0, #e3dccb 55%, #c9c1ad)',
      boxShadow: on ? 'inset 0 1px 3px rgba(0,0,0,0.45)' : '0 1px 0 rgba(0,0,0,0.6)',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(); } }}
      onPointerEnter={() => hint && setHint(hint)} onPointerLeave={clearHint} />
  );
}

/** The GENDER meter: cream face, scale, faces at both ends and a needle showing the gender setting. */
export function GenderMeter({ x, y, w, h, value }: { x: number; y: number; w: number; h: number; value: number }) {
  const ang = value * 42;
  const cx = w / 2, cy = h * 0.95;
  const [nx, ny] = polar(cx, cy, h * 0.78, ang);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 6, overflow: 'hidden', background: '#11100f', boxShadow: 'inset 0 0 0 2px #3a362f' }}>
      <svg width={w} height={h} style={{ position: 'absolute' }}>
        <defs>
          <radialGradient id="pgm" cx="50%" cy="35%" r="75%"><stop offset="0" stopColor="#f6eed8" /><stop offset="1" stopColor="#c9bc9a" /></radialGradient>
        </defs>
        <rect x={5} y={5} width={w - 10} height={h - 18} rx={4} fill="url(#pgm)" />
        {Array.from({ length: 15 }, (_, i) => {
          const a = -42 + i * 6;
          const [x0, y0] = polar(cx, cy, h * 0.8, a), [x1, y1] = polar(cx, cy, h * (i % 7 === 0 ? 0.68 : 0.73), a);
          return <line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="#5d5341" strokeWidth={0.8} />;
        })}
        <text x={cx} y={h * 0.42} textAnchor="middle" fontSize={7.5} fontWeight={700} fill="#8f8266" fontFamily="system-ui, sans-serif">GENDER</text>
        <text x={14} y={h * 0.62} fontSize={13} fill="#4b412f" fontFamily="system-ui, sans-serif">♂</text>
        <text x={w - 24} y={h * 0.62} fontSize={13} fill="#4b412f" fontFamily="system-ui, sans-serif">♀</text>
        <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#d2401c" strokeWidth={1.3} />
      </svg>
    </div>
  );
}

/** Plain text in the retro style. */
export function Txt({ x, y, w, h = 9, children, size = 7.5, color = '#d9d2c2', align = 'center', bold = true }: {
  x: number; y: number; w: number; h?: number; children: ReactNode; size?: number; color?: string; align?: 'left' | 'center' | 'right'; bold?: boolean;
}) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, lineHeight: `${h}px`, fontSize: size, color, textAlign: align, fontWeight: bold ? 700 : 400, whiteSpace: 'nowrap', pointerEvents: 'none', letterSpacing: '0.04em' }}>{children}</div>
  );
}
