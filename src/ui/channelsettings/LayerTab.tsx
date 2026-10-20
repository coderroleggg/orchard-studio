// Layer channel settings page (FL: the Layer's window shows only the FUNC
// sheet's Levels adjustment, Layering and Keyboard panels; Polyphony, Time,
// Tracking, Cut groups, Arpeggiator and Echo are hidden). The Layering panel
// is laid out at FL's form coordinates (TVectorPanel LayerPanel, 228 x 122;
// children at their Left / Top, see docs/research/layer.md).

import type { Draft } from 'immer';
import type { Channel } from '../../model/types';
import { adjVolGain, defaultSampler } from '../../model/sampler';
import { defaultLayer, LAYER_FADE_MAX, type LayerSettings } from '../../model/layer';
import { formatDb, formatPan } from '../../model/scales';
import { DEFAULT_KEY, KEY_MAX, KEY_MIN, keyName } from '../../model/notes';
import * as A from '../../store/actions';
import { store } from '../../store';
import { Knob } from '../widgets/Knob';
import { openMenu } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import { KnobCell, Section, chAuto, editSampler } from './controls';
import { fmtCents, signedPct } from './format';
import { PreviewKeyboard } from './PreviewKeyboard';
import { layerMenuItems, pressSetChildren } from './layerMenu';
import './layer.css';

const D = defaultSampler();
const gainDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

/** FL's round check box of the Layering panel (Random, Sequential, Crossfade) with its hint text. */
function LayerCheck({ on, label, hint, set, x, y }: { on: boolean; label: string; hint: string; set: (on: boolean) => void; x: number; y: number }) {
  return (
    <div className={'cs-tog ly-radio ly-abs' + (on ? ' on' : '')} style={{ left: x, top: y }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        set(!on);
        setHint(`${hint} (${!on ? 'on' : 'off'})`);
      }}
      onPointerEnter={() => setHint(`${hint} (${on ? 'on' : 'off'})`)}
      onPointerLeave={clearHint}>
      <span className="cs-tog-box" />
      <span className="cs-tog-label">{label}</span>
    </div>
  );
}

/** FL's "Layering" panel: Set children, Show children, Random / Sequential / Crossfade, the FADE wheel and the Layering menu. */
function LayeringPanel({ ch }: { ch: Channel }) {
  const L = ch.layer ?? defaultLayer();
  const id = ch.id;
  const setFlag = (label: string, r: (l: Draft<LayerSettings>) => void) => A.setLayer(id, label, r);
  const button = (left: number, caption: string, hint: string, run: () => void) => (
    <button className="ly-btn ly-abs" style={{ left, top: 26, width: 106, height: 35 }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.preventDefault(); e.stopPropagation(); run(); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {caption}
    </button>
  );
  return (
    <div className="ly-panel">
      <div className="ly-title">
        <button className="ly-menu"
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.preventDefault();
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            openMenu(r.left, r.bottom, layerMenuItems(ch), { minWidth: 150 });
          }}
          onPointerEnter={() => setHint('Extra layer functions')} onPointerLeave={clearHint}>
          <svg width="7" height="7" viewBox="0 0 7 7"><path d="M1 0.5 L5.5 3.5 L1 6.5 Z" fill="currentColor" /></svg>
        </button>
        <span>Layering</span>
      </div>
      {button(6, 'Set children', 'Layer with selected channels', () => {
        const n = pressSetChildren(id);
        if (n >= 0) flashHint(n ? `${n} child${n === 1 ? '' : 'ren'} set` : 'No children: right-click the selector of the channels to layer, then press Set children');
      })}
      {button(116, 'Show children', 'Show (select) all layered channels', () => A.showLayerChildren(id))}
      <LayerCheck x={3} y={75} label="Random" hint="Trigger one of the children at random" on={L.random}
        set={(v) => setFlag('Layer random', (l) => { l.random = v; })} />
      <LayerCheck x={85} y={75} label="Sequential" hint="Trigger one of the children in sequential order" on={L.sequential}
        set={(v) => setFlag('Layer sequential', (l) => { l.sequential = v; })} />
      <LayerCheck x={3} y={95} label="Crossfade" hint="Crossfade between children" on={L.crossfade}
        set={(v) => setFlag('Layer crossfade', (l) => { l.crossfade = v; })} />
      <div className="ly-abs ly-fade" style={{ left: 190, top: 72 }}>
        <KnobCell cap="FADE" label="Crossfade level" size={30} auto={chAuto(id, 'layer.fade')} value={L.fade} min={0} max={LAYER_FADE_MAX} step={1} def={0}
          format={(v) => `${Math.round((v / LAYER_FADE_MAX) * 100)}%`}
          set={(v) => A.setLayer(id, 'Crossfade level', (l) => { l.fade = Math.round(v); })} />
      </div>
    </div>
  );
}

