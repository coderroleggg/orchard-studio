// SimSynth editor (FL: SimSynth Live, SynthPanel 562 x 376). Every control sits at
// FL's form coordinates (SimSynth_x64.dylib's TSynthEditorForm; Tag = the engine's
// control index): three oscillator rows (on LED, shape selector, PW / CRS / FINE /
// LEVEL / LFO / ENV wheels, octave 1 / 2 and WARM switches, RING 1x2), the AMP
// section (envelope display, ATT / DEC / SUS / REL, LEVEL = VCA Velo), the SVF
// section (on LED, envelope display, ATT / DEC / SUS / REL / ENV, LFO / KB, TRACK
// AMP, CUT / EMPH / HIGH / BAND), the LFO section (on LED, shape selector, RATE /
// DEL, RETRIGGER) and the CHORUS switch. Controls 0..25 are FL's automatable
// parameters; the others edit plugin state (not automatable in FL either). FL 2026
// shows its logo where the form keeps a (hidden) preview keyboard. Colours follow
// FL's plugin database thumbnail; original drawing, no Image-Line artwork.

import { useMemo } from 'react';
import { FxPanel, WheelControl, Display, useFxEditor, useFxEdit, useParam } from '../../kit';
import { setHint, clearHint } from '../../../hint';
import type { ControlProps } from '../../../widgets/control';
import { store } from '../../../../store';
import { EXTRA_DEFAULTS, SHAPES, TAGS, tagMax } from '../../../../model/gen/plugins/simsynth';
import type { FxEditorModule } from '../../registry';
import './simsynth.css';

const GREEN = '#9fe04f';
const BLUE = '#39b6ea';
const TRACK = '#283236';
const ENV_LINE = '#3fb4e6';

type Fmt = (v: number) => string;
const pct: Fmt = (v) => `${Math.round((v / 65535) * 100)}%`;
const onOff: Fmt = (v) => (v ? 'On' : 'Off');
/** FL's pitch hint (wrapper 0x166060): "+12.00 semitones", "-4.00 cents". */
function pitchText(x: number, unit: string): string {
  return `${x >= 0 ? '+' : ''}${x.toFixed(2)} ${unit}${Math.abs(x) > 1 ? 's' : ''}`;
}
const rint = (x: number) => { const r = Math.round(x); return r - x === 0.5 && (r & 1) !== 0 ? r - 1 : r; };

/** FL's hint names and texts of the state controls (tags 26..57). */
const STATE_INFO: Record<string, [string, Fmt]> = {
  o1Pw: ['Osc1 Pulse Width', (v) => `${rint((v / 65535) * 96 + 2)}%`],
  o1Coarse: ['Osc1 Coarse', (v) => pitchText(v - 24, 'semitone')],
  o1Fine: ['Osc1 Fine', (v) => pitchText(rint((v / 65535) * 200 - 100), 'cent')],
  o2Pw: ['Osc2 Pulse Width', (v) => `${rint((v / 65535) * 96 + 2)}%`],
  o2Coarse: ['Osc2 Coarse', (v) => pitchText(v - 24, 'semitone')],
  o2Fine: ['Osc2 Fine', (v) => pitchText(rint((v / 65535) * 200 - 100), 'cent')],
  o3Pw: ['Osc3 Pulse Width', (v) => `${rint((v / 65535) * 96 + 2)}%`],
  o3Coarse: ['Osc3 Coarse', (v) => pitchText(v - 24, 'semitone')],
  o3Fine: ['Osc3 Fine', (v) => pitchText(rint((v / 65535) * 200 - 100), 'cent')],
  svfKb: ['SVF Kb', pct],
  chorus: ['Chorus On/Off', onOff], retrigger: ['Retrigger', onOff], trackAmp: ['SVF Track Amp', onOff],
  lfoOn: ['LFO On/Off', onOff], svfOn: ['SVF On/Off', onOff],
  o1On: ['Osc1 On/Off', onOff], o2On: ['Osc2 On/Off', onOff], o3On: ['Osc3 On/Off', onOff], ring: ['RingMod Osc1xOsc2', onOff],
  o1Oct1: ['Osc1 +1 Octave', onOff], o1Oct2: ['Osc1 +2 Octaves', onOff], o1Warm: ['Osc1 Warm', onOff],
  o2Oct1: ['Osc2 +1 Octave', onOff], o2Oct2: ['Osc2 +2 Octaves', onOff], o2Warm: ['Osc2 Warm', onOff],
  o3Oct1: ['Osc3 +1 Octave', onOff], o3Oct2: ['Osc3 +2 Octaves', onOff], o3Warm: ['Osc3 Warm', onOff],
  o1Shape: ['Osc1 shape', (v) => SHAPES[v] ?? ''], o2Shape: ['Osc2 shape', (v) => SHAPES[v] ?? ''],
  o3Shape: ['Osc3 shape', (v) => SHAPES[v] ?? ''], lfoShape: ['LFO shape', (v) => SHAPES[v] ?? ''],
};

