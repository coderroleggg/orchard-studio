// MiniSynth editor (FL: MiniSynth, the FL Studio Mobile synth's 717 x 473
// panel): six page tabs (Oscillator, Amplifier, Filter, Filter Env, LFO,
// Effects; the Effects page has Delay / Chorus / Phaser / Distortion tabs at
// the right) and the preset bar at the bottom. Controls sit at FL's editor
// coordinates (CMiniSynthEditor, MiniSynth_x64.dylib 0x10bf0..0x11258), group
// frames and value displays where FL's page bitmaps have them, colours sampled
// from FL's bitmaps. Original drawing, no Image-Line artwork.

import type { ReactNode } from 'react';
import { FxPanel, useFxEditor, useFxState, useFxView } from '../../kit';
import type { FxEditorModule } from '../../registry';
import * as A from '../../../../store/actions';
import { genDef, genPresetState } from '../../../../model/gen/registry';
import { MS_DELAY_TIMES, MS_KINDS, MS_RATES } from '../../../../model/gen/plugins/minisynth';
import { FilterPad, Fader, KindMenu, Knob, Leds, StepKnob, Switch } from './widgets';
import './minisynth.css';

const PAGES = ['Oscillator', 'Amplifier', 'Filter', 'Filter Env', 'LFO', 'Effects'];
const FX_PAGES = ['Delay', 'Chorus', 'Phaser', 'Distortion'];

/** A titled group frame (rounded outline, title over the top edge). */
function Group({ x, y, w, h, title }: { x: number; y: number; w: number; h: number; title?: string }) {
  return (
    <div className="fxk-abs ms-group" style={{ left: x, top: y, width: w, height: h }}>
      {title && <div className="ms-group-title"><span>{title}</span></div>}
    </div>
  );
}

function Caption({ x, y, w, children, size = 15 }: { x: number; y: number; w: number; children: ReactNode; size?: number }) {
  return <div className="fxk-abs ms-caption" style={{ left: x, top: y, width: w, fontSize: size }}>{children}</div>;
}

function OscPage() {
  return (
    <>
      <Group x={18} y={86} w={302} h={314} title="Waveform" />
      <Group x={362} y={86} w={145} h={314} title="Voice mode" />
      <Group x={548} y={86} w={131} h={314} title="Mod wheel" />
      <KindMenu k="oscKind" x={43} y={144} w={144} h={39} names={MS_KINDS} />
      <Caption x={196} y={96} w={110}>Transpose</Caption>
      <Knob k="transpose" x={220} y={130} />
      <Caption x={30} y={243} w={110}>Modifier</Caption>
      <Knob k="oscMod" x={55} y={277} />
      <Caption x={196} y={243} w={110}>Noise</Caption>
      <Knob k="oscNoise" x={220} y={277} />
      <Leds k="voicesMode" x={393} y={111} n={3} gap={51} labels={['Poly', 'Mono', 'Lead']} labelX={436} labelW={60} />
      <Caption x={380} y={270} w={110}>Slide time</Caption>
      <Knob k="slideTime" x={403} y={304} display={false} />
      <Leds k="mwDest" x={566} y={129} n={2} gap={61} labels={['Filter', 'LFO']} labelX={609} labelW={60} />
      <Caption x={558} y={270} w={110}>Amount</Caption>
      <Knob k="mwAmount" x={582} y={304} display={false} />
    </>
  );
}

function EnvPage({ keys, xs, amount }: { keys: string[]; xs: number[]; amount?: boolean }) {
  const names = ['Attack', 'Decay', 'Sustain', 'Release'];
  return (
    <>
      {keys.map((k, i) => (
        <div key={k}>
          <Caption x={xs[i] - 24} y={95} w={110}>{names[i]}</Caption>
          <Fader k={k} x={xs[i]} y={119} />
        </div>
      ))}
      {amount && (
        <>
          <Group x={566} y={161} w={130} h={174} title="Amount" />
          <Knob k="egfAmnt" x={600} y={197} />
        </>
      )}
    </>
  );
}

function FilterPage() {
  return (
    <>
      <FilterPad x={61} y={130} w={228} h={207} />
      <Group x={401} y={145} w={274} h={201} title="Filter tracking" />
      <Caption x={411} y={176} w={110}>Keyboard</Caption>
      <Knob k="fltKbd" x={435} y={210} />
      <Caption x={554} y={176} w={110}>Velocity</Caption>
      <Knob k="fltVel" x={578} y={210} />
    </>
  );
}

function LfoPage() {
  return (
    <>
      <Group x={24} y={86} w={130} h={314} title="Shape" />
      <Group x={185} y={86} w={130} h={314} title="Rate" />
      <Group x={347} y={86} w={187} h={314} title="Destination" />
      <Group x={565} y={86} w={130} h={314} title="Amount" />
      <Leds k="lfoShape" x={46} y={145} n={3} gap={84} labels={['Sine', 'Saw', 'Square']} labelX={84} labelW={62} />
      <StepKnob k="lfoRate" x={220} y={197} n={11} names={MS_RATES} rate />
      <Leds k="lfoDest" x={369} y={145} n={3} gap={84} labels={['Filter', 'Frequency', 'Osc. Modifier']} labelX={404} labelW={124} />
      <Knob k="lfoAmnt" x={600} y={197} />
    </>
  );
}

