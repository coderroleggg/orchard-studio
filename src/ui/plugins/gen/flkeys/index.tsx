// FL Keys editor (FL: FL Keys, SynthPanel 480 x 270): the dark panel with the FL KEYS title, the wavetable list
// and info button on top, four captioned groups (ENVIRONMENT, MISC, VELOCITY, TUNING) of 42 px knobs at FL's
// form positions (Decay, Release, Overdrive, LFO Rate, Velocity to Muffle, Muffle, Tune / Pan/Tremolo,
// Stereo, Treble, Stretch, Velocity to Hardness, Hardness, Velocity Sensitivity, Detune) and a piano
// keyboard (a 1540 px MIDI keyboard scrolled to E4 in FL; here scrolled with the mouse wheel). The info
// button shows the wavetable's NAME / AUTHOR / SAMPLERATE / VELOCITY LAYERS / NR OF SAMPLES / RANGE / FILESIZE
// in FL's about panel. Colours sampled from FL's plugin database thumbnail (read only); original drawing, no
// FL artwork. "Import FL content..." (window menu) reads FL's wavetables from the user's own FL install.

import { useId, useMemo, useRef, useState } from 'react';
import { host, store } from '../../../../store';
import { AnimatedDisplay, FxPanel, Label, useFxEdit, useFxEditor, useFxMonitor, useNoScrollWheel, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import type { FxEditorModule } from '../../registry';
import { channelOfSlot } from '../../../../model/gen/ids';
import { getRaw } from '../../../../audio/samples';
import { KEYS_CATALOG, KEYS_PARAM_KEYS, keysEntry } from '../../../../engine/gen/plugins/flkeys/catalog';
import { synthTable } from '../../../../engine/gen/plugins/flkeys/synth';
import { unpackKeysTable, type KeysTable } from '../../../../engine/gen/plugins/flkeys/table';
import { KEYS_MAX, KEYS_MIN } from '../../../../engine/gen/plugins/flkeys/core';
import { forgetFlKeys, pickFlKeys, projectFlTable, reuseFlKeys } from './fldata';

const W = 480;
const H = 270;
const COL = {
  bg: '#1e1e1e', keysBg: '#252525', bar: '#575757', barText: '#c3c5c7', caption: '#8f9091', title: '#9a9c9d',
  combo: '#9f9f9f', comboText: '#1c1c1c', comboEdge: '#6e6e6e', about: '#575757', aboutText: '#b9bbbd',
  white: '#babec5', whiteDown: '#7fa9d6', black: '#1a1a1a', blackDown: '#4f7fb0', line: '#3a3a3c',
};
const SWEEP = 270;

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** FL's 42 px wheel: dark ring, grey cap, a light pointer. */
function KnobView({ size, t }: { size: number; t: number }) {
  const c = size / 2;
  const id = 'fk' + useId().replace(/:/g, '');
  const ang = -SWEEP / 2 + SWEEP * Math.min(1, Math.max(0, t));
  const rOut = c - 0.5, rCap = c * 0.66;
  const [x0, y0] = polar(c, rCap * 0.25, ang);
  const [x1, y1] = polar(c, rCap * 0.95, ang);
  const ticks = [];
  for (let k = 0; k <= 10; k++) {
    const [tx, ty] = polar(c, rOut - 1.6, -SWEEP / 2 + (SWEEP * k) / 10);
    ticks.push(<circle key={k} cx={tx} cy={ty} r={0.6} fill="#4a4a4b" />);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id} cx="0.4" cy="0.3" r="0.9">
          <stop offset="0" stopColor="#c4c4c4" />
          <stop offset="0.6" stopColor="#8c8c8c" />
          <stop offset="1" stopColor="#5b5b5b" />
        </radialGradient>
      </defs>
      <circle cx={c} cy={c} r={rOut} fill="#232323" stroke="#2f2f2f" strokeWidth={1} />
      {ticks}
      <circle cx={c} cy={c + 0.8} r={rCap + 1} fill="rgba(0,0,0,0.45)" />
      <circle cx={c} cy={c} r={rCap} fill={`url(#${id})`} />
      <ellipse cx={c - rCap * 0.1} cy={c - rCap * 0.42} rx={rCap * 0.62} ry={rCap * 0.3} fill="#fff" opacity={0.16} />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#f1f1f1" strokeWidth={2} strokeLinecap="butt" />
    </svg>
  );
}

function Knob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 42, height: 42 }} {...h}>
      <KnobView size={42} t={t} />
    </div>
  );
}