/** A state control (not automatable): undoable edits of the plugin state. */
function useStateControl(key: string): ControlProps {
  const c = useFxEditor();
  const edit = useFxEdit();
  const [label, format] = STATE_INFO[key];
  const max = tagMax(TAGS.indexOf(key as (typeof TAGS)[number]));
  const raw = c.params[key];
  const value = typeof raw === 'number' ? raw : EXTRA_DEFAULTS[key];
  return {
    value, min: 0, max, defaultValue: EXTRA_DEFAULTS[key], step: 1, label, format,
    onChange: (v) => { const x = Math.round(Math.min(max, Math.max(0, v))); edit(label, (d) => { d[key] = x; }, 'simsynth:' + key); },
    onBegin: () => store.beginGesture(label),
    onEnd: () => store.endGesture(),
  };
}

function Cap({ x, y, w = 34, children }: { x: number; y: number; w?: number; children: string }) {
  return <div className="ss-cap" style={{ left: x - 8, top: y, width: w + 16 }}>{children}</div>;
}

/** An automatable wheel (FL parameter `k`) with its caption. */
function PKnob({ k, x, y, cap, color }: { k: string; x: number; y: number; cap: string; color: string }) {
  const p = useParam(k);
  return (
    <>
      <WheelControl x={x} y={y} size={34} color={color} track={TRACK} bipolar={p.def.bipolar} control={p.control} />
      <Cap x={x} y={y + 35}>{cap}</Cap>
    </>
  );
}

/** A state wheel (FL control without a parameter index) with its caption. */
function SKnob({ k, x, y, cap, color, bipolar }: { k: string; x: number; y: number; cap: string; color: string; bipolar?: boolean }) {
  const control = useStateControl(k);
  return (
    <>
      <WheelControl x={x} y={y} size={34} color={color} track={TRACK} bipolar={bipolar} control={control} />
      <Cap x={x} y={y + 35}>{cap}</Cap>
    </>
  );
}

/** LED switch (TVectorCheckBox), optionally with a caption. */
function Led({ k, x, y, w, h, caption }: { k: string; x: number; y: number; w: number; h: number; caption?: string }) {
  const cp = useStateControl(k);
  const on = cp.value !== 0;
  return (
    <div className={'ss-led' + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); cp.onBegin?.(); cp.onChange(on ? 0 : 1); cp.onEnd?.(); }}
      onPointerEnter={() => setHint(`${cp.label}: ${cp.format!(cp.value)}`)} onPointerLeave={clearHint}>
      <span className="dot" />
      {caption && <span className="t">{caption}</span>}
    </div>
  );
}

/** The octave buttons "1" / "2" (TVectorCheckBox with a caption only). */
function Num({ k, x, y, w, h, caption }: { k: string; x: number; y: number; w: number; h: number; caption: string }) {
  const cp = useStateControl(k);
  const on = cp.value !== 0;
  return (
    <div className={'ss-num' + (on ? ' on' : '')} style={{ left: x, top: y, width: w, height: h }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); cp.onBegin?.(); cp.onChange(on ? 0 : 1); cp.onEnd?.(); }}
      onPointerEnter={() => setHint(`${cp.label}: ${cp.format!(cp.value)}`)} onPointerLeave={clearHint}>
      <span style={{ width: 7, height: 7, borderRadius: 2, marginRight: 4, background: on ? '#ff8a3a' : '#262f34', boxShadow: on ? '0 0 4px rgba(255,120,40,0.7)' : 'inset 0 1px 1px rgba(0,0,0,0.6)' }} />
      {caption}
    </div>
  );
}

