// PoiZone editor (FL: PoiZone, SynthEditorForm 855 x 521): FL's layout at the
// form's coordinates (TVectorWheel 40 x 40 knobs, TVectorSlider 25 x 72 sliders,
// 31 x 31 switch buttons, option selectors, digit wheels for the engine's hidden
// settings, the 16 trance-gate steps, the MIDI CC link display with LINK /
// UNLINK, pitch-bend and mod wheels, the on-screen keyboard). Original drawing in
// PoiZone's colours (panel #242526, yellow section headers, blue display; from
// the form's colours and FL's thumbnail).

import { useRef, useState } from 'react';
import {
  CheckView, DigiWheelControl, FxPanel, Label, SliderControl, WheelControl, useFxEditor, useFxState, useParam,
} from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { host } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import {
  PZ_ENUMS, PZ_HIDDEN_DEFAULT, PZ_LFO_SYNC_TEXT, PZ_PARAM_KEYS, PZ_PARAM_NAMES, PZ_SPEED_TEXT, PZ_UNISON_STEPS,
} from '../../../../model/gen/plugins/poizone/data';

const C = {
  panel: '#242526', panel2: '#1d1e1f', head: '#dec924', headText: '#1c1c10', text: '#c9cbcd', dim: '#8a8d90',
  arc: '#e8c43a', track: '#3a3b3c', lcd: '#4555c1', lcdText: '#e6ebff', btn: '#2a2b2d', led: '#ffd23a',
};

function Section({ x, y, w, h, title }: { x: number; y: number; w: number; h: number; title: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: C.panel2, borderRadius: 4, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.5)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 13, background: C.head, borderRadius: '4px 4px 0 0', color: C.headText, fontSize: 9, fontWeight: 800, letterSpacing: 1.2, lineHeight: '13px', paddingLeft: 6 }}>{title}</div>
    </div>
  );
}

function Knob({ k, x, y, cap }: { k: string; x: number; y: number; cap: string }) {
  const p = useParam(k);
  return (
    <>
      <WheelControl x={x} y={y} size={40} control={p.control} color={C.arc} track={C.track} look="flat" bipolar={p.def.bipolar} />
      <Label x={x - 12} y={y + 41} w={64} h={11} size={8} bold color={C.dim}>{cap}</Label>
    </>
  );
}

function VSlider({ k, x, y, cap }: { k: string; x: number; y: number; cap: string }) {
  const p = useParam(k);
  return (
    <>
      <SliderControl x={x} y={y} w={25} h={72} control={p.control} capColor={C.arc} />
      <Label x={x - 10} y={y + 73} w={45} h={11} size={8} bold color={C.dim}>{cap}</Label>
    </>
  );
}

