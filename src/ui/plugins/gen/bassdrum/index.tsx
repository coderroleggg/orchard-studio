// BassDrum editor (FL: BassDrum, SynthPanel 389 x 420): the knobs at FL's form
// coordinates (Bassdrum_x64.dylib TSynthEditorForm), around a round display
// with the sample layer (noise sample selector with FL's previous / next
// buttons and its seven small knobs). Quadrants as in FL: MAIN (base, peak,
// slide), MASTER (drive, sub bass, attack), SLAVE (variation base / peak /
// slide / phase) and CLICK (level, cut, freq). Original drawing in FL's colours
// (sampled from FL's thumbnail), no Image-Line artwork.
//
// FL's noise samples and its oscillator waveform are not shipped: the options
// menu imports them from the user's FL installation (BassDrum folder: the
// "sounddata" file and "Noise Samples"), into the project's sample pool.

import { useEffect } from 'react';
import { FxPanel, Label, Wheel, useFxEdit, useFxEditor, useFxState, useFxView } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { store } from '../../../../store';
import { BD_NOISE_NAMES } from '../../../../model/gen/plugins/bassdrum';
import type { FxEditorModule } from '../../registry';
import { importWavFiles, pickFiles, poolSampleNamed } from './flimport';
import * as A from '../../../../store/actions';

const ORANGE = '#d5994e';
const LINE = '#b07a3a';
const TEXT = '#d8d8d8';
const BG = '#1f2021';
const CX = 194, CY = 225;