/** Shape icons: square, saw, triangle, noise, sine. */
function ShapeIcon({ i, color }: { i: number; color: string }) {
  const s = { stroke: color, strokeWidth: 1.6, fill: 'none', strokeLinejoin: 'round' as const };
  switch (i) {
    case 0: return <svg width={16} height={12} viewBox="0 0 16 12"><path d="M1 10 H4 V2 H10 V10 H15" {...s} /></svg>;
    case 1: return <svg width={16} height={12} viewBox="0 0 16 12"><path d="M1 10 L8 2 V10 L15 2" {...s} /></svg>;
    case 2: return <svg width={16} height={12} viewBox="0 0 16 12"><path d="M1 6 L4.5 2 L11.5 10 L15 6" {...s} /></svg>;
    case 3: return <svg width={14} height={14} viewBox="0 0 14 14"><rect x={1.5} y={1.5} width={11} height={11} rx={2.5} fill={color} opacity={0.85} /><g fill="#2a3338"><circle cx={4.5} cy={4.5} r={1.2} /><circle cx={9.5} cy={9.5} r={1.2} /><circle cx={7} cy={7} r={1.2} /></g></svg>;
    default: return <svg width={16} height={12} viewBox="0 0 16 12"><path d="M1 6 C3 0, 5 0, 8 6 S13 12, 15 6" {...s} /></svg>;
  }
}

/** TPaintBoxSelector: a row of shape icons; click selects, the wheel steps. */
function ShapeSel({ k, x, y, w, h, n }: { k: string; x: number; y: number; w: number; h: number; n: number }) {
  const cp = useStateControl(k);
  const set = (i: number) => { if (i === cp.value) return; cp.onBegin?.(); cp.onChange(i); cp.onEnd?.(); };
  return (
    <div className="ss-sel" style={{ left: x, top: y, width: w, height: h }}
      onWheel={(e) => set(Math.max(0, Math.min(n - 1, cp.value + (e.deltaY > 0 ? 1 : -1))))}
      onPointerLeave={clearHint}>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className={'it' + (cp.value === i ? ' on' : '')}
          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); set(i); }}
          onPointerEnter={() => setHint(`${cp.label}: ${SHAPES[i]}`)}>
          <ShapeIcon i={i} color={cp.value === i ? GREEN : '#93a1a8'} />
        </div>
      ))}
    </div>
  );
}

/**
 * Envelope display (TQuickPaintBox): the ADSR the four wheels give, attack v^3 x 8 s,
 * decay / release v^2 x 8 s, each stage drawn over a quarter of the box.
 */
function EnvDisplay({ x, y, w, h, keys }: { x: number; y: number; w: number; h: number; keys: [string, string, string, string] }) {
  const { params } = useFxEditor();
  const v = keys.map((k) => (typeof params[k] === 'number' ? (params[k] as number) / 65535 : 0));
  const draw = useMemo(() => (g: CanvasRenderingContext2D, W: number, H: number) => {
    g.clearRect(0, 0, W, H);
    const q = (W - 8) / 4;
    const top = 4, bot = H - 4;
    const a = v[0] ** 3, d = v[1] ** 2, s = v[2], r = v[3] ** 2;
    const pts: [number, number][] = [[4, bot]];
    let px = 4 + a * q;
    pts.push([px, top]);
    px += d * q;
    const sy = bot - (bot - top) * s;
    pts.push([px, sy]);
    px += q;
    pts.push([px, sy]);
    px += r * q;
    pts.push([px, bot]);
    g.strokeStyle = 'rgba(63,180,230,0.18)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(4, bot + 0.5); g.lineTo(W - 4, bot + 0.5); g.stroke();
    g.strokeStyle = ENV_LINE;
    g.lineWidth = 1.6;
    g.beginPath();
    pts.forEach(([X, Y], i) => (i ? g.lineTo(X, Y) : g.moveTo(X, Y)));
    g.stroke();
    g.fillStyle = ENV_LINE;
    for (const [X, Y] of pts.slice(1, -1)) { g.beginPath(); g.arc(X, Y, 2, 0, Math.PI * 2); g.fill(); }
  }, [v[0], v[1], v[2], v[3]]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Display x={x} y={y} w={w} h={h} className="ss-env" draw={draw} deps={[draw]} />;
}

/** The chorus switch (538, 340, 24 x 38): an icon that lights when on. */
function Chorus() {
  const cp = useStateControl('chorus');
  const on = cp.value !== 0;
  const c = on ? '#ff8a3a' : '#7d8b92';
  return (
    <div className="ss-chorus" style={{ left: 538, top: 340, width: 24, height: 36 }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); cp.onBegin?.(); cp.onChange(on ? 0 : 1); cp.onEnd?.(); }}
      onPointerEnter={() => setHint(`${cp.label}: ${cp.format!(cp.value)}`)} onPointerLeave={clearHint}>
      <svg width={16} height={16} viewBox="0 0 16 16" style={{ filter: on ? 'drop-shadow(0 0 3px rgba(255,120,40,0.7))' : undefined }}>
        <rect x={1} y={1} width={14} height={14} rx={3} fill="none" stroke={c} strokeWidth={1.4} />
        <path d="M3.5 9 C5 5, 6.5 5, 8 8 S11 11, 12.5 7" stroke={c} strokeWidth={1.3} fill="none" />
        <path d="M3.5 7 C5 3.5, 6.5 3.5, 8 6 S11 9, 12.5 5" stroke={c} strokeWidth={1} fill="none" opacity={0.6} />
      </svg>
    </div>
  );
}

