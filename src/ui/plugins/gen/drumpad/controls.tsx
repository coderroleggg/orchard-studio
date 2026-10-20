// Drumpad's controls (FL: Drumpad_x64.dylib TSynthEditorForm), shared by the
// Drumpad editor and Drumaxx's selected-pad section (Drumaxx_x64.dylib places the
// same controls 16 px left and 255 px down): FL's two TVectorWheel styles, the
// Mallet retrig check box, the MID Retrig selector, the four velocity target
// combos and the orange section outlines. Original drawing, no Image-Line artwork.

import { createContext, useContext, type CSSProperties } from 'react';
import { Label, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { DP_KEYS, DP_TARGETS } from '../../../../model/gen/plugins/drumpad';

export const DP_C = {
  panel: '#3b3836', top: '#252423', band: '#2d2c2b', orange: '#d2782f', head: '#2a1d12', label: '#c9c6c2', dim: '#8d8984',
  smallCap: '#626465', smallFill: '#e8ac13', bigCap: '#d5d5d5', bigFill: '#1d6e94',
  padCap: '#9ea0a0', padFill: '#c1c1c1',
  combo: '#171717', comboText: '#d3d3b5', led: '#272c2e', ledText: '#b9bec3',
};

export const abs = (x: number, y: number, w: number, h: number, extra?: CSSProperties): CSSProperties => ({ position: 'absolute', left: x, top: y, width: w, height: h, ...extra });

/** Where the Drumpad controls sit and which parameters they edit (Drumpad index -> key). */
interface DpLayout { key: (i: number) => string; dx: number; dy: number }
const Layout = createContext<DpLayout>({ key: (i) => DP_KEYS[i], dx: 0, dy: 0 });

export type KnobLook = 'small' | 'big' | 'pad';

/** FL's TVectorWheel in Drumpad's styles: small (dark cap, orange pointer), big (light cap, blue pointer), Drumaxx's pad wheels. */
export function DpKnob({ k, x, y, size, look = 'small' }: { k: string; x: number; y: number; size: number; look?: KnobLook }) {
  const p = useParam(k);
  const h = useControl({ travel: 180, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  const a = ((225 - 270 * t) * Math.PI) / 180;
  const big = look !== 'small';
  const c = size / 2, rc = c * (big ? 0.78 : 0.72);
  const px = (r: number) => c + Math.cos(a) * r, py = (r: number) => c - Math.sin(a) * r;
  const cap = look === 'big' ? DP_C.bigCap : look === 'pad' ? DP_C.padCap : DP_C.smallCap;
  const fill = look === 'big' ? DP_C.bigFill : look === 'pad' ? '#2a2a2a' : DP_C.smallFill;
  return (
    <div className="fxk-abs fxk-wheel" style={abs(x, y, size, size, { cursor: 'ns-resize' })} {...h}>
      <svg width={size} height={size} style={{ display: 'block', overflow: 'visible' }}>
        {p.def.bipolar && <circle cx={c} cy={-1.5} r={1} fill={DP_C.dim} />}
        <circle cx={c} cy={c + 1} r={c - 0.5} fill="rgba(0,0,0,0.45)" />
        <circle cx={c} cy={c} r={c - 1.5} fill={look === 'pad' ? '#0f0f0f' : big ? '#4a4a4a' : '#2b2b2b'} stroke="#1a1a1a" strokeWidth={1} />
        <circle cx={c} cy={c} r={rc} fill={cap} stroke={look === 'small' ? '#777a7c' : '#f2f2f2'} strokeWidth={0.8} />
        {big && <circle cx={c} cy={c} r={rc * 0.62} fill="none" stroke="rgba(0,0,0,0.10)" strokeWidth={1} />}
        {look === 'pad' && <circle cx={px(c - 2.2)} cy={py(c - 2.2)} r={1.6} fill={DP_C.padFill} />}
        <line x1={px(big ? rc * 0.25 : rc * 0.15)} y1={py(big ? rc * 0.25 : rc * 0.15)} x2={px(rc * 0.95)} y2={py(rc * 0.95)}
          stroke={fill} strokeWidth={big ? 3.2 : 2.4} strokeLinecap="round" />
      </svg>
    </div>
  );
}

/** A Drumpad knob at its Drumpad form position (Drumpad index i). */
function Knob({ i, x, y, size, big }: { i: number; x: number; y: number; size: number; big?: boolean }) {
  const l = useContext(Layout);
  return <DpKnob k={l.key(i)} x={x + l.dx} y={y + l.dy} size={size} look={big ? 'big' : 'small'} />;
}

/** A section: FL's orange outline with its header tab. */
function Section({ x, y = 44, w, h = 161, title, path }: { x: number; y?: number; w: number; h?: number; title: string; path?: string }) {
  const { dx, dy } = useContext(Layout);
  return (
    <>
      {path
        ? <svg className="fxk-abs" style={abs(dx, dy, 794, 225, { pointerEvents: 'none' })}><path d={path} fill="none" stroke={DP_C.orange} strokeWidth={1.5} /></svg>
        : <div className="fxk-abs" style={abs(x + dx, y + dy, w, h, { border: `1.5px solid ${DP_C.orange}`, borderRadius: 3, boxSizing: 'border-box', pointerEvents: 'none' })} />}
      <div className="fxk-abs" style={abs(x + dx, y + dy, w, 13, { background: DP_C.orange, borderRadius: '3px 3px 0 0', color: DP_C.head, textAlign: 'center',
        font: 'bold 8.5px/13px var(--fxk-font, sans-serif)', letterSpacing: 0.6, pointerEvents: 'none' })}>{title}</div>
    </>
  );
}

/** A caption under a knob (one or two lines), centred on cx. */
export function Cap({ cx, y, children, color = DP_C.label }: { cx: number; y: number; children: string; color?: string }) {
  const { dx, dy } = useContext(Layout);
  const lines = children.split('\n');
  return <>{lines.map((s, j) => <Label key={j} x={cx - 30 + dx} y={y + j * 7 + dy} w={60} h={8} size={6.5} bold color={color}>{s}</Label>)}</>;
}

/** Mallet retrig (FL: TVectorCheckBox, VCS_Maxx style). */
function RetrigCheck() {
  const l = useContext(Layout);
  const p = useParam(l.key(0));
  const on = p.value >= 128;
  return (
    <div className="fxk-abs" style={abs(102 + l.dx, 164 + l.dy, 24, 24, { cursor: 'pointer' })}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 256); p.control.onEnd?.(); }}
      onPointerEnter={() => setHint(`Mallet retrig: ${on ? 'On' : 'Off'}`)} onPointerLeave={clearHint}>
      <div style={abs(4, 4, 16, 16, { background: '#1c1c1c', border: '1px solid #555', borderRadius: 2, boxSizing: 'border-box' })} />
      <div style={abs(8, 8, 8, 8, { background: on ? DP_C.smallFill : '#3d3d3d', borderRadius: 1, boxShadow: on ? `0 0 4px ${DP_C.smallFill}` : 'none' })} />
    </div>
  );
}

