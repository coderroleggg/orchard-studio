// Harmor's part page (y 0..330): every control of the displayed part at FL's
// form position, the timbre scopes and the part page's special switches.

import { memo, useMemo } from 'react';
import type { HEnv, HPart } from '../../../../model/gen/plugins/harmor/types';
import { setHint, clearHint } from '../../../hint';
import { openMenu } from '../../../widgets/ContextMenu';
import { FORM } from './form';
import { HCtl, useCtlProps } from './Ctl';
import { points, valueAt } from './curve';
import { useHarmor, setView, editGlobal } from './use';
import { HButton, commit } from './widgets';

const PART_CONTROLS = [
  'TPhaseWheel', 'TPhaseRandWheel', 'HMMixWheel', 'HarmBlendSelect',
  'Sub1Slider', 'Sub3Slider', 'Sub4Slider', 'SafetyVolSlider', 'HarmClipVolSlider',
  'PartFXMixSlider', 'PartVolSlider', 'PartVolEnvSlider', 'AutoGainWheel',
  'VelToAttTimeBox', 'VelToAttLengthBox', 'VelToRelLengthBox',
  'BlurMixWheel', 'TimeBlurAttWheel', 'TimeBlurDecWheel', 'HarmBlurAmtWheel', 'HarmBlurRTnsWheel', 'HarmBlurLTnsWheel',
  'TremAmtWheel', 'TremTimeWheel', 'TremGapWheel',
  'TGrittinessWheel', 'GrittyModeBox',
  'SFXMixWheel', 'SFXWidthWheel', 'SFXStrengthWheel', 'SFXPat1Wheel', 'SFXPat2Wheel', 'SFXPat3Wheel', 'SFXPat4Wheel',
  'FatOrderSelect', 'FatTypeSelect', 'FatInvBox', 'FatPanWheel', 'FatPitchWheel', 'FatPhaseWheel',
  'HarmPitchModeSelect', 'PartPitchMulSelect', 'PartPitchDivSelect', 'DetuningMulSelect', 'DetuningDivSelect',
  'PitchEnvAmtWheel', 'VibratoAmtWheel', 'VibratoTimeWheel', 'PortaCurveBox', 'PortaVarTimeBox', 'PortaTimeWheel', 'PortaLimitWheel',
  'F1EnvAltBox', 'F1HzSlopeSelect', 'F1TypeSelect', 'F1ResTypeSelect', 'F1ResHzSlopeSelect',
  'F1EnvAmtWheel', 'F1KbTrackWheel', 'F1WidthWheel', 'F1CutWheel', 'F1ResWheel', 'F1ResWidthWheel', 'F1ResAWidthBox', 'F1OscWheel',
  'FilterTypeMixWheel',
  'F2EnvAltBox', 'F2HzSlopeSelect', 'F2TypeSelect', 'F2ResTypeSelect', 'F2ResHzSlopeSelect',
  'F2EnvAmtWheel', 'F2KbTrackWheel', 'F2WidthWheel', 'F2CutWheel', 'F2ResWheel', 'F2ResWidthWheel', 'F2ResAWidthBox',
  'PluckDecWheel', 'PluckToBlurBox',
  'PMixWheel', 'PWidthWheel', 'POfsWheel', 'PhaserTypeSelect', 'PHzSlopeSelect', 'PMotionSpeedWheel', 'PKbTrackWheel',
  'GlobalEQMixWheel',
] as const;

/** Every FL component the part page shows (tests check their bindings). */
export const PART_PAGE_CONTROLS: readonly string[] = [...PART_CONTROLS, 'SubVolModeSelect', 'HarmClipModeSelect', 'GrittyFromVolSelect', 'F1ResCutOfsWheel', 'F2ResCutOfsWheel'];

// ------------------------------------------------------------------ scopes

/** Gain of a harmonic level map value (0.25 = the natural 1/h level of a saw). */
function levelGain(y: number): number {
  return y <= 0 ? 0 : Math.pow(y / 0.25, 1.5);
}

