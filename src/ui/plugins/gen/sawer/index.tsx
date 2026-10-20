// Sawer editor (FL: Sawer, SynthEditorForm 897 x 622): FL's layout at the form's coordinates
// (TVectorWheel knobs of 52 / 46 / 44 / 36 px, TVectorSlider faders, TSwitchSelector
// two-way switches, TVectorCheckBox section switches, the FS_DigiWheel combos of the MIDI
// modulation matrix, polyphony, bend range and arpeggiator speed, the MIDI link panel and
// the on-screen keyboard that covers the effect and matrix rows when shown). Labels use the
// texts FL's editor code paints (MASTER ... MIDI MODULATION MATRIX); original drawing in
// Sawer's colours (form colours), no Image-Line artwork. The plugin menu carries FL's option
// plus the optional import of FL's data.saw from the user's own FL install.

import { useRef, useState, type ReactNode } from 'react';
import { FxPanel, Label, SliderControl, WheelControl, useFxEditor, useFxState, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { host, store } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import {
  SW_ARP_SPEED_TEXT, SW_BEND_TEXT, SW_ENGINE_COUNT, SW_HIDDEN_DEFAULT, SW_PARAM_COUNT, SW_PARAM_KEYS, SW_PARAM_NAMES, SW_POLY_TEXT,
} from '../../../../model/gen/plugins/sawer/data';
import { forgetData, pickData, projectData, reuseData } from './fldata';

const C = {
  panel: '#3b3836', sect: '#33302e', edge: '#4a4643', head: '#e3b448', text: '#d9d2c4', dim: '#a19a8f',
  arc: '#e8b84a', track: '#1f1d1c', sw: '#272c2e', combo: '#171717', digi: '#585135', kbd: '#19110b', keys: '#9fa7ad', led: '#ffc83d',
};

// FL's mod matrix items (editor code): sources ' ---', Velocity, Aftertouch, PitchWheel, then MIDI CC 0..127
const CC_NAMES: Record<number, string> = {
  0: 'BankLSB', 1: 'ModWhl', 2: 'Breath', 4: 'Foot', 5: 'PortaTm', 6: 'DatEnt', 7: 'Vol [A]', 8: 'Bal', 11: 'Expr', 12: 'FX #1',
  13: 'FX #2', 16: 'GP #1', 17: 'GP #2', 18: 'GP #3', 19: 'GP #4', 32: 'Bank [A]', 64: 'Sust. [A]', 65: 'PortaOn', 66: 'Susten.',
  67: 'SoftPdl', 68: 'Legato', 69: 'Hold 2', 70: 'Snd #1', 71: 'Reson.', 72: 'Rel', 73: 'Atk', 74: 'Ctf', 75: 'Dec', 76: 'VibRate',
  77: 'VibDpth', 78: 'VibDel', 79: 'Snd #10', 80: 'GP #5', 81: 'GP #6', 82: 'GP #7', 83: 'GP #8', 84: 'PrtCtrl', 91: 'Fx1Dpth',
  92: 'Fx2Dpth', 93: 'Fx3Dpth', 94: 'Fx4Dpth', 95: 'Fx5Dpth', 96: 'DE +1', 97: 'DE -1', 120: 'ASO', 121: 'RA [A]', 123: 'ANO [A]',
  126: 'Mono', 127: 'Poly',
};
const ccName = (n: number): string => (n === 10 ? '10:Pan [A]' : CC_NAMES[n] ? `${n}: ${CC_NAMES[n]}` : `${n}: ---`);
export const SW_MOD_SOURCES = [' ---', 'Velocity', 'Aftertouch', 'PitchWheel', ...Array.from({ length: 128 }, (_, i) => ccName(i))];
export const SW_MOD_DESTS = SW_PARAM_NAMES.slice(0, SW_PARAM_COUNT);
const NH = SW_ENGINE_COUNT - SW_PARAM_COUNT;

function slotParams(slotId: string): Record<string, unknown> | undefined {
  const chId = channelOfSlot(slotId);
  const ch = chId ? store.project.channels.find((c) => c.id === chId) : undefined;
  return ch?.plugin?.params as Record<string, unknown> | undefined;
}

/** Tags the engine value a control edits (the link panel shows the last one touched). */
const Tag = ({ id, children }: { id: number; children: ReactNode }) => <div style={{ display: 'contents' }} data-swp={id}>{children}</div>;

function Section({ x, y, w, h, title }: { x: number; y: number; w: number; h: number; title: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: C.sect, border: `1px solid ${C.edge}`, borderRadius: 6, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.45)' }}>
      <div style={{ position: 'absolute', left: 8, top: 2, color: C.head, fontSize: 9, fontWeight: 800, letterSpacing: 1.4, whiteSpace: 'nowrap' }}>{title}</div>
    </div>
  );
}