/** FL's 31 x 31 switch button: a round button with a lamp. */
function Toggle({ k, x, y, cap, onText }: { k: string; x: number; y: number; cap: string; onText?: [string, string] }) {
  const p = useParam(k);
  const on = p.value !== 0;
  return (
    <>
      <div className="fxk-abs" title={p.def.name} style={{ left: x + 3, top: y + 3, width: 25, height: 25, borderRadius: 13, background: on ? '#4a4320' : C.btn, border: `1px solid ${on ? C.led : '#454649'}`, boxShadow: on ? `0 0 6px ${C.led}55` : 'inset 0 1px 2px rgba(0,0,0,0.6)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 7, fontWeight: 800, color: on ? C.led : C.dim }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); }}>
        {onText ? onText[on ? 1 : 0] : on ? 'ON' : 'OFF'}
      </div>
      <Label x={x - 12} y={y + 31} w={55} h={11} size={8} bold color={C.dim}>{cap}</Label>
    </>
  );
}

/** TPaintBoxSelector: the options as a lit list; FL's raw value = trunc(i x 256 / (n - 1)). */
function Selector({ k, x, y, w, h }: { k: string; x: number; y: number; w: number; h: number }) {
  const p = useParam(k);
  const idx = PZ_PARAM_KEYS.indexOf(k);
  const opts = PZ_ENUMS[idx] ?? ['1', '2', '3', '4'];
  const n = opts.length;
  const sel = (() => { const t = p.def.format?.(p.value) ?? ''; const i = opts.indexOf(t); return i < 0 ? 0 : i; })();
  const rowH = h / n;
  return (
    <div className="fxk-abs" title={p.def.name} style={{ left: x, top: y, width: w, height: h, background: '#2e2f30', borderRadius: 2, boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.6)' }}>
      {opts.map((o, i) => (
        <div key={o} style={{ position: 'absolute', left: 1, top: i * rowH, width: w - 2, height: rowH, fontSize: Math.min(8, rowH - 2), lineHeight: `${rowH}px`, fontWeight: 700, textAlign: 'center', color: i === sel ? '#1c1c10' : C.dim, background: i === sel ? C.head : 'transparent', borderRadius: 2, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden' }}
          onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(Math.trunc((i * 256) / (n - 1))); p.control.onEnd?.(); }}>{o}</div>
      ))}
    </div>
  );
}

/** A digit wheel for one of the engine's hidden settings (state `hidden`, engine ids 74..80). */
function Hidden({ i, x, y, min, max, label, text, toRaw, fromRaw }: { i: number; x: number; y: number; min: number; max: number; label: string; text: (v: number) => string; toRaw: (v: number) => number; fromRaw: (r: number) => number }) {
  const ctx = useFxEditor();
  const hid = useFxState<number[]>('hidden', PZ_HIDDEN_DEFAULT);
  const value = Math.max(min, Math.min(max, fromRaw(Number(hid[i - 74] ?? PZ_HIDDEN_DEFAULT[i - 74]))));
  const control: ControlProps = {
    value, min, max, step: 1, defaultValue: value, label,
    onChange: (v) => A.editFx(ctx.slotId, label, (p) => {
      const h = Array.isArray(p.hidden) ? (p.hidden as number[]).slice() : PZ_HIDDEN_DEFAULT.slice();
      h[i - 74] = toRaw(Math.round(v));
      p.hidden = h;
    }),
    format: (v) => text(Math.round(v)),
  };
  return <DigiWheelControl x={x} y={y} w={35} h={17} control={control} />;
}

function GateStep({ i, x, y }: { i: number; x: number; y: number }) {
  const p = useParam(`gate${i}`);
  const on = p.value !== 0;
  return <CheckView x={x} y={y} w={13} h={20} on={on} color={C.led} hint={p.def.name}
    onToggle={() => { p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); }} />;
}

/** The mod wheel drives MIDI CC 1 (FL's parameter "MIDI CC 1"); the pitch wheel springs back. */
function PerfWheel({ x, y, k, label }: { x: number; y: number; k?: string; label: string }) {
  const p = useParam(k ?? 'cc1');
  const [bend, setBend] = useState(0.5);
  const v = k ? p.value / 256 : bend;
  const drag = useRef<{ y0: number; v0: number } | null>(null);
  return (
    <>
      <div className="fxk-abs" title={label} style={{ left: x, top: y, width: 19, height: 94, borderRadius: 4, background: 'linear-gradient(90deg,#141414,#3a3b3c 50%,#141414)', boxShadow: 'inset 0 0 3px #000', cursor: 'ns-resize' }}
        onPointerDown={(e) => { (e.target as HTMLElement).setPointerCapture(e.pointerId); drag.current = { y0: e.clientY, v0: v }; if (k) p.control.onBegin?.(); }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const nv = Math.max(0, Math.min(1, drag.current.v0 - (e.clientY - drag.current.y0) / 90));
          if (k) p.set(Math.round(nv * 256)); else setBend(nv);
        }}
        onPointerUp={() => { drag.current = null; if (k) p.control.onEnd?.(); else setBend(0.5); }}>
        <div style={{ position: 'absolute', left: 2, right: 2, top: 4 + (1 - v) * 80, height: 6, background: C.head, borderRadius: 2 }} />
      </div>
      <Label x={x - 14} y={y + 95} w={47} h={11} size={8} bold color={C.dim}>{label}</Label>
    </>
  );
}

const WHITE = [0, 2, 4, 5, 7, 9, 11];
/** The on-screen keyboard (FL key 36..83); plays the channel. */
function Keyboard({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const ctx = useFxEditor();
  const ch = channelOfSlot(ctx.slotId);
  const held = useRef(new Map<number, number>());
  const [down, setDown] = useState<number[]>([]);
  const nWhite = 28, kw = w / nWhite;
  const keys: { key: number; x: number; w: number; black: boolean }[] = [];
  for (let o = 0; o < 4; o++) {
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
    <div key={k.key} style={{ position: 'absolute', left: k.x, top: 0, width: k.w - (k.black ? 0 : 1), height: k.black ? h * 0.6 : h, zIndex: k.black ? 2 : 1, background: down.includes(k.key) ? C.head : k.black ? '#101112' : '#e8e8e6', borderRadius: '0 0 2px 2px', boxShadow: k.black ? '0 2px 2px rgba(0,0,0,0.6)' : 'inset 0 -3px 0 #b7b7b7' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.target as HTMLElement).setPointerCapture(e.pointerId); const rel = (e.clientY - (e.currentTarget as HTMLElement).getBoundingClientRect().top) / (k.black ? h * 0.6 : h); on(k.key, Math.round(40 + 87 * Math.min(1, rel))); }}
      onPointerUp={() => off(k.key)} onPointerCancel={() => off(k.key)} />
  );
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#000', borderRadius: 2 }}>
      {keys.filter((k) => !k.black).map(keyEl)}
      {keys.filter((k) => k.black).map(keyEl)}
    </div>
  );
}