export function LayerTab({ ch }: { ch: Channel }) {
  const s = ch.sampler;
  const id = ch.id;
  const set = (label: string, r: Parameters<typeof editSampler>[2]) => editSampler(id, label, r);
  const zone = s.keyLo > KEY_MIN || s.keyHi < KEY_MAX ? `  Zone: ${keyName(s.keyLo)} - ${keyName(s.keyHi)}` : '';
  return (
    <div className="cs-page ly-page">
      <Section title="Levels adjustment" className="fixed ly-levels">
        <KnobCell cap="PAN" label="Panning offset" size={38} auto={chAuto(id, 'sampler.adjPan')} value={s.adjPan} min={-1} max={1} bipolar def={D.adjPan} format={formatPan}
          set={(v) => set('Levels pan', (d) => { d.adjPan = v; })} />
        <KnobCell cap="VOL" label="Volume multiplier" size={38} auto={chAuto(id, 'sampler.adjVol')} value={s.adjVol} def={D.adjVol}
          format={(v) => `${Math.round(v * 200)}% (${formatDb(gainDb(adjVolGain(v)))})`}
          set={(v) => set('Levels volume', (d) => { d.adjVol = v; })} />
        <KnobCell cap="MOD X" label="Modulation X offset" size={38} auto={chAuto(id, 'sampler.adjModX')} value={s.adjModX} min={-1} max={1} bipolar def={D.adjModX} format={signedPct}
          set={(v) => set('Levels mod X', (d) => { d.adjModX = v; })} />
        <KnobCell cap="MOD Y" label="Modulation Y offset" size={38} auto={chAuto(id, 'sampler.adjModY')} value={s.adjModY} min={-1} max={1} bipolar def={D.adjModY} format={signedPct}
          set={(v) => set('Levels mod Y', (d) => { d.adjModY = v; })} />
      </Section>

      <LayeringPanel ch={ch} />

      <Section title={`Root note: ${keyName(s.rootKey)}${zone}`} className="col ly-keys">
        <div className="ly-kb-row">
          <button className="ly-btn ly-reset"
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.preventDefault();
              set('Reset keyboard', (d) => { d.rootKey = DEFAULT_KEY; d.keyLo = KEY_MIN; d.keyHi = KEY_MAX; });
            }}
            onPointerEnter={() => setHint('Default layer properties')} onPointerLeave={clearHint}>
            Reset
          </button>
          <span className="ly-fine">Fine tune</span>
          <Knob size={22} value={s.fineTune} min={-100} max={100} bipolar defaultValue={D.fineTune} label="Fine tuning" format={fmtCents}
            auto={chAuto(id, 'sampler.fineTune')}
            onBegin={() => store.beginGesture('Fine tune')} onEnd={() => store.endGesture()}
            onChange={(v) => set('Fine tune', (d) => { d.fineTune = Math.round(v); })} />
          <div className="cs-note cs-push">Right-click a key: root note<br />Drag the ruler: key region</div>
        </div>
        <PreviewKeyboard ch={ch} />
      </Section>
    </div>
  );
}