function Bar({ x, w, children }: { x: number; w: number; children: string }) {
  return (
    <Label x={x} y={36} w={w} h={17} size={9} bold color={COL.barText} style={{ background: COL.bar, letterSpacing: 0.6 }}>
      {children}
    </Label>
  );
}

function Cap({ x, y, w = 60, children }: { x: number; y: number; w?: number; children: string }) {
  return (
    <Label x={x + 21 - w / 2} y={y} w={w} h={12} size={8} bold color={COL.caption} style={{ letterSpacing: 0.3, transform: 'scaleX(0.9)' }}>
      {children}
    </Label>
  );
}

/** The link glyph between a velocity wheel's caption and its target's. */
function Link({ x, y }: { x: number; y: number }) {
  return (
    <svg className="fxk-abs" width={16} height={12} style={{ left: x, top: y, pointerEvents: 'none' }}>
      <path d="M3 3 L9 6 L3 9 Z" fill={COL.caption} />
    </svg>
  );
}

// ------------------------------------------------------------------ keyboard
const WHITE_W = 1540 / 75;
const WHITE = [0, 2, 4, 5, 7, 9, 11];
const BLACK_AT: Record<number, number> = { 1: 1, 3: 2, 6: 4, 8: 5, 10: 6 };
const KB_W = 462;
const KB_H = 71;
const BLACK_W = 12.6;
const BLACK_H = 44;
/** The keyboard's first visible white key (FL's control starts 30 white keys in: E4). */
const FIRST_WHITE = 30;
const LAST_WHITE = 74;

function whiteKeyNote(wi: number): number {
  return Math.floor(wi / 7) * 12 + WHITE[wi % 7];
}

function Keyboard({ x, y, chId, playing }: { x: number; y: number; chId: string | undefined; playing: React.MutableRefObject<ReadonlySet<number>> }) {
  const first = useRef(FIRST_WHITE);
  const held = useRef<{ key: number; tag: number } | null>(null);
  const keyAt = (px: number, py: number): number => {
    const wx = px / WHITE_W + first.current;
    const wi = Math.min(LAST_WHITE, Math.floor(wx));
    if (py < BLACK_H) {
      // black keys sit on the borders between white keys
      const near = Math.round(wx);
      const semi = whiteKeyNote(near) - whiteKeyNote(near - 1) === 2 ? whiteKeyNote(near) - 1 : -1;
      if (semi >= 0 && Math.abs(wx - near) < BLACK_W / 2 / WHITE_W && near > 0 && near <= LAST_WHITE) return semi;
    }
    return whiteKeyNote(wi);
  };
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.white;
    g.fillRect(0, 0, w, h);
    const f0 = first.current;
    const down = (key: number) => held.current?.key === key || playing.current.has(key);
    for (let wi = f0; wi <= Math.min(LAST_WHITE, f0 + 24); wi++) {
      const kx = (wi - f0) * WHITE_W;
      const key = whiteKeyNote(wi);
      if (down(key)) { g.fillStyle = COL.whiteDown; g.fillRect(kx, 0, WHITE_W, h); }
      g.fillStyle = COL.line;
      g.fillRect(Math.round(kx), 0, 1, h);
    }
    for (let wi = f0 + 1; wi <= Math.min(LAST_WHITE, f0 + 24); wi++) {
      if (whiteKeyNote(wi) - whiteKeyNote(wi - 1) !== 2) continue;
      const key = whiteKeyNote(wi) - 1;
      const kx = (wi - f0) * WHITE_W - BLACK_W / 2;
      g.fillStyle = down(key) ? COL.blackDown : COL.black;
      g.fillRect(kx, 0, BLACK_W, BLACK_H);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(kx + 1, 0, 1, BLACK_H - 3);
    }
  };
  const press = (key: number) => {
    if (!chId || key < 0 || key > 131) return;
    const h = held.current;
    if (h && h.key === key) return;
    if (h) host.noteOff(chId, h.key, h.tag);
    held.current = { key, tag: host.noteOn(chId, key, 100) };
  };
  const release = () => {
    const h = held.current;
    if (h && chId) host.noteOff(chId, h.key, h.tag);
    held.current = null;
  };
  const pos = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return keyAt(Math.max(0, Math.min(KB_W - 1, ((e.clientX - r.left) / r.width) * KB_W)), Math.max(0, Math.min(KB_H - 1, ((e.clientY - r.top) / r.height) * KB_H)));
  };
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: KB_W, height: KB_H }}
      onWheel={(e) => { first.current = Math.max(0, Math.min(LAST_WHITE - 21, first.current + Math.sign(e.deltaY || e.deltaX) * 3)); }}>
      <AnimatedDisplay x={0} y={0} w={KB_W} h={KB_H} frame={frame}
        onPointerDown={(e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); press(pos(e)); }}
        onPointerMove={(e) => { if (held.current) press(pos(e)); }}
        onPointerUp={(e) => { release(); try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* released */ } }} />
    </div>
  );
}