/** FL 2026's logo area (4, 296, 315 x 76): an original lettering. */
function Logo() {
  return (
    <svg className="ss-logo" style={{ left: 4, top: 296 }} width={315} height={76} viewBox="0 0 315 76">
      <rect x={16} y={14} width={262} height={44} rx={9} fill="none" stroke="#aeb9be" strokeWidth={2} />
      <rect x={21} y={19} width={86} height={34} rx={5} fill="#aeb9be" />
      <text x={64} y={46} textAnchor="middle" fontSize={27} fontWeight={300} letterSpacing={5} fill="#384449" fontFamily="var(--font-ui), sans-serif">SIM</text>
      <text x={190} y={46} textAnchor="middle" fontSize={27} fontWeight={300} letterSpacing={6} fill="#aeb9be" fontFamily="var(--font-ui), sans-serif">SYNTH</text>
      <text x={262} y={70} textAnchor="middle" fontSize={15} fontStyle="italic" fontWeight={700} fill="#e0402c" fontFamily="var(--font-ui), sans-serif">Live</text>
    </svg>
  );
}

function OscRow({ n, y0 }: { n: 1 | 2 | 3; y0: number }) {
  const o = `o${n}`;
  const ky = y0 + 46 - (n === 3 ? 1 : 0);
  return (
    <>
      <div className="ss-title" style={{ left: 8, top: y0 + 3 }}>Osc {n}</div>
      <Led k={`${o}On`} x={58} y={y0 + 6 - (n === 1 ? 0 : 0)} w={21} h={16} />
      <ShapeSel k={`${o}Shape`} x={94} y={y0 + 7} w={161} h={26} n={5} />
      <SKnob k={`${o}Pw`} x={8} y={ky} cap="PW" color={GREEN} />
      <SKnob k={`${o}Coarse`} x={51} y={ky} cap="CRS" color={GREEN} bipolar />
      <SKnob k={`${o}Fine`} x={94} y={ky} cap="FINE" color={GREEN} bipolar />
      <PKnob k={`${o}Level`} x={137} y={ky} cap="LEVEL" color={GREEN} />
      <PKnob k={`${o}Lfo`} x={180} y={ky} cap="LFO" color={GREEN} />
      <PKnob k={`${o}Env`} x={223} y={ky} cap="ENV" color={GREEN} />
    </>
  );
}

