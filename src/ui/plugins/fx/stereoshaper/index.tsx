// Stereo Shaper editor (FL: Fruity Stereo Shaper, 271 x 313): MIXER MATRIX
// with four bipolar sliders (R into L, L, R, L into R), the routing brackets
// and LEFT / RIGHT output labels; EFFECTS with PRE / POST, the DELAY and
// PHASE wheels and the IN/OUT DIFFERENCE output selector. Positions of the
// painted labels and decorations were measured on FL's 1.5x screenshot.

import { useEffect } from 'react';
import { FxPanel, Label, useFxEditor, useRoutes } from '../../kit';
import * as A from '../../../../store/actions';
import type { FxEditorModule } from '../../registry';
import { CollarKnob, RouteLcd, StateLedRadio, type CollarLook } from '../panomatic/widgets';
import { ShaperSlider } from './ShaperSlider';

const YELLOW = '#ffe410';
const RED = '#ff0e0e';
const MARK = '#ffda10';

/** DELAY / PHASE wheels: steel cap, dark collar with a top highlight, thin track, yellow marker and dot. */
const SHAPER_KNOB: CollarLook = {
  cap: 'conic-gradient(#b8c1c8 0deg, #d2dce0 15deg, #e1e9ef 30deg, #b7c1c5 45deg, #9ca5ab 60deg, #8e979c 75deg, #858f95 90deg, #7f8a8f 120deg, #7f8a8f 150deg, #899297 165deg, #959fa3 180deg, #b9c3c9 195deg, #d6dfe5 210deg, #abb5b9 225deg, #97a1a5 240deg, #8f999e 255deg, #8f989f 270deg, #959fa3 300deg, #9ca5ab 330deg, #a5b1b6 345deg, #b8c1c8 360deg)',
  capShade: 'radial-gradient(circle, rgba(70,80,86,0.45) 0%, rgba(70,80,86,0.18) 40%, rgba(0,0,0,0) 75%)',
  rim: '#dfe8ec', line: '#15181a',
  collar: 'conic-gradient(#6f797f 0deg, #727d81 30deg, #4a5359 55deg, #1d272c 90deg, #2c363c 130deg, #39444b 180deg, #2c363c 230deg, #1d272c 270deg, #4a5359 305deg, #727d81 330deg, #6f797f 360deg)',
  marker: MARK, ticks: null, track: '#383f45', dot: MARK,
  capR: 16.3, lineR: 17.5, collarR: 22.4, trackR: 28.5, trackW: 0.9, markerFrom: 17.6, markerTo: 21.9, markerW: 1.4, dotR: 31.7,
};

/** FL's small pennant markers: ▶ (yellow, left channel) and ◀ (red, right channel). */
function Flag({ x, y, dir, color }: { x: number; y: number; dir: 'right' | 'left' | 'down'; color: string }) {
  const d = dir === 'right' ? 'M0 0 L2.2 0 L5.8 3.8 L2.2 7.6 L0 7.6 Z' : dir === 'left' ? 'M5.8 0 L3.6 0 L0 3.8 L3.6 7.6 L5.8 7.6 Z' : 'M0 0 L8 0 L4 5 Z';
  return (
    <svg className="fxk-abs" width={dir === 'down' ? 8 : 6} height={8} style={{ left: x, top: y, overflow: 'visible', pointerEvents: 'none' }}>
      <path d={d} fill={color} />
    </svg>
  );
}

function Text({ x, y, w, h = 12, children, color = '#dfe6ea', size = 10.5, align = 'left', weight = 400 }: {
  x: number; y: number; w: number; h?: number; children: string; color?: string; size?: number; align?: 'left' | 'center' | 'right'; weight?: number;
}) {
  return (
    <Label x={x} y={y} w={w} h={h} size={size} color={color} align={align}
      style={{ textTransform: 'none', fontFamily: 'var(--font-ui)', fontWeight: weight, letterSpacing: 0, overflow: 'visible' }}>{children}</Label>
  );
}

/** Map a preset's pending FL output index (diffIdx) to the routed track it names. */
function useResolvePresetOutput(routes: { index: number }[]) {
  const { slotId, params } = useFxEditor();
  const pending = params.diffIdx;
  useEffect(() => {
    if (typeof pending !== 'number') return;
    const t = pending > 0 ? routes[pending - 1]?.index ?? -1 : -1;
    A.setFxStateNoHistory(slotId, 'Difference output', (p) => { p.diff = t; delete p.diffIdx; });
  }, [pending, routes, slotId]);
}