/** Annular sector path (angles in degrees, 0 = up, clockwise). */
function sector(r0: number, r1: number, a0: number, a1: number): string {
  const p = (r: number, a: number) => {
    const t = ((a - 90) * Math.PI) / 180;
    return `${(CX + r * Math.cos(t)).toFixed(1)} ${(CY + r * Math.sin(t)).toFixed(1)}`;
  };
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M${p(r1, a0)} A${r1} ${r1} 0 ${large} 1 ${p(r1, a1)} L${p(r0, a1)} A${r0} ${r0} 0 ${large} 0 ${p(r0, a0)} Z`;
}

function Tab({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, height: 12, padding: '0 4px', background: ORANGE, color: '#1b1b1b', borderRadius: 2,
      font: 'bold 8px/12px var(--fxk-font, sans-serif)', letterSpacing: 0.5 }}>{children}</div>
  );
}

/** A caption under / above a knob. */
function Cap({ x, y, w = 60, children }: { x: number; y: number; w?: number; children: string }) {
  return <Label x={x - w / 2} y={y} w={w} h={10} size={7} bold color={TEXT}>{children}</Label>;
}

/** FL's big / medium knobs: grey metal bodies with an orange value arc. */
function Knob({ k, x, y, size }: { k: string; x: number; y: number; size: number }) {
  return <Wheel k={k} x={x} y={y} size={size} look="metal" color={ORANGE} track="#2a2b2c" />;
}

/** The sample layer's small knobs (20 px, orange). */
function Small({ k, x, y }: { k: string; x: number; y: number }) {
  return <Wheel k={k} x={x} y={y} size={20} look="classic" color={ORANGE} />;
}

function noiseMenu(slotId: string, edit: ReturnType<typeof useFxEdit>, name: string): MenuItem[] {
  const pool = Object.values(store.project.samples);
  const choose = (sampleId: string, sampleName: string) => edit('Noise sample', (p) => { p.noiseSample = sampleId; p.noiseName = sampleName; });
  return [
    { label: 'FL noise samples', header: true },
    ...BD_NOISE_NAMES.map((n): MenuItem => {
      const s = poolSampleNamed(n);
      return { label: s ? n : `${n} (not imported)`, checked: n === name, radio: true, disabled: !s, onClick: () => s && choose(s.id, n) };
    }),
    { separator: true },
    { label: 'Project samples', submenu: pool.length ? pool.map((s): MenuItem => ({ label: s.name, onClick: () => choose(s.id, s.name) })) : [{ label: '(none)', disabled: true }] },
    { label: 'Load...', onClick: () => void loadNoise(slotId) },
    { label: 'None', onClick: () => choose('', '') },
  ];
}

async function loadNoise(slotId: string): Promise<void> {
  const files = await pickFiles('.wav,audio/wav');
  const got = await importWavFiles(files.slice(0, 1), 'Load noise sample');
  if (!got.length) return;
  const [name, info] = got[0];
  A.editFx(slotId, 'Noise sample', (p) => { p.noiseSample = info.id; p.noiseName = name; });
}

/** Options menu: import FL's own BassDrum content from the user's FL installation. */
async function importFl(slotId: string): Promise<void> {
  const files = await pickFiles('');
  const got = await importWavFiles(files, 'Import FL BassDrum samples');
  const wave = got.find(([n, s]) => n.toLowerCase() === 'sounddata' || s.frames === 1024);
  A.editFx(slotId, 'Import FL BassDrum samples', (p) => {
    if (wave) p.waveSample = wave[1].id;
    const name = typeof p.noiseName === 'string' ? p.noiseName : '';
    const n = got.find(([b]) => b.toLowerCase() === name.toLowerCase());
    if (n) p.noiseSample = n[1].id;
  });
}

function NoiseSelector() {
  const { slotId } = useFxEditor();
  const edit = useFxEdit();
  const view = useFxView();
  const name = useFxState('noiseName', '');
  const sample = useFxState('noiseSample', '');
  // a factory preset names FL's sample: link it once it is in the pool (imported)
  useEffect(() => {
    if (sample || !name) return;
    const s = poolSampleNamed(name);
    if (s) view('Noise sample', (p) => { p.noiseSample = s.id; });
  }, [name, sample, view]);
  const step = (d: number) => {
    const i = BD_NOISE_NAMES.indexOf(name);
    const n = BD_NOISE_NAMES[((i < 0 ? (d > 0 ? -1 : 0) : i) + d + BD_NOISE_NAMES.length) % BD_NOISE_NAMES.length];
    const s = poolSampleNamed(n);
    edit('Noise sample', (p) => { p.noiseName = n; p.noiseSample = s ? s.id : ''; });
  };
  const missing = !!name && !sample;
  const arrow = (x: number, d: number, hint: string, glyph: string) => (
    <div className="fxk-abs" style={{ left: x, top: 205, width: 15, height: 17, color: ORANGE, font: 'bold 11px/17px sans-serif', textAlign: 'center', cursor: 'pointer' }}
      onPointerDown={(e) => { e.stopPropagation(); step(d); }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>{glyph}</div>
  );
  return (
    <>
      {arrow(123, -1, 'Previous noise sample', '‹')}
      <div className="fxk-abs" style={{ left: 142, top: 205, width: 106, height: 17, borderRadius: 2, background: '#120f0b', border: `1px solid #4a3a26`, boxSizing: 'border-box',
        color: missing ? '#8a6a44' : ORANGE, font: 'bold 9px/15px sans-serif', textAlign: 'center', cursor: 'pointer', overflow: 'hidden', whiteSpace: 'nowrap' }}
        onPointerDown={(e) => { e.stopPropagation(); const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); openMenu(r.left, r.bottom, noiseMenu(slotId, edit, name)); }}
        onPointerEnter={() => setHint(missing ? `${name}: FL's sample is not imported (options menu: Import FL BassDrum samples)` : 'Noise sample')} onPointerLeave={clearHint}>
        {name || '(none)'}
      </div>
      {arrow(251, 1, 'Next noise sample', '›')}
    </>
  );
}

