// GMS editor (FL: GMS, 964 x 414: IL's bitmap editor, GMSynthEditor): every control at the
// position FL's construction code gives it (FL 2026 GMS_x64 0x26f70, extracted with a static
// interpreter): the synth screen (wave menus, oscillator pitch / fine numbers, mix, phase,
// unison, modulation kind / amount, octave) that the MIDI / EQ screen (velocity, mod wheel
// and aftertouch routing, pitch-bend range, five-band EQ) replaces, the filter / envelope /
// LFO faders with their switches, the channel section (level, ADSR, panning, pitch, slide),
// the ten effect buttons, the X / Y pad (momentary activation), X / Y knobs, glue and the
// effect LFO. Original drawing in GMS's colours; no Image-Line artwork. The plugin menu
// imports FL's Synth Waves from the user's own FL install.

import { useState, type ReactNode } from 'react';
import { FxPanel, Label, SliderControl, WheelControl, useFxEditor, useFxState, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import {
  GMS_FX_NAMES, GMS_FX_XY, GMS_MIDI_DESTS, GMS_PARAM_COUNT, GMS_PARAM_KEYS, GMS_SYNC_TEXT, gmsInternal, gmsMirror, type GmsStateLike,
} from '../../../../model/gen/plugins/gms/data';
import { GMS_SYNTH_WAVES } from '../../../../engine/gen/plugins/gms/waves';
import { forgetWaves, loadUserWave, pickFlWaves, projectWaves } from './flwaves';

const C = {
  bg: '#19191b', wood: '#7a4a24', panel: '#232326', edge: '#38383c', lcd: '#b9c2b4', lcdDark: '#2b3328', lcdDim: '#5d6a58',
  text: '#d6d6d0', dim: '#8d8d88', amber: '#f2a531', track: '#0e0e10', led: '#ff9b2f',
};
const W = 964, H = 414;

function slotParams(slotId: string): Record<string, unknown> | undefined {
  const chId = channelOfSlot(slotId);
  const ch = chId ? store.project.channels.find((c) => c.id === chId) : undefined;
  return ch?.plugin?.params as Record<string, unknown> | undefined;
}

/** Edit the state: the FL view values written back, then a change, then the views mirrored again. */
function editState(slotId: string, label: string, fn: (p: GmsStateLike) => void): void {
  A.editFx(slotId, label, (d) => {
    const p = d as unknown as GmsStateLike;
    const iv = Array.isArray(p.iv) ? (p.iv as number[]).slice() : [];
    const sel = Array.isArray(p.sel) ? (p.sel as number[]).slice() : [0, 0, 0];
    for (let i = 0; i < GMS_PARAM_COUNT; i++) {
      const m = gmsInternal(i, sel);
      const raw = Number(p[GMS_PARAM_KEYS[i]]);
      if (m < 0 || !Number.isFinite(raw)) continue;
      const cur = Number(iv[m]);
      if (Number.isFinite(cur) && raw === Math.trunc(Math.min(Math.max(cur, 0), 1) * 256)) continue;
      iv[m] = Math.fround(Math.min(Math.max(Math.fround(raw * 0.00390625), 0), 1));
    }
    p.iv = iv; p.sel = sel;
    fn(p);
    gmsMirror(p);
  });
}

const Box = ({ x, y, w, h, children, bg = C.panel }: { x: number; y: number; w: number; h: number; children?: ReactNode; bg?: string }) => (
  <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: bg, border: `1px solid ${C.edge}`, borderRadius: 4, boxShadow: 'inset 0 1px 3px rgba(0,0,0,0.6)' }}>{children}</div>
);
const Cap = ({ x, y, w, children, color = C.dim, size = 8 }: { x: number; y: number; w: number; children: ReactNode; color?: string; size?: number }) => (
  <Label x={x} y={y} w={w} h={10} size={size} bold color={color}>{children}</Label>
);