/** MID Retrig (FL: TPaintBoxSelector, 1 x 4 cells: 0, I, II, III). */
function RetrigSelector() {
  const l = useContext(Layout);
  const p = useParam(l.key(1));
  const cur = Math.min(3, Math.trunc((Math.round(p.value) * 3) / 256));
  const vals = [0, 86, 171, 256];
  return (
    <>
      {['0', 'I', 'II', 'III'].map((s, k) => (
        <div key={k}>
          <div className="fxk-abs" style={abs(469 + l.dx, 124 + k * 16.5 + l.dy, 15, 14, { background: DP_C.led, border: '1px solid #151718', borderRadius: 2, boxSizing: 'border-box', cursor: 'pointer' })}
            onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(vals[k]); p.control.onEnd?.(); }}
            onPointerEnter={() => setHint(`Retrig: ${s}`)} onPointerLeave={clearHint}>
            <div style={abs(4, 3.5, 5, 5, { background: k === cur ? '#ffb43a' : '#3a3f41', borderRadius: 1, boxShadow: k === cur ? '0 0 4px #ffb43a' : 'none' })} />
          </div>
          <Label x={489 + l.dx} y={126 + k * 16.5 + l.dy} w={14} h={9} size={6.5} bold color={DP_C.ledText} align="left">{s}</Label>
        </div>
      ))}
    </>
  );
}