function BassDrumEditor() {
  return (
    <FxPanel width={389} height={420} style={{ background: BG }}>
      <svg className="fxk-abs" width={389} height={420} style={{ left: 0, top: 0, pointerEvents: 'none' }}>
        <rect x={6.5} y={10.5} width={376} height={403} rx={16} fill="none" stroke={LINE} strokeWidth={1.2} />
        {/* quadrants: MAIN, MASTER, SLAVE, CLICK */}
        <path d={sector(108, 175, -84, -8)} fill="#232425" stroke={LINE} strokeWidth={1.2} />
        <path d={sector(108, 175, 8, 84)} fill="#232425" stroke={LINE} strokeWidth={1.2} />
        <path d={sector(108, 175, -172, -94)} fill="#232425" stroke={LINE} strokeWidth={1.2} />
        <path d={sector(108, 175, 94, 172)} fill="#232425" stroke={LINE} strokeWidth={1.2} />
        {/* the round display */}
        <circle cx={CX} cy={CY} r={101} fill="#151516" stroke="#0b0b0c" strokeWidth={3} />
        <circle cx={CX} cy={CY} r={96} fill="none" stroke="#3a3a3b" strokeWidth={1} />
        <circle cx={CX} cy={CY} r={88} fill="#0e0d0c" />
        <rect x={130} y={176} width={128} height={20} rx={3} fill="#2a2a2b" stroke="#4b4b4c" />
      </svg>
      <Label x={130} y={178} w={128} h={16} size={11} bold color="#9a9a9a" style={{ letterSpacing: 2, fontStyle: 'italic' }}>BASSDRUM</Label>
      {/* top row */}
      <Knob k="duration" x={36} y={47} size={46} />
      <Knob k="level" x={172} y={47} size={46} />
      <Knob k="ratio" x={307} y={47} size={46} />
      <Cap x={59} y={33}>DURATION</Cap>
      <Cap x={195} y={33}>OUTPUT LEVEL</Cap>
      <Cap x={330} y={33} w={80}>SAMPLING RATIO</Cap>
      {/* MAIN */}
      <Knob k="base" x={123} y={75} size={36} />
      <Knob k="peak" x={77} y={107} size={36} />
      <Knob k="slide" x={46} y={154} size={36} />
      <Cap x={141} y={112}>BASE</Cap>
      <Cap x={95} y={144}>PEAK</Cap>
      <Cap x={64} y={191}>SLIDE</Cap>
      <Tab x={14} y={118}>MAIN</Tab>
      {/* MASTER */}
      <Knob k="drive" x={233} y={75} size={36} />
      <Knob k="sub" x={278} y={107} size={36} />
      <Knob k="attack" x={309} y={154} size={36} />
      <Cap x={251} y={112}>DRIVE</Cap>
      <Cap x={296} y={144}>SUB-BASS</Cap>
      <Cap x={327} y={191}>ATTACK</Cap>
      <Tab x={331} y={118}>MASTER</Tab>
      {/* SLAVE */}
      <Knob k="varBase" x={37} y={212} size={36} />
      <Knob k="varPeak" x={50} y={263} size={36} />
      <Knob k="varSlide" x={80} y={309} size={36} />
      <Knob k="varPhase" x={126} y={337} size={36} />
      <Cap x={55} y={249}>BASE</Cap>
      <Cap x={68} y={300}>PEAK</Cap>
      <Cap x={98} y={346}>SLIDE</Cap>
      <Cap x={144} y={374}>PHASE</Cap>
      <Tab x={14} y={380}>SLAVE</Tab>
      {/* CLICK */}
      <Knob k="clickAmt" x={306} y={262} size={36} />
      <Knob k="clickCut" x={275} y={308} size={36} />
      <Knob k="clickFreq" x={230} y={337} size={36} />
      <Cap x={324} y={299}>LEVEL</Cap>
      <Cap x={293} y={345}>CUT</Cap>
      <Cap x={248} y={374}>FREQ</Cap>
      <Tab x={339} y={380}>CLICK</Tab>
      {/* sample layer */}
      <NoiseSelector />
      <Small k="noiseA" x={140} y={236} />
      <Small k="noiseD" x={170} y={236} />
      <Small k="noiseS" x={200} y={236} />
      <Small k="noiseStart" x={230} y={236} />
      <Small k="noisePitch" x={157} y={270} />
      <Small k="noiseFilter" x={184} y={277} />
      <Small k="noiseMix" x={215} y={270} />
      <Label x={135} y={227} w={30} h={9} size={6} bold color={ORANGE}>A</Label>
      <Label x={165} y={227} w={30} h={9} size={6} bold color={ORANGE}>D</Label>
      <Label x={195} y={227} w={30} h={9} size={6} bold color={ORANGE}>S</Label>
      <Label x={225} y={227} w={30} h={9} size={6} bold color={ORANGE}>DELAY</Label>
      <Label x={152} y={291} w={30} h={9} size={6} bold color={ORANGE}>PITCH</Label>
      <Label x={179} y={298} w={30} h={9} size={6} bold color={ORANGE}>FLT</Label>
      <Label x={210} y={291} w={30} h={9} size={6} bold color={ORANGE}>MIX</Label>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'bassdrum',
  Editor: BassDrumEditor,
  menu: (slotId) => [
    { label: 'Import FL BassDrum samples...', hint: 'Pick "sounddata" and the Noise Samples from your FL Studio installation (Plugins/Fruity/Generators/BassDrum)', onClick: () => void importFl(slotId) },
  ],
};
