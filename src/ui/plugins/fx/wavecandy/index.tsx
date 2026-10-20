// Wave Candy settings panel (FL: Wave Candy, 592 x 315), every control at
// FL's form position: Input (gain, fade out, hold), Appearance (title,
// window switches, reflect / bevel, glow, corners, punches), Colors (28
// targets with hue, lightness, saturation and the two opacities), the four
// mode sheets and "Auto visual mode". The visualisation itself is the
// separate display window (./display.tsx).

import { useState } from 'react';
import {
  WC_BANDS, WC_METER_HINTS, WC_METER_MODES, WC_MODES, WC_TARGET_ITEMS, WC_VEC_MODES, hlsToRgb, rgbToHls,
  wcEffectiveMode, wcGainText, wcHoldText, wcMsText, wcState,
} from '../../../../model/fx/plugins/wavecandy';
import { FxPanel, useAuxWindow, useFxEditor, useParam } from '../../kit';
import { store, useUi } from '../../../../store';
import { mixerTrackName } from '../../../../model/defaults';
import * as A from '../../../../store/actions';
import { openMenu } from '../../../widgets/ContextMenu';
import type { FxEditorModule } from '../../registry';
import { C, Check, Combo, GainSlider, HoldPad, Knob, MetalKnob, Panel, SheetTabs, Text, useStateValue } from './widgets';
import { WaveCandyDisplay } from './display';

/** Combo index <-> colour target index (the combo has section headers). */
const TARGET_ROWS = WC_TARGET_ITEMS.map((it, i) => (it.startsWith('-') ? -1 : i)).filter((i) => i >= 0);