/** One cycle of a timbre from its harmonic level map (x = (partial - 1) / 515) and the harmonic phase map. */
export function timbreCycle(level: HEnv | undefined, phase: HEnv | undefined, n = 96, harmonics = 64): Float32Array {
  const out = new Float32Array(n);
  if (!level) return out;
  const lp = points(level), pp = phase ? points(phase) : null;
  const amp = new Float32Array(harmonics + 1), ph = new Float32Array(harmonics + 1);
  for (let h = 1; h <= harmonics; h++) {
    const x = (h - 1) / 515;
    amp[h] = levelGain(valueAt(lp, x)) / h;
    ph[h] = pp ? (valueAt(pp, x) - 0.5) * 2 * Math.PI : 0;
  }
  let peak = 1e-9;
  for (let i = 0; i < n; i++) {
    const th = (2 * Math.PI * i) / n;
    let s = 0;
    for (let h = 1; h <= harmonics; h++) if (amp[h]) s += amp[h] * Math.sin(h * th + ph[h]);
    out[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  for (let i = 0; i < n; i++) out[i] /= peak;
  return out;
}

/** THQWAVScope: one cycle of a timbre (black back, grey centre line, light trace), memoised on the curves. */
const Scope = memo(function Scope({ n, level, phase, title }: { n: string; level: HEnv | undefined; phase: HEnv | undefined; title: string }) {
  const c = FORM[n];
  const cyc = useMemo(() => timbreCycle(level, phase), [level, phase]);
  const w = c.w, h = c.h;
  let d = '';
  for (let i = 0; i <= cyc.length; i++) {
    const v = cyc[i % cyc.length];
    const x = (i / cyc.length) * (w - 4) + 2;
    const y = h / 2 - v * (h / 2 - 4);
    d += (i ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
  }
  return (
    <div className="hm-ctl hm-scope" style={{ left: c.x, top: c.y, width: w, height: h }}
      onPointerEnter={() => setHint(`${title} - right-click for options`)} onPointerLeave={clearHint}
      onContextMenu={(e) => {
        e.preventDefault();
        openMenu(e.clientX, e.clientY, [
          { label: 'Analyze single-cycle waveform...', disabled: true },
          { label: 'Randomize', disabled: true },
        ]);
      }}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <defs>
          <linearGradient id={`hsc${n}`} x1="0" y1="0" x2="0.4" y2="1">
            <stop offset="0" stopColor="#3b4c55" />
            <stop offset="1" stopColor="#1c252b" />
          </linearGradient>
        </defs>
        <rect x={0} y={0} width={w} height={h} fill={`url(#hsc${n})`} />
        <line x1={2} y1={h / 2} x2={w - 2} y2={h / 2} stroke="#808080" strokeOpacity={0.45} strokeWidth={1} />
        <path d={d} fill="none" stroke={c.line ?? '#dee9ef'} strokeWidth={1.2} strokeLinejoin="round" />
        <rect x={0.5} y={0.5} width={w - 1} height={h - 1} fill="none" stroke="rgba(0,0,0,0.6)" />
      </svg>
    </div>
  );
});

// ---------------------------------------------------------- glyph combos

/** SubVolModeSelect glyph: sub-harmonics around or below the fundamental. */
function subGlyph(v: number) {
  return (
    <svg width={13} height={13} viewBox="0 0 13 13">
      <rect x={6} y={1} width={1.6} height={11} fill="currentColor" />
      {v === 0 ? (
        <><rect x={2} y={5} width={1.4} height={7} fill="currentColor" opacity={0.7} /><rect x={10} y={5} width={1.4} height={7} fill="currentColor" opacity={0.7} /></>
      ) : (
        <><rect x={1} y={6} width={1.4} height={6} fill="currentColor" opacity={0.7} /><rect x={3.6} y={4} width={1.4} height={8} fill="currentColor" opacity={0.7} /></>
      )}
    </svg>
  );
}

/** HarmClipModeSelect glyph: high threshold, soft / sharp / hard low threshold, subtraction. */
function clipGlyph(v: number) {
  const paths = [
    'M1 11 L5 3 L12 3', // high threshold: clipped top
    'M1 11 C4 11 6 4 12 3', // soft low
    'M1 11 L6 11 L12 3', // sharp low
    'M1 11 L6 11 L6 3 L12 3', // hard low
    'M1 3 L6 3 L6 11 L12 11', // subtraction
  ];
  return (
    <svg width={13} height={14} viewBox="0 0 13 14">
      <path d={paths[v] ?? paths[0]} fill="none" stroke="currentColor" strokeWidth={1.4} />
    </svg>
  );
}

/** GrittyFromVolSelect (TPaintBoxSelector): off / on / inverted cells. */
function PrismFromVol() {
  const c = FORM.GrittyFromVolSelect;
  const cp = useCtlProps(c);
  const v = Math.round(cp.value);
  const names = c.hints ?? ['off', 'on', 'inverted'];
  const cw = c.w / 3;
  return (
    <div className="hm-ctl" style={{ left: c.x, top: c.y, width: c.w, height: c.h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        commit(cp, Math.min(2, Math.max(0, Math.floor(((e.clientX - r.left) / r.width) * 3))));
      }}
      onPointerEnter={() => setHint(`${cp.label}: ${names[v]}`)} onPointerLeave={clearHint}>
      <svg width={c.w} height={c.h} style={{ display: 'block' }}>
        <rect x={0.5} y={0.5} width={c.w - 1} height={c.h - 1} rx={3} fill="rgba(0,0,0,0.35)" stroke="rgba(0,0,0,0.5)" />
        {[0, 1, 2].map((i) => (
          <g key={i}>
            {i === v && <rect x={i * cw + 1.5} y={1.5} width={cw - 3} height={c.h - 3} rx={2} fill="#f0a64a" />}
            <path d={i === 0 ? `M${i * cw + 4} ${c.h / 2} L${i * cw + cw - 4} ${c.h / 2}` : i === 1 ? `M${i * cw + 4} ${c.h - 4} L${i * cw + cw - 4} 4` : `M${i * cw + 4} 4 L${i * cw + cw - 4} ${c.h - 4}`}
              stroke={i === v ? '#2a1d1d' : 'rgba(255,255,255,0.7)'} strokeWidth={1.4} />
          </g>
        ))}
      </svg>
    </div>
  );
}

// ------------------------------------------------------------- the page

export function PartPage() {
  const h = useHarmor();
  const hp: HPart | undefined = h.hp;
  const subV = Math.round(hp?.subMode ?? 0), clipV = Math.round(hp?.clipMode ?? 0);
  const noise1 = (hp?.r1Type ?? 100) === 109, noise2 = (hp?.r2Type ?? 100) === 109;
  return (
    <>
      {PART_CONTROLS.map((n) => <HCtl key={n} n={n} />)}
      <HCtl n="F1ResCutOfsWheel" dim={noise1} />
      <HCtl n="F2ResCutOfsWheel" dim={noise2} />
      <HCtl n="SubVolModeSelect" glyph={subGlyph(subV)} />
      <HCtl n="HarmClipModeSelect" glyph={clipGlyph(clipV)} />
      <PrismFromVol />
      <Scope n="Timbre1Scope" level={hp?.maps[2]} phase={hp?.maps[1]} title="Timbre 1" />
      <Scope n="Timbre2Scope" level={hp?.maps[3]} phase={hp?.maps[1]} title="Timbre 2" />
      <HButton ctl={FORM.VisFBBtn} glyph="vis" hint="Visual feedback" active={!!h.view.vis}
        onClick={() => setView(h.slotId, 'Visual feedback', { vis: h.view.vis ? 0 : 1 })} />
      {h.view.vis ? <VisScale /> : null}
    </>
  );
}

/** Visual feedback scale (oct / Hz): HGlobal.flags bit 1. */
function VisScale() {
  const h = useHarmor();
  const c = FORM.VisFBScaleSelect;
  const flags = h.hg?.flags ?? 0;
  const v = (flags >> 1) & 1;
  return (
    <HCtlSwitchFlags x={c.x} y={c.y} w={c.w} h={c.h} v={v} caps={c.caps ?? ['oct', 'Hz']}
      onPick={(i) => editGlobal(h.slotId, 'Visual feedback scale', (g) => { g.flags = (g.flags & ~2) | (i ? 2 : 0); })} />
  );
}

function HCtlSwitchFlags({ x, y, w, h, v, caps, onPick }: { x: number; y: number; w: number; h: number; v: number; caps: string[]; onPick: (i: number) => void }) {
  const rowH = h / caps.length;
  return (
    <div className="hm-ctl" style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(1 - v); } }}
      onPointerEnter={() => setHint(`Visual feedback scale: ${caps[v]}`)} onPointerLeave={clearHint}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        <rect x={w - 10} y={2} width={9} height={h - 4} rx={4.5} fill="rgba(0,0,0,0.5)" stroke="#3f4245" />
        <circle cx={w - 5.5} cy={rowH * v + rowH / 2} r={3.4} fill="#d9dde0" />
        {caps.map((s, i) => <text key={i} x={w - 13} y={rowH * i + rowH / 2 + 3.3} textAnchor="end" className={'hm-switch-cap' + (i === v ? ' on' : '')}>{s}</text>)}
      </svg>
    </div>
  );
}
