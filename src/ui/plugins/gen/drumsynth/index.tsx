// DrumSynth Live editor (FL: Fruity DrumSynth Live, SynthPanel 580 x 358): FL's
// form (Fruity DrumSynth Live_x64.dylib TSynthEditorForm) at its coordinates:
// WAVE, TRIG, OSC 1, OSC 2 and MAIN OUT / SEND TO / SELECTED panels bound to the
// selected patch, and the keyboard panel (MORPH TO list, the morph modulation
// strip, two octaves of patch keys with the bank buttons and AUTO). A key
// click selects its patch and plays it; right-click: copy / paste the patch,
// set it to a default patch (FL's Default kit). Original drawing in FL's colours
// (form colours and FL's thumbnail), no Image-Line artwork.

import { useRef, useState } from 'react';
import { FxPanel, Label, Wheel, Slider, DigiWheel, useFxEditor, useFxState, useFxView, useFxEdit, useParam, useFxMonitor } from '../../kit';
import { useControl } from '../../../widgets/control';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { host } from '../../../../store';
import * as A from '../../../../store/actions';
import { DS_LOCAL, DS_PATCHES, DS_WAVES, dsKey, dsKeyName, dsKitState } from '../../../../model/gen/plugins/drumsynth';
import { DS_WAVE_FRAMES } from '../../../../engine/gen/plugins/drumsynth';
import type { FxEditorModule } from '../../registry';
import { addPoolSample, pickFiles } from '../bassdrum/flimport';

const C = {
  panel: '#404748', bevel: '#4a5253', bevelEdge: '#5d6667', bevelDark: '#30363a', label: '#a7b4b6', title: '#cfd8d9',
  arc: '#e8ecee', black: '#121516', orange: '#f29b3a', white: '#d9dde0', blackKey: '#2c3133',
};

function Bev({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: C.bevel, borderRadius: 3, boxShadow: `inset 1px 1px 0 ${C.bevelEdge}, inset -1px -1px 0 ${C.bevelDark}` }} />;
}

function Cap({ x, y, w, children }: { x: number; y: number; w: number; children: string }) {
  return <Label x={x} y={y} w={w} h={9} size={7} bold color={C.label}>{children}</Label>;
}

function Title({ x, y, w, children }: { x: number; y: number; w: number; children: string }) {
  return <Label x={x} y={y} w={w} h={13} size={9} bold color={C.title} align="right">{children}</Label>;
}

/** The selected patch's parameter key for FL local parameter `i`. */
function useKey(i: number): string {
  const sel = useFxState<number>('sel', 48);
  return dsKey(Math.max(0, Math.min(DS_PATCHES - 1, sel)), i);
}

function K({ i, x, y, size = 38 }: { i: number; x: number; y: number; size?: number }) {
  const k = useKey(i);
  return <Wheel k={k} x={x} y={y} size={size} look="classic" color={C.arc} bipolar={DS_LOCAL[i].min < 0} />;
}

/** Velocity mapping knobs (36 px, FL's black knobs' companions). */
function V({ i, x, y }: { i: number; x: number; y: number }) {
  const k = useKey(i);
  return <Wheel k={k} x={x} y={y} size={36} look="flat" color={C.orange} bipolar />;
}

function HSlider({ i, x, y }: { i: number; x: number; y: number }) {
  const k = useKey(i);
  return (
    <>
      <div className="fxk-abs" style={{ left: x - 1, top: y - 1, width: 261, height: 17, background: C.black }} />
      <Slider k={k} x={x} y={y} w={259} h={14} capColor="#c9d2d4" />
    </>
  );
}

/** FL's small switch buttons (NOISE, INVERT). */
function Switch({ i, x, y }: { i: number; x: number; y: number }) {
  const k = useKey(i);
  const p = useParam(k);
  const on = p.value >= 1;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 33, height: 12, borderRadius: 2, cursor: 'pointer', boxSizing: 'border-box',
      border: `1px solid ${C.bevelDark}`, background: on ? C.orange : '#2a3032' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); }}
      onPointerEnter={() => setHint(`${p.def.name}: ${p.def.format ? p.def.format(p.value) : p.value}`)} onPointerLeave={clearHint} />
  );
}

function Digi({ i, x, y, w, h }: { i: number; x: number; y: number; w: number; h: number }) {
  const k = useKey(i);
  return <DigiWheel k={k} x={x} y={y} w={w} h={h} />;
}

