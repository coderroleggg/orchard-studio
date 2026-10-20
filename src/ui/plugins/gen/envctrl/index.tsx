// Envelope Controller editor (FL: Fruity Envelope Controller, SynthPanel 737 x 395): the X / Y pad with the
// global Mod X / Y wheels and the options menu, the articulator selector, the MODE switch, the BASE / ENV / LFO
// wheels, the source combo (envelope, LFO and the mapping envelopes), the key range keyboard and the envelope
// editor (EnvEditor.tsx). Positions are FL's form coordinates; colours were sampled from the manual's
// screenshots. Original drawing, no FL assets.

import { useEffect, useMemo, useRef, useState } from 'react';
import { FxPanel, useFxEdit, useFxEditor, useFxMonitor, useFxState, useFxView, useParam } from '../../kit';
import { openMenu } from '../../../widgets/ContextMenu';
import { host, store } from '../../../../store';
import { channelOfSlot } from '../../../../model/gen/ids';
import {
  EC_ARTS, EC_SOURCES, EC_KEY_SPAN, EC_VEL_X, ecDefaultState, ecFlatShape, ecKey, ecLfoHz, type EcArt, type EcShape,
} from '../../../../model/gen/plugins/envctrl';
import { PianoKb, KB_WW } from '../keyboardctrl/PianoKb';
import { ArtSelect, BigWheel, MiniWheel, ModeGlyph, OptionsButton, SourceCombo, Txt, XYPad } from './Controls';
import { EnvEditor } from './EnvEditor';
import { cloneShape, isFlat } from './shapeOps';
import type { LfoPreview } from './draw';
import type { FxEditorModule } from '../../registry';

const DEFAULT_ARTS = ecDefaultState().arts as EcArt[];
const clampI = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);

/** The first scroll of the keyboard: C3 at its left edge (FL's keyboard shows C3..C7). */
const KB_SCROLL0 = Math.round(21 * KB_WW - 4);

