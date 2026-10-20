// Delay Bank editor (FL: Fruity Delay Bank, 580 x 280): the unit tabs with
// their enable LEDs (right-click solos a unit) and "to next" routing arrows,
// the global DRY / WET / IN / FB wheels and OVERSAMPLE, and the selected
// unit's IN, FILT, FEEDBACK, FB FILT, GRAIN and OUT sections, every control
// at the coordinates of FL's editor form. Filter displays show FL's type
// names with the 1 / 2 / 3 slope selector (drag or scroll the name, or
// right-click it for the list).

import type { ReactElement, ReactNode } from 'react';
import * as A from '../../../../store/actions';
import {
  DB_FILTERS, DB_FILTER_NAMES, DB_MODES, DB_SLOPES, DB_UNITS, dbKey, dbUnits, type DbUnit,
} from '../../../../model/fx/plugins/delaybank';
import { useControl, type ControlProps } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { FxPanel, useFxEditor, useFxState, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import './delaybank.css';

const START = -135;
const SWEEP = 270;
let gid = 0;

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

function arc(c: number, r: number, a0: number, a1: number): string {
  const [x0, y0] = polar(c, r, a0);
  const [x1, y1] = polar(c, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

/** Unit wheels: dark brushed knob inside a segmented dark ring. */
function DarkKnob({ S, t }: { S: number; t: number }) {
  const c = S / 2, id = `dbk${(gid = (gid + 1) % 1e6)}`;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const ringR = S * 0.37, ringW = S * 0.125, bodyR = S * 0.268;
  const segs: ReactElement[] = [];
  for (let i = 0; i < 6; i++) {
    const a0 = START + 45 * i + 1.6, a1 = START + 45 * (i + 1) - 1.6;
    segs.push(<path key={i} d={arc(c, ringR, a0, a1)} stroke="rgba(50,58,65,0.55)" strokeWidth={ringW} fill="none" />);
  }
  const [p0x, p0y] = polar(c, bodyR * 0.12, ang);
  const [p1x, p1y] = polar(c, bodyR * 0.8, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}b`} cx="50%" cy="40%" r="62%">
          <stop offset="0" stopColor="#5c656c" />
          <stop offset="0.55" stopColor="#353c42" />
          <stop offset="1" stopColor="#24292d" />
        </radialGradient>
        <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0.38" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="0.62" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
      </defs>
      {segs}
      <circle cx={c} cy={c} r={bodyR + 1.3} fill="#2a3035" />
      <circle cx={c} cy={c} r={bodyR} fill={`url(#${id}b)`} />
      <circle cx={c} cy={c} r={bodyR} fill={`url(#${id}s)`} />
      <circle cx={c} cy={c} r={bodyR - 0.7} fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth={0.8} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#f4f7f9" strokeWidth={2.1} strokeLinecap="round" />
    </svg>
  );
}

/** Global wheels: light knob with a dark rim, a faint track and tick marks. */
function LightKnob({ S, t }: { S: number; t: number }) {
  const c = S / 2, id = `dbg${(gid = (gid + 1) % 1e6)}`;
  const ang = START + SWEEP * Math.min(1, Math.max(0, t));
  const bodyR = S * 0.3;
  const ticks: ReactElement[] = [];
  for (let i = 0; i < 7; i++) {
    const a = START + 45 * i;
    const [x0, y0] = polar(c, S * 0.37, a);
    const [x1, y1] = polar(c, S * 0.5, a);
    ticks.push(<line key={i} x1={x0} y1={y0} x2={x1} y2={y1} stroke="rgba(70,80,88,0.55)" strokeWidth={1.1} />);
  }
  const [p0x, p0y] = polar(c, bodyR * 0.1, ang);
  const [p1x, p1y] = polar(c, bodyR * 0.85, ang);
  return (
    <svg width={S} height={S} viewBox={`0 0 ${S} ${S}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={`${id}b`} cx="45%" cy="35%" r="70%">
          <stop offset="0" stopColor="#d9e2ea" />
          <stop offset="0.6" stopColor="#a9b5bf" />
          <stop offset="1" stopColor="#8e9aa4" />
        </radialGradient>
      </defs>
      <path d={arc(c, S * 0.42, START, START + SWEEP)} stroke="rgba(90,100,110,0.28)" strokeWidth={S * 0.08} fill="none" />
      {ticks}
      <circle cx={c} cy={c} r={bodyR + 1.4} fill="#1f2529" />
      <circle cx={c} cy={c} r={bodyR} fill={`url(#${id}b)`} />
      <line x1={p0x} y1={p0y} x2={p1x} y2={p1y} stroke="#ffffff" strokeWidth={2} strokeLinecap="round" />
    </svg>
  );
}

function KnobBox({ x, y, S, control, light }: { x: number; y: number; S: number; control: ControlProps; light?: boolean }) {
  const h = useControl({ travel: 200, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = (control.value - min) / (max - min || 1);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: S, height: S }} {...h}>
      {light ? <LightKnob S={S} t={t} /> : <DarkKnob S={S} t={t} />}
    </div>
  );
}

function UKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  return <KnobBox x={x} y={y} S={44} control={p.control} />;
}

function GKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  return <KnobBox x={x} y={y} S={40} control={p.control} light />;
}

function Cap({ x, y, w, children, glob }: { x: number; y: number; w: number; children: ReactNode; glob?: boolean }) {
  return <div className={'db-cap' + (glob ? ' glob' : '')} style={{ left: x, top: y, width: w }}>{children}</div>;
}

/** Vertical slider (TVectorSlider): track, fader cap and FL's orange fill below the cap. */
function VSlider({ x, y, w, h, control, ticks }: { x: number; y: number; w: number; h: number; control: ControlProps; ticks?: 'single' | 'double' }) {
  const hd = useControl({ travel: h, ...control }, 'vertical');
  const min = control.min ?? 0, max = control.max ?? 1;
  const t = Math.min(1, Math.max(0, (control.value - min) / (max - min || 1)));
  const capH = 19, capW = 13;
  const cx = w / 2, top = 6, bot = h - 6;
  const cy = bot - (bot - top) * t;
  const marks: ReactElement[] = [];
  if (ticks) {
    for (let i = 0; i <= 16; i++) {
      const yy = top + ((bot - top) * i) / 16 + 0.5;
      if (i === 0 || i === 16 || i === 8) continue;
      if (ticks === 'single') marks.push(<line key={i} x1={cx + 8} y1={yy} x2={w + 3} y2={yy} stroke="rgba(72,82,90,0.55)" strokeWidth={0.9} />);
      else {
        marks.push(<line key={`a${i}`} x1={cx + 7} y1={yy} x2={cx + 11} y2={yy} stroke="rgba(72,82,90,0.55)" strokeWidth={0.9} />);
        marks.push(<line key={`b${i}`} x1={cx + 13} y1={yy} x2={cx + 17} y2={yy} stroke="rgba(72,82,90,0.55)" strokeWidth={0.9} />);
      }
    }
  }
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: w, height: h }} {...hd}>
      <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }}>
        {marks}
        <line x1={cx} y1={top - 2} x2={cx} y2={bot + 2} stroke="#4c565e" strokeWidth={2} />
        <line x1={cx - 6} y1={bot + 2} x2={w + 3} y2={bot + 2} stroke="rgba(72,82,90,0.5)" strokeWidth={0.9} />
        <line x1={cx - 6} y1={(top + bot) / 2} x2={w + 3} y2={(top + bot) / 2} stroke="rgba(72,82,90,0.5)" strokeWidth={0.9} />
        {cy < bot - 0.5 && <line x1={cx} y1={cy + capH / 2} x2={cx} y2={bot + 2} stroke="#f5a531" strokeWidth={2} />}
        <rect x={cx - capW / 2} y={cy - capH / 2 + 1.5} width={capW} height={capH} rx={2} fill="rgba(0,0,0,0.28)" />
        <rect x={cx - capW / 2} y={cy - capH / 2} width={capW} height={capH} rx={2} fill="#4a5157" stroke="#2b3034" strokeWidth={0.8} />
        <rect x={cx - capW / 2 + 1} y={cy - capH / 2 + 1} width={capW - 2} height={4} fill="#5d656c" />
        <rect x={cx - capW / 2 + 1} y={cy - 2.5} width={capW - 2} height={2.2} fill="#15191c" />
        <rect x={cx - capW / 2 + 1} y={cy + 3} width={capW - 2} height={2.2} fill="#15191c" />
        <rect x={cx - capW / 2 + 1} y={cy + 0.2} width={capW - 2} height={2.4} fill="#646c73" />
      </svg>
    </div>
  );
}