function Knob({ i, x, y, cap, s = 29, lcd = false }: { i: number; x: number; y: number; cap?: string; s?: number; lcd?: boolean }) {
  const p = useParam(GMS_PARAM_KEYS[i]);
  return (
    <>
      <WheelControl x={x} y={y} size={s} control={p.control} color={lcd ? C.lcdDark : C.amber} track={lcd ? '#9aa395' : C.track} look="flat" bipolar={p.def.bipolar} />
      {cap && <Cap x={x - 16} y={y + s + 1} w={s + 32} color={lcd ? C.lcdDark : C.dim}>{cap}</Cap>}
    </>
  );
}

function Fader({ i, x, y, cap, w = 20, h = 100 }: { i: number; x: number; y: number; cap?: string; w?: number; h?: number }) {
  const p = useParam(GMS_PARAM_KEYS[i]);
  return (
    <>
      <SliderControl x={x} y={y} w={w} h={h} control={p.control} capColor={C.amber} />
      {cap && <Cap x={x - 15} y={y - 11} w={w + 30}>{cap}</Cap>}
    </>
  );
}

function Led({ x, y, on, w = 11, h = 11 }: { x: number; y: number; on: boolean; w?: number; h?: number }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, borderRadius: 3, background: on ? C.led : '#3a2a1c', boxShadow: on ? `0 0 6px ${C.led}` : 'inset 0 1px 2px #000' }} />;
}

/** A two-state FL parameter as a lit button. */
function Toggle({ i, x, y, cap, w = 22, h = 14, lcd = false }: { i: number; x: number; y: number; cap?: string; w?: number; h?: number; lcd?: boolean }) {
  const p = useParam(GMS_PARAM_KEYS[i]);
  const on = p.value !== 0;
  return (
    <>
      <div className="fxk-abs" title={p.def.name}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 256); p.control.onEnd?.(); }}
        style={{ left: x, top: y, width: w, height: h, borderRadius: 3, cursor: 'pointer', background: on ? (lcd ? C.lcdDark : C.led) : lcd ? '#a6ae9f' : '#2b2b2e', border: `1px solid ${lcd ? C.lcdDim : '#111'}`, boxShadow: on && !lcd ? `0 0 6px ${C.led}88` : 'inset 0 1px 2px rgba(0,0,0,0.5)' }} />
      {cap && <Cap x={x - 18} y={y + h + 1} w={w + 36} color={lcd ? C.lcdDark : C.dim}>{cap}</Cap>}
    </>
  );
}

/** CControlStateSelector: n states, value i / (n - 1), click to step, the names lit. */
function States({ i, x, y, names, vertical = true, w = 40, step = 11, lcd = false }: { i: number; x: number; y: number; names: string[]; vertical?: boolean; w?: number; step?: number; lcd?: boolean }) {
  const p = useParam(GMS_PARAM_KEYS[i]);
  const n = names.length;
  const cur = Math.min(Math.max(Math.round((p.value / 256) * (n - 1)), 0), n - 1);
  const set = (k: number) => { p.control.onBegin?.(); p.set((k * 256) / (n - 1)); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" title={p.def.name} style={{ left: x, top: y, width: vertical ? w : w * n, height: vertical ? step * n : step + 2 }}>
      {names.map((nm, k) => (
        <div key={k} onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); set(k); }}
          style={{ position: 'absolute', left: vertical ? 0 : k * w, top: vertical ? k * step : 0, width: w, height: step, fontSize: 7, fontWeight: 800, lineHeight: `${step}px`, textAlign: 'center', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', color: k === cur ? (lcd ? '#e3ead9' : '#1a1206') : lcd ? C.lcdDark : C.dim, background: k === cur ? (lcd ? C.lcdDark : C.amber) : 'transparent', borderRadius: 2 }}>{nm}</div>
      ))}
    </div>
  );
}