function WaveCandyEditor() {
  const { slotId, params } = useFxEditor();
  const s = wcState(params);
  const holdP = useParam('hold');
  const hold = holdP.value > 0;
  const eff = wcEffectiveMode(s);
  const [sheet, setSheet] = useState(eff);
  const [target, setTarget] = useState(1); // combo row of "Background"
  const ti = TARGET_ROWS.indexOf(target);
  const col = s.colors[Math.max(0, ti)] ?? [256, 256, 0, 0, 0];
  const exists = !!A.findFx(store.project, slotId);

  const set = (label: string, recipe: (p: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
  const toggle = (key: keyof typeof s, label: string) => set(label, (p) => { p[key] = !s[key]; });
  const colorCtl = (k: number, label: string, def: number) => useStateValue(`color${k}`, col[k], 0, 256, def, label, undefined, (p, v) => {
    const cols = (Array.isArray(p.colors) ? (p.colors as number[][]) : s.colors).map((c) => [...c]);
    if (ti >= 0) { cols[ti][k] = v; p.colors = cols; }
  });

  const gain = useStateValue('gain', s.gain, -120, 120, 0, 'Visual gain', wcGainText);
  const fade = useStateValue('fade', s.fade, 0, 5001, 5001, 'Fade out after silence', (v) => (v >= 5001 ? 'Never' : wcMsText(v)));
  const reflect = useStateValue('reflect', s.reflect, -256, 256, 64, 'Bevel size / reflection opacity');
  const corners = useStateValue('corners', s.corners, 0, 512, 256, 'Rounded corners size');
  const punches = useStateValue('punches', s.punches, -24, 24, 0, 'Punches size (rounded / square)');
  const hue = colorCtl(2, 'Hue', 0), light = colorCtl(3, 'Lightness', 16), sat = colorCtl(4, 'Saturation', 64);
  const oa = colorCtl(0, 'Object opacity', 128), ca = colorCtl(1, 'Color opacity', 128);
  const oscUpdate = useStateValue('oscUpdate', s.oscUpdate, 500, 5000, 1000, 'Block length');
  const oscWindow = useStateValue('oscWindow', s.oscWindow, 1000, 10000, 2000, 'Block repeat', (v) => `${(v / 100).toFixed(1)} ms`);
  const oscSep = useStateValue('oscSep', s.oscSep, -1, 1000, -1, 'Stereo display separation', (v) => (v < 0 ? 'Mono' : `${Math.round(v / 10)}%`));
  const specUpdate = useStateValue('specUpdate', s.specUpdate, 500, 10000, 1500, 'Block length', (v) => `${(v / 100).toFixed(1)} ms`);
  const specScale = useStateValue('specScale', s.specScale, 0, 256, 0, 'Frequency curve', (v) => (v >= 256 ? 'Piano keyboard' : String(v)));
  const specRange = useStateValue('specRange', s.specRange, 48, 144, 96, 'dB range', (v) => `${v} dB`);
  const meterScale = useStateValue('meterScale', s.meterScale, 0, 256, 128, 'Scale');
  const meterHold = useStateValue('meterHold', s.meterHold, 0, 5001, 2500, 'Hold duration', wcHoldText);
  const meterSpeed = useStateValue('meterSpeed', s.meterSpeed, 1, 5000, 750, 'Decay speed', wcMsText);
  const vecUpdate = useStateValue('vecUpdate', s.vecUpdate, 500, 5000, 1000, 'Block length', (v) => `${(v / 100).toFixed(1)} ms`);
  const vecThick = useStateValue('vecThickness', s.vecThickness, 100, 600, 350, 'Thickness');

  const [r, g, b] = hlsToRgb(col[2], col[3], col[4]);
  const pickColor = () => {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    inp.oninput = () => {
      const hex = inp.value;
      const [h, l, sa] = rgbToHls(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
      A.editFx(slotId, 'Pick color', (p) => {
        const cols = (Array.isArray(p.colors) ? (p.colors as number[][]) : s.colors).map((c) => [...c]);
        if (ti >= 0) { cols[ti][2] = h; cols[ti][3] = l; cols[ti][4] = sa; p.colors = cols; }
      }, `wc:${slotId}:pick`);
    };
    inp.click();
  };
  const titleMenu = (e: React.PointerEvent) => {
    const fonts = ['Trebuchet MS', 'Tahoma', 'Arial', 'Arial Narrow', 'Verdana', 'Georgia', 'Courier New'];
    openMenu(e.clientX, e.clientY, [
      { label: 'Edit title...', onClick: () => { const t = prompt('Title', s.title); if (t !== null) set('Title', (p) => { p.title = t.slice(0, 128); }); } },
      { header: true, label: 'Font' },
      ...fonts.map((f) => ({ label: f, radio: true, checked: s.font === f, onClick: () => set('Title font', (p) => { p.font = f; }) })),
      { label: 'Size', submenu: [10, 12, 13, 15, 16, 18, 21, 24, 30, 36].map((z) => ({ label: `${z}`, radio: true, checked: s.fontSize === z, onClick: () => set('Title size', (p) => { p.fontSize = z; }) })) },
      { label: 'Italic', checked: !!(s.fontStyle & 1), onClick: () => set('Title style', (p) => { p.fontStyle = s.fontStyle ^ 1; }) },
      { label: 'Bold', checked: !!(s.fontStyle & 2), onClick: () => set('Title style', (p) => { p.fontStyle = s.fontStyle ^ 2; }) },
      { label: 'Alignment', submenu: ['Left', 'Center', 'Right'].map((a, i) => ({ label: a, radio: true, checked: s.titleAlign === i, onClick: () => set('Title alignment', (p) => { p.titleAlign = i; }) })) },
    ]);
  };

  const label = (x: number, y: number, w: number, text: string) => <Text x={x} y={y} w={w} h={23} align="right">{text}</Text>;

  return (
    <FxPanel width={592} height={315} style={{ background: C.bg }}>
      <Panel x={7} y={7} w={116} h={204} title="Input">
        <GainSlider x={11} y={22} w={38} h={115} control={gain} />
        <MetalKnob x={64} y={85} size={44} control={fade} dot="#ff3b30" />
        <Text x={10} y={133} w={40} align="center">Gain</Text>
        <Text x={56} y={133} w={60} align="center">Fade out</Text>
        <HoldPad x={6} y={156} w={104} h={42} on={hold} onClick={() => { holdP.control.onBegin?.(); holdP.set(hold ? 0 : 1); holdP.control.onEnd?.(); }} />
      </Panel>

      <Panel x={131} y={7} w={238} h={204} title="Appearance">
        <Text x={7} y={26} w={30} h={17}>Title</Text>
        <div style={{ position: 'absolute', left: 37, top: 25, width: 160, height: 19, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); titleMenu(e); } }}>
          <Text x={0} y={0} w={160} h={19} size={14} bold={false}>{s.title || ' '}</Text>
        </div>
        <Check x={3} y={50} w={100} caption="Visible" on={s.visible} hint="Show window" onToggle={() => toggle('visible', 'Visible')} />
        <Check x={3} y={71} w={100} caption="Mini view" on={s.mini} hint="Mini view" onToggle={() => toggle('mini', 'Mini view')} />
        <Check x={3} y={92} w={100} caption="Background" on={s.background} hint="Show window background" onToggle={() => toggle('background', 'Background')} />
        <Check x={3} y={113} w={100} caption="Solid" on={s.solid} hint="Set window clickable" onToggle={() => toggle('solid', 'Solid')} />
        <Check x={3} y={134} w={100} caption="Keep in front" on={s.stayOnTop} hint="Keep window on top" onToggle={() => toggle('stayOnTop', 'Keep in front')} />
        <Check x={3} y={155} w={100} caption="On desktop" on={s.onDesktop} hint="Don't minimize window along with application" onToggle={() => toggle('onDesktop', 'On desktop')} />
        <Text x={110} y={53} w={84} h={15} align="right">Reflect / bevel</Text>
        <Knob x={198} y={44} size={34} control={reflect} bipolar />
        <div style={{ position: 'absolute', left: 145, top: 73, width: 59, height: 17, cursor: 'default', opacity: s.reflect < 0 ? 1 : 0.5 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); toggle('glow', 'Glow'); } }}>
          <Text x={0} y={0} w={40} h={17} align="right" bold={false} color={C.dim}>Glow</Text>
          <span style={{ position: 'absolute', left: 45, top: 2, width: 13, height: 13, borderRadius: '50%', boxSizing: 'border-box', border: '1px solid #2c3135', background: s.glow ? 'radial-gradient(circle at 45% 40%, #ffe6c8, #ffab73 45%, #e0562e)' : 'radial-gradient(circle at 45% 40%, #8a9196, #5f666b 60%, #454b50)' }} />
        </div>
        <Text x={143} y={116} w={51} h={15} align="right">Corners</Text>
        <Knob x={198} y={107} size={34} control={corners} />
        <Text x={140} y={158} w={54} h={15} align="right">Punches</Text>
        <Knob x={198} y={149} size={34} control={punches} bipolar arc={null} />
      </Panel>

      <Panel x={377} y={7} w={208} h={204} title="Colors">
        <Combo x={6} y={26} w={173} items={WC_TARGET_ITEMS} value={target} onPick={setTarget} hint="Color target" />
        <div style={{ position: 'absolute', left: 180, top: 26, width: 23, height: 23, boxSizing: 'border-box', border: '1px solid #2c3135', borderRadius: 2, background: `rgb(${r},${g},${b})`, cursor: 'default' }}
          title="" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); pickColor(); } }} />
        <Text x={10} y={93} w={30} h={16} align="right">Hue</Text>
        <Knob x={45} y={76} size={50} control={hue} arc={null} full />
        <Knob x={96} y={65} size={34} control={light} arc={null} full />
        <Text x={135} y={74} w={60} h={16}>Lightness</Text>
        <Knob x={96} y={103} size={34} control={sat} arc={null} full />
        <Text x={135} y={112} w={64} h={16}>Saturation</Text>
        <Text x={7} y={162} w={44} h={16} color={C.dim} bold={false}>Opacity</Text>
        <Text x={50} y={162} w={42} h={16} align="right">Object</Text>
        <Knob x={96} y={153} size={34} control={oa} arc={C.white} full />
        <Text x={135} y={162} w={29} h={16}>Color</Text>
        <Knob x={168} y={153} size={34} control={ca} arc={C.white} full />
      </Panel>

      <Panel x={7} y={219} w={578} h={57}>
        {sheet === 0 && <>
          {label(7, 17, 38, 'Update')}<MetalKnob x={50} y={8} size={40} control={oscUpdate} />
          {label(100, 17, 48, 'Window')}<MetalKnob x={153} y={8} size={40} control={oscWindow} />
          {label(200, 17, 98, 'Stereo separation')}<MetalKnob x={303} y={8} size={40} control={oscSep} />
          <Check x={446} y={6} w={91} h={23} caption="Pinch" on={s.oscPinch} hint="Pinch sides of waveform" onToggle={() => toggle('oscPinch', 'Pinch')} />
          <Check x={446} y={28} w={91} h={23} caption="Interpolate" on={s.oscInterp} hint="Interpolate zoomed waveform" onToggle={() => toggle('oscInterp', 'Interpolate')} />
        </>}
        {sheet === 1 && <>
          {label(7, 17, 38, 'Update')}<MetalKnob x={50} y={8} size={40} control={specUpdate} />
          {label(98, 17, 47, 'Max res')}<Combo x={150} y={17} w={89} items={WC_BANDS} value={s.specRes} hint="Max resolution" onPick={(i) => set('Max resolution', (p) => { p.specRes = i; })} />
          {label(250, 17, 31, 'Scale')}<MetalKnob x={286} y={8} size={40} control={specScale} />
          {label(336, 17, 52, 'dB range')}<MetalKnob x={393} y={8} size={40} control={specRange} />
          <Check x={446} y={6} w={130} h={23} caption="Natural weighting" on={s.specNatural} onToggle={() => toggle('specNatural', 'Natural weighting')} />
          <Check x={446} y={28} w={130} h={23} caption="Enhanced frequency" on={s.specEnhanced} onToggle={() => toggle('specEnhanced', 'Enhanced frequency')} />
        </>}
        {sheet === 2 && <>
          {label(14, 17, 31, 'Scale')}<MetalKnob x={50} y={8} size={40} control={meterScale} />
          {label(98, 17, 58, 'Hold time')}<MetalKnob x={161} y={8} size={40} control={meterHold} />
          {label(210, 17, 36, 'Mode')}<Combo x={251} y={17} w={101} items={WC_METER_MODES} hints={WC_METER_HINTS} value={s.meterMode} hint="Mode" onPick={(i) => set('Meter mode', (p) => { p.meterMode = i; })} />
          {label(360, 17, 72, 'Decay speed')}<MetalKnob x={437} y={8} size={40} control={meterSpeed} />
        </>}
        {sheet === 3 && <>
          {label(7, 17, 38, 'Update')}<MetalKnob x={50} y={8} size={40} control={vecUpdate} />
          {label(100, 17, 56, 'Thickness')}<MetalKnob x={161} y={8} size={40} control={vecThick} />
          {label(210, 17, 36, 'Mode')}<Combo x={251} y={17} w={101} items={WC_VEC_MODES} value={s.vecMode} hint="Mode" onPick={(i) => set('Vectorscope mode', (p) => { p.vecMode = i; })} />
          <Check x={365} y={17} w={83} h={23} caption="Add" on={s.vecAdd} hint="Additive blending" onToggle={() => toggle('vecAdd', 'Add')} />
        </>}
      </Panel>
      <SheetTabs x={6} y={276} w={298} h={33} items={WC_MODES} value={sheet} onPick={setSheet} widths={[90, 67, 51, 90]} />
      <Check x={454} y={285} w={130} h={23} caption="Auto visual mode" on={s.auto} onToggle={() => toggle('auto', 'Auto visual mode')} />

      {/* gallery only (no slot): the real display is the Persistent window below */}
      {!exists && /[?&]wcdisplay/.test(location.search) && (
        <WaveCandyDisplay slotId={slotId} s={s} hold={hold} onSettings={() => {}} demo={/[?&]wcdemo/.test(location.search)} />
      )}
    </FxPanel>
  );
}