function PSlider({ k, x, y, w, h, ticks }: { k: string; x: number; y: number; w: number; h: number; ticks?: 'single' | 'double' }) {
  const p = useParam(k);
  return <VSlider x={x} y={y} w={w} h={h} control={p.control} ticks={ticks} />;
}

// ------------------------------------------------------------- unit state

function useUnits(): DbUnit[] {
  const { params } = useFxEditor();
  return dbUnits(params.units);
}

function editUnit(slotId: string, u: number, label: string, recipe: (s: DbUnit) => void, mergeKey?: string): void {
  A.editFx(slotId, label, (p) => {
    const units = dbUnits(p.units);
    recipe(units[u]);
    p.units = units;
  }, mergeKey);
}

/** A slider bound to a unit setting (grain division / shape: not automatable in FL). */
function StateSlider({ u, field, x, y, w, h, min, max, label, format, ticks }: {
  u: number; field: 'div' | 'shape'; x: number; y: number; w: number; h: number; min: number; max: number;
  label: string; format: (v: number) => string; ticks?: 'single' | 'double';
}) {
  const { slotId } = useFxEditor();
  const value = useUnits()[u][field];
  const control: ControlProps = {
    value, min, max, step: 1, defaultValue: 0, label, format,
    onChange: (v) => editUnit(slotId, u, label, (s) => { s[field] = Math.round(v); }, `db:${slotId}:${u}:${field}`),
  };
  return <VSlider x={x} y={y} w={w} h={h} control={control} ticks={ticks} />;
}