/** FL's morph modulation strip (TPaintWheel, 15 x 80): a vertical wheel. */
function ModStrip() {
  const k = useKey(37);
  const p = useParam(k);
  const h = useControl({ travel: 120, ...p.control }, 'vertical');
  const t = (p.value - p.def.min) / (p.def.max - p.def.min);
  return (
    <div className="fxk-abs fxk-wheel" style={{ left: 242, top: 269, width: 15, height: 80, background: 'linear-gradient(90deg,#1b1f20,#3d4446 50%,#1b1f20)', borderRadius: 2 }} {...h}>
      {Array.from({ length: 9 }, (_, j) => {
        const yy = ((j * 10 + (1 - t) * 30) % 80);
        return <div key={j} style={{ position: 'absolute', left: 2, right: 2, top: yy, height: 1, background: 'rgba(255,255,255,0.18)' }} />;
      })}
      <div style={{ position: 'absolute', left: 1, right: 1, top: 2 + (1 - t) * 74, height: 4, background: C.orange, borderRadius: 1 }} />
    </div>
  );
}

function Combo({ x, y, w, h, text, hint, items }: { x: number; y: number; w: number; h: number; text: string; hint: string; items: () => MenuItem[] }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: '#2b3133', border: `1px solid ${C.bevelDark}`, boxSizing: 'border-box',
      color: C.white, font: '9px/18px sans-serif', padding: '0 4px', overflow: 'hidden', whiteSpace: 'nowrap', cursor: 'pointer' }}
      onPointerDown={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, items()); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{text}</div>
  );
}

const patchLabel = (names: string[], p: number) => `${dsKeyName(p)} ${names[p] ?? ''}`;

let clip: Record<string, number> | null = null;

/** The patch keyboard: two octaves (14 white keys) from the bank's first C. */
function PatchKeys() {
  const { slotId, params } = useFxEditor();
  const view = useFxView();
  const edit = useFxEdit();
  const sel = useFxState<number>('sel', 48);
  const octave = useFxState<number>('octave', 4);
  const auto = useFxState<boolean>('auto', false);
  const names = useFxState<string[]>('names', []);
  const held = useRef<{ key: number; tag: number } | null>(null);
  const [mon, setMon] = useState<number[]>([]);
  useFxMonitor(slotId, (m) => {
    const k = m && Array.isArray(m.keys) ? (m.keys as number[]) : [];
    setMon((old) => (old.length === k.length && old.every((x, i) => x === k[i]) ? old : k));
  });
  const playing = new Set(mon);
  const chId = slotId.startsWith('ch:') ? slotId.slice(3) : null;
  const base = octave * 12;
  // AUTO: follow the notes being played
  if (auto && mon && mon.length) {
    const last = mon[mon.length - 1];
    const oct = Math.max(0, Math.min(8, Math.floor(last / 24) * 2));
    if (oct !== octave) queueMicrotask(() => view('Keyboard', (p) => { p.octave = oct; p.sel = last; }));
  }
  const KW = 22, W = 308, H = 80;
  const whites = [0, 2, 4, 5, 7, 9, 11];
  const keys: { k: number; black: boolean; x: number; w: number }[] = [];
  for (let o = 0; o < 2; o++) whites.forEach((s, j) => keys.push({ k: base + o * 12 + s, black: false, x: (o * 7 + j) * KW, w: KW }));
  for (let o = 0; o < 2; o++) [1, 3, 6, 8, 10].forEach((s) => {
    const wi = o * 7 + [0, 1, 3, 4, 5][[1, 3, 6, 8, 10].indexOf(s)];
    keys.push({ k: base + o * 12 + s, black: true, x: wi * KW + KW - 7, w: 14 });
  });
  const down = (k: number, e: React.PointerEvent) => {
    e.stopPropagation();
    if (k >= DS_PATCHES) return;
    if (e.button === 2) {
      const p = params as Record<string, unknown>;
      const def = dsKitState('Default');
      openMenu(e.clientX, e.clientY, [
        { label: `${dsKeyName(k)} ${names[k] ?? ''}`, header: true },
        { label: 'Copy patch', onClick: () => { clip = {}; DS_LOCAL.forEach((_, i) => { clip![i] = Number(p[dsKey(k, i)]); }); } },
        { label: 'Paste patch', disabled: !clip, onClick: () => clip && edit('Paste patch', (d) => { DS_LOCAL.forEach((_, i) => { d[dsKey(k, i)] = clip![i]; }); }) },
        { label: 'Set to default patch', submenu: Array.from({ length: 24 }, (_, j): MenuItem => ({
          label: (def.names as string[])[48 + j], checked: names[k] === (def.names as string[])[48 + j],
          onClick: () => edit('Set to default patch', (d) => {
            DS_LOCAL.forEach((_, i) => { d[dsKey(k, i)] = (def[dsKey(48 + j, i)] as number); });
            (d.names as string[])[k] = (def.names as string[])[48 + j];
          }),
        })) },
      ]);
      return;
    }
    if (e.button !== 0) return;
    view('Select patch', (d) => { d.sel = k; });
    if (chId) held.current = { key: k, tag: host.noteOn(chId, k, 100) };
  };
  const up = () => { const h = held.current; if (h && chId) host.noteOff(chId, h.key, h.tag); held.current = null; };
  return (
    <>
      <div className="fxk-abs" style={{ left: 262, top: 269, width: W, height: H, background: '#202426', overflow: 'hidden' }}
        onPointerUp={up} onPointerLeave={up} onContextMenu={(e) => e.preventDefault()}
        onPointerEnter={() => setHint('Patch selection / testing keyboard')}>
        {keys.map(({ k, black, x, w }) => {
          const isSel = k === sel, on = playing.has(k);
          return (
            <div key={k} title={`${dsKeyName(k)} ${names[k] ?? ''}`}
              style={{ position: 'absolute', left: x, top: 0, width: w - 1, height: black ? 48 : H - 1, zIndex: black ? 2 : 1,
                background: on ? C.orange : black ? C.blackKey : C.white, borderRadius: '0 0 2px 2px',
                boxShadow: isSel ? `inset 0 0 0 2px ${C.orange}` : undefined }}
              onPointerDown={(e) => down(k, e)}>
              {!black && (k % 12 === 0) && <div style={{ position: 'absolute', bottom: 2, width: '100%', textAlign: 'center', font: 'bold 7px sans-serif', color: '#59616a' }}>{dsKeyName(k)}</div>}
            </div>
          );
        })}
      </div>
      <BankBtn x={500} label={'‹'} hint="Previous patch bank" onClick={() => view('Bank', (d) => { d.octave = Math.max(0, octave - 2); })} />
      <BankBtn x={517} label={'›'} hint="Next patch bank" onClick={() => view('Bank', (d) => { d.octave = Math.min(8, octave + 2); })} />
      <div className="fxk-abs" style={{ left: 534, top: 241, width: 37, height: 16, boxSizing: 'border-box', border: `1px solid ${C.bevelDark}`, borderRadius: 2,
        background: auto ? C.orange : '#2b3133', color: auto ? '#1d1d1d' : C.label, font: 'bold 8px/14px sans-serif', textAlign: 'center', cursor: 'pointer' }}
        onPointerDown={(e) => { e.stopPropagation(); view('AUTO', (d) => { d.auto = !auto; }); }}
        onPointerEnter={() => setHint('Auto-select patch')} onPointerLeave={clearHint}>AUTO</div>
    </>
  );
}

