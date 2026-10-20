// Voltage Controller editor (FL: Fruity Voltage Controller, SynthPanel 302 x 472): the ON switch and the
// settings menu on top, the plugin title, per output channel (Left / Right) a source combo, the note colour,
// the offset wheel with its polarity switch and the scale wheel, the live output voltage, the output tabs
// (Main, Out 2..4) with the target mixer track of the extra outputs, and FL's warning about continuous DC
// signals when ON is switched on. Positions are FL's form coordinates (the form's colours: panel #3c4346,
// digits #b9d5ff). Original drawing, no FL assets.

import { useRef, useState } from 'react';
import { FxPanel, Wheel, useFxEdit, useFxEditor, useFxMonitor, useFxState, useFxView, useParam } from '../../kit';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { useControl, type ControlProps } from '../../../widgets/control';
import {
  VC_CHANNELS, VC_CLOCK_PPQ, VC_RANGES, VC_SOURCES, VC_TABS, VC_TARGET_MAX, vcDefaultState, vcOfsKey, vcSclKey,
} from '../../../../model/gen/plugins/voltagectrl';
import { SourceCombo, Txt } from '../envctrl/Controls';
import type { FxEditorModule } from '../../registry';

const ACCENT = '#b9d5ff';
const PANEL = '#3c4346';
const SECTION = '#3c5375';
const DEFAULTS = vcDefaultState();

/** The ON switch: FL's vector check box (an LED and its caption). */
function OnSwitch({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: 17, top: 4, width: 39, height: 25, display: 'flex', alignItems: 'center', gap: 5, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint('Enable output; Warning, generates continous DC signals !')} onPointerLeave={clearHint}>
      <span style={{
        width: 11, height: 11, borderRadius: '50%', boxSizing: 'border-box', border: '1.5px solid #8a9094', flex: 'none',
        background: on ? 'radial-gradient(circle at 45% 40%, #e9ffc9 0%, #9be34a 55%, #5c9a1c 100%)' : '#2b3033', boxShadow: on ? '0 0 5px #9be34a' : 'none',
      }} />
      <span style={{ fontSize: 12.5, color: '#dfe5e8' }}>ON</span>
    </div>
  );
}

/** The settings button: a gear. */
function GearButton({ onClick }: { onClick: (e: React.PointerEvent) => void }) {
  return (
    <div className="fxk-abs" style={{ left: 259, top: 4, width: 28, height: 25, borderRadius: 4, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onClick(e); } }}
      onPointerEnter={() => setHint('Settings')} onPointerLeave={clearHint}>
      <svg width={18} height={18} viewBox="0 0 18 18">
        <g fill="none" stroke="#cdd3d8" strokeWidth={1.6}>
          <circle cx={9} cy={9} r={2.8} />
          {Array.from({ length: 8 }, (_, i) => (
            <path key={i} d="M9 1.6 V4.4" transform={`rotate(${i * 45} 9 9)`} strokeWidth={2.4} />
          ))}
          <circle cx={9} cy={9} r={5.2} />
        </g>
      </svg>
    </div>
  );
}

/** A small value box with drag / wheel / arrow changes (FL's digit wheel: the note colour, the target track). */
function DigiBox({ x, y, w, h, value, min, max, text, onChange, hint }: {
  x: number; y: number; w: number; h: number; value: number; min: number; max: number; text: string; onChange: (v: number) => void; hint: string;
}) {
  const control: ControlProps = {
    value, min, max, defaultValue: Math.max(min, Math.min(max, min <= 0 && max >= 0 ? 0 : min)), label: hint, step: 1, travel: Math.max(60, (max - min) * 5),
    format: () => text, onChange,
  };
  const hnd = useControl(control, 'vertical');
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 4, background: '#2c3236', border: '1px solid #20262a', display: 'flex', alignItems: 'center', justifyContent: 'center',
      color: ACCENT, fontSize: 16, fontWeight: 300, cursor: 'ns-resize', touchAction: 'none',
    }} {...hnd}>
      <span style={{ display: 'inline-block', transform: 'scaleX(0.8)' }}>{text}</span>
    </div>
  );
}

/** FL's offset polarity switch: an arrow from the baseline (unipolar: only adds) or around it (bipolar). */
function PolarityButton({ x, y, bipolar, onToggle, side }: { x: number; y: number; bipolar: boolean; onToggle: () => void; side: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 36, height: 41, cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onToggle(); } }}
      onPointerEnter={() => setHint(`${side} offset polarity (unipolar / bipolar): ${bipolar ? 'bipolar' : 'unipolar'}`)} onPointerLeave={clearHint}>
      <svg width={30} height={34} viewBox="0 0 30 34" fill="none" stroke={ACCENT} strokeWidth={1.8}>
        {bipolar ? (
          <>
            <path d="M3 17 H27" opacity={0.55} />
            <path d="M8 24 V10 M5 13 L8 9 L11 13" />
            <path d="M22 10 V24 M19 21 L22 25 L25 21" />
          </>
        ) : (
          <>
            <path d="M3 28 H27" opacity={0.55} />
            <path d="M9 26 V8 M6 11 L9 7 L12 11" />
            <path d="M21 26 V16 M18 19 L21 15 L24 19" opacity={0.6} />
          </>
        )}
      </svg>
    </div>
  );
}