function Led({ x, y, d, on, red, dim }: { x: number; y: number; d: number; on: boolean; red?: boolean; dim?: boolean }) {
  return <span className={'db-led' + (on ? ' on' : '') + (red ? ' red' : '') + (dim ? ' dim' : '')} style={{ left: x - d / 2, top: y - d / 2, width: d, height: d }} />;
}

/** Enable LEDs (left-click toggles, right-click solos), unit tabs and "to next" arrows. */
function UnitTabs({ tab }: { tab: number }) {
  const { slotId, params } = useFxEditor();
  const units = useUnits();
  const solo = typeof params.solo === 'number' ? params.solo : -1;
  const out: ReactElement[] = [];
  for (let u = 0; u < DB_UNITS; u++) {
    const cx = 22 + 28 * u, on = !!units[u].enable;
    const name = `Delay ${u + 1}`;
    out.push(<Led key={`l${u}`} x={cx} y={22} d={13} on={on} dim={solo >= 0 && solo !== u} />);
    out.push(
      <div key={`h${u}`} className="db-hit" style={{ left: cx - 10, top: 12, width: 20, height: 20 }}
        onPointerEnter={() => setHint(`Enable unit (Right-click to solo): ${name} ${on ? 'on' : 'off'}${solo === u ? ', solo' : ''}`)}
        onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          editUnit(slotId, u, `${name} ${on ? 'off' : 'on'}`, (s) => { s.enable = on ? 0 : 1; });
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          A.editFx(slotId, `Solo ${name}`, (p) => { p.solo = p.solo === u ? -1 : u; });
        }} />,
    );
    if (u < DB_UNITS - 1) {
      const nx = numParam(params, dbKey(u, 'Next'));
      if (nx !== 0) out.push(<span key={`r${u}`} className="db-route" style={{ left: cx + 9, top: 18 }} />);
    }
    out.push(
      <div key={`t${u}`} className={'db-tab' + (u === tab ? ' sel' : '') + (on ? '' : ' off')} style={{ left: 8 + 28 * u }}
        onPointerEnter={() => setHint(`Delay unit: ${u + 1}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          if (u !== tab) A.setFxStateNoHistory(slotId, 'Delay unit', (p) => { p.tab = u; });
        }}>{u + 1}</div>,
    );
  }
  return <>{out}</>;
}

function numParam(params: Record<string, unknown>, key: string): number {
  const v = params[key];
  return typeof v === 'number' ? v : 0;
}

function Oversample() {
  const { slotId, params } = useFxEditor();
  const on = Number(params.oversample) >= 0.5;
  return (
    <div className="db-osc" style={{ left: 314, top: 31, width: 82, height: 21 }}
      onPointerEnter={() => setHint(`2x oversampling (mainly for filters): ${on ? 'on' : 'off'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        A.editFx(slotId, '2x oversampling', (p) => { p.oversample = on ? 0 : 1; });
      }}>
      <span className={'db-led' + (on ? ' on' : '')} />
      <span className="db-osc-cap">OVERSAMPL..</span>
    </div>
  );
}