function BankBtn({ x, label, hint, onClick }: { x: number; label: string; hint: string; onClick: () => void }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: 241, width: 18, height: 16, boxSizing: 'border-box', border: `1px solid ${C.bevelDark}`, borderRadius: 2,
      background: '#2b3133', color: C.title, font: 'bold 11px/13px sans-serif', textAlign: 'center', cursor: 'pointer' }}
      onPointerDown={(e) => { e.stopPropagation(); onClick(); }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{label}</div>
  );
}

function PatchCombos() {
  const view = useFxView();
  const sel = useFxState<number>('sel', 48);
  const names = useFxState<string[]>('names', []);
  const mk = useKey(34);
  const morph = useParam(mk);
  const list = (onPick: (p: number) => void, cur: number): MenuItem[] =>
    Array.from({ length: 5 }, (_, b): MenuItem => ({
      label: `${dsKeyName(b * 24)} - ${dsKeyName(b * 24 + 23)}`,
      submenu: Array.from({ length: 24 }, (_, j): MenuItem => ({ label: patchLabel(names, b * 24 + j), checked: b * 24 + j === cur, onClick: () => onPick(b * 24 + j) })),
    }));
  return (
    <>
      <Combo x={473} y={197} w={97} h={20} text={patchLabel(names, sel)} hint="Selected patch"
        items={() => list((p) => view('Select patch', (d) => { d.sel = p; d.octave = Math.min(8, Math.floor(p / 24) * 2); }), sel)} />
      <Combo x={132} y={280} w={104} h={20} text={patchLabel(names, morph.value)} hint={`${morph.def.name}: ${morph.def.format ? morph.def.format(morph.value) : morph.value}`}
        items={() => list((p) => { morph.control.onBegin?.(); morph.set(p); morph.control.onEnd?.(); }, morph.value)} />
    </>
  );
}

