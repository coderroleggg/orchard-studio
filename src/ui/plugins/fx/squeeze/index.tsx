// Squeeze editor (FL: Fruity Squeeze, 279 x 220): SQUARIZE (steps), PUNCHER
// (preserve, impact, relation, amount), FILTER (on LED, type spinner,
// cutoff, resonance, pre / post selector), MIX and GAIN faders and the
// name plate, at FL's form coordinates in FL's flat grey skin.

import { memo, type ReactNode } from 'react';
import { useControl } from '../../../widgets/control';
import { FxPanel, useParam } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import { relatedImpact } from '../../../../engine/effects/plugins/squeeze';
import type { FxEditorModule } from '../../registry';

const PANEL = '#595a5a';
const BEVEL = '#767778';
const DARK = '#4d4e4e';
const A0 = -154;
const SWEEP = 308;

function Bevel({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: BEVEL }} />;
}

function Title({ x, y, children, size = 14 }: { x: number; y: number; children: ReactNode; size?: number }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, height: size + 2, whiteSpace: 'nowrap', pointerEvents: 'none', font: `italic ${size}px Arial, Helvetica, sans-serif`, color: '#f1f1f1', lineHeight: `${size + 2}px` }}>{children}</div>
  );
}

function Caption({ x, y, w, children }: { x: number; y: number; w: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: 10, textAlign: 'center', pointerEvents: 'none', font: '700 8.6px Arial, Helvetica, sans-serif', color: '#ffffff', lineHeight: '10px' }}>{children}</div>
  );
}

/** FL's caption plate (TQuickBtn): dark rounded plate, white bold text, the knob sits in its right end. */
function Plate({ y, children }: { y: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: 9, top: y, width: 66, height: 24, borderRadius: 4, background: DARK, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 7.5, top: 0, font: '700 9px Arial, Helvetica, sans-serif', lineHeight: '24px', color: '#ffffff', whiteSpace: 'nowrap' }}>{children}</div>
    </div>
  );
}

function pt(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** Squeeze wheel: grey cap with a thin dark rim and a white pointer from the centre outward. */
function SqKnobView({ size, t }: { size: number; t: number }) {
  const c = size / 2;
  const rb = size * 0.435;
  const ang = A0 + SWEEP * Math.min(1, Math.max(0, t));
  const [x0, y0] = pt(c, rb * 0.08, ang);
  const [x1, y1] = pt(c, rb * 0.86, ang);
  const id = `sqk${size}`;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5f6060" />
          <stop offset="0.5" stopColor="#555656" />
          <stop offset="1" stopColor="#4a4b4b" />
        </linearGradient>
      </defs>
      <circle cx={c} cy={c} r={size * 0.5} fill="#6d6e6f" />
      <circle cx={c - 0.4} cy={c + size * 0.045} r={rb + 0.8} fill="rgba(40,42,44,0.45)" />
      <circle cx={c} cy={c} r={rb} fill={`url(#${id})`} stroke="#2f373c" strokeWidth={size * 0.028} />
      <path d={`M${pt(c, rb - 0.9, -60).join(' ')} A${rb - 0.9} ${rb - 0.9} 0 0 1 ${pt(c, rb - 0.9, 60).join(' ')}`} stroke="rgba(255,255,255,0.10)" strokeWidth={0.8} fill="none" />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#ffffff" strokeWidth={Math.max(1.4, size * 0.05)} strokeLinecap="round" />
    </svg>
  );
}

const SqKnob = memo(function SqKnob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: size, height: size }} {...h}>
      <SqKnobView size={size} t={t} />
    </div>
  );
});

/** Preserve / relation also move the impact wheel when a relation is set (FL's ProcessParam does this). */
function RelatedKnob({ k, x, y }: { k: 'preserve' | 'relation'; x: number; y: number }) {
  const p = useParam(k);
  const imp = useParam('impact');
  const pres = useParam('preserve');
  const rel = useParam('relation');
  const onChange = (v: number) => {
    p.set(v);
    const r = k === 'relation' ? v : rel.value;
    const pr = k === 'preserve' ? v : pres.value;
    if (Math.round(r) !== 0) imp.set(relatedImpact(r, pr, imp.value));
  };
  const h = useControl({ travel: 200, ...p.control, onChange }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 30, height: 30 }} {...h}>
      <SqKnobView size={30} t={t} />
    </div>
  );
}