/** Filter type display + slope selector (TVectorDigiWheel + TPaintBoxSelector). */
function FilterDisplay({ u, which, x, y, mx, my }: { u: number; which: 'in' | 'fb'; x: number; y: number; mx: number; my: number }) {
  const { slotId } = useFxEditor();
  const s = useUnits()[u];
  const typeKey = which === 'in' ? 'inType' : 'fbType';
  const modeKey = which === 'in' ? 'inMode' : 'fbMode';
  const label = which === 'in' ? 'Input filter type' : 'Feedback filter type';
  const type = s[typeKey], mode = s[modeKey];
  const setType = (v: number) => editUnit(slotId, u, label, (q) => { q[typeKey] = Math.min(7, Math.max(0, Math.round(v))); }, `db:${slotId}:${u}:${typeKey}`);
  const h = useControl({
    value: type, min: 0, max: 7, step: 1, defaultValue: 0, travel: 90, label,
    format: (v) => DB_FILTER_NAMES[Math.round(v)] ?? '', onChange: setType,
  }, 'vertical');
  const modeLabel = which === 'in' ? 'Input filter mode' : 'Feedback filter mode';
  return (
    <>
      <div className="db-digi" style={{ left: x, top: y, width: 95 }} {...h}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, DB_FILTER_NAMES.map((n, i) => ({ label: n, radio: true, checked: i === type, onClick: () => setType(i) })));
        }}>{DB_FILTERS[type]}</div>
      <div className="db-slopes" style={{ left: mx, top: my, width: 46 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className={'db-slope' + (i === mode ? ' sel' : '')}
            onPointerEnter={() => setHint(`${modeLabel}: ${DB_SLOPES[i]}`)} onPointerLeave={clearHint}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              if (i !== mode) editUnit(slotId, u, modeLabel, (q) => { q[modeKey] = i; });
            }}>{i + 1}</div>
        ))}
      </div>
    </>
  );
}

function PostBox({ u }: { u: number }) {
  const { slotId } = useFxEditor();
  const on = !!useUnits()[u].post;
  return (
    <div className="db-post" style={{ left: 79, top: 169, width: 35, height: 46 }}
      onPointerEnter={() => setHint(`Pre / post delay: ${on ? 'post' : 'pre'}`)} onPointerLeave={clearHint}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        editUnit(slotId, u, 'Pre / post delay', (s) => { s.post = on ? 0 : 1; });
      }}>
      <Led x={17.5} y={11.5} d={11} on={on} />
      <div className="db-cap" style={{ left: 0, top: 31, width: 35 }}>POST</div>
    </div>
  );
}