const Cap = ({ x, y, w, children, color = C.dim }: { x: number; y: number; w: number; children: ReactNode; color?: string }) => (
  <Label x={x} y={y} w={w} h={10} size={8} bold color={color}>{children}</Label>
);

function Knob({ i, x, y, s, cap }: { i: number; x: number; y: number; s: number; cap?: string }) {
  const p = useParam(SW_PARAM_KEYS[i]);
  return (
    <Tag id={i}>
      <WheelControl x={x} y={y} size={s} control={p.control} color={C.arc} track={C.track} look="flat" bipolar={p.def.bipolar} />
      {cap && <Cap x={x - 16} y={y + s + 1} w={s + 32}>{cap}</Cap>}
    </Tag>
  );
}

/** A stepped knob with its options painted around it (FL: VOICES, MODE, SHAPE, DESTINATION...). */
function StepKnob({ i, x, y, s, cap, marks, r = 0.5 }: { i: number; x: number; y: number; s: number; cap?: string; marks: string[]; r?: number }) {
  const n = marks.length;
  const cx = x + s / 2, cy = y + s / 2, rad = s * (0.5 + r);
  return (
    <>
      <Knob i={i} x={x} y={y} s={s} cap={cap} />
      {marks.map((m, k) => {
        const a = ((-135 + (270 * k) / Math.max(1, n - 1)) * Math.PI) / 180;
        const lx = cx + Math.sin(a) * rad, ly = cy - Math.cos(a) * rad;
        return <Label key={k} x={lx - 24} y={ly - 5} w={48} h={10} size={7} bold color={C.dim}>{m}</Label>;
      })}
    </>
  );
}

function Fader({ i, x, y, w, h, cap }: { i: number; x: number; y: number; w: number; h: number; cap?: string }) {
  const p = useParam(SW_PARAM_KEYS[i]);
  return (
    <Tag id={i}>
      <SliderControl x={x} y={y} w={w} h={h} control={p.control} capColor={C.arc} />
      {cap && <Cap x={x - 14} y={y + h + 1} w={w + 28}>{cap}</Cap>}
    </Tag>
  );
}

/** TSwitchSelector (19 x 54): a two-way lever; the upper label is the On state. */
function Switch({ i, x, y, on, off }: { i: number; x: number; y: number; on: string; off?: string }) {
  const p = useParam(SW_PARAM_KEYS[i]);
  const v = p.value !== 0;
  const flip = (e: React.PointerEvent) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(v ? 0 : 256); p.control.onEnd?.(); };
  return (
    <Tag id={i}>
      <Cap x={x - 20} y={y - 11} w={59} color={v ? C.head : C.dim}>{on}</Cap>
      <div className="fxk-abs" title={p.def.name} onPointerDown={flip}
        style={{ left: x + 3, top: y + 2, width: 13, height: 50, borderRadius: 7, background: C.sw, boxShadow: 'inset 0 1px 3px #000', cursor: 'pointer' }}>
        <div style={{ position: 'absolute', left: 1, top: v ? 2 : 27, width: 11, height: 21, borderRadius: 5, background: v ? `linear-gradient(${C.led},#b8861c)` : 'linear-gradient(#8d8780,#56514c)', boxShadow: '0 1px 2px #000' }} />
      </div>
      {off && <Cap x={x - 20} y={y + 55} w={59} color={v ? C.dim : C.text}>{off}</Cap>}
    </Tag>
  );
}