/** "... Switch" parameters: the button steps the parameter they belong to. */
function Cycle({ target, n, x, y }: { target: number; n: number; x: number; y: number }) {
  const p = useParam(GMS_PARAM_KEYS[target]);
  const cur = Math.min(Math.max(Math.round((p.value / 256) * (n - 1)), 0), n - 1);
  return <div className="fxk-abs" title={`${p.def.name} (next)`}
    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set((((cur + 1) % n) * 256) / (n - 1)); p.control.onEnd?.(); }}
    style={{ left: x, top: y, width: 20, height: 15, borderRadius: 3, background: '#2b2b2e', border: '1px solid #111', cursor: 'pointer', color: C.amber, fontSize: 9, lineHeight: '14px', textAlign: 'center' }}>&#9656;</div>;
}

/** CControlNumber: a value shown as text, dragged vertically. */
function NumberBox({ i, x, y, w = 30, lcd = true, text }: { i: number; x: number; y: number; w?: number; lcd?: boolean; text?: (v: number) => string }) {
  const p = useParam(GMS_PARAM_KEYS[i]);
  const [drag, setDrag] = useState<{ y0: number; v0: number } | null>(null);
  return (
    <div className="fxk-abs" title={p.def.name}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); setDrag({ y0: e.clientY, v0: p.value }); p.control.onBegin?.(); }}
      onPointerMove={(e) => { if (drag) p.set(Math.min(256, Math.max(0, drag.v0 + (drag.y0 - e.clientY) * 2))); }}
      onPointerUp={() => { setDrag(null); p.control.onEnd?.(); }}
      style={{ left: x, top: y, width: w, height: 14, fontSize: 9, fontWeight: 700, lineHeight: '14px', textAlign: 'center', cursor: 'ns-resize', color: lcd ? C.lcdDark : C.amber, background: lcd ? '#aab3a5' : '#101012', borderRadius: 2 }}>
      {text ? text(p.value) : (p.def.format?.(p.value) ?? '').trim()}
    </div>
  );
}

// ------------------------------------------------------------------ internal values (MIDI / EQ screen: FL's ids 78..92 -> 197..211)
function useIv(id: number): [number, (v: number, label: string) => void] {
  const ctx = useFxEditor();
  const iv = useFxState<number[]>('iv', []);
  const v = Number(iv[id] ?? 0);
  return [Number.isFinite(v) ? v : 0, (x, label) => editState(ctx.slotId, label, (p) => { (p.iv as number[])[id] = x; })];
}

function IvKnob({ id, x, y, label, bipolar }: { id: number; x: number; y: number; label: string; bipolar?: boolean }) {
  const [v, set] = useIv(id);
  const control: ControlProps = {
    value: Math.min(Math.max(v, 0), 1), min: 0, max: 1, step: 0, defaultValue: 0.5, label,
    onChange: (x2) => set(x2, label), onBegin: () => store.beginGesture(label), onEnd: () => store.endGesture(),
    format: (x2) => (bipolar ? `${Math.round((x2 * 2 - 1) * 100)} %` : `${Math.round(x2 * 24 - 12)} dB`),
  };
  return <WheelControl x={x} y={y} size={29} control={control} color={C.lcdDark} track="#9aa395" look="flat" bipolar />;
}

function IvToggle({ id, x, y, label }: { id: number; x: number; y: number; label: string }) {
  const [v, set] = useIv(id);
  const on = v !== 0;
  return <div className="fxk-abs" title={label} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); set(on ? 0 : 1, label); } }}
    style={{ left: x, top: y, width: 20, height: 14, borderRadius: 3, cursor: 'pointer', background: on ? C.lcdDark : '#a6ae9f', border: `1px solid ${C.lcdDim}` }} />;
}