function Led({ on }: { on: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 10, height: 10, borderRadius: '50%', boxSizing: 'border-box',
      border: '1px solid #2c3032',
      background: on ? 'radial-gradient(circle at 45% 40%, #ffd0b8 0%, #ff6a3c 45%, #c8321a 100%)' : 'radial-gradient(circle at 45% 40%, #6b7072 0%, #3f4446 60%, #2f3335 100%)',
      boxShadow: on ? '0 0 3px #ff6a3c, 0 0 0 1px rgba(255,255,255,0.08)' : '0 0 0 1px rgba(255,255,255,0.08)',
    }} />
  );
}

function FilterSwitch() {
  const p = useParam('filter');
  const on = p.value >= 0.5;
  const h = useControl(p.control, 'vertical');
  return (
    <div className="fxk-abs" style={{ left: 113, top: 7, width: 71, height: 17, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); setHint(`Filter: ${on ? 'off' : 'on'}`); }}
      onContextMenu={h.onContextMenu} onPointerEnter={() => setHint(`Filter: ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <div style={{ position: 'absolute', left: 3, top: 0, font: 'italic 14px Arial, Helvetica, sans-serif', color: '#f1f1f1', lineHeight: '17px' }}>FILTER</div>
      <div style={{ position: 'absolute', left: 57, top: 3.5 }}><Led on={on} /></div>
    </div>
  );
}

/** Filter type spinner (TVectorDigiWheel): drag, wheel or click the arrows. */
function TypeSpinner() {
  const p = useParam('ftype');
  const h = useControl({ travel: 60, ...p.control }, 'vertical');
  const bump = (d: number) => { p.control.onBegin?.(); p.set(Math.min(4, Math.max(0, Math.round(p.value) + d))); p.control.onEnd?.(); };
  const text = (p.def.options?.[Math.round(p.value)] ?? '').toUpperCase();
  return (
    <div className="fxk-abs" style={{ left: 113, top: 28, width: 87, height: 22, boxSizing: 'border-box', background: '#565757', border: '1px solid #3a3d3f', boxShadow: 'inset 0 1px 0 rgba(0,0,0,0.25)' }}>
      <div {...h} style={{ position: 'absolute', left: 0, top: 0, width: 72, height: 20, textAlign: 'center', font: '12px Arial, Helvetica, sans-serif', lineHeight: '20px', color: '#ffffff', cursor: 'ns-resize', whiteSpace: 'nowrap' }}>{text}</div>
      <div style={{ position: 'absolute', left: 74, top: 2, width: 10, height: 8, cursor: 'default' }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); bump(1); } }}>
        <svg width={10} height={8}><path d="M5 2 L8 6 L2 6 Z" fill="#a9aaab" /></svg>
      </div>
      <div style={{ position: 'absolute', left: 74, top: 10, width: 10, height: 8, cursor: 'default' }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); bump(-1); } }}>
        <svg width={10} height={8}><path d="M5 6 L8 2 L2 2 Z" fill="#a9aaab" /></svg>
      </div>
    </div>
  );
}

/** PRE / POS selector (TPaintBoxSelector) with LED buttons. */
function PosSelector() {
  const p = useParam('fpos');
  const v = p.value >= 0.5 ? 1 : 0;
  const h = useControl(p.control, 'vertical');
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); setHint(`Filter Position: ${i ? 'pos' : 'pre'}`); };
  const item = (i: number, label: string, x: number) => (
    <div style={{ position: 'absolute', left: x, top: 0, width: 40, height: 27, display: 'flex', alignItems: 'center', gap: 5, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pick(i); } }}>
      <Led on={v === i} />
      <span style={{ font: '700 9px Arial, Helvetica, sans-serif', color: '#ffffff' }}>{label}</span>
    </div>
  );
  return (
    <div className="fxk-abs" style={{ left: 113, top: 131, width: 87, height: 27, borderRadius: 4, background: '#58595a' }}
      onContextMenu={h.onContextMenu} onPointerEnter={() => setHint(`Filter Position: ${v ? 'pos' : 'pre'}`)} onPointerLeave={clearHint}>
      {item(0, 'PRE', 5.5)}
      {item(1, 'POS', 49)}
    </div>
  );
}

/** FL's vertical fader: dark rounded track with tick marks, white fill below a silver cap. */
const Fader = memo(function Fader({ k, x }: { k: string; x: number }) {
  const p = useParam(k);
  const H = 138, CAP = 25.5;
  const h = useControl({ travel: H - CAP, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const capY = 10 + (1 - t) * (H - CAP);
  const cx = 11;
  return (
    <div className="fxk-abs" style={{ left: x, top: 10, width: 22, height: H, cursor: 'default' }} {...h}>
      <svg width={22} height={H} style={{ display: 'block', overflow: 'visible' }}>
        <rect x={0.5} y={0} width={21} height={H} rx={4} fill="#5a5a5a" />
        {Array.from({ length: 9 }, (_, i) => 16.7 + i * 13.33).map((yy, i) => (
          <g key={i} fill="#838383">
            <rect x={2.5} y={yy} width={6} height={0.7} />
            <rect x={13.4} y={yy} width={6} height={0.7} />
          </g>
        ))}
        <rect x={cx - 0.35} y={8} width={0.7} height={Math.max(0, capY - 10 - 8)} fill="#848484" />
        <rect x={cx - 0.65} y={capY - 10 + CAP} width={1.3} height={Math.max(0, H - 13 - (capY - 10 + CAP))} fill="#ffffff" />
        <g transform={`translate(0 ${capY - 10})`}>
          <rect x={4} y={CAP - 1} width={14} height={4.2} fill="rgba(0,0,0,0.32)" />
          <defs>
            <linearGradient id={`sqcap-${k}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="#c7cad3" />
              <stop offset="0.08" stopColor="#a8abb4" />
              <stop offset="0.42" stopColor="#dfe2eb" />
              <stop offset="0.49" stopColor="#b4b7c0" />
              <stop offset="0.5" stopColor="#323336" />
              <stop offset="0.53" stopColor="#323336" />
              <stop offset="0.55" stopColor="#979aa3" />
              <stop offset="0.68" stopColor="#40434c" />
              <stop offset="1" stopColor="#a3a6af" />
            </linearGradient>
          </defs>
          <rect x={3.9} y={0} width={14.2} height={CAP} fill={`url(#sqcap-${k})`} stroke="#54565d" strokeWidth={0.5} />
        </g>
      </svg>
    </div>
  );
});

