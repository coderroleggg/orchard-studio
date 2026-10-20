// Widgets of the Parametric EQ editor, drawn after FL's screenshots: the
// brushed metal wheel, the level slider with its gunmetal cap and red level
// line, and the green filter type spinner with FL's type icons.

import { memo, type ReactNode } from 'react';
import { useControl, automationMenuItems, autoTargetOf, type ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useParam } from '../../kit';

type Box = { x: number; y: number; w: number; h: number };

const SWEEP_START = -150;
const SWEEP = 300;

/** FL's brushed metal vector wheel (static conic sheen, white pointer). */
export function MetalKnobView({ w, h, t, disabled }: { w: number; h: number; t: number; disabled?: boolean }) {
  const D = Math.min(w, h);
  const R = D / 2 - 0.5;
  const cx = w / 2, cy = h / 2;
  const ang = SWEEP_START + SWEEP * Math.min(1, Math.max(0, t));
  const rad = ((ang - 90) * Math.PI) / 180;
  const p0 = 0.16 * R, p1 = 0.64 * R;
  const ring = (r: number, extra: object) => ({
    position: 'absolute' as const, left: cx - r, top: cy - r, width: 2 * r, height: 2 * r, borderRadius: '50%', ...extra,
  });
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: disabled ? 0.5 : 1 }}>
      <div style={ring(R + 0.6, { top: cy - R + 1.4, background: 'rgba(10,14,16,0.35)', filter: 'blur(0.8px)' })} />
      <div style={ring(R, { background: 'linear-gradient(180deg, #252e33, #13191c)' })} />
      <div style={ring(R * 0.93, {
        background: 'repeating-conic-gradient(#9da8ae 0deg, #7a858b 14deg, #6e787e 30deg, #7a858b 46deg, #9da8ae 60deg)',
      })} />
      <div style={ring(R * 0.785, {
        background: 'conic-gradient(#3b4448 0deg, #3c4549 18deg, #6c777c 58deg, #6f7a80 90deg, #6c777c 122deg, #3c4549 162deg, #393f43 180deg, #3c4549 198deg, #68737a 238deg, #6b767c 270deg, #66717a 302deg, #3c4549 342deg, #3b4448 360deg)',
        boxShadow: 'inset 0 0 0 0.6px rgba(20,28,32,0.6)',
      })} />
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <line x1={cx + p0 * Math.cos(rad)} y1={cy + p0 * Math.sin(rad)} x2={cx + p1 * Math.cos(rad)} y2={cy + p1 * Math.sin(rad)}
          stroke="#ffffff" strokeWidth={Math.max(1.6, R * 0.15)} strokeLinecap="round" />
      </svg>
    </div>
  );
}

export const MetalKnob = memo(function MetalKnob({ k, x, y, w, h, control: over }: Box & { k: string; control?: Partial<ControlProps> }) {
  const p = useParam(k, over);
  const hnd = useControl({ travel: 200, ...p.control }, 'vertical');
  const min = p.control.min ?? 0, max = p.control.max ?? 1;
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: w, height: h }} {...hnd}>
      <MetalKnobView w={w} h={h} t={(p.value - min) / (max - min || 1)} disabled={p.control.disabled} />
    </div>
  );
});

/** Cap size of the level slider (editor pixels). */
const CAP_W = 17, CAP_H = 14;

/**
 * Level slider (TVectorSlider, vertical): tick marks on both sides, a thin
 * groove, a red line from 0 dB to the cap and FL's dark metal cap.
 */
