// BooBass editor (FL: BooBass, SynthPanel 340 x 150): the slate panel with a
// light, curved body (a bass guitar's edge), the BOOBASS logo top right and
// three black knobs with metal caps and red pointers (BassWheel, MidWheel,
// TrebleWheel, 56 x 56 at FL's form positions), labels under the knobs.
// Colours sampled from FL's plugin database thumbnail (read-only reference);
// original drawing, no FL artwork. The FL data import lives in the plugin
// window menu ("Load FL Studio data..."), as FL's panel has no such control.

import { useId } from 'react';
import { FxPanel, useNoScrollWheel, useParam } from '../../kit';
import { useControl } from '../../../widgets/control';
import type { MenuItem } from '../../../widgets/ContextMenu';
import type { FxEditorModule } from '../../registry';
import { channelOfSlot } from '../../../../model/gen/ids';
import { store } from '../../../../store';
import { forgetFlData, pickFlData, projectFlData, reuseFlData } from './fldata';

const BG = '#31373b';
const BODY = '#c0c0c0';
const LABEL = '#4a5054';
const SWEEP = 300;

function polar(c: number, r: number, deg: number): [number, number] {
  const a = ((deg - 90) * Math.PI) / 180;
  return [c + r * Math.cos(a), c + r * Math.sin(a)];
}

/** Black knob with a brushed metal cap, a red pointer dot and tick dots around it. */
function BooKnobView({ size, t }: { size: number; t: number }) {
  const c = size / 2;
  const id = 'bb' + useId().replace(/:/g, '');
  const ang = -SWEEP / 2 + SWEEP * Math.min(1, Math.max(0, t));
  const rKnob = size * 0.36;
  const rCap = size * 0.23;
  const [px, py] = polar(c, size * 0.295, ang);
  const ticks = [];
  for (let k = 0; k <= 10; k++) {
    const [x, y] = polar(c, size * 0.455, -SWEEP / 2 + (SWEEP * k) / 10);
    ticks.push(<circle key={k} cx={x} cy={y} r={size * 0.016} fill="#6b7175" />);
  }
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ display: 'block', overflow: 'visible' }}>
      <defs>
        <radialGradient id={id + 'k'} cx="0.45" cy="0.3" r="0.75">
          <stop offset="0" stopColor="#3a3f43" />
          <stop offset="0.55" stopColor="#141618" />
          <stop offset="1" stopColor="#050606" />
        </radialGradient>
        <linearGradient id={id + 'c'} x1="0.2" y1="0" x2="0.8" y2="1">
          <stop offset="0" stopColor="#d9dcde" />
          <stop offset="0.45" stopColor="#8c9296" />
          <stop offset="1" stopColor="#4b5155" />
        </linearGradient>
      </defs>
      {ticks}
      <circle cx={c} cy={c + 1} r={rKnob + 1.5} fill="rgba(0,0,0,0.35)" />
      <circle cx={c} cy={c} r={rKnob} fill={`url(#${id}k)`} stroke="#000" strokeWidth={0.8} />
      <circle cx={c} cy={c} r={rCap + 0.8} fill="#0b0c0d" />
      <circle cx={c} cy={c} r={rCap} fill={`url(#${id}c)`} />
      <ellipse cx={c - rCap * 0.15} cy={c - rCap * 0.35} rx={rCap * 0.6} ry={rCap * 0.32} fill="#fff" opacity={0.18} />
      <circle cx={px} cy={py} r={size * 0.04} fill="#e2282f" />
    </svg>
  );
}

function BooKnob({ k, x, y }: { k: string; x: number; y: number }) {
  const p = useParam(k);
  const h = useControl({ travel: 200, ...p.control }, 'vertical');
  const ref = useNoScrollWheel<HTMLDivElement>();
  const t = (p.value - p.def.min) / (p.def.max - p.def.min || 1);
  return (
    <div ref={ref} className="fxk-abs fxk-wheel" style={{ left: x, top: y, width: 56, height: 56 }} {...h}>
      <BooKnobView size={56} t={t} />
    </div>
  );
}

function Caption({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <div className="fxk-abs" style={{ left: x - 30, top: y, width: 60, textAlign: 'center', color: LABEL, fontSize: 8, fontWeight: 700, letterSpacing: 0.3, fontFamily: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif', pointerEvents: 'none', transform: 'scaleX(0.9)' }}>
      {children}
    </div>
  );
}

function BooBassEditor() {
  const id = 'bbp' + useId().replace(/:/g, '');
  return (
    <FxPanel width={340} height={150} style={{ background: BG }}>
      <svg className="fxk-abs" width={340} height={150} style={{ left: 0, top: 0, pointerEvents: 'none' }}>
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c9c9c9" />
            <stop offset="1" stopColor={BODY} />
          </linearGradient>
        </defs>
        {/* the body's soft blue-grey rim, then the body */}
        <path d="M24 152 C14 118 14 82 34 62 C78 22 196 6 342 56 L342 152 Z" fill="none" stroke="#5d6673" strokeWidth={5} opacity={0.55} />
        <path d="M24 152 C14 118 14 82 34 62 C78 22 196 6 342 56 L342 152 Z" fill="none" stroke="#8e959d" strokeWidth={2} />
        <path d="M24 152 C14 118 14 82 34 62 C78 22 196 6 342 56 L342 152 Z" fill={`url(#${id})`} />
        <text x={332} y={19} textAnchor="end" style={{ font: '700 13px "Arial Black", "Helvetica Neue", Arial, sans-serif', letterSpacing: 1.5 }}>
          <tspan fill="none" stroke="#5c6f8e" strokeWidth={0.8}>BOO</tspan>
          <tspan fill="#c5cbd1">BASS</tspan>
        </text>
      </svg>
      <BooKnob k="bass" x={50} y={45} />
      <BooKnob k="mid" x={120} y={66} />
      <BooKnob k="treble" x={190} y={75} />
      <Caption x={78} y={101}>BASS</Caption>
      <Caption x={148} y={122}>MID</Caption>
      <Caption x={218} y={131}>TREBLE</Caption>
    </FxPanel>
  );
}

function menu(slotId: string): MenuItem[] {
  const chId = channelOfSlot(slotId);
  const ch = chId ? store.project.channels.find((c) => c.id === chId) : undefined;
  const using = typeof ch?.plugin?.params.dataSample === 'string' && !!ch.plugin.params.dataSample;
  const inProject = projectFlData();
  return [
    { label: 'Load FL Studio data...', onClick: () => pickFlData(slotId) },
    ...(!using && inProject ? [{ label: 'Use FL Studio data from this project', onClick: () => reuseFlData(slotId) }] : []),
    { label: 'Use synthesized sound', checked: !using, disabled: !using, onClick: () => forgetFlData(slotId) },
  ];
}

export const editor: FxEditorModule = { id: 'boobass', Editor: BooBassEditor, menu };