function ModeRadio({ u }: { u: number }) {
  const { slotId } = useFxEditor();
  const mode = useUnits()[u].mode;
  const cells: [number, string, number, number][] = [[0, 'OFF', 222, 90], [1, 'NORM', 274, 90], [2, 'INV', 222, 107], [3, 'P.PONG', 274, 107]];
  return (
    <>
      {cells.map(([m, name, x, y]) => (
        <div key={m} className="db-radio" style={{ left: x, top: y, width: 52 }}
          onPointerEnter={() => setHint(`Feedback mode: ${DB_MODES[m]}`)} onPointerLeave={clearHint}
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            if (m !== mode) editUnit(slotId, u, 'Feedback mode', (s) => { s.mode = m; });
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(e.clientX, e.clientY, DB_MODES.map((n, i) => ({ label: n, radio: true, checked: i === mode, onClick: () => editUnit(slotId, u, 'Feedback mode', (s) => { s.mode = i; }) })));
          }}>
          <span className={'db-led red' + (m === mode ? ' on' : '')} />
          <span className="db-radio-cap">{name}</span>
        </div>
      ))}
    </>
  );
}

/** Process / leave first echo (bar icon) and tempo-based time ("T"). */
function EchoTempo({ u }: { u: number }) {
  const { slotId } = useFxEditor();
  const s = useUnits()[u];
  const leave = !!s.leave, tempo = !!s.tempo;
  const bars = leave ? [9, 9, 7, 5] : [9, 7.5, 6, 4.5];
  return (
    <>
      <div className="db-echo" style={{ left: 188, top: 92, width: 13, height: 13 }}
        onPointerEnter={() => setHint(`Process / leave first echo: ${leave ? 'leave' : 'process'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          editUnit(slotId, u, 'Process / leave first echo', (q) => { q.leave = leave ? 0 : 1; });
        }}>
        {bars.map((bh, i) => <span key={i} style={{ left: 1.6 + i * 2.6, height: bh }} />)}
      </div>
      <div className={'db-tempo ' + (tempo ? 'on' : 'off')} style={{ left: 190, top: 110, width: 9, height: 11 }}
        onPointerEnter={() => setHint(`Tempo-based time: ${tempo ? 'on' : 'off'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          editUnit(slotId, u, 'Tempo-based time', (q) => { q.tempo = tempo ? 0 : 1; });
        }}>T</div>
    </>
  );
}

function Section({ x, w, title, dark }: { x: number; w: number; title: string; dark?: boolean }) {
  return (
    <>
      <div className="db-title" style={{ left: x, top: 69, width: w }}>{title}</div>
      <div className={'db-sec' + (dark ? ' dark' : '')} style={{ left: x, top: 87, width: w, height: 187 }} />
    </>
  );
}

function Line({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <div className="db-line" style={{ left: x, top: y, width: w, height: h }} />;
}

function DelayBankEditor() {
  const tab = Math.min(DB_UNITS - 1, Math.max(0, Math.round(Number(useFxState<number>('tab', 0)) || 0)));
  const k = (name: string) => dbKey(tab, name);
  return (
    <FxPanel width={580} height={280} className="db-panel">
      <div className="db-sep" />
      <UnitTabs tab={tab} />
      <Oversample />
      <Cap x={401} y={8} w={32} glob>DRY</Cap>
      <GKnob k="dry" x={397} y={21} />
      <Cap x={440} y={8} w={45} glob>WET</Cap>
      <GKnob k="wet" x={442} y={21} />
      <Cap x={488} y={8} w={38} glob>IN</Cap>
      <GKnob k="input" x={487} y={21} />
      <Cap x={532} y={8} w={38} glob>FB</Cap>
      <GKnob k="feedback" x={531} y={21} />

      <Section x={8} w={57} title="IN" dark />
      <Section x={69} w={107} title="FILT" />
      <Section x={180} w={150} title="FEEDBACK" />
      <div className="db-sec" style={{ left: 330, top: 154, width: 4, height: 48, borderRadius: 0 }} />
      <Section x={334} w={107} title="FB FILT" />
      <Section x={445} w={66} title="GRAIN" />
      <Section x={515} w={57} title="OUT" dark />

      {/* IN */}
      <UKnob k={k('InPan')} x={14} y={157} />
      <Cap x={14} y={200} w={44}>PAN</Cap>
      <UKnob k={k('InVol')} x={14} y={216} />
      <Cap x={14} y={258} w={44}>VOL</Cap>

      {/* FILT */}
      <FilterDisplay u={tab} which="in" x={75} y={99} mx={123} my={101} />
      <PostBox u={tab} />
      <UKnob k={k('InGain')} x={126} y={157} />
      <Cap x={126} y={200} w={44}>GAIN</Cap>
      <UKnob k={k('InCut')} x={75} y={216} />
      <Cap x={78} y={258} w={38}>CUT</Cap>
      <UKnob k={k('InRes')} x={126} y={216} />
      <Cap x={129} y={258} w={38}>RES</Cap>

      {/* FEEDBACK */}
      <EchoTempo u={tab} />
      <ModeRadio u={tab} />
      <Line x={194} y={121} w={1} h={10} />
      <Line x={198} y={131} w={61} h={1} />
      <Line x={198} y={131} w={1} h={6} />
      <Line x={228} y={131} w={1} h={6} />
      <Line x={258} y={131} w={1} h={6} />
      <PSlider k={k('Time')} x={185} y={138} w={27} h={115} ticks="single" />
      <Cap x={184} y={258} w={24}>TIME</Cap>
      <PSlider k={k('Ofs')} x={212} y={138} w={32} h={115} ticks="double" />
      <Cap x={215} y={258} w={23}>OFS</Cap>
      <PSlider k={k('Sep')} x={244} y={138} w={28} h={115} />
      <Cap x={249} y={258} w={25}>SEP</Cap>
      <UKnob k={k('FbPan')} x={280} y={157} />
      <Cap x={280} y={200} w={44}>PAN</Cap>
      <UKnob k={k('FbVol')} x={280} y={216} />
      <Cap x={283} y={258} w={38}>VOL</Cap>

      {/* FB FILT */}
      <FilterDisplay u={tab} which="fb" x={340} y={98} mx={388} my={100} />
      <UKnob k={k('FbGain')} x={391} y={157} />
      <Cap x={391} y={200} w={44}>GAIN</Cap>
      <UKnob k={k('FbCut')} x={340} y={216} />
      <Cap x={343} y={258} w={38}>CUT</Cap>
      <UKnob k={k('FbRes')} x={391} y={216} />
      <Cap x={394} y={258} w={38}>RES</Cap>

      {/* GRAIN */}
      <Line x={465} y={131} w={27} h={1} />
      <Line x={465} y={131} w={1} h={6} />
      <Line x={491} y={131} w={1} h={6} />
      <StateSlider u={tab} field="div" x={452} y={138} w={27} h={115} min={0} max={16} ticks="single"
        label="Grain division" format={(v) => (v <= 0 ? 'off' : `${Math.round(v)}`)} />
      <Cap x={450} y={258} w={25}>DIV</Cap>
      <StateSlider u={tab} field="shape" x={478} y={138} w={27} h={115} min={-128} max={128}
        label="Grain shape" format={(v) => `${Math.round((v / 128) * 100)}%`} />
      <Cap x={482} y={258} w={25}>SH</Cap>

      {/* OUT */}
      {tab < DB_UNITS - 1 && <UKnob k={k('Next')} x={521} y={95} />}
      {tab < DB_UNITS - 1 && <Cap x={521} y={139} w={44}>NEXT</Cap>}
      <UKnob k={k('OutPan')} x={521} y={157} />
      <Cap x={521} y={200} w={44}>PAN</Cap>
      <UKnob k={k('OutVol')} x={521} y={216} />
      <Cap x={521} y={258} w={44}>VOL</Cap>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'delaybank', Editor: DelayBankEditor };
