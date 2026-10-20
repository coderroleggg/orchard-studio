// Fruity DX10 editor (FL: SynthPanel 536 x 340): the MISC, AMPLITUDE,
// MODULATION 1 / 2 and logo panels and the "Current key & range" keyboard, at
// FL's form coordinates (control positions = panel + control Left / Top).
// Look after FL 2026's DX10 (editor thumbnail colours: background #303E45,
// panels #5D6973); original drawing. The envelope displays show FL's
// piecewise-linear envelope sketches; their points can be dragged. The plugin
// menu shows / hides the keyboard (FL: "Show/Hide Keyboard"), which shrinks the
// panel to 536 x 238.

import { store, useProject } from '../../../../store';
import * as A from '../../../../store/actions';
import { channelOfSlot } from '../../../../model/gen/ids';
import { FxPanel, useFxEditor, useFxMonitor, useFxState, useFxView, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { useState } from 'react';
import { COL, Cap, DxKnob, DxPanel, EnvDisplay, Logo, ampPoints, modPoints, type EnvPoint } from './widgets';
import { DxKeyboard, kbDefaultStart } from './Keyboard';

const W = 536;
const H_FULL = 340;
const H_NOKB = 238;
const U = 65536;

/** Normalised value of a 0..65536 wheel. */
function useWheel(key: string) {
  const p = useParam(key);
  return { p, v: p.value / U, set: (x: number) => p.set(Math.round(Math.min(1, Math.max(0, x)) * U)) };
}

function AmpEnv() {
  const att = useWheel('attack'), dec = useWheel('decay'), rel = useWheel('release');
  const pts = ampPoints(att.v, dec.v, rel.v);
  const drag = (i: number, [x]: EnvPoint) => {
    if (i === 1) att.set(3 * x);
    else if (i === 2) dec.set(3 * x - att.v);
    else if (i === 3) rel.set(3 * x - att.v - dec.v);
  };
  return <EnvDisplay x={6} y={122} pts={pts} hint="Amplitude envelope display" onDrag={drag}
    onBegin={() => store.beginGesture('Amplitude envelope')} onEnd={() => store.endGesture()} />;
}

function ModEnv({ n, x, y }: { n: 1 | 2; x: number; y: number }) {
  const init = useWheel(`mod${n}Init`), time = useWheel(`mod${n}Decay`), sus = useWheel(`mod${n}Sustain`), rel = useWheel(`mod${n}Release`);
  const pts = modPoints(init.v, time.v, sus.v, rel.v);
  const drag = (i: number, [px, py]: EnvPoint) => {
    if (i === 0) init.set(py);
    else if (i === 1) { time.set(2 * px); sus.set(py); }
    else rel.set(2 * px - time.v);
  };
  return <EnvDisplay x={x} y={y} pts={pts} hint={`Modulation ${n} envelope display`} onDrag={drag}
    onBegin={() => store.beginGesture(`Modulation ${n} envelope`)} onEnd={() => store.endGesture()} />;
}

function Keys() {
  const { slotId } = useFxEditor();
  const chId = channelOfSlot(slotId);
  const s = useProject((p) => p.channels.find((c) => c.id === chId)?.sampler);
  const root = s?.rootKey ?? 60, lo = s?.keyLo ?? 0, hi = s?.keyHi ?? 131;
  const stored = useFxState<number | undefined>('kbView', undefined);
  const view = useFxView();
  const [held, setHeld] = useState<ReadonlySet<number>>(new Set());
  useFxMonitor(slotId, (d) => {
    const keys = Array.isArray(d.keys) ? (d.keys as number[]) : [];
    const k = keys.join(',');
    setHeld((h) => ([...h].join(',') === k ? h : new Set(keys)));
  });
  const start = typeof stored === 'number' ? stored : kbDefaultStart(root);
  return <DxKeyboard x={2} y={238} w={532} h={99} chId={chId} root={root} lo={lo} hi={hi} held={held}
    start={start} onStart={(wi) => view('Keyboard scroll', (p) => { p.kbView = Math.max(0, Math.min(77 - 28, Math.round(wi))); })} />;
}

function DX10Editor() {
  const kb = useFxState<boolean>('keyboard', true) !== false;
  return (
    <FxPanel width={W} height={kb ? H_FULL : H_NOKB} style={{ background: COL.bg }}>
      <DxPanel x={2} y={2} w={176} h={89} title="MISC" />
      <DxKnob k="waveform" x={6} y={37} />
      <DxKnob k="octave" x={50} y={37} />
      <DxKnob k="lfoRate" x={95} y={37} />
      <DxKnob k="vibrato" x={140} y={37} />
      <Cap x={12} y={76} w={24}>WAVE</Cap>
      <Cap x={49} y={76} w={38}>COARSE</Cap>
      <Cap x={92} y={76} w={42}>LFO RATE</Cap>
      <Cap x={139} y={76} w={38}>VIB</Cap>

      <DxPanel x={2} y={93} w={176} h={143} title="AMPLITUDE" />
      <AmpEnv />
      <DxKnob k="attack" x={6} y={180} />
      <DxKnob k="decay" x={50} y={180} />
      <DxKnob k="release" x={95} y={180} light />
      <Cap x={12} y={219} w={24}>ATT</Cap>
      <Cap x={49} y={219} w={38}>DEC</Cap>
      <Cap x={94} y={219} w={38}>REL</Cap>

      <DxPanel x={180} y={2} w={176} h={201} title="MODULATION 1" />
      <DxKnob k="mod1Coarse" x={185} y={37} />
      <DxKnob k="mod1Fine" x={228} y={37} />
      <DxKnob k="mod1Vel" x={273} y={37} />
      <DxKnob k="modThru" x={317} y={37} />
      <Cap x={183} y={76} w={40}>COARSE</Cap>
      <Cap x={227} y={76} w={38}>FINE</Cap>
      <Cap x={272} y={76} w={38}>VEL.SENS</Cap>
      <Cap x={321} y={76} w={29}>THRU</Cap>
      <ModEnv n={1} x={184} y={93} />
      <DxKnob k="mod1Init" x={185} y={150} />
      <DxKnob k="mod1Decay" x={227} y={150} />
      <DxKnob k="mod1Sustain" x={272} y={150} />
      <DxKnob k="mod1Release" x={316} y={150} light />
      <Cap x={191} y={190} w={24}>INIT</Cap>
      <Cap x={226} y={190} w={38}>TIME</Cap>
      <Cap x={271} y={190} w={38}>SUS</Cap>
      <Cap x={316} y={190} w={38}>REL</Cap>

      <DxPanel x={180} y={205} w={354} h={31} />
      <Logo x={180} y={205} />

      <DxPanel x={358} y={2} w={176} h={201} title="MODULATION 2" />
      <DxKnob k="mod2Coarse" x={363} y={37} />
      <DxKnob k="mod2Fine" x={407} y={37} />
      <DxKnob k="mod2Vel" x={452} y={37} />
      <Cap x={360} y={76} w={42}>COARSE</Cap>
      <Cap x={406} y={76} w={38}>FINE</Cap>
      <Cap x={451} y={76} w={38}>VEL.SENS</Cap>
      <ModEnv n={2} x={362} y={93} />
      <DxKnob k="mod2Init" x={362} y={150} />
      <DxKnob k="mod2Decay" x={406} y={150} />
      <DxKnob k="mod2Sustain" x={450} y={150} />
      <DxKnob k="mod2Release" x={495} y={150} light />
      <Cap x={368} y={190} w={24}>INIT</Cap>
      <Cap x={405} y={190} w={38}>TIME</Cap>
      <Cap x={449} y={190} w={38}>SUS</Cap>
      <Cap x={494} y={190} w={38}>REL</Cap>

      {kb && <Keys />}
    </FxPanel>
  );
}

function keyboardShown(slotId: string): boolean {
  return A.findFx(store.project, slotId)?.fx.params.keyboard !== false;
}

export const editor: FxEditorModule = {
  id: 'dx10',
  Editor: DX10Editor,
  size: (params) => ({ w: W, h: params.keyboard === false ? H_NOKB : H_FULL }),
  menu: (slotId) => [{
    label: 'Show keyboard', checked: keyboardShown(slotId),
    onClick: () => A.setFxStateNoHistory(slotId, 'Keyboard', (p) => { p.keyboard = !keyboardShown(slotId); }),
  }],
};