/** TVectorCheckBox (30 x 28): a lit square button. */
function Check({ i, x, y, cap, capRight = true }: { i: number; x: number; y: number; cap?: string; capRight?: boolean }) {
  const p = useParam(SW_PARAM_KEYS[i]);
  const v = p.value !== 0;
  return (
    <Tag id={i}>
      <div className="fxk-abs" title={p.def.name}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(v ? 0 : 256); p.control.onEnd?.(); }}
        style={{ left: x + 6, top: y + 6, width: 18, height: 16, borderRadius: 3, cursor: 'pointer', background: v ? C.led : '#2a2725', border: '1px solid #151312', boxShadow: v ? `0 0 7px ${C.led}99` : 'inset 0 1px 2px #000' }} />
      {cap && <Label x={capRight ? x + 28 : x - 21} y={y + 9} w={capRight ? 60 : 72} h={10} size={8} bold color={v ? C.head : C.dim} align={capRight ? 'left' : 'center'}>{cap}</Label>}
    </Tag>
  );
}

// ------------------------------------------------------------------ hidden settings (state `hidden`, engine ids 73..95)
function useHidden(id: number): [number, (v: number, label: string) => void] {
  const ctx = useFxEditor();
  const hid = useFxState<number[]>('hidden', SW_HIDDEN_DEFAULT);
  const v = Number(hid[id - SW_PARAM_COUNT]);
  const set = (x: number, label: string) => A.editFx(ctx.slotId, label, (p) => {
    const h = Array.isArray(p.hidden) ? (p.hidden as number[]).slice() : SW_HIDDEN_DEFAULT.slice();
    while (h.length < NH) h.push(SW_HIDDEN_DEFAULT[h.length]);
    h[id - SW_PARAM_COUNT] = x;
    p.hidden = h;
  });
  return [Number.isFinite(v) ? v : SW_HIDDEN_DEFAULT[id - SW_PARAM_COUNT], set];
}

/** TQuickCombo in FS_DigiWheel style: click for the list, mouse wheel to step. */
function Combo({ id, x, y, w, h, items, label, color = C.combo, size = 9 }: { id: number; x: number; y: number; w: number; h: number; items: string[]; label: string; color?: string; size?: number }) {
  const [v, set] = useHidden(id);
  const idx = Math.trunc(v);
  const text = items[idx] ?? (Number.isFinite(idx) ? String(idx) : items[0]);
  return (
    <div className="fxk-abs" title={label}
      style={{ left: x, top: y, width: w, height: h, background: color, borderRadius: '5px 5px 2px 2px', color: C.text, fontSize: size, fontWeight: 600, lineHeight: `${h}px`, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', cursor: 'pointer', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 1px 2px #000' }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, items.map((it, k) => ({ label: it.trim() || '---', radio: true, checked: k === idx, onClick: () => set(k, label) })));
      }}
      onWheel={(e) => { const n = Math.max(0, Math.min(items.length - 1, idx + (e.deltaY < 0 ? 1 : -1))); if (n !== idx) set(n, label); }}>
      {text}
    </div>
  );
}

/** A modulation amount (engine 78..83: 0..1, amount = |2v - 1| (2v - 1)). */
function ModAmount({ id, x, y }: { id: number; x: number; y: number }) {
  const [v, set] = useHidden(id);
  const label = `Mod${id - 77} amount`;
  const control: ControlProps = {
    value: v, min: 0, max: 1, step: 0, defaultValue: 0.5, label,
    onChange: (x2) => set(x2, label),
    onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture(),
    format: (x2) => { const s = 2 * x2 - 1; return `${Math.round(Math.abs(s) * s * 100)}%`; },
  };
  return <WheelControl x={x} y={y} size={34} control={control} color={C.arc} track={C.track} look="flat" bipolar />;
}