function StereoShaperEditor() {
  const { slotId } = useFxEditor();
  const routes = useRoutes(slotId);
  useResolvePresetOutput(routes);
  return (
    <FxPanel width={271} height={313} style={{ background: 'radial-gradient(ellipse 136px 644px at 138px 0px, rgb(84,97,104) 0%, rgb(60,69,72) 100%)' }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 271, height: 24, background: '#495357' }} />
      <Label x={6} y={4} w={104} h={15} size={16} color="#f0eeee"
        style={{ textTransform: 'none', fontFamily: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif', fontStretch: 'condensed', fontWeight: 700, fontStyle: 'italic', letterSpacing: 0, overflow: 'visible' }}>MIXER MATRIX</Label>
      <Label x={161} y={4} w={104} h={15} size={16} color="#f0eeee" align="right"
        style={{ textTransform: 'none', fontFamily: '"Arial Narrow", "Roboto Condensed", Arial, sans-serif', fontStretch: 'condensed', fontWeight: 700, fontStyle: 'italic', letterSpacing: 0, overflow: 'visible' }}>EFFECTS</Label>

      {/* routing brackets: R (red) feeds sliders 1 and 3, L (yellow) feeds sliders 2 and 4 */}
      <svg className="fxk-abs" width={271} height={60} style={{ left: 0, top: 0, pointerEvents: 'none' }}>
        <path d="M36 41 V33.7 H114 V41" fill="none" stroke={RED} strokeWidth={0.9} />
        <path d="M75.3 44.3 V38.3 H153 V44.3" fill="none" stroke="#ffe826" strokeWidth={0.9} />
      </svg>
      <Flag x={32.2} y={50} dir="down" color={RED} />
      <Flag x={73.3} y={49.3} dir="right" color={YELLOW} />
      <Flag x={110.7} y={49.3} dir="left" color={RED} />
      <Flag x={149.2} y={50} dir="down" color={YELLOW} />

      {/* + / - (upper half adds, lower half subtracts) */}
      <div className="fxk-abs" style={{ left: 4.7, top: 150, width: 15.3, height: 18, background: '#4e565e' }} />
      <div className="fxk-abs" style={{ left: 4.7, top: 178, width: 15.3, height: 16.7, background: '#4e565e' }} />
      <Text x={4.7} y={152.5} w={15.3} align="center" color="#b0b9bf" size={12} weight={700}>+</Text>
      <Text x={4.7} y={180} w={15.3} align="center" color="#b0b9bf" size={12} weight={700}>-</Text>

      <ShaperSlider k="rl" x={21} y={60} color={RED} />
      <ShaperSlider k="lvol" x={60} y={60} color={YELLOW} />
      <ShaperSlider k="rvol" x={99} y={60} color={RED} />
      <ShaperSlider k="lr" x={138} y={60} color={YELLOW} />

      <Flag x={34.3} y={290.8} dir="right" color={YELLOW} />
      <Text x={45} y={288.5} w={30} color={YELLOW} size={9.5}>LEFT</Text>
      <Text x={112} y={288.5} w={33.5} color={RED} size={9.5} align="right">RIGHT</Text>
      <Flag x={150} y={290.8} dir="left" color={RED} />

      <StateLedRadio stateKey="fxpos" x={187} y={33} w={79} h={17} options={["PRE", "POST"]} fallback={1} label="Effects position" horizontal size={9} weight={400} color="#e6ecef" gap={2.5} />

      <CollarKnob k="delay" x={195} y={67} size={64} look={SHAPER_KNOB} dot />
      <Flag x={203.3} y={133} dir="right" color={YELLOW} />
      <Text x={210} y={130.5} w={36} align="center" size={9.5}>DELAY</Text>
      <Flag x={246.5} y={133} dir="left" color={RED} />

      <CollarKnob k="dephase" x={195} y={160} size={64} look={SHAPER_KNOB} dot />
      <Flag x={203.3} y={227.5} dir="right" color={YELLOW} />
      <Text x={210} y={225} w={36} align="center" size={9.5}>PHASE</Text>
      <Flag x={246.5} y={227.5} dir="left" color={RED} />

      <Text x={174} y={256} w={56} size={9.5}>IN/OUT</Text>
      <Text x={174} y={267.5} w={56} size={9.5}>DIFFERENCE</Text>
      <RouteLcd x={232} y={255} w={33} h={25} stateKey="diff" hint="Difference sidechain output number" look="shaper" routes={routes} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'stereoshaper', Editor: StereoShaperEditor };