export const LevelSlider = memo(function LevelSlider({ k, x, y, w, h, hidden }: Box & { k: string; hidden?: boolean }) {
  const p = useParam(k);
  const hnd = useControl({ travel: h - CAP_H, ...p.control }, 'vertical');
  if (hidden) return null;
  const min = p.def.min, max = p.def.max;
  const t = Math.min(1, Math.max(0, (p.value - min) / (max - min || 1)));
  const travel = h - CAP_H;
  const capTop = (1 - t) * travel;
  const mid = travel / 2 + CAP_H / 2, capMid = capTop + CAP_H / 2;
  const cx = w / 2;
  const ticks: ReactNode[] = [];
  const N = 21;
  for (let i = 0; i < N; i++) {
    const yy = Math.round(CAP_H / 2 + (i * travel) / (N - 1)) + 0.5;
    const long = i === (N - 1) / 2;
    ticks.push(<line key={'l' + i} x1={cx - (long ? 9 : 8)} x2={cx - 3.5} y1={yy} y2={yy} />);
    ticks.push(<line key={'r' + i} x1={cx + 3.5} x2={cx + (long ? 9 : 8)} y1={yy} y2={yy} />);
  }
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, cursor: 'default', touchAction: 'none' }} {...hnd}>
      <svg width={w} height={h} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }}>
        <g stroke="#2a3439" strokeWidth={0.75} opacity={0.8}>{ticks}</g>
        <rect x={cx - 1.4} y={CAP_H / 2 - 1} width={2.8} height={travel + 2} rx={1} fill="#4a555c" />
        <rect x={cx - 0.75} y={CAP_H / 2 - 0.5} width={1.5} height={travel + 1} fill="#1e282d" />
        {Math.abs(capMid - mid) > 0.5 && <rect x={cx - 0.9} y={Math.min(mid, capMid)} width={1.8} height={Math.abs(capMid - mid)} fill="#ff1c1c" />}
      </svg>
      <div style={{ position: 'absolute', left: (w - CAP_W) / 2, top: capTop + 3, width: CAP_W, height: CAP_H, borderRadius: '0 0 3px 3px', background: 'rgba(14,20,23,0.38)', filter: 'blur(1.2px)' }} />
      <div style={{ position: 'absolute', left: (w - CAP_W) / 2 - 1, top: capTop + CAP_H / 2 - 1.5, width: CAP_W + 2, height: 3, background: 'rgba(16,22,25,0.7)' }} />
      <div style={{
        position: 'absolute', left: (w - CAP_W) / 2, top: capTop, width: CAP_W, height: CAP_H,
        background: 'linear-gradient(180deg, #66727a 0%, #4e595f 10%, #353d41 20%, #424b50 30%, #4a545a 42%, #3d464b 56%, #262d31 70%, #171d20 100%)',
        boxShadow: 'inset 1px 0 0 rgba(255,255,255,0.05), inset -1px 0 0 rgba(0,0,0,0.25)',
      }}>
        <div style={{ position: 'absolute', left: 0, right: 0, top: CAP_H / 2 - 0.5, height: 1, background: '#ff2418' }} />
      </div>
    </div>
  );
});

/** FL's band type glyphs, drawn in a 23 x 16 box. */
export function typeIcon(type: number): string {
  switch (type) {
    case 1: return 'M4.6 5.2 H10.8 Q14 5.2 15.2 8 Q16.4 11.4 18.4 13.6';
    case 2: return 'M4.8 13.4 Q8.4 13.2 10 8.2 Q11.5 3.4 13 8.2 Q14.6 13.2 18.2 13.4';
    case 3: return 'M4.6 13.6 Q6.6 11.4 7.8 8 Q9 5.2 12.2 5.2 H18.4';
    case 4: return 'M4.4 5.2 H9.3 Q10.9 5.2 11.2 9.2 Q11.5 13.6 11.8 9.2 Q12.1 5.2 13.7 5.2 H18.6';
    case 5: return 'M5.6 1.3 Q5.6 7.8 12.5 7.8 H16.9 M5.6 14.4 Q5.6 7.8 12.5 7.8';
    case 6: return 'M11.3 0.9 V4.1 M11.3 11.9 V15 M4.7 8 H7.8 M14.7 8 H17.8 M11.3 4.1 Q11.9 7.3 14.7 8 Q11.9 8.7 11.3 11.9 Q10.7 8.7 7.8 8 Q10.7 7.3 11.3 4.1';
    case 7: return 'M17.4 1.3 Q17.4 7.8 10.5 7.8 H6.1 M17.4 14.4 Q17.4 7.8 10.5 7.8';
    default: return 'M8.5 8 H14.5';
  }
}

/** Band type spinner (TVectorDigiWheel showing the type glyph): drag, wheel or right-click. */
export const TypeSpinner = memo(function TypeSpinner({ k, x, y, w, h }: Box & { k: string }) {
  const p = useParam(k);
  const hnd = useControl({ travel: 70, ...p.control }, 'vertical');
  const opts = p.def.options ?? [];
  const v = Math.round(p.value);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  const target = autoTargetOf(p.control);
  return (
    <div className="fxk-abs" {...hnd}
      onPointerEnter={() => setHint(`${p.def.name}: ${opts[v] ?? v}`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault(); e.stopPropagation();
        openMenu(e.clientX, e.clientY, [
          ...opts.map((o, i) => ({ label: o, checked: i === v, radio: true, onClick: () => pick(i) } as MenuItem)),
          ...(target ? automationMenuItems(target, e.clientX, e.clientY) : []),
        ]);
      }}
      style={{ left: x, top: y, width: w, height: h, boxSizing: 'border-box', border: '1px solid #050a0c', background: 'linear-gradient(180deg, #3b4f39, #42583f)', cursor: 'ns-resize', touchAction: 'none' }}>
      <svg width={w - 2} height={h - 2} viewBox={`1 1 ${w - 2} ${h - 2}`} style={{ display: 'block' }}>
        <path d={typeIcon(v)} fill="none" stroke="#c1ffc0" strokeWidth={1.15} strokeLinecap="butt" strokeLinejoin="round" />
      </svg>
    </div>
  );
});