/** Our own small badge for the name plate (FL shows its juicer artwork here). */
function Badge() {
  return (
    <svg className="fxk-abs" width={39} height={40} style={{ left: 222, top: 172, pointerEvents: 'none' }}>
      <circle cx={19.5} cy={21} r={13} fill="#c9d64a" stroke="#8e9a2a" strokeWidth={1.2} />
      <circle cx={19.5} cy={21} r={10.2} fill="#e6ee8a" />
      {[0, 60, 120, 180, 240, 300].map((a) => {
        const r = (a * Math.PI) / 180;
        return <line key={a} x1={19.5} y1={21} x2={19.5 + 9.6 * Math.sin(r)} y2={21 - 9.6 * Math.cos(r)} stroke="#c9d64a" strokeWidth={1.1} />;
      })}
      <circle cx={19.5} cy={21} r={1.6} fill="#c9d64a" />
    </svg>
  );
}

function SqueezeEditor() {
  return (
    <FxPanel width={279} height={220} style={{ background: PANEL }}>
      <Bevel x={5} y={5} w={98} h={50} />
      <Bevel x={5} y={60} w={98} h={155} />
      <Bevel x={108} y={5} w={98} h={159} />
      <Bevel x={108} y={169} w={165} h={46} />
      <Bevel x={211} y={5} w={62} h={159} />
      <Title x={10} y={6.5}>SQUARIZE</Title>
      <Plate y={26}>AMOUNT</Plate>
      <SqKnob k="steps" x={69} y={23} size={30} />
      <Title x={10} y={61.5}>PUNCHER</Title>
      <Plate y={87}>PRESERVE</Plate>
      <RelatedKnob k="preserve" x={69} y={84} />
      <Plate y={120}>IMPACT</Plate>
      <SqKnob k="impact" x={69} y={117} size={30} />
      <Plate y={153}>RELATION</Plate>
      <RelatedKnob k="relation" x={69} y={150} />
      <Plate y={186}>AMOUNT</Plate>
      <SqKnob k="amount" x={69} y={183} size={30} />
      <FilterSwitch />
      <TypeSpinner />
      <Caption x={116} y={67.5} w={37}>FREQ.</Caption>
      <Caption x={163} y={67.5} w={34}>RES.</Caption>
      <SqKnob k="cutoff" x={113} y={81} size={40} />
      <SqKnob k="res" x={160} y={81} size={40} />
      <PosSelector />
      <Fader k="mix" x={216} />
      <Fader k="gain" x={245} />
      <Caption x={211} y={151.5} w={31}>MIX</Caption>
      <Caption x={242} y={151.5} w={30}>GAIN</Caption>
      <Title x={114} y={180.5} size={18}>SQUEEZE</Title>
      <Badge />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'squeeze', Editor: SqueezeEditor };