function DrumSynthEditor() {
  return (
    <FxPanel width={580} height={358} style={{ background: `linear-gradient(180deg, #4c5455 0%, ${C.panel} 45%, #363c3d 100%)` }}>
      <Bev x={5} y={5} w={140} h={100} />
      <Bev x={5} y={109} w={140} h={151} />
      <Bev x={149} y={5} w={316} h={128} />
      <Bev x={149} y={136} w={316} h={124} />
      <Bev x={469} y={5} w={106} h={255} />
      <Bev x={5} y={264} w={570} h={90} />
      <div className="fxk-abs" style={{ left: 476, top: 118, width: 42, height: 40, background: C.bevelDark, borderRadius: 3 }} />
      {/* WAVE */}
      <Title x={99} y={9} w={42}>WAVE</Title>
      <Digi i={15} x={10} y={24} w={132} h={18} />
      <V i={29} x={10} y={53} />
      <K i={16} x={56} y={52} />
      <K i={17} x={102} y={51} />
      <Cap x={11} y={91} w={34}>VEL</Cap>
      <Cap x={56} y={91} w={38}>TUNE</Cap>
      <Cap x={102} y={91} w={38}>MIX</Cap>
      {/* TRIG */}
      <Title x={99} y={111} w={42}>TRIG</Title>
      <Digi i={24} x={10} y={127} w={132} h={18} />
      <K i={18} x={9} y={150} />
      <K i={19} x={56} y={150} />
      <K i={20} x={102} y={150} />
      <Cap x={8} y={190} w={40}>COUNT</Cap>
      <Cap x={56} y={190} w={38}>RATE</Cap>
      <Cap x={102} y={190} w={38}>DEC</Cap>
      <V i={30} x={10} y={208} />
      <K i={2} x={56} y={206} />
      <K i={23} x={102} y={206} />
      <Cap x={11} y={246} w={34}>VEL</Cap>
      <Cap x={56} y={246} w={38}>TONE</Cap>
      <Cap x={102} y={246} w={38}>CLICK</Cap>
      {/* OSC 1 */}
      <Title x={416} y={8} w={43}>OSC 1</Title>
      <V i={25} x={155} y={25} />
      <HSlider i={4} x={198} y={25} />
      <HSlider i={5} x={198} y={45} />
      <Cap x={156} y={62} w={34}>VEL</Cap>
      <V i={31} x={155} y={81} />
      <K i={3} x={198} y={79} />
      <K i={7} x={243} y={79} />
      <K i={6} x={288} y={79} />
      <Switch i={32} x={335} y={80} />
      <Switch i={22} x={335} y={105} />
      <V i={26} x={377} y={81} />
      <K i={8} x={422} y={79} />
      <Cap x={156} y={118} w={34}>VEL</Cap>
      <Cap x={198} y={118} w={38}>HARM</Cap>
      <Cap x={243} y={118} w={38}>DEC</Cap>
      <Cap x={288} y={118} w={38}>SWEEP</Cap>
      <Cap x={332} y={93} w={37}>NOISE</Cap>
      <Cap x={332} y={118} w={38}>INVERT</Cap>
      <Cap x={378} y={118} w={34}>VEL</Cap>
      <Cap x={422} y={118} w={38}>MIX</Cap>
      {/* OSC 2 */}
      <Title x={417} y={138} w={43}>OSC 2</Title>
      <V i={27} x={155} y={151} />
      <HSlider i={10} x={198} y={153} />
      <HSlider i={11} x={198} y={173} />
      <Cap x={156} y={189} w={34}>VEL</Cap>
      <K i={33} x={154} y={206} />
      <K i={12} x={198} y={206} />
      <K i={13} x={243} y={206} />
      <K i={9} x={288} y={207} />
      <K i={21} x={332} y={206} />
      <V i={28} x={377} y={208} />
      <K i={14} x={422} y={206} />
      <Cap x={153} y={246} w={40}>RING</Cap>
      <Cap x={198} y={246} w={38}>ATT</Cap>
      <Cap x={243} y={246} w={38}>DEC</Cap>
      <Cap x={288} y={246} w={38}>SHAPE</Cap>
      <Cap x={331} y={246} w={40}>REL</Cap>
      <Cap x={378} y={246} w={34}>VEL</Cap>
      <Cap x={422} y={246} w={38}>MIX</Cap>
      {/* MAIN OUT / SEND TO / SELECTED */}
      <Title x={474} y={8} w={96}>MAIN OUT</Title>
      <K i={1} x={475} y={37} size={40} />
      <K i={0} x={530} y={37} size={40} />
      <Cap x={478} y={81} w={34}>PAN</Cap>
      <Cap x={534} y={81} w={32}>VOL</Cap>
      <Title x={474} y={96} w={96}>SEND TO</Title>
      <Digi i={36} x={480} y={126} w={34} h={22} />
      <K i={35} x={530} y={119} size={40} />
      <Cap x={479} y={161} w={37}>NUM</Cap>
      <Cap x={534} y={161} w={32}>LVL</Cap>
      <Title x={474} y={176} w={96}>SELECTED</Title>
      <PatchCombos />
      {/* keyboard panel */}
      <Title x={139} y={266} w={96}>MORPH TO</Title>
      <ModStrip />
      <PatchKeys />
      <Label x={10} y={313} w={227} h={32} size={26} bold color="#e9eef0" align="left" style={{ letterSpacing: 1 }}>DRUMSYNTH</Label>
      <Label x={147} y={331} w={71} h={23} size={17} color="#151819" align="left" style={{ fontStyle: 'italic' }}>Live</Label>
    </FxPanel>
  );
}