/** A velocity modulation target (FL: TQuickCombo, FS_DigiWheel style). */
function Target({ n, y }: { n: number; y: number }) {
  const l = useContext(Layout);
  const p = useParam(l.key(30 + n));
  const v = Math.round(p.value);
  const pick = (k: number) => { p.control.onBegin?.(); p.set(k); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={abs(625 + l.dx, y + l.dy, 88, 20, { background: DP_C.combo, borderRadius: 2, color: DP_C.comboText, textAlign: 'center',
      font: '9px/20px Arial, sans-serif', overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'pointer' })}
      onPointerDown={(e) => {
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, DP_TARGETS.map((s, k): MenuItem => ({ label: k === 0 ? 'none' : s, radio: true, checked: k === v, onClick: () => pick(k) })));
      }}
      onWheel={(e) => { e.stopPropagation(); pick(Math.max(0, Math.min(28, v + (e.deltaY > 0 ? 1 : -1)))); }}
      onPointerEnter={() => setHint(`Velocity mod ${n + 1} source: ${v === 0 ? 'none' : DP_TARGETS[v]}`)} onPointerLeave={clearHint}>
      {v === 0 ? 'none' : DP_TARGETS[v]}
    </div>
  );
}

/**
 * Drumpad's sections and controls at Drumpad form coordinates moved by (dx, dy),
 * editing the parameters key(i) (Drumpad index i).
 */