/** The output tabs (Main, Out 2, Out 3, Out 4). */
function Tabs({ value, onChange }: { value: number; onChange: (i: number) => void }) {
  return (
    <div className="fxk-abs" style={{ left: 18, top: 441, width: 225, height: 26, display: 'flex', borderRadius: 4, overflow: 'hidden', background: SECTION }}
      onPointerEnter={() => setHint('Output selection')} onPointerLeave={clearHint}>
      {VC_TABS.map((t, i) => (
        <div key={t} style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11.5, fontWeight: 700, cursor: 'default',
          color: i === value ? ACCENT : '#9fa8ad', background: i === value ? 'rgba(255,255,255,0.10)' : 'transparent',
        }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onChange(i); } }}>{t}</div>
      ))}
    </div>
  );
}

function VoltageControllerEditor() {
  const { slotId } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const on = useFxState<boolean>('on', false);
  const src = useFxState<number[]>('src', DEFAULTS.src as number[]);
  const color = useFxState<number[]>('color', DEFAULTS.color as number[]);
  const bipolar = useFxState<boolean[]>('bipolar', DEFAULTS.bipolar as boolean[]);
  const range = useFxState<number>('range', 1);
  const pitchScale = useFxState<number>('pitchScale', 1);
  const ppq = useFxState<number>('ppq', 24);
  const pulse = useFxState<number>('pulse', 5);
  const target = useFxState<number[]>('target', [0, 0, 0]);
  const automap = useFxState<boolean>('automap', false);
  const warned = useFxState<boolean>('warned', false);
  const tabRaw = useFxState<number>('tab', 0);
  const tab = Math.max(0, Math.min(VC_TABS.length - 1, Math.round(tabRaw)));
  const [warning, setWarning] = useState(false);
  const [dontShow, setDontShow] = useState(false);
  const [volts, setVolts] = useState<number[]>(new Array(VC_CHANNELS).fill(0));
  const vk = useRef('');
  useFxMonitor(slotId, (d) => {
    const v = d.volts as number[] | undefined;
    if (!Array.isArray(v)) return;
    const k = v.join(',');
    if (k === vk.current) return;
    vk.current = k;
    setVolts(v.slice());
  });

  const chL = tab * 2, chR = tab * 2 + 1;
  const ofsL = useParam(vcOfsKey(chL)), ofsR = useParam(vcOfsKey(chR));
  const sclL = useParam(vcSclKey(chL)), sclR = useParam(vcSclKey(chR));

  const setOn = (v: boolean) => edit('Output on / off', (p) => { p.on = v; });
  const toggleOn = () => {
    if (!on && !warned) { setDontShow(false); setWarning(true); return; }
    setOn(!on);
  };

  const settings = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, [
      { label: 'Pitch scale', submenu: [
        { label: '1 V/Oct', radio: true, checked: pitchScale === 1, onClick: () => edit('Pitch scale', (p) => { p.pitchScale = 1; }) },
        { label: '1.2 V/Oct', radio: true, checked: pitchScale === 1.2, onClick: () => edit('Pitch scale', (p) => { p.pitchScale = 1.2; }) },
        { label: 'Adjust scaling factor...', onClick: () => {
          const s = window.prompt('Volts per octave', String(pitchScale));
          const v = s === null ? NaN : Number(s.replace(',', '.'));
          if (Number.isFinite(v) && v > 0) edit('Pitch scale', (p) => { p.pitchScale = Math.min(100, Math.max(0.01, v)); });
        } },
      ] },
      { label: 'Voltage range', submenu: VC_RANGES.map((n, i) => ({ label: n, radio: true, checked: range === i, onClick: () => edit('Voltage range', (p) => { p.range = i; }) })) },
      { label: 'Clock resolution', submenu: VC_CLOCK_PPQ.map((n) => ({ label: `${n} PPQ`, radio: true, checked: ppq === n, onClick: () => edit('Clock resolution', (p) => { p.ppq = n; }) })) },
      { label: 'Set trigger/clock pulse length...', onClick: () => {
        const s = window.prompt('Pulse length (ms)', String(pulse));
        const v = s === null ? NaN : Number(s.replace(',', '.'));
        if (Number.isFinite(v) && v > 0) edit('Pulse length', (p) => { p.pulse = Math.min(1000, Math.max(0.1, v)); });
      } },
      { separator: true },
      { label: 'Automap extra outputs', checked: automap, hint: 'Assign outputs 2, 3 and 4 to the mixer tracks following the plugin\'s track', onClick: () => edit('Automap extra outputs', (p) => { p.automap = !automap; }) },
    ]);
  };

  const channel = (side: 'Left' | 'Right', ch: number, x: number, ofs: ReturnType<typeof useParam>, scl: ReturnType<typeof useParam>, wx: number, sx: number, px: number, cx: number, tx: number) => (
    <>
      <SourceCombo x={x} y={110} w={75} h={23} items={VC_SOURCES} value={src[ch] ?? 0} used={VC_SOURCES.map(() => false)}
        onChange={(i) => edit(`${side} channel mod source`, (p) => { const a = (p.src as number[]).slice(); a[ch] = i; p.src = a; })} />
      <DigiBox x={cx} y={110} w={30} h={23} value={color[ch] ?? 1} min={1} max={16} text={String(color[ch] ?? 1)} hint={`${side} channel color`}
        onChange={(v) => edit(`${side} channel color`, (p) => { const a = (p.color as number[]).slice(); a[ch] = v; p.color = a; }, `vccolor${ch}`)} />
      <Wheel k={vcOfsKey(ch)} x={wx} y={154} size={90} color={ACCENT} bipolar control={{ ...ofs.control, label: `${side} offset` }} />
      <PolarityButton x={px} y={254} side={side} bipolar={bipolar[ch] !== false}
        onToggle={() => edit(`${side} offset polarity`, (p) => { const a = (p.bipolar as boolean[]).slice(); a[ch] = !(bipolar[ch] !== false); p.bipolar = a; })} />
      <Wheel k={vcSclKey(ch)} x={sx} y={315} size={80} color={ACCENT} bipolar control={{ ...scl.control, label: `${side} scale` }} />
      <Txt x={tx} y={408} w={side === 'Left' ? 89 : 94} h={21} align="center" size={12.5} weight={700} color="#dfe5e8">{`${side} voltage`}</Txt>
      <Txt x={tx} y={424} w={side === 'Left' ? 89 : 94} h={14} align="center" size={11} weight={500} color={ACCENT}>{`${(volts[ch] ?? 0).toFixed(3)} V`}</Txt>
    </>
  );

  return (
    <FxPanel width={302} height={472} style={{ background: PANEL }}>
      <OnSwitch on={on} onToggle={toggleOn} />
      <GearButton onClick={settings} />
      <Txt x={30} y={34} w={242} h={25} align="center" size={22} weight={300} color="#b4bec6" squeeze={0.85}>Fruity Voltage Controller</Txt>
      {channel('Left', chL, 33, ofsL, sclL, 33, 38, 60, 113, 34)}
      {channel('Right', chR, 193, ofsR, sclR, 178, 183, 205, 158, 176)}
      <Tabs value={tab} onChange={(i) => view('Output tab', (p) => { p.tab = i; })} />
      {tab > 0 && (
        <DigiBox x={248} y={440} w={38} h={28} value={automap ? tab : (target[tab - 1] ?? 0)} min={-VC_TARGET_MAX} max={VC_TARGET_MAX}
          text={(automap ? tab : (target[tab - 1] ?? 0)) === 0 ? '⋯' : `${(automap ? tab : (target[tab - 1] ?? 0)) > 0 ? '+' : ''}${automap ? tab : (target[tab - 1] ?? 0)}`}
          hint="Target mixer track (offset from the plugin's track)"
          onChange={(v) => edit('Target mixer track', (p) => { const a = (p.target as number[]).slice(); a[tab - 1] = v; p.target = a; }, `vctarget${tab}`)} />
      )}
      {warning && (
        <div className="fxk-abs" style={{ left: 22, top: 171, width: 265, height: 138, background: SECTION, borderRadius: 4, boxShadow: '0 4px 14px rgba(0,0,0,0.5)', zIndex: 10 }}>
          <Txt x={27} y={14} w={211} h={30} size={26} weight={300} color="#e6ecf0" squeeze={0.85}>Warning!</Txt>
          <Txt x={27} y={46} w={215} h={42} size={11.5} weight={500} color="#c9d3da" style={{ whiteSpace: 'normal', lineHeight: '14px' }}>
            This plugin generates continuous DC signals. Use a DC-coupled interface and keep speakers and headphones away from its outputs.
          </Txt>
          <div className="fxk-abs" style={{ left: 22, top: 100, width: 119, height: 25, display: 'flex', alignItems: 'center', gap: 6, cursor: 'default' }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setDontShow((v) => !v); } }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, border: '1.5px solid #bcc4d5', display: 'inline-block', background: dontShow ? '#bcc4d5' : 'transparent' }} />
            <span style={{ fontSize: 11.5, color: '#dfe5e8' }}>Don't show again</span>
          </div>
          <div className="fxk-abs" style={{
            left: 159, top: 97, width: 86, height: 30, borderRadius: 4, background: '#4a5f82', color: '#fff', fontSize: 13, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default',
          }} onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            setWarning(false);
            edit('Output on / off', (p) => { p.on = true; if (dontShow) p.warned = true; });
          }}>OK</div>
        </div>
      )}
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'voltagectrl', Editor: VoltageControllerEditor };