function EnvelopeControllerEditor() {
  const { slotId, params } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const arts = useFxState<EcArt[]>('arts', DEFAULT_ARTS);
  const sel = clampI(useFxState<number>('sel', 0), 0, EC_ARTS - 1, 0);
  const srcRaw = clampI(useFxState<number>('src', 0), 0, EC_SOURCES.length - 1, 0);
  const src = srcRaw === 2 ? 0 : srcRaw;
  const cont = useFxState<boolean>('cont', false);
  const kscroll = useFxState<number>('kscroll', KB_SCROLL0);
  const art = arts[sel] ?? DEFAULT_ARTS[sel];
  const shape = src === 0 ? art.env : src === 1 ? art.lfo : art.maps[src - 3];

  const base = useParam(ecKey(sel, 'base'));
  const envLevel = useParam(ecKey(sel, 'env'));
  const lfoLevel = useParam(ecKey(sel, 'lfo'));
  const modx = useParam('modx');
  const mody = useParam('mody');
  const num = (f: string, d: number) => { const v = params[ecKey(sel, f)]; return typeof v === 'number' && Number.isFinite(v) ? v : d; };

  // ---- edits of the displayed shape
  const writeShape = (next: EcShape, label: string) => edit(label, (p) => {
    const a = (p.arts as EcArt[])[sel];
    if (src === 0) a.env = next; else if (src === 1) a.lfo = next; else a.maps[src - 3] = next;
  });
  const setFlag = (flag: 'on' | 'tempo' | 'global', v: boolean) => edit(flag === 'on' ? (src === 0 ? 'Envelope on / off' : 'LFO on / off') : flag === 'tempo' ? 'Tempo' : 'Global', (p) => {
    const a = (p.arts as EcArt[])[sel];
    const sh = src === 0 ? a.env : a.lfo;
    sh[flag] = v;
  });
  const reset = () => {
    const dflt = DEFAULT_ARTS[sel];
    const next = src === 0 ? cloneShape(dflt.env) : src === 1 ? cloneShape(dflt.lfo) : ecFlatShape(art.polar ? 0.5 : 1);
    if (src <= 1) { next.on = shape.on; }
    writeShape(next, 'Reset envelope');
  };

  // ---- the last note's line on the mapping axes
  const [mon, setMon] = useState<{ last: number[]; gx: number; gy: number } | null>(null);
  const monKey = useRef('');
  useFxMonitor(slotId, (d) => {
    const last = d.last as number[] | undefined;
    if (!Array.isArray(last)) return;
    const k = `${last.join(',')}|${d.gx}|${d.gy}`;
    if (k === monKey.current) return;
    monKey.current = k;
    setMon({ last: last.slice(), gx: Number(d.gx), gy: Number(d.gy) });
  });
  const noteLine = useMemo(() => {
    if (!mon || src < 3) return null;
    const [key, vel, rand, fx, fy] = mon.last.slice(sel * 5, sel * 5 + 5);
    const x = src === 3 ? key / EC_KEY_SPAN : src === 4 ? vel * EC_VEL_X : src === 5 ? mon.gx + fx / 2 : src === 6 ? mon.gy + fy / 2 : rand;
    return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : null;
  }, [mon, src, sel]);

  // ---- the LFO's preview wave
  const spd = num('spd', 40000), tns = num('tns', 0), skw = num('skw', 0), pw = num('pw', 0), llfo = num('lfo', 0);
  const lfo: LfoPreview | null = useMemo(
    () => (src === 1 ? { hz: ecLfoHz(spd), tns, sk: skw, pw, level: llfo / 256 } : null),
    [src, spd, tns, skw, pw, llfo],
  );

  // ---- source combo
  const used = [art.env.on, art.lfo.on, false, ...art.maps.map((m) => !isFlat(m))];

  // ---- test notes (a click on the keyboard plays the articulator)
  const chId = channelOfSlot(slotId);
  const note = useRef<{ key: number; tag: number } | null>(null);
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  const stopNote = () => {
    const n = note.current;
    if (n && chId) host.noteOff(chId, n.key, n.tag);
    note.current = null;
    setHeld(new Set());
  };
  useEffect(() => () => {
    const n = note.current;
    if (n && chId) host.noteOff(chId, n.key, n.tag);
  }, [chId]);

  const optionsOpen = useRef(false);
  const [, force] = useState(0);

  return (
    <FxPanel width={737} height={395} style={{ background: '#3f454a' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 126, height: 104, background: '#2d3438' }} />
      <XYPad x={5} y={5} size={93} px={modx.value / 65536} py={mody.value / 65536}
        onBegin={() => store.beginGesture('X / Y modulation')} onEnd={() => store.endGesture()}
        onChange={(x, y) => { modx.set(Math.round(x * 65536)); mody.set(Math.round(y * 65536)); }} />
      <OptionsButton x={101} y={4} open={optionsOpen.current} onClick={(e) => {
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        optionsOpen.current = true;
        force((n) => n + 1);
        openMenu(r.left, r.bottom, [
          { label: 'Continuous output', checked: cont, hint: 'Keep the outputs following the global X / Y modulation when no note plays', onClick: () => edit('Continuous output', (p) => { p.cont = !cont; }) },
        ], { onClose: () => { optionsOpen.current = false; force((n) => n + 1); } });
      }} />
      <Txt x={107} y={34} w={10} h={13} align="center" size={11}>x</Txt>
      <MiniWheel x={104} y={48} size={16} control={modx.control} color="#d6dde2" pointer={0.55} />
      <MiniWheel x={104} y={70} size={16} control={mody.control} color="#d6dde2" pointer={0.55} />
      <Txt x={107} y={87} w={10} h={13} align="center" size={11}>y</Txt>

      <ArtSelect x={132} y={6} value={sel} onChange={(i) => view('Articulator', (p) => { p.sel = i; })} />
      <Txt x={176} y={14} w={34} h={11} align="center" size={11}>MODE</Txt>
      <ModeGlyph x={182} y={25} polar={art.polar} onToggle={() => edit('Combining mode', (p) => { (p.arts as EcArt[])[sel].polar = !art.polar; })} />
      <Txt x={208} y={33} w={30} h={10} align="right" size={12}>BASE</Txt>
      <BigWheel x={241} y={21} size={34} control={base.control} />
      <BigWheel x={273} y={6} size={30} control={envLevel.control} bipolar />
      <Txt x={306} y={14} w={23} h={11} size={11}>ENV</Txt>
      <BigWheel x={273} y={40} size={30} control={lfoLevel.control} bipolar />
      <Txt x={306} y={51} w={23} h={11} size={11}>LFO</Txt>
      <SourceCombo x={179} y={75} w={145} h={23} items={EC_SOURCES} value={src} used={used} onChange={(i) => view('Source', (p) => { p.src = i; })} />

      {/* the key range keyboard */}
      <div className="fxk-abs" style={{ left: 331, top: 7, width: 399, height: 89, boxSizing: 'border-box', background: '#31383c', border: '1px solid #31383c' }}>
        <PianoKb x={0} y={0} w={397} keysH={55} scroll={kscroll} onScroll={(s) => view('Keyboard scroll', (p) => { p.kscroll = Math.round(s); })}
          lo={art.lo} hi={art.hi} held={held}
          onRange={(a, b) => edit('Key range', (p) => { const x = (p.arts as EcArt[])[sel]; x.lo = a; x.hi = b; }, `ecrange:${sel}`)}
          onKey={(k, down, vel) => {
            if (!chId) return;
            if (down) {
              stopNote();
              note.current = { key: k, tag: host.noteOn(chId, k, vel ?? 100) };
              setHeld(new Set([k]));
            } else stopNote();
          }}
          keyHint="Test articulator: key" rangeHint="Key range for the current articulator: drag along the ruler to set the limits" />
      </div>

      <EnvEditor src={src} sel={sel} art={art} shape={shape} write={writeShape} setFlag={setFlag} lfo={lfo} noteLine={noteLine} onReset={reset} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'envctrl', Editor: EnvelopeControllerEditor };