function IvMenu({ id, x, y, label }: { id: number; x: number; y: number; label: string }) {
  const [v, set] = useIv(id);
  const code = Math.trunc(v);
  const text = GMS_MIDI_DESTS[code] ?? GMS_MIDI_DESTS[0];
  return (
    <div className="fxk-abs" title={label}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const items: MenuItem[] = GMS_MIDI_DESTS.map((nm, k) => (nm === '' ? { separator: true } : [5, 9, 13, 16, 19].includes(k)
          ? { label: nm, header: true } : { label: nm, radio: true, checked: k === code, onClick: () => set(k, label) }));
        openMenu(e.clientX, e.clientY, items);
      }}
      style={{ left: x, top: y, width: 80, height: 14, fontSize: 8, fontWeight: 700, lineHeight: '14px', paddingLeft: 3, cursor: 'pointer', color: C.lcdDark, background: '#aab3a5', borderRadius: 2, whiteSpace: 'nowrap', overflow: 'hidden' }}>{text}</div>
  );
}

function BendRange({ x, y }: { x: number; y: number }) {
  const [v, set] = useIv(205);
  const n = Math.trunc(Math.fround(Math.min(Math.max(v, 0), 1) * 12));
  return <div className="fxk-abs" title="Pitch bend range"
    onWheel={(e) => set(Math.min(Math.max((n + (e.deltaY < 0 ? 1 : -1)) / 12, 0), 1), 'Pitch bend range')}
    onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); openMenu(e.clientX, e.clientY, Array.from({ length: 13 }, (_, k) => ({ label: `${k}`, radio: true, checked: k === n, onClick: () => set(k / 12, 'Pitch bend range') }))); }}
    style={{ left: x, top: y, width: 30, height: 14, fontSize: 9, fontWeight: 700, lineHeight: '14px', textAlign: 'center', cursor: 'pointer', color: C.lcdDark, background: '#aab3a5', borderRadius: 2 }}>{n}</div>;
}