// ------------------------------------------------------------------ wavetable list and info
const NOTE = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (k: number) => `${NOTE[((k % 12) + 12) % 12]}${Math.floor(k / 12)}`;

/** The wavetable the plugin plays now: imported data when the pool has it, else the synthesized stand-in. */
function useTable(): { table: KeysTable; imported: boolean } {
  const { params } = useFxEditor();
  const e = keysEntry(params.wavetable);
  const id = typeof params[e.key] === 'string' ? (params[e.key] as string) : '';
  const buf = id ? getRaw(id)?.channels[0] : undefined;
  return useMemo(() => {
    const t = buf ? unpackKeysTable(buf) : null;
    return t ? { table: t, imported: true } : { table: synthTable(e.name), imported: false };
  }, [buf, e.name]);
}

function About({ onClose }: { onClose: () => void }) {
  const { table: t, imported } = useTable();
  const bytes = imported ? (t.frames * (t.stereo ? 4 : 2) + (t.root.length * 20)) : 0;
  const size = imported ? (bytes >= 1 << 20 ? `${(bytes / (1 << 20)).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`) : 'synthesized';
  const rows: [string, string][] = [
    ['NAME:', t.name],
    ['AUTHOR:', imported ? '' : 'Orchard (synthesized stand-in)'],
    ['SAMPLERATE:', `${t.rate}`],
    ['VELOCITY LAYERS:', `${t.layers}`],
    ['NR OF SAMPLES:', `${t.root.length}`],
    ['RANGE:', `${noteName(t.root[0])} - ${noteName(Math.min(127, t.high[t.high.length - 1] > 127 ? t.root[t.root.length - 1] + 12 : t.high[t.high.length - 1]))}`],
    ['FILESIZE:', size],
  ];
  return (
    <div className="fxk-abs" onClick={onClose} style={{ left: 9, top: 101, width: 463, height: 133, background: COL.about }}>
      <div className="fxk-abs" style={{ left: 6, top: 12, color: COL.aboutText, fontSize: 9 }}>FL Keys</div>
      {rows.map(([k, v], i) => (
        <div key={k}>
          <div className="fxk-abs" style={{ left: 91 - 4, top: 27 + i * 14, width: 104 + 4, textAlign: 'right', fontSize: 8, fontWeight: 700, color: COL.aboutText }}>{k}</div>
          <div className="fxk-abs" style={{ left: 201, top: 25 + i * 14, fontSize: 9, color: '#a0a0a0', whiteSpace: 'nowrap' }}>{v}</div>
        </div>
      ))}
    </div>
  );
}

function Combo() {
  const { params } = useFxEditor();
  const edit = useFxEdit();
  const name = keysEntry(params.wavetable).name;
  const open = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const items: MenuItem[] = KEYS_CATALOG.map((c) => ({
      label: c.name, checked: c.name === name, radio: true,
      onClick: () => edit('Wavetable', (p) => {
        p.wavetable = c.name;
        // the table's descriptor sets the parameters it gives a value for
        c.defaults.forEach((d, i) => { if (d !== null) p[KEYS_PARAM_KEYS[i]] = Math.round(KEYS_MIN[i] + d * (KEYS_MAX[i] - KEYS_MIN[i])); });
      }),
    }));
    openMenu(r.left, r.bottom, items, { minWidth: r.width });
  };
  return (
    <div className="fxk-abs" onPointerDown={open} title="Select a wavetable"
      style={{ left: 328, top: 9, width: 127, height: 19, background: COL.combo, border: `1px solid ${COL.comboEdge}`, boxSizing: 'border-box', color: COL.comboText, fontSize: 10, lineHeight: '17px', paddingLeft: 5, cursor: 'default', overflow: 'hidden', whiteSpace: 'nowrap', fontFamily: 'Arial, Helvetica, sans-serif' }}>
      {name}
      <svg width={9} height={6} style={{ position: 'absolute', right: 4, top: 6 }}><path d="M0 0 L9 0 L4.5 6 Z" fill="#303030" /></svg>
    </div>
  );
}