// ------------------------------------------------------------------ MIDI link panel
function LinkPanel({ sel }: { sel: number }) {
  const ctx = useFxEditor();
  const map = useFxState<number[]>('ccMap', []);
  const cc = sel >= 0 ? Number(map[sel] ?? -1) : -1;
  const link = (c: number) => A.editFx(ctx.slotId, c < 0 ? 'Unlink CC' : 'Link CC', (p) => {
    const m = Array.isArray(p.ccMap) ? (p.ccMap as number[]).slice() : new Array(SW_ENGINE_COUNT).fill(-1);
    m[sel] = c;
    p.ccMap = m;
  });
  const btn = (x: number, w: number, t: string, hint: string, on: (e: React.PointerEvent) => void) => (
    <div className="fxk-abs" title={hint} onPointerDown={(e) => { if (e.button === 0 && sel >= 0) { e.stopPropagation(); on(e); } }}
      style={{ left: 40 + x, top: 14, width: w, height: 14, borderRadius: 4, background: '#c7c7c7', color: '#222', fontSize: 8, fontWeight: 800, lineHeight: '14px', textAlign: 'center', cursor: 'pointer' }}>{t}</div>
  );
  const lcd = (x: number, w: number, t: string) => (
    <div className="fxk-abs" style={{ left: 40 + x, top: 15, width: w, height: 13, borderRadius: 4, background: C.digi, color: '#f0e6c0', fontSize: 8, fontWeight: 700, lineHeight: '13px', textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden' }}>{t}</div>
  );
  return (
    <>
      <Label x={40} y={17} w={30} h={9} size={7} bold color={C.dim}>CTRL</Label>
      {lcd(32, 37, cc >= 0 ? String(cc) : '---')}
      {btn(74, 35, 'LINK', 'Link CC to selected parameter', (e) => openMenu(e.clientX, e.clientY, Array.from({ length: 128 }, (_, c) => ({ label: `CC ${c}`, radio: true, checked: c === cc, onClick: () => link(c) }))))}
      {btn(113, 47, 'UNLINK', 'Unlink CC from selected parameter', () => link(-1))}
      <Label x={203} y={17} w={37} h={9} size={7} bold color={C.dim}>PARAM</Label>
      {lcd(201, 115, sel >= 0 ? SW_PARAM_NAMES[sel] ?? `Mod ${sel}` : '---')}
    </>
  );
}

// ------------------------------------------------------------------ keyboard
const WHITE = [0, 2, 4, 5, 7, 9, 11];
function Keyboard({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const ctx = useFxEditor();
  const ch = channelOfSlot(ctx.slotId);
  const held = useRef(new Map<number, number>());
  const [down, setDown] = useState<number[]>([]);
  const oct = 5, nWhite = oct * 7, kw = w / nWhite;
  const keys: { key: number; x: number; w: number; black: boolean }[] = [];
  for (let o = 0; o < oct; o++) {
    WHITE.forEach((s, j) => keys.push({ key: 36 + o * 12 + s, x: (o * 7 + j) * kw, w: kw, black: false }));
    [1, 3, 6, 8, 10].forEach((s) => {
      const j = WHITE.findIndex((ws) => ws > s) - 1;
      keys.push({ key: 36 + o * 12 + s, x: (o * 7 + j + 1) * kw - kw * 0.32, w: kw * 0.64, black: true });
    });
  }
  const on = (key: number, vel: number) => {
    if (ch === null || held.current.has(key)) return;
    held.current.set(key, host.noteOn(ch, key, vel));
    setDown([...held.current.keys()]);
  };
  const off = (key: number) => {
    const tag = held.current.get(key);
    if (ch === null || tag === undefined) return;
    host.noteOff(ch, key, tag);
    held.current.delete(key);
    setDown([...held.current.keys()]);
  };
  const keyEl = (k: (typeof keys)[number]) => (
    <div key={k.key} style={{ position: 'absolute', left: k.x, top: 0, width: k.w - (k.black ? 0 : 1), height: k.black ? h * 0.62 : h, zIndex: k.black ? 2 : 1, background: down.includes(k.key) ? C.head : k.black ? '#151515' : C.keys, borderRadius: '0 0 3px 3px', boxShadow: k.black ? '0 2px 3px rgba(0,0,0,0.7)' : 'inset 0 -4px 0 #7f878d' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); const rel = (e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top) / (k.black ? h * 0.62 : h); on(k.key, Math.round(40 + 87 * Math.min(1, rel))); }}
      onPointerUp={() => off(k.key)} onPointerCancel={() => off(k.key)} />
  );
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#000' }}>
      {keys.filter((k) => !k.black).map(keyEl)}
      {keys.filter((k) => k.black).map(keyEl)}
    </div>
  );
}

// ------------------------------------------------------------------ the editor
function SawerEditor() {
  const ctx = useFxEditor();
  const view = useFxView();
  const keysOn = useFxState<boolean>('swKeys', true) !== false;
  const linkOn = useFxState<boolean>('swLink', false) === true;
  const [sel, setSel] = useState(-1);
  const pick = (e: React.PointerEvent) => {
    let el = e.target as HTMLElement | null;
    while (el && el !== e.currentTarget) {
      const t = el.getAttribute?.('data-swp');
      if (t !== null && t !== undefined) { setSel(Number(t)); return; }
      el = el.parentElement;
    }
  };
  const mods = [0, 1, 2, 3, 4, 5].map((k) => ({ k, x: [34, 246, 457][k >> 1], y: [536, 566][k & 1] }));
  return (
    <FxPanel width={897} height={622} style={{ background: `linear-gradient(180deg, #45413e 0%, ${C.panel} 18%, #322f2d 100%)` }}>
      <div onPointerDownCapture={pick} style={{ display: 'contents' }}>
        {/* title bar */}
        <div className="fxk-abs" title="MIDI controls" onPointerDown={(e) => { if (e.button === 0) view('MIDI controls', (p) => { p.swLink = !linkOn; }); }}
          style={{ left: 26, top: 15, width: 12, height: 12, borderRadius: 3, border: '1px solid #c7c7c7', background: linkOn ? C.led : 'transparent', cursor: 'pointer' }} />
        {linkOn ? <LinkPanel sel={sel} /> : <Label x={44} y={15} w={120} h={12} size={8} bold color={C.dim} align="left">MIDI CONTROLS</Label>}
        <div className="fxk-abs" style={{ left: 378, top: 6, width: 142, height: 30, color: C.head, fontSize: 25, fontWeight: 900, letterSpacing: 7, fontStyle: 'italic', textAlign: 'center', textShadow: '0 2px 0 #000' }}>SAWER</div>
        <Label x={548} y={16} w={120} h={10} size={7} bold color={C.dim}>IMAGE LINE</Label>
        <div className="fxk-abs" title="Options" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); openMenu(e.clientX, e.clientY, menu(ctx.slotId)); } }}
          style={{ left: 751, top: 14, width: 21, height: 21, color: '#9192a1', fontSize: 15, lineHeight: '21px', textAlign: 'center', cursor: 'pointer' }}>&#9776;</div>
        <Cap x={769} y={4} w={59}>POLYPHONY</Cap>
        <Combo id={75} x={775} y={15} w={47} h={19} items={SW_POLY_TEXT} label="Polyphony" color={C.digi} size={11} />
        <Cap x={819} y={4} w={59}>BEND RANGE</Cap>
        <Combo id={76} x={825} y={15} w={47} h={19} items={SW_BEND_TEXT} label="Bend range" color={C.digi} size={11} />

        {/* row 1: master, tuning, glide, voice mode, unison */}
        <Section x={20} y={48} w={280} h={120} title="MASTER" />
        <Section x={306} y={48} w={96} h={120} title="TUNING" />
        <Section x={406} y={48} w={146} h={120} title="GLIDE MODE" />
        <Section x={556} y={48} w={120} h={120} title="VOICES" />
        <Section x={680} y={48} w={197} h={120} title="UNISON" />
        <Knob i={0} x={35} y={81} s={52} cap="LEVEL" />
        <Cap x={20} y={70} w={30}>-24</Cap><Cap x={72} y={70} w={30}>24</Cap><Cap x={46} y={64} w={30}>dB</Cap>
        <Knob i={1} x={99} y={81} s={52} cap="PANNING" />
        <Cap x={88} y={70} w={20}>L</Cap><Cap x={142} y={70} w={20}>R</Cap>
        <Fader i={2} x={175} y={67} w={22} h={86} cap="A" />
        <Fader i={3} x={205} y={67} w={22} h={86} cap="D" />
        <Fader i={4} x={235} y={67} w={22} h={86} cap="S" />
        <Fader i={5} x={265} y={67} w={22} h={86} cap="R" />
        <Fader i={6} x={322} y={67} w={19} h={86} cap="TRANSPOSE" />
        <Cap x={338} y={64} w={26}>12</Cap><Cap x={338} y={105} w={26}>0</Cap><Cap x={338} y={146} w={26}>-12</Cap>
        <Fader i={7} x={368} y={67} w={19} h={86} cap="FINE" />
        <Cap x={381} y={64} w={24}>100</Cap><Cap x={381} y={105} w={24}>0</Cap><Cap x={381} y={146} w={24}>-100</Cap>
        <Switch i={9} x={413} y={76} on="STATIC" off="VARI" />
        <Switch i={10} x={450} y={76} on="BEND" off="HELD" />
        <Knob i={11} x={490} y={81} s={52} cap="TIME" />
        <Cap x={478} y={128} w={24}>MIN</Cap><Cap x={530} y={128} w={24}>MAX</Cap>
        <Switch i={8} x={564} y={76} on="MONO" off="POLY" />
        <Switch i={12} x={600} y={76} on="OCT" />
        <Switch i={13} x={637} y={76} on="RETRIG" />
        <StepKnob i={14} x={692} y={85} s={46} cap="VOICES" marks={['1', '2', '4', '8']} r={0.32} />
        <Knob i={15} x={750} y={81} s={52} cap="DETUNE" />
        <Knob i={16} x={811} y={81} s={52} cap="PAN" />

        {/* rows 2 / 3: oscillators and sub-saw, filter and its envelope, LFO */}
        <Section x={20} y={176} w={280} h={196} title="OSCILLATORS" />
        <Section x={306} y={176} w={312} h={196} title="FILTER" />
        <Section x={622} y={176} w={255} h={196} title="LFO" />
        <Knob i={26} x={35} y={197} s={52} cap="NOISE LEVEL" />
        <Knob i={24} x={99} y={197} s={52} cap="SYNC FREQ" />
        <Check i={25} x={145} y={193} cap="SYNC" capRight={false} />
        <Switch i={21} x={195} y={207} on="RETRIG" />
        <Switch i={22} x={233} y={207} on="INVERT" />
        <Switch i={23} x={268} y={207} on="SQUARE" />
        <Cap x={28} y={276} w={70} color={C.head}>SUB-SAW</Cap>
        <Knob i={19} x={36} y={294} s={52} cap="LEVEL" />
        <Knob i={17} x={99} y={294} s={52} cap="PHASE" />
        <StepKnob i={18} x={175} y={301} s={44} cap="OCTAVE" marks={['-2', '', '-1', '', '0', '', '1', '', '2']} r={0.3} />
        <Knob i={20} x={239} y={294} s={52} cap="DETUNE" />
        <Knob i={27} x={308} y={197} s={52} cap="CUTOFF" />
        <Knob i={28} x={368} y={197} s={52} cap="RESO" />
        <Knob i={29} x={429} y={197} s={52} cap="KBD TRACK" />
        <Knob i={30} x={490} y={197} s={52} cap="VELO TRACK" />
        <StepKnob i={31} x={562} y={201} s={44} cap="MODE" marks={['LP24', 'LP12', 'BP', 'HP']} r={0.36} />
        <Cap x={312} y={276} w={140} color={C.head}>FILTER ENVELOPE</Cap>
        <Fader i={32} x={313} y={289} w={22} h={76} cap="A" />
        <Fader i={33} x={345} y={289} w={22} h={76} cap="D" />
        <Fader i={34} x={378} y={289} w={22} h={76} cap="S" />
        <Fader i={35} x={411} y={289} w={22} h={76} cap="R" />
        <Fader i={36} x={454} y={289} w={22} h={76} cap="AMOUNT" />
        <StepKnob i={37} x={530} y={303} s={44} cap="DESTINATION" marks={['CUTOFF', 'SYNC', 'SUB PHASE', 'MASTER FREQ']} r={0.42} />
        <Knob i={39} x={629} y={197} s={52} cap="SPEED" />
        <Knob i={41} x={689} y={197} s={52} cap="ATTACK" />
        <Knob i={42} x={750} y={197} s={52} cap="RELEASE" />
        <Knob i={45} x={811} y={197} s={52} cap="AMOUNT" />
        <Switch i={43} x={633} y={291} on="RETRIG" />
        <Switch i={40} x={669} y={291} on="TMP SYNC" />
        <Check i={44} x={697} y={270} cap="INV" />
        <StepKnob i={38} x={717} y={303} s={44} cap="SHAPE" marks={['TRI', 'SAW', 'SQR', 'RND']} r={0.34} />
        <StepKnob i={46} x={805} y={303} s={44} cap="DESTINATION" marks={['CUTOFF', 'SYNC', 'SUB', 'FREQ', 'NOISE', 'LEVEL', 'PAN']} r={0.4} />

        {/* rows 4 / 5: effects, MIDI modulation matrix, arpeggiator (under the keyboard when it is shown) */}
        {!keysOn && (
          <>
            <Section x={14} y={418} w={142} h={96} title="" />
            <Section x={158} y={418} w={222} h={96} title="" />
            <Section x={382} y={418} w={308} h={96} title="" />
            <Section x={692} y={418} w={186} h={96} title="" />
            <Check i={47} x={22} y={424} cap="CHORUS" />
            <Knob i={48} x={32} y={465} s={36} cap="DEPTH" />
            <Knob i={49} x={74} y={465} s={36} cap="RATE" />
            <Knob i={50} x={116} y={465} s={36} cap="MIX" />
            <Check i={51} x={162} y={424} cap="PHASER" />
            <Knob i={52} x={172} y={465} s={36} cap="CENTER" />
            <Knob i={53} x={214} y={465} s={36} cap="RATE" />
            <Knob i={54} x={256} y={465} s={36} cap="DEPTH" />
            <Knob i={55} x={298} y={465} s={36} cap="FDBACK" />
            <Knob i={56} x={340} y={465} s={36} cap="MIX" />
            <Check i={57} x={384} y={424} cap="DELAY" />
            <Knob i={58} x={396} y={465} s={36} cap="LEFT" />
            <Knob i={59} x={439} y={465} s={36} cap="RIGHT" />
            <Knob i={60} x={481} y={465} s={36} cap="FDBACK" />
            <Knob i={61} x={523} y={465} s={36} cap="DEPTH" />
            <Knob i={62} x={565} y={465} s={36} cap="LO-CUT" />
            <Knob i={63} x={607} y={465} s={36} cap="HI-CUT" />
            <Knob i={64} x={649} y={465} s={36} cap="MIX" />
            <Check i={65} x={694} y={424} cap="REVERB" />
            <Knob i={66} x={705} y={465} s={36} cap="DECAY" />
            <Knob i={67} x={747} y={465} s={36} cap="HI-CUT" />
            <Knob i={68} x={789} y={465} s={36} cap="DAMP" />
            <Knob i={69} x={832} y={465} s={36} cap="MIX" />

            <Section x={14} y={518} w={652} h={84} title="MIDI MODULATION MATRIX" />
            {[0, 1, 2].map((c) => (
              <div key={c} style={{ display: 'contents' }}>
                <Cap x={[34, 246, 457][c]} y={524} w={60}>SOURCE</Cap>
                <Cap x={[96, 307, 518][c]} y={524} w={44}>AMOUNT</Cap>
                <Cap x={[138, 350, 564][c]} y={524} w={90}>DESTINATION</Cap>
              </div>
            ))}
            {mods.map(({ k, x, y }) => (
              <div key={k} style={{ display: 'contents' }}>
                <Combo id={90 + k} x={x} y={y} w={60} h={22} items={SW_MOD_SOURCES} label={`Mod${k + 1} source`} />
                <ModAmount id={78 + k} x={x + 66} y={y - 7} />
                <Combo id={84 + k} x={x + 104} y={y} w={90} h={22} items={SW_MOD_DESTS} label={`Mod${k + 1} destination`} />
              </div>
            ))}
            <Section x={670} y={518} w={208} h={84} title="ARPEGGIATOR" />
            <StepKnob i={71} x={682} y={547} s={44} marks={['UP', 'DOWN', 'UP/DN', 'RND']} r={0.36} />
            <Check i={70} x={758} y={525} cap="PLAY" capRight={false} />
            <Combo id={74} x={750} y={566} w={49} h={22} items={SW_ARP_SPEED_TEXT} label="Arpeggiator speed" />
            <StepKnob i={72} x={814} y={547} s={44} cap="" marks={['1', '2', '3', '4']} r={0.3} />
            <Cap x={808} y={526} w={56}>RANGE</Cap>
          </>
        )}
        <div className="fxk-abs" title="Toggle keyboard" onPointerDown={(e) => { if (e.button === 0) view('Toggle keyboard', (p) => { p.swKeys = !keysOn; }); }}
          style={{ left: 854, top: 373, width: 21, height: 14, borderRadius: 3, border: '1px solid #c7c7c7', color: '#c7c7c7', fontSize: 9, lineHeight: '13px', textAlign: 'center', cursor: 'pointer', background: keysOn ? '#5a554f' : 'transparent' }}>&#9000;</div>
        {keysOn && (
          <div className="fxk-abs" style={{ left: 26, top: 428, width: 844, height: 170, background: C.kbd, borderRadius: 4, boxShadow: 'inset 0 1px 4px #000' }}>
            <div style={{ position: 'absolute', left: 0, right: 0, top: 3, textAlign: 'center', color: '#8a6f4c', fontSize: 9, fontWeight: 800, letterSpacing: 3 }}>IMAGE LINE</div>
            <Keyboard x={2} y={20} w={840} h={150} />
          </div>
        )}
      </div>
    </FxPanel>
  );
}

function menu(slotId: string): MenuItem[] {
  const params = slotParams(slotId);
  const using = typeof params?.sample === 'string' && !!params.sample;
  const inProject = projectData();
  return [
    { label: 'Convert old presets', disabled: true, hint: 'FL converts its old preset files here; Orchard reads every Sawer preset directly' },
    { separator: true },
    { label: 'Import FL data.saw...', onClick: () => pickData(slotId) },
    ...(!using && inProject ? [{ label: 'Use FL data.saw from this project', onClick: () => reuseData(slotId) }] : []),
    { label: 'Use the stand-in saw', checked: !using, disabled: !using, onClick: () => forgetData(slotId) },
  ];
}

export const editor: FxEditorModule = { id: 'sawer', Editor: SawerEditor, menu };