/** The MIDI CC link display: the last touched parameter and its linked CC (state `ccMap`). */
function LinkPanel() {
  const ctx = useFxEditor();
  const map = useFxState<number[]>('ccMap', new Array(74).fill(-1));
  const [sel, setSel] = useState(18);
  const link = (cc: number) => A.editFx(ctx.slotId, 'Link CC', (p) => {
    const m = Array.isArray(p.ccMap) ? (p.ccMap as number[]).slice() : new Array(74).fill(-1);
    m[sel] = cc;
    p.ccMap = m;
  });
  const lcd = (y: number, text: string, onClick?: (e: React.PointerEvent) => void) => (
    <div className="fxk-abs" style={{ left: 33, top: y, width: 154, height: 15, background: C.lcd, borderRadius: 4, color: C.lcdText, fontSize: 9, fontWeight: 700, lineHeight: '15px', textAlign: 'center', boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.5)', cursor: onClick ? 'pointer' : 'default', whiteSpace: 'nowrap', overflow: 'hidden' }}
      onPointerDown={onClick}>{text}</div>
  );
  const choose = (e: React.PointerEvent) => {
    const items: MenuItem[] = PZ_PARAM_NAMES.slice(0, 74).map((nm, i) => ({ label: nm, radio: true, checked: i === sel, onClick: () => setSel(i) }));
    openMenu(e.clientX, e.clientY, items);
  };
  const cc = Number(map[sel] ?? -1);
  return (
    <>
      {lcd(66, PZ_PARAM_NAMES[sel], choose)}
      {lcd(89, cc >= 0 ? `CC: ${cc}` : '---')}
      <div className="fxk-abs" style={{ left: 203, top: 65, width: 43, height: 16, background: '#232a50', color: '#c8d0ff', fontSize: 8, fontWeight: 800, lineHeight: '16px', textAlign: 'center', borderRadius: 2, cursor: 'pointer' }}
        title="Link CC to selected parameter"
        onPointerDown={(e) => openMenu(e.clientX, e.clientY, Array.from({ length: 128 }, (_, c) => ({ label: `CC ${c}`, radio: true, checked: c === cc, onClick: () => link(c) })))}>LINK</div>
      <div className="fxk-abs" style={{ left: 203, top: 88, width: 43, height: 16, background: '#232a50', color: '#c8d0ff', fontSize: 8, fontWeight: 800, lineHeight: '16px', textAlign: 'center', borderRadius: 2, cursor: 'pointer' }}
        title="Unlink CC from selected parameter" onPointerDown={() => link(-1)}>UNLINK</div>
    </>
  );
}

function PoiZoneEditor() {
  return (
    <FxPanel width={855} height={521} style={{ background: `linear-gradient(180deg, #2b2c2e 0%, ${C.panel} 40%, #1f2021 100%)` }}>
      {/* title bar */}
      <div className="fxk-abs" style={{ left: 16, top: 12, width: 260, height: 30, color: C.head, fontSize: 22, fontWeight: 900, letterSpacing: 6, fontStyle: 'italic', textShadow: '0 1px 0 #000' }}>POIZONE</div>
      {/* row 1 */}
      <Section x={14} y={50} w={242} h={74} title="MIDI LINK" />
      <Section x={270} y={50} w={118} h={74} title="VOICES" />
      <Section x={390} y={50} w={98} h={74} title="UNISON" />
      <Section x={490} y={50} w={146} h={74} title="MODE" />
      <Section x={638} y={50} w={54} h={74} title="GLIDE" />
      <Section x={696} y={50} w={96} h={74} title="TUNING" />
      <Section x={794} y={50} w={52} h={74} title="GAIN" />
      {/* row 2 */}
      <Section x={14} y={136} w={124} h={100} title="MODWHEEL" />
      <Section x={144} y={136} w={262} h={100} title="LFO" />
      <Section x={412} y={136} w={256} h={100} title="ENVELOPE" />
      <Section x={686} y={136} w={156} h={100} title="AMPLIFIER" />
      {/* row 3 */}
      <Section x={12} y={244} w={102} h={82} title="BALANCE" />
      <Section x={118} y={244} w={162} h={82} title="OSCILLATOR A" />
      <Section x={286} y={244} w={174} h={82} title="OSCILLATOR B" />
      <Section x={468} y={244} w={226} h={82} title="FILTER" />
      <Section x={698} y={244} w={146} h={82} title="ARPEGGIATOR" />
      {/* row 4 */}
      <Section x={12} y={330} w={358} h={68} title="DELAY" />
      <Section x={376} y={330} w={180} h={68} title="CHORUS" />
      <Section x={560} y={330} w={284} h={68} title="TRANCE GATE" />

      <LinkPanel />
      <Label x={274} y={66} w={60} h={11} size={8} bold color={C.dim}>UNISON</Label>
      <Hidden i={75} x={288} y={91} min={0} max={6} label="Unison" text={(v) => String(PZ_UNISON_STEPS[v] ?? 1)} toRaw={(v) => v} fromRaw={(r) => Math.trunc(r)} />
      <Label x={330} y={66} w={60} h={11} size={8} bold color={C.dim}>POLY</Label>
      <Hidden i={76} x={343} y={91} min={1} max={64} label="Polyphony" text={(v) => String(v)} toRaw={(v) => v - 1} fromRaw={(r) => Math.trunc(r) + 1} />
      <Knob k="uniDetune" x={395} y={78} cap="DETUNE" />
      <Knob k="uniPan" x={442} y={78} cap="PAN" />
      <Toggle k="octaver" x={493} y={88} cap="OCTAVER" />
      <Toggle k="mono" x={528} y={88} cap="MONO" />
      <Toggle k="glideHeld" x={563} y={88} cap="HELD" />
      <Toggle k="glideStatic" x={599} y={88} cap="STATIC" />
      <Knob k="glide" x={643} y={78} cap="TIME" />
      <Knob k="transpose" x={702} y={78} cap="COARSE" />
      <Knob k="fine" x={745} y={78} cap="FINE" />
      <Knob k="gain" x={800} y={78} cap="GAIN" />

      <Selector k="mwDest" x={22} y={169} w={45} h={60} />
      <Knob k="mwAmt" x={88} y={156} cap="AMOUNT" />
      <Label x={66} y={215} w={24} h={11} size={8} bold color={C.dim}>PB</Label>
      <Hidden i={78} x={91} y={212} min={1} max={12} label="MIDI PB range" text={(v) => String(v)} toRaw={(v) => v - 1} fromRaw={(r) => Math.trunc(r) + 1} />
      <Selector k="lfoDest" x={152} y={157} w={45} h={72} />
      <VSlider k="lfoAmt" x={215} y={158} cap="AMOUNT" />
      <VSlider k="lfoRate" x={257} y={158} cap="RATE" />
      <Selector k="lfoShape" x={296} y={169} w={45} h={60} />
      <Toggle k="lfoRetrig" x={365} y={155} cap="RETRIG" />
      <Label x={355} y={199} w={50} h={11} size={8} bold color={C.dim}>SYNC</Label>
      <Hidden i={80} x={363} y={212} min={0} max={9} label="LFO tempo sync" text={(v) => PZ_LFO_SYNC_TEXT[v] ?? 'Off'} toRaw={(v) => v} fromRaw={(r) => Math.max(0, Math.trunc(r))} />
      <Selector k="egDest" x={420} y={169} w={45} h={60} />
      <VSlider k="egAmt" x={483} y={158} cap="AMOUNT" />
      <VSlider k="egA" x={526} y={158} cap="A" />
      <VSlider k="egD" x={561} y={158} cap="D" />
      <VSlider k="egS" x={597} y={158} cap="S" />
      <VSlider k="egR" x={633} y={158} cap="R" />
      <VSlider k="ampA" x={694} y={158} cap="A" />
      <VSlider k="ampD" x={730} y={158} cap="D" />
      <VSlider k="ampS" x={766} y={158} cap="S" />
      <VSlider k="ampR" x={802} y={158} cap="R" />

      <Knob k="oscBal" x={19} y={271} cap="A / B" />
      <Knob k="noiseBal" x={67} y={271} cap="NOISE" />
      <Knob k="oscAPw" x={124} y={271} cap="PW" />
      <Toggle k="oscAShape" x={169} y={279} cap="SHAPE" onText={['SAW', 'PLS']} />
      <Toggle k="oscARing" x={206} y={279} cap="RING" />
      <Toggle k="oscASync" x={243} y={279} cap="SYNC" />
      <Knob k="oscBPw" x={293} y={271} cap="PW" />
      <Toggle k="oscBShape" x={335} y={279} cap="SHAPE" onText={['SAW', 'PLS']} />
      <Knob k="oscBPitch" x={370} y={271} cap="PITCH" />
      <Knob k="oscBDetune" x={413} y={271} cap="DETUNE" />
      <Knob k="cutoff" x={477} y={271} cap="CUTOFF" />
      <Knob k="reso" x={521} y={271} cap="RES" />
      <Knob k="keytrack" x={565} y={271} cap="KEY" />
      <Knob k="veltrack" x={610} y={271} cap="VEL" />
      <Selector k="filterMode" x={656} y={269} w={32} h={36} />
      <Selector k="arpMode" x={702} y={261} w={46} h={60} />
      <Selector k="arpRange" x={757} y={273} w={32} h={48} />
      <Label x={794} y={259} w={48} h={11} size={8} bold color={C.dim}>SPEED</Label>
      <Hidden i={77} x={800} y={272} min={0} max={6} label="Arpegiator tempo sync" text={(v) => PZ_SPEED_TEXT[v] ?? '1/16'} toRaw={(v) => v} fromRaw={(r) => Math.max(0, Math.trunc(r))} />

      <Toggle k="delayOn" x={16} y={350} cap="ON" />
      <Knob k="delayL" x={52} y={348} cap="TIME L" />
      <Knob k="delayR" x={97} y={348} cap="TIME R" />
      <Knob k="delayFb" x={142} y={348} cap="FDBK" />
      <Knob k="delayMod" x={187} y={348} cap="MOD" />
      <Knob k="delayLo" x={232} y={348} cap="LO CUT" />
      <Knob k="delayHi" x={277} y={348} cap="HI CUT" />
      <Knob k="delayWet" x={322} y={348} cap="WET" />
      <Toggle k="chorusOn" x={382} y={350} cap="ON" />
      <Knob k="chorusDepth" x={418} y={348} cap="DEPTH" />
      <Knob k="chorusRate" x={463} y={348} cap="RATE" />
      <Knob k="chorusWet" x={508} y={348} cap="WET" />
      <Knob k="gateSmooth" x={565} y={348} cap="SMOOTH" />
      <Knob k="gateMix" x={613} y={348} cap="MIX" />
      <Label x={660} y={348} w={48} h={11} size={8} bold color={C.dim}>SPEED</Label>
      <Hidden i={79} x={667} y={362} min={0} max={6} label="Gate tempo sync" text={(v) => PZ_SPEED_TEXT[v] ?? '1/32'} toRaw={(v) => v} fromRaw={(r) => Math.max(0, Math.trunc(r))} />
      {Array.from({ length: 16 }, (_, i) => <GateStep key={i} i={i + 1} x={713 + (i % 8) * 16} y={i < 8 ? 346 : 369} />)}

      <PerfWheel x={47} y={408} label="PITCH" />
      <PerfWheel x={97} y={408} k="cc1" label="MOD" />
      <Keyboard x={165} y={411} w={666} h={100} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'poizone',
  Editor: PoiZoneEditor,
};