function FlKeysEditor() {
  const ctx = useFxEditor();
  const chId = channelOfSlot(ctx.slotId) ?? undefined;
  const playing = useRef<ReadonlySet<number>>(new Set());
  const [about, setAbout] = useState(false);
  useFxMonitor(ctx.slotId, (d) => { playing.current = new Set(Array.isArray(d.keys) ? (d.keys as number[]) : []); });
  return (
    <FxPanel width={W} height={H} style={{ background: COL.bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 183, width: W, height: 89, background: COL.keysBg }} />
      <div className="fxk-abs" style={{ left: 11, top: 4, color: COL.title, fontSize: 26, fontWeight: 900, letterSpacing: 2, fontFamily: '"Arial Black", "Helvetica Neue", Arial, sans-serif', textShadow: '1px 1px 0 #5b5d5e', pointerEvents: 'none' }}>FL KEYS</div>
      <Combo />
      <div className="fxk-abs" onClick={() => setAbout((a) => !a)} title="Show information about this wavetable"
        style={{ left: 454, top: 9, width: 18, height: 19, background: COL.combo, border: `1px solid ${COL.comboEdge}`, boxSizing: 'border-box', color: COL.comboText, textAlign: 'center', fontSize: 11, fontWeight: 700, lineHeight: '17px', cursor: 'default', fontFamily: 'Georgia, serif' }}>i</div>
      <Bar x={9} w={111}>ENVIRONMENT</Bar>
      <Bar x={129} w={110}>MISC</Bar>
      <Bar x={249} w={159}>VELOCITY</Bar>
      <Bar x={419} w={51}>TUNING</Bar>
      <Knob k="decay" x={14} y={62} />
      <Knob k="release" x={72} y={62} />
      <Knob k="overdrive" x={135} y={62} />
      <Knob k="lfoRate" x={192} y={62} />
      <Knob k="velMuffle" x={255} y={62} />
      <Knob k="muffle" x={311} y={62} />
      <Knob k="tune" x={425} y={62} />
      <Knob k="panTrem" x={14} y={124} />
      <Knob k="stereo" x={72} y={124} />
      <Knob k="treble" x={135} y={124} />
      <Knob k="stretch" x={192} y={124} />
      <Knob k="velHardness" x={255} y={124} />
      <Knob k="hardness" x={311} y={124} />
      <Knob k="velSens" x={364} y={124} />
      <Knob k="detune" x={425} y={124} />
      <Cap x={14} y={106}>DECAY</Cap>
      <Cap x={72} y={106}>RELEASE</Cap>
      <Cap x={135} y={106}>OVERDRIVE</Cap>
      <Cap x={192} y={106}>LFO</Cap>
      <Cap x={255} y={106} w={40}>VEL</Cap>
      <Cap x={311} y={106}>MUFFLE</Cap>
      <Cap x={425} y={106}>TUNE</Cap>
      <Link x={292} y={106} />
      <Cap x={14} y={168}>PAN</Cap>
      <Cap x={72} y={168}>STEREO</Cap>
      <Cap x={135} y={168}>TREBLE</Cap>
      <Cap x={192} y={168}>STRETCH</Cap>
      <Cap x={255} y={168} w={40}>VEL</Cap>
      <Cap x={311} y={168}>HARDNESS</Cap>
      <Cap x={364} y={168}>SENS</Cap>
      <Cap x={425} y={168}>DETUNE</Cap>
      <Link x={292} y={168} />
      <Keyboard x={9} y={190} chId={chId} playing={playing} />
      {about && <About onClose={() => setAbout(false)} />}
    </FxPanel>
  );
}

function menu(slotId: string): MenuItem[] {
  const chId = channelOfSlot(slotId);
  const ch = chId ? store.project.channels.find((c) => c.id === chId) : undefined;
  const using = KEYS_CATALOG.some((e) => typeof ch?.plugin?.params[e.key] === 'string' && !!ch.plugin.params[e.key]);
  const inProject = KEYS_CATALOG.some((e) => !!projectFlTable(e));
  return [
    { label: 'Import FL content...', onClick: () => pickFlKeys(slotId) },
    ...(inProject ? [{ label: 'Use FL Keys data from this project', onClick: () => reuseFlKeys(slotId) }] : []),
    { label: 'Use synthesized sound', checked: !using, disabled: !using, onClick: () => forgetFlKeys(slotId) },
  ];
}

export const editor: FxEditorModule = { id: 'flkeys', Editor: FlKeysEditor, menu };