// ------------------------------------------------------------------ waves
function WaveMenu({ k, x, y }: { k: number; x: number; y: number }) {
  const ctx = useFxEditor();
  const waves = useFxState<string[]>('waves', ['', '', '']);
  const pool = useFxState<Record<string, string>>('wavePool', {});
  const name = waves[k] ?? '';
  const set = (nm: string) => editState(ctx.slotId, `Wave ${k + 1}`, (p) => { const w = (p.waves as string[] | undefined)?.slice() ?? ['', '', '']; w[k] = nm; p.waves = w; });
  const step = (d: number) => {
    const i = GMS_SYNTH_WAVES.indexOf(name);
    set(GMS_SYNTH_WAVES[(i + d + GMS_SYNTH_WAVES.length) % GMS_SYNTH_WAVES.length]);
  };
  return (
    <>
      <div className="fxk-abs" title={`Wave ${k + 1}${pool[name] ? ' (FL file)' : name ? ' (stand-in)' : ''}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const items: MenuItem[] = GMS_SYNTH_WAVES.map((w) => ({ label: w.replace(/\.wav$/i, ''), radio: true, checked: w === name, onClick: () => set(w) }));
          items.push({ separator: true }, { label: 'Load Waveform...', onClick: () => loadUserWave(ctx.slotId, k) });
          openMenu(e.clientX, e.clientY, items);
        }}
        style={{ left: x, top: y, width: 110, height: 14, fontSize: 8, fontWeight: 700, lineHeight: '14px', paddingLeft: 4, cursor: 'pointer', color: C.lcdDark, background: '#aab3a5', borderRadius: 2, whiteSpace: 'nowrap', overflow: 'hidden' }}>
        {name ? name.replace(/\.(wav|aiff?|wv|ogg)$/i, '') : '---'}
      </div>
      <div className="fxk-abs" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); step(-1); } }} style={{ left: x - 16, top: y + 1, width: 7, height: 12, cursor: 'pointer', color: C.lcdDark, fontSize: 8 }}>&#9664;</div>
      <div className="fxk-abs" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); step(1); } }} style={{ left: x - 8, top: y + 1, width: 7, height: 12, cursor: 'pointer', color: C.lcdDark, fontSize: 8 }}>&#9654;</div>
    </>
  );
}

// ------------------------------------------------------------------ selections and effects
function SelTab({ which, x, y, names }: { which: 1 | 2; x: number; y: number; names: string[] }) {
  const ctx = useFxEditor();
  const sel = useFxState<number[]>('sel', [0, 0, 0]);
  const cur = sel[which] | 0;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 36 * names.length, height: 14 }}>
      {names.map((nm, k) => (
        <div key={k} onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); editState(ctx.slotId, which === 1 ? 'Envelope Number' : 'LFO Number', (p) => { (p.sel as number[])[which] = k; }); }}
          style={{ position: 'absolute', left: k * 36, top: 0, width: 34, height: 14, fontSize: 8, fontWeight: 800, lineHeight: '14px', textAlign: 'center', cursor: 'pointer', borderRadius: 3, color: k === cur ? '#1a1206' : C.dim, background: k === cur ? C.amber : '#2b2b2e' }}>{nm}</div>
      ))}
    </div>
  );
}

function FxButtons() {
  const ctx = useFxEditor();
  const sel = useFxState<number[]>('sel', [0, 0, 0]);
  const iv = useFxState<number[]>('iv', []);
  const short = ['DIST', 'CRSH', 'FLNG', 'PHSR', 'LPF', 'HPF', 'ECHO', 'RVRB', 'PAN', 'TRNC'];
  return (
    <>
      {short.map((nm, k) => {
        const x = 650 + 30 * k;
        const on = Number(iv[147 + k] ?? 0) !== 0;
        return (
          <div key={k} style={{ display: 'contents' }}>
            <div className="fxk-abs" title={GMS_FX_NAMES[k]}
              onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); editState(ctx.slotId, `Select ${GMS_FX_NAMES[k]}`, (p) => { (p.sel as number[])[0] = k; }); }}
              style={{ left: x, top: 93, width: 28, height: 28, borderRadius: 4, cursor: 'pointer', fontSize: 7, fontWeight: 800, lineHeight: '28px', textAlign: 'center', color: sel[0] === k ? '#1a1206' : C.text, background: sel[0] === k ? C.amber : '#2b2b2e', border: '1px solid #111' }}>{nm}</div>
            <Led x={x + 10} y={124} on={on} w={9} h={9} />
          </div>
        );
      })}
    </>
  );
}

/** The X / Y pad: dragging sets the selected effect's X / Y; pressing activates it (FL's "FX Activate"). */
function FxPad() {
  const ctx = useFxEditor();
  const view = useFxView();
  const px = useParam(GMS_PARAM_KEYS[18]), py = useParam(GMS_PARAM_KEYS[19]);
  const [down, setDown] = useState(false);
  const put = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1), fy = Math.min(Math.max(1 - (e.clientY - r.top) / r.height, 0), 1);
    px.set(Math.round(fx * 256)); py.set(Math.round(fy * 256));
  };
  void ctx;
  return (
    <div className="fxk-abs" title="FX X / Y (press to activate)"
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); setDown(true); view('FX Activate', (p) => { p.fxHold = true; }); px.control.onBegin?.(); put(e); }}
      onPointerMove={(e) => { if (down) put(e); }}
      onPointerUp={() => { setDown(false); view('FX Activate', (p) => { p.fxHold = false; }); px.control.onEnd?.(); }}
      style={{ left: 659, top: 144, width: 111, height: 111, borderRadius: '50%', cursor: 'crosshair', background: 'radial-gradient(circle, #33402f 0%, #1c2419 70%, #0d110c 100%)', border: '2px solid #444', boxShadow: down ? `0 0 10px ${C.amber}` : 'inset 0 0 10px #000' }}>
      <div style={{ position: 'absolute', left: (px.value / 256) * 107 - 3, top: (1 - py.value / 256) * 107 - 3, width: 8, height: 8, borderRadius: 4, background: down ? C.amber : '#9fc58e', boxShadow: `0 0 6px ${down ? C.amber : '#9fc58e'}` }} />
      <div style={{ position: 'absolute', left: 54, top: 0, width: 1, height: 107, background: '#3d4c38' }} />
      <div style={{ position: 'absolute', left: 0, top: 54, width: 107, height: 1, background: '#3d4c38' }} />
    </div>
  );
}

function SynthScreen() {
  return (
    <>
      <Label x={70} y={104} w={130} h={10} size={7} bold color={C.lcdDark} align="left">WAVESHAPE</Label>
      <Cap x={205} y={104} w={30} color={C.lcdDark} size={7}>PITCH</Cap>
      <Cap x={240} y={104} w={30} color={C.lcdDark} size={7}>FINE</Cap>
      {[0, 1, 2].map((k) => <WaveMenu key={k} k={k} x={87} y={117 + 16 * k} />)}
      {[70, 72, 74].map((i, k) => <NumberBox key={i} i={i} x={216} y={117 + 16 * k} />)}
      {[71, 73, 75].map((i, k) => <NumberBox key={i} i={i} x={250} y={117 + 16 * k} />)}
      <Cap x={58} y={168} w={80} color={C.lcdDark} size={7}>MODULATION</Cap>
      <States i={66} x={68} y={180} names={['1 SYNC', '2>1 FM', '2>1 RM']} vertical={false} w={55} step={12} lcd />
      <Fader i={65} x={83} y={200} w={179} h={14} />
      <Cap x={280} y={118} w={44} color={C.lcdDark} size={7}>OSC 2</Cap>
      <Knob i={63} x={296} y={130} lcd />
      <Toggle i={69} x={294} y={153} w={14} h={10} lcd />
      <Cap x={280} y={160} w={44} color={C.lcdDark} size={7}>OSC 3</Cap>
      <Knob i={64} x={296} y={171} lcd />
      <Knob i={60} x={296} y={207} cap="NOISE" lcd />
      <Cap x={330} y={118} w={44} color={C.lcdDark} size={7}>PHASE 2</Cap>
      <Knob i={67} x={344} y={130} lcd />
      <Toggle i={68} x={345} y={155} w={18} h={10} lcd />
      <Toggle i={62} x={345} y={184} w={18} h={10} lcd />
      <Knob i={61} x={344} y={207} cap="UNI PHASE" lcd />
      <Cap x={372} y={128} w={56} color={C.lcdDark} size={7}>UNISONO</Cap>
      <Knob i={56} x={384} y={141} cap="" lcd />
      <Knob i={58} x={389} y={175} lcd />
      <Knob i={57} x={397} y={207} cap="DETUNE" lcd />
      <Cap x={436} y={126} w={54} color={C.lcdDark} size={7}>OCTAVE</Cap>
      <States i={59} x={420} y={138} names={['-2', '-1', '0', '+1', '+2']} vertical={false} w={15} step={12} lcd />
      <Toggle i={55} x={438} y={207} w={24} h={14} cap="MONO" lcd />
    </>
  );
}

function MidiScreen() {
  return (
    <>
      <Cap x={60} y={118} w={100} color={C.lcdDark} size={7}>VELOCITY</Cap>
      <IvMenu id={199} x={73} y={132} label="Velocity destination" />
      <IvKnob id={198} x={98} y={161} label="Velocity amount" bipolar />
      <IvToggle id={200} x={165} y={152} label="Velocity to level" />
      <Cap x={150} y={168} w={50} color={C.lcdDark} size={6}>VEL &gt; LEVEL</Cap>
      <Cap x={205} y={118} w={100} color={C.lcdDark} size={7}>MODULATION</Cap>
      <IvMenu id={202} x={217} y={132} label="Mod wheel destination" />
      <IvKnob id={201} x={242} y={161} label="Mod wheel amount" bipolar />
      <Cap x={303} y={118} w={100} color={C.lcdDark} size={7}>AFTERTOUCH</Cap>
      <IvMenu id={204} x={315} y={132} label="Aftertouch destination" />
      <IvKnob id={203} x={340} y={161} label="Aftertouch amount" bipolar />
      <Cap x={414} y={134} w={60} color={C.lcdDark} size={7}>PITCH BEND</Cap>
      <BendRange x={429} y={147} />
      <Cap x={150} y={200} w={46} color={C.lcdDark} size={7}>EQ</Cap>
      <IvToggle id={206} x={162} y={212} label="EQ enable" />
      {[0, 1, 2, 3, 4].map((b) => (
        <div key={b} style={{ display: 'contents' }}>
          <IvKnob id={207 + b} x={207 + 50 * b} y={209} label={`EQ ${['80 Hz', '220 Hz', '1.2 kHz', '6 kHz', '12 kHz'][b]}`} />
          <Cap x={197 + 50 * b} y={240} w={50} color={C.lcdDark} size={6}>{['60', '220', '1500', '8000', '12000'][b]}</Cap>
        </div>
      ))}
    </>
  );
}

function GmsEditor() {
  const ctx = useFxEditor();
  const iv = useFxState<number[]>('iv', []);
  const sel = useFxState<number[]>('sel', [0, 0, 0]);
  const midi = Number(iv[197] ?? 0) !== 0;
  const [mx] = GMS_FX_XY[sel[0] ?? 0] ?? ['X', 'Y'];
  const my = (GMS_FX_XY[sel[0] ?? 0] ?? ['X', 'Y'])[1];
  return (
    <FxPanel width={W} height={H} style={{ background: `linear-gradient(90deg, ${C.wood} 0, #5a3518 16px, ${C.bg} 17px, ${C.bg} ${W - 17}px, #5a3518 ${W - 16}px, ${C.wood} 100%)` }}>
      <div className="fxk-abs" style={{ left: 30, top: 6, width: 300, height: 18, color: C.amber, fontSize: 10, fontWeight: 800, letterSpacing: 2 }}>GROOVE MACHINE SYNTH</div>
      {/* screen */}
      <Box x={50} y={96} w={445} h={168} bg={C.lcd} />
      {midi ? <MidiScreen /> : <SynthScreen />}
      <div className="fxk-abs" title="MIDI / EQ" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); editState(ctx.slotId, 'MIDI / EQ', (p) => { (p.iv as number[])[197] = midi ? 0 : 1; }); } }}
        style={{ left: 67, top: 238, width: 58, height: 20, borderRadius: 3, cursor: 'pointer', fontSize: 8, fontWeight: 800, lineHeight: '20px', textAlign: 'center', color: midi ? '#e3ead9' : C.lcdDark, background: midi ? C.lcdDark : '#a6ae9f' }}>{midi ? 'SYNTH' : 'MIDI/EQ'}</div>
      {/* filter / envelopes / LFOs */}
      <Box x={50} y={276} w={445} h={134} />
      <Cap x={60} y={280} w={80} color={C.amber}>FILTER</Cap>
      <Fader i={32} x={69} y={304} cap="CUTOFF" />
      <Fader i={33} x={99} y={304} cap="RES" />
      <Toggle i={34} x={124} y={303} cap="KBD" />
      <Cycle target={36} n={3} x={125} y={339} />
      <States i={36} x={121} y={358} names={['LP', 'BP', 'HP']} w={28} />
      <SelTab which={1} x={168} y={281} names={['EG1', 'EG2']} />
      <Fader i={40} x={179} y={304} cap="ATK" />
      <Fader i={41} x={209} y={304} cap="DEC" />
      <Fader i={42} x={239} y={304} cap="AMNT" />
      <Toggle i={43} x={266} y={303} cap="INV" />
      <Cycle target={39} n={4} x={267} y={339} />
      <States i={39} x={262} y={358} names={['CUT', 'MOD', 'PITCH', 'LFO']} w={34} />
      <SelTab which={2} x={318} y={281} names={['LFO1', 'LFO2']} />
      <Fader i={45} x={322} y={304} cap="RATE" />
      <Cycle target={50} n={3} x={349} y={339} />
      <States i={50} x={344} y={358} names={['NONE', 'BEAT', 'BAR']} w={30} />
      <Fader i={46} x={388} y={304} cap="AMNT" />
      <Toggle i={47} x={415} y={303} cap="RETRIG" />
      <Toggle i={48} x={454} y={303} cap="INV" />
      <Cycle target={52} n={4} x={416} y={339} />
      <States i={52} x={411} y={358} names={['CUT', 'MOD', 'PITCH', 'AMP']} w={34} />
      <Cycle target={54} n={4} x={455} y={339} />
      <States i={54} x={449} y={358} names={['SIN', 'TRI', 'SAW', 'SQR']} w={32} />
      {/* channel */}
      <Box x={505} y={96} w={130} h={314} />
      <Cap x={510} y={100} w={60} color={C.amber}>LEVEL EG</Cap>
      <Knob i={28} x={518} y={143} cap="AMP" />
      <Knob i={24} x={518} y={221} cap="ATTACK" />
      <Knob i={25} x={518} y={276} cap="DECAY" />
      <Knob i={26} x={518} y={331} cap="SUSTAIN" />
      <Knob i={27} x={518} y={387} />
      <Cap x={548} y={393} w={44}>RELEASE</Cap>
      <Cap x={580} y={100} w={50} color={C.amber}>CHANNEL</Cap>
      <Fader i={20} x={594} y={133} cap="OUT" w={20} h={100} />
      <Knob i={21} x={594} y={276} cap="PAN" />
      <NumberBox i={22} x={594} y={323} lcd={false} />
      <Cap x={588} y={338} w={42}>PITCH</Cap>
      <Knob i={30} x={594} y={364} />
      <Toggle i={31} x={593} y={399} w={30} h={10} />
      <Cap x={560} y={364} w={36}>SLIDE</Cap>
      {/* effects */}
      <Box x={645} y={84} w={300} h={326} />
      <FxButtons />
      <FxPad />
      <Cap x={780} y={132} w={50} color={C.amber}>FX LFO</Cap>
      <States i={12} x={782} y={143} names={GMS_SYNC_TEXT} w={36} step={11} />
      <Fader i={13} x={829} y={154} cap="" />
      <Cap x={818} y={256} w={40}>AMOUNT</Cap>
      <Cycle target={17} n={2} x={870} y={171} />
      <States i={17} x={894} y={164} names={['BEAT', 'BAR']} w={34} />
      <Cycle target={15} n={4} x={870} y={219} />
      <States i={15} x={894} y={202} names={['SIN', 'TRI', 'SAW', 'SQR']} w={34} />
      <Knob i={18} x={657} y={281} cap={mx.toUpperCase()} />
      <Knob i={19} x={781} y={281} cap={my.toUpperCase()} />
      <Toggle i={11} x={902} y={280} w={30} h={20} cap="GLUE" />
      <div className="fxk-abs" style={{ left: 760, top: 350, width: 170, height: 46, color: '#c9c9c4', fontSize: 30, fontWeight: 900, fontStyle: 'italic', letterSpacing: 4, textAlign: 'right', textShadow: '0 2px 0 #000, 0 0 8px #555' }}>GMS</div>
      <Label x={652} y={330} w={140} h={12} size={8} bold color={C.amber} align="left">{GMS_FX_NAMES[sel[0] ?? 0]}</Label>
    </FxPanel>
  );
}

function menu(slotId: string): MenuItem[] {
  const params = slotParams(slotId);
  const pool = (params?.wavePool ?? {}) as Record<string, string>;
  const n = Object.keys(pool).length;
  const inProject = projectWaves();
  return [
    { label: 'Import FL Synth Waves...', onClick: () => pickFlWaves(slotId) },
    ...(n === 0 && Object.keys(inProject).length ? [{ label: 'Use FL Synth Waves from this project', onClick: () => editState(slotId, 'Use FL Synth Waves', (p) => { p.wavePool = { ...inProject }; }) }] : []),
    { label: 'Use the stand-in waves', checked: n === 0, disabled: n === 0, onClick: () => forgetWaves(slotId) },
  ];
}

export const editor: FxEditorModule = { id: 'gms', Editor: GmsEditor, menu };