function FxPage() {
  const page = useFxState<number>('fxPage', 0);
  const view = useFxView();
  const rate = (k: string, title: string, step?: { n: number; names: string[]; rate?: boolean }) => (
    <>
      <Group x={36} y={220} w={130} h={174} title={title} />
      {step ? <StepKnob k={k} x={69} y={259} n={step.n} names={step.names} rate={step.rate} /> : <Knob k={k} x={69} y={259} />}
    </>
  );
  const faders = (items: [string, string, number][]) => items.map(([k, cap, x]) => (
    <div key={k}>
      <Caption x={x - 24} y={95} w={110}>{cap}</Caption>
      <Fader k={k} x={x} y={119} />
    </div>
  ));
  let body: ReactNode = null;
  if (page === 0) body = (
    <>
      <Caption x={40} y={110} w={100}>Delay</Caption>
      <Switch k="delay" x={59} y={138} />
      {rate('delayTime', 'Time', { n: 3, names: MS_DELAY_TIMES })}
      {faders([['delayFdbk', 'Feedback', 235], ['delayFilter', 'Filter', 379], ['delayMix', 'Mix', 522]])}
    </>
  );
  else if (page === 1) body = (
    <>
      <Caption x={40} y={110} w={100}>Chorus</Caption>
      <Switch k="chorus" x={59} y={138} />
      {rate('chorusRate', 'Rate')}
      {faders([['chorusDepth', 'Mod', 286], ['chorusMix', 'Mix', 480]])}
    </>
  );
  else if (page === 2) body = (
    <>
      <Caption x={40} y={110} w={100}>Phaser</Caption>
      <Switch k="phaser" x={59} y={138} />
      {rate('phaserSpeed', 'Rate', { n: 11, names: MS_RATES, rate: true })}
      {faders([['phaserWidth', 'Width', 214], ['phaserFdbk', 'Feedback', 322], ['phaserFreq', 'Frequency', 429], ['phaserMix', 'Mix', 537]])}
    </>
  );
  else body = (
    <>
      <Caption x={30} y={124} w={120}>Distortion</Caption>
      <Switch k="dist" x={59} y={151} />
      <Group x={236} y={91} w={131} h={175} title="Overdrive" />
      <Knob k="overdrive" x={270} y={130} />
      <Group x={452} y={91} w={130} h={175} title="Decimator" />
      <Knob k="decimator" x={485} y={130} />
      <div className="fxk-abs ms-grille" style={{ left: 66, top: 292, width: 542, height: 92 }} />
    </>
  );
  return (
    <>
      {body}
      <div className="fxk-abs ms-fxtabs" style={{ left: 657, top: 70, width: 60, height: 345 }}>
        {FX_PAGES.map((nm, i) => (
          <div key={nm} className={'ms-fxtab' + (i === page ? ' on' : '')} onPointerDown={() => view('Effect page', (p) => { p.fxPage = i; })}>
            <span>{nm}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** FL Studio Mobile's preset bar: previous / next preset and the preset name. */
function PresetBar() {
  const { slotId, plugin, params } = useFxEditor();
  const presets = genDef(plugin)?.presets ?? [];
  const cur = typeof params.__preset === 'string' ? params.__preset : '';
  const idx = presets.findIndex((p) => p.name === cur);
  const load = (d: number) => {
    if (!presets.length) return;
    const i = idx < 0 ? (d > 0 ? 0 : presets.length - 1) : (idx + d + presets.length) % presets.length;
    const pr = presets[i];
    const fresh = genPresetState(plugin, pr, params);
    A.editFx(slotId, `Preset: ${pr.name}`, (p) => { for (const k of Object.keys(p)) delete p[k]; Object.assign(p, fresh); });
  };
  const name = cur ? cur.slice(cur.lastIndexOf('/') + 1) : 'Default';
  return (
    <>
      <div className="fxk-abs ms-arrow left" style={{ left: 128, top: 425, width: 44, height: 40 }} onPointerDown={() => load(-1)} />
      <div className="fxk-abs ms-preset" style={{ left: 180, top: 430, width: 356, height: 28 }}>{name}</div>
      <div className="fxk-abs ms-arrow right" style={{ left: 545, top: 425, width: 44, height: 40 }} onPointerDown={() => load(1)} />
      <div className="fxk-abs ms-logo" style={{ left: 596, top: 424, width: 116, height: 42 }}>
        <span className="ms-logo-a">FL STUDIO</span>
        <span className="ms-logo-b">mobile</span>
      </div>
    </>
  );
}

function MiniSynthEditor() {
  const page = useFxState<number>('page', 0);
  const view = useFxView();
  let body: ReactNode;
  switch (page) {
    case 1: body = <EnvPage keys={['ampAtk', 'ampDec', 'ampSus', 'ampRel']} xs={[106, 250, 393, 536]} />; break;
    case 2: body = <FilterPage />; break;
    case 3: body = <EnvPage keys={['egfAtk', 'egfDec', 'egfSus', 'egfRel']} xs={[63, 192, 321, 450]} amount />; break;
    case 4: body = <LfoPage />; break;
    case 5: body = <FxPage />; break;
    default: body = <OscPage />;
  }
  return (
    <FxPanel width={717} height={473} className="ms-panel">
      <div className="fxk-abs ms-tabbar" style={{ left: 0, top: 0, width: 717, height: 66 }}>
        {PAGES.map((nm, i) => (
          <div key={nm} className={'ms-tab' + (i === page ? ' on' : '')} style={{ left: 9 + i * 117, width: 116 }}
            onPointerDown={() => view('MiniSynth page', (p) => { p.page = i; })}>{nm}</div>
        ))}
      </div>
      {body}
      <div className="fxk-abs ms-bottom" style={{ left: 0, top: 415, width: 717, height: 58 }} />
      <PresetBar />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'minisynth', Editor: MiniSynthEditor };