export function DrumpadControls({ keyOf = (i: number) => DP_KEYS[i], dx = 0, dy = 0 }: { keyOf?: (i: number) => string; dx?: number; dy?: number }) {
  // MEMBRANE's outline steps out under LOW for the Shape knob (FL's panel)
  const membrane = 'M142.75 205.25 V47 Q142.75 44.75 145 44.75 H255.5 Q257.75 44.75 257.75 47 V155.25 H306.5 Q308.75 155.25 308.75 157.5 V202.75 Q308.75 205.25 306.5 205.25 Z';
  return (
    <Layout.Provider value={{ key: keyOf, dx, dy }}>
      <Section x={35} w={104} title="MALLET" />
      <div className="fxk-abs" style={abs(89 + dx, 105 + dy, 49, 100, { borderLeft: '1px solid #6b5642', borderTop: '1px solid #6b5642', borderRadius: '3px 0 0 0', pointerEvents: 'none' })} />
      <Label x={81 + dx} y={124 + dy} w={6} h={9} size={7} color={DP_C.dim}>‹</Label>
      <Section x={142} w={116} title="MEMBRANE" path={membrane} />
      <Section x={262} w={47} h={107} title="LOW" />
      <Section x={315} w={47} title="SOF" />
      <Section x={366} w={137} title="MIDDLE" />
      <div className="fxk-abs" style={abs(416 + dx, 62 + dy, 1, 138, { background: '#5a4a3a', pointerEvents: 'none' })} />
      <Label x={358 + dx} y={124 + dy} w={6} h={9} size={7} color={DP_C.dim}>‹</Label>
      <Section x={507} w={47} title="HIGH" />
      <Label x={560 + dx} y={45 + dy} w={48} h={12} size={8.5} bold color={DP_C.orange} style={{ letterSpacing: 0.6 }}>OUTPUT</Label>
      <Section x={615} w={146} title="VELOCITY" />

      <Knob i={2} x={47} y={63} size={30} /><Cap cx={62} y={96}>AMPLITUDE</Cap>
      <Knob i={3} x={99} y={63} size={30} /><Cap cx={114} y={96}>DECAY</Cap>
      <Knob i={4} x={47} y={113} size={30} /><Cap cx={62} y={146}>{'NOISE\nLEVEL'}</Cap>
      <Knob i={5} x={99} y={113} size={30} /><Cap cx={114} y={146}>{'NOISE\nPHASE'}</Cap>
      <RetrigCheck /><Cap cx={114} y={194}>RETRIG</Cap>

      <Knob i={6} x={159} y={61} size={32} big /><Cap cx={175} y={96}>DECAY</Cap>
      <Knob i={7} x={214} y={61} size={32} big /><Cap cx={230} y={96}>CUTOFF</Cap>
      <Knob i={8} x={159} y={110} size={32} big /><Cap cx={175} y={146}>TENSION</Cap>
      <Knob i={9} x={214} y={111} size={32} big /><Cap cx={230} y={146}>PHASE</Cap>
      <Knob i={10} x={159} y={162} size={32} big /><Cap cx={175} y={196}>MATERIAL</Cap>
      <Knob i={11} x={214} y={162} size={32} big /><Cap cx={230} y={196}>SIZE</Cap>
      <Knob i={12} x={271} y={162} size={32} big /><Cap cx={287} y={196}>SHAPE</Cap>

      <Knob i={13} x={272} y={63} size={30} /><Cap cx={287} y={96}>FREQ</Cap>
      <Knob i={14} x={272} y={113} size={30} /><Cap cx={287} y={146}>RESO</Cap>

      <Knob i={15} x={324} y={63} size={30} /><Cap cx={339} y={96}>FREQ</Cap>
      <Knob i={16} x={324} y={113} size={30} /><Cap cx={339} y={146}>DECAY</Cap>
      <Knob i={17} x={324} y={164} size={30} /><Cap cx={339} y={196}>LEVEL</Cap>

      <Knob i={18} x={376} y={63} size={30} /><Cap cx={391} y={96}>FREQ</Cap>
      <Knob i={19} x={376} y={113} size={30} /><Cap cx={391} y={146}>LEVEL</Cap>
      <Knob i={20} x={376} y={164} size={30} /><Cap cx={391} y={196}>RESO</Cap>
      <Knob i={21} x={427} y={63} size={30} /><Cap cx={442} y={94}>{'EQ\nFREQ'}</Cap>
      <Knob i={22} x={427} y={113} size={30} /><Cap cx={442} y={144}>{'EQ\nLEVEL'}</Cap>
      <Knob i={23} x={427} y={164} size={30} /><Cap cx={442} y={196}>DECAY</Cap>
      <RetrigSelector /><Cap cx={477} y={196}>RETRIG</Cap>

      <Knob i={24} x={516} y={63} size={30} /><Cap cx={531} y={96}>FREQ</Cap>
      <Knob i={25} x={516} y={113} size={30} /><Cap cx={531} y={146}>LEVEL</Cap>
      <Knob i={26} x={516} y={164} size={30} /><Cap cx={531} y={196}>RESO</Cap>

      <Knob i={28} x={570} y={61} size={32} big /><Cap cx={586} y={96}>HOLD</Cap>
      <Knob i={27} x={570} y={111} size={32} big /><Cap cx={586} y={146}>LO FI</Cap>
      <Knob i={29} x={571} y={162} size={32} big /><Cap cx={587} y={196}>PITCH</Cap>

      <Target n={0} y={68} /><Target n={1} y={102} /><Target n={2} y={136} /><Target n={3} y={170} />
      <Knob i={34} x={721} y={64} size={28} /><Knob i={35} x={721} y={98} size={28} />
      <Knob i={36} x={721} y={132} size={28} /><Knob i={37} x={721} y={166} size={28} />
      <Cap cx={669} y={196}>PARAMETER</Cap><Cap cx={735} y={196}>VALUE</Cap>
    </Layout.Provider>
  );
}