/** Find FL's waveform block in the user's DrumSynth engine binary (fingerprint + FL's own checksum). */
function findWaves(bytes: Uint8Array): Int16Array | null {
  const need = DS_WAVE_FRAMES * 2;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // FL derives its noise seed from the block: 0x56ce + four strided sums of 2312 samples = -395180
  const check = (o: number) => {
    if (o + 0x908 / 4 * 0x3f8 + 0x2fa + 2 > bytes.length) return false;
    let s = 0x56ce;
    for (let it = 0, p = o; it < 0x908 / 4; it++, p += 0x3f8) s += dv.getInt16(p, true) + dv.getInt16(p + 0xfe, true) + dv.getInt16(p + 0x1fc, true) + dv.getInt16(p + 0x2fa, true);
    return s === -395180;
  };
  for (let o = 0; o + need <= bytes.length; o++) {
    // cheap pre-filter: FL's block starts with these two samples' signs and sizes
    const a = dv.getInt16(o, true), b = dv.getInt16(o + 2, true);
    if (a !== 968 || b !== -3231) continue;
    if (!check(o)) continue;
    const out = new Int16Array(DS_WAVE_FRAMES);
    for (let i = 0; i < DS_WAVE_FRAMES; i++) out[i] = dv.getInt16(o + 2 * i, true);
    return out;
  }
  return null;
}

/** A float WAV of the block (stored in the pool; 44.1 kHz header so a 44.1 kHz decode keeps it exact). */
function wavBytes(x: Int16Array): ArrayBuffer {
  const n = x.length, b = new ArrayBuffer(44 + n * 4), dv = new DataView(b);
  const w = (o: number, s: string) => { for (let i = 0; i < 4; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 3, true); dv.setUint16(22, 1, true); dv.setUint32(24, 44100, true); dv.setUint32(28, 44100 * 4, true);
  dv.setUint16(32, 4, true); dv.setUint16(34, 32, true); w(36, 'data'); dv.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) dv.setFloat32(44 + i * 4, x[i] / 32768, true);
  return b;
}

async function importWaves(slotId: string): Promise<void> {
  const files = await pickFiles('');
  for (const f of files) {
    if (f.size > 64 << 20) continue;
    const block = findWaves(new Uint8Array(await f.arrayBuffer()));
    if (!block) continue;
    const ch = new Float32Array(block.length);
    for (let i = 0; i < block.length; i++) ch[i] = block[i] / 32768;
    const info = await addPoolSample('DrumSynth Live waves', { channels: [ch], sampleRate: 44100 }, wavBytes(block), 'Import FL DrumSynth waves');
    A.editFx(slotId, 'Import FL DrumSynth waves', (p) => { p.wavesSample = info.id; });
    return;
  }
}

export const editor: FxEditorModule = {
  id: 'drumsynth',
  Editor: DrumSynthEditor,
  menu: (slotId) => [
    { label: 'Import FL DrumSynth waves...', hint: `Pick libDrumSynth_Eng_x64 from your FL Studio installation (Plugins/Fruity/Generators/Fruity DrumSynth Live) for FL's ${DS_WAVES.length} waveforms`, onClick: () => void importWaves(slotId) },
  ],
};