/** The plugin editor window of a slot (FL: double-click the display / "View settings"). */
function openEditor(slotId: string) {
  const loc = A.findFx(store.project, slotId);
  if (!loc) return;
  const t = store.project.mixer.tracks.find((x) => x.index === loc.track);
  A.openFxWindow(slotId, t ? `${loc.fx.name} (${mixerTrackName(t)})` : loc.fx.name);
}


/**
 * FL's display window, alive as long as the slot: FL opens it when the plugin
 * is inserted ("Visible" is on by default) and keeps it open when the editor
 * is closed. Frameless like FL's layered window, stacked with the app windows.
 */
function WaveCandyPersistent() {
  const { slotId, params, trackName, pluginName } = useFxEditor();
  const s = wcState(params);
  const hold = useParam('hold').value > 0;
  const z = useUi((u) => u.windows[`fxaux:${slotId}`]?.z ?? 400);
  const open = useAuxWindow(slotId, 'wavecandy', s.visible, () => ({ title: `${pluginName} display (${trackName})` }), () => {
    A.setFxStateNoHistory(slotId, 'Hide Wave Candy display', (p) => { p.visible = false; });
  });
  if (!open || !s.visible) return null;
  return <WaveCandyDisplay slotId={slotId} s={s} hold={hold} host="workspace" z={z} onFocus={() => A.focusWindow(`fxaux:${slotId}`)} onSettings={() => openEditor(slotId)} />;
}

export const editor: FxEditorModule = {
  id: 'wavecandy',
  Editor: WaveCandyEditor,
  Persistent: WaveCandyPersistent,
  menu: (slotId) => {
    const p = A.findFx(store.project, slotId)?.fx.params as Record<string, unknown> | undefined;
    const s = wcState(p ?? {});
    const set = (label: string, recipe: (q: Record<string, unknown>) => void) => A.editFx(slotId, label, recipe);
    return [
      { label: 'Visible', checked: s.visible, onClick: () => set('Visible', (q) => { q.visible = !s.visible; }) },
      { label: 'Mini view', checked: s.mini, onClick: () => set('Mini view', (q) => { q.mini = !s.mini; }) },
      { label: 'Background', checked: s.background, onClick: () => set('Background', (q) => { q.background = !s.background; }) },
      { label: 'Mode', submenu: [
        { label: 'Auto', checked: s.auto, onClick: () => set('Auto visual mode', (q) => { q.auto = !s.auto; }) },
        { separator: true },
        ...WC_MODES.map((m, i) => ({ label: m, radio: true, checked: !s.auto && s.mode === i, onClick: () => set(`Mode: ${m}`, (q) => { q.mode = i; q.auto = false; }) })),
      ] },
    ];
  },
};