function SimSynthEditor() {
  return (
    <FxPanel width={562} height={376} className="ss-panel">
      {/* sections */}
      <div className="ss-sec" style={{ left: 0, top: 0, width: 340, height: 97 }} />
      <div className="ss-sec" style={{ left: 0, top: 97, width: 340, height: 97 }} />
      <div className="ss-sec" style={{ left: 0, top: 194, width: 340, height: 96 }} />
      <div className="ss-sec r" style={{ left: 340, top: 0, width: 222, height: 97 }} />
      <div className="ss-sec r" style={{ left: 340, top: 97, width: 222, height: 193 }} />
      <div className="ss-sec r" style={{ left: 340, top: 290, width: 222, height: 86, borderBottom: 'none' }} />
      <OscRow n={1} y0={0} />
      <OscRow n={2} y0={97} />
      <OscRow n={3} y0={194} />
      {/* oscillator switches */}
      <Led k="ring" x={267} y={11} w={65} h={16} caption="Ring 1x2" />
      <Num k="o1Oct1" x={267} y={45} w={28} h={16} caption="1" />
      <Num k="o1Oct2" x={292} y={45} w={27} h={16} caption="2" />
      <Led k="o1Warm" x={267} y={66} w={50} h={16} caption="Warm" />
      <Num k="o2Oct1" x={267} y={145} w={28} h={16} caption="1" />
      <Num k="o2Oct2" x={292} y={145} w={27} h={16} caption="2" />
      <Led k="o2Warm" x={267} y={165} w={50} h={16} caption="Warm" />
      <Num k="o3Oct1" x={267} y={242} w={28} h={16} caption="1" />
      <Num k="o3Oct2" x={291} y={242} w={27} h={16} caption="2" />
      <Led k="o3Warm" x={267} y={262} w={50} h={16} caption="Warm" />
      {/* AMP */}
      <div className="ss-title" style={{ left: 349, top: 3 }}>Amp</div>
      <EnvDisplay x={433} y={7} w={121} h={34} keys={['envA', 'envD', 'envS', 'envR']} />
      <PKnob k="envA" x={347} y={46} cap="ATT" color={BLUE} />
      <PKnob k="envD" x={390} y={46} cap="DEC" color={BLUE} />
      <PKnob k="envS" x={433} y={46} cap="SUS" color={BLUE} />
      <PKnob k="envR" x={476} y={46} cap="REL" color={BLUE} />
      <PKnob k="vcaVelo" x={519} y={46} cap="LEVEL" color={BLUE} />
      {/* SVF */}
      <div className="ss-title" style={{ left: 349, top: 100 }}>SVF</div>
      <Led k="svfOn" x={380} y={103} w={21} h={16} />
      <EnvDisplay x={433} y={104} w={121} h={34} keys={['fenvA', 'fenvD', 'fenvS', 'fenvR']} />
      <PKnob k="fenvA" x={347} y={145} cap="ATT" color={BLUE} />
      <PKnob k="fenvD" x={390} y={145} cap="DEC" color={BLUE} />
      <PKnob k="fenvS" x={433} y={145} cap="SUS" color={BLUE} />
      <PKnob k="fenvR" x={476} y={145} cap="REL" color={BLUE} />
      <PKnob k="svfEnv" x={519} y={145} cap="ENV" color={BLUE} />
      <PKnob k="svfLfo" x={347} y={195} cap="LFO" color={BLUE} />
      <SKnob k="svfKb" x={390} y={194} cap="KB" color={BLUE} />
      <Led k="trackAmp" x={479} y={195} w={75} h={16} caption="Track Amp" />
      <PKnob k="svfCut" x={347} y={243} cap="CUT" color={BLUE} />
      <PKnob k="svfEmph" x={390} y={243} cap="EMPH" color={BLUE} />
      <PKnob k="svfHigh" x={433} y={243} cap="HIGH" color={BLUE} />
      <PKnob k="svfBand" x={476} y={243} cap="BAND" color={BLUE} />
      {/* LFO */}
      <div className="ss-title" style={{ left: 349, top: 294 }}>LFO</div>
      <Led k="lfoOn" x={380} y={297} w={21} h={16} />
      <ShapeSel k="lfoShape" x={436} y={299} w={108} h={26} n={4} />
      <PKnob k="lfoRate" x={347} y={323} cap="RATE" color={BLUE} />
      <PKnob k="lfoDelay" x={390} y={323} cap="DEL" color={BLUE} />
      <Led k="retrigger" x={438} y={356} w={73} h={16} caption="Retrigger" />
      <Chorus />
      <Logo />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'simsynth', Editor: SimSynthEditor };
