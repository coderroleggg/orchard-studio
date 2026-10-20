// Transmitter editor (FL Studio 2026, 740 x 366): the scrolling transient /
// sustain display on top, then the Detection, Transient and Sustain panels and
// the bottom bar (logo, STEREO LINK, LOOKAHEAD, options gear), all at the
// coordinates of FL's form. The effect knobs swap with the effect selector
// (Saturation: Drive / Warmth, Bounce: Time curve / Amp curve, Diffusion:
// Diffusion / Delay, Delay: Feedback / Delay + tempo switch; Blur and Off
// leave the knobs inactive). The routing boxes pick the detection sidechain
// input and the tracks the transient and sustain parts are sent to.

import { type ReactNode } from 'react';
import * as A from '../../../../store/actions';
import { findFx } from '../../../../store/actions';
import { store } from '../../../../store';
import { FX, FX_NAMES, MODE_NAMES } from '../../../../model/fx/plugins/transmitter';
import { FxPanel, useFxEditor, useFxState, useParam, useRoutes, type Route } from '../../kit';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { TxDisplay } from './display';
import { THEMES, themeOf, type TxTheme } from './theme';
import { Caption, DarkBox, RouteBox, SectionTab, TextSwitch, TxCombo, TxFader, TxKnob } from './widgets';


function Panel({ x, y, w, h, theme, children }: { x: number; y: number; w: number; h: number; theme: TxTheme; children?: ReactNode }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 3,
      background: `linear-gradient(180deg, ${theme.panelTop}, ${theme.panelBot})`,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
    }}>{children}</div>
  );
}

/** The level fader with its value box; linked mode moves both faders together. */
function Level({ p, x, theme }: { p: 't' | 's'; x: number; theme: TxTheme }) {
  const me = useParam(p + 'Level');
  const other = useParam((p === 't' ? 's' : 't') + 'Level');
  const linked = useFxState<boolean>('linked', false);
  const control = {
    ...me.control,
    onChange: (v: number) => {
      if (linked) other.set(other.value + (v - me.value));
      me.set(v);
    },
  };
  return (
    <>
      <DarkBox x={x - 6} y={209} w={36} h={12} theme={theme} style={{ font: `600 9.5px ${theme.font}` }}
        hint={`${me.def.name}: ${me.control.format?.(me.value) ?? me.value}`}>
        {me.control.format?.(me.value) ?? String(me.value)}
      </DarkBox>
      <TxFader x={x} y={224} w={24} h={98} control={control} theme={theme} />
    </>
  );
}

function LinkButton({ x, y, theme }: { x: number; y: number; theme: TxTheme }) {
  const { slotId } = useFxEditor();
  const linked = useFxState<boolean>('linked', false);
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: 14, height: 14, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Linked mode', (q) => { q.linked = !linked; }); } }}
      onPointerEnter={() => setHint(`Linked mode: ${linked ? 'on' : 'off'}`)} onPointerLeave={clearHint}>
      <svg width={14} height={14} viewBox="0 0 14 14">
        <g fill="none" stroke={linked ? theme.accent : theme.caption} strokeWidth={1.3} strokeLinecap="round">
          <path d="M6.2 8.6 L8.6 6.2" />
          <path d="M5.2 6.9 L3.9 8.2 A1.8 1.8 0 0 0 6.4 10.7 L7.7 9.4" />
          <path d="M6.9 5.2 L8.2 3.9 A1.8 1.8 0 0 1 10.7 6.4 L9.4 7.7" />
        </g>
      </svg>
    </div>
  );
}

/** Effect knobs of one part, swapped by its effect selector. */
function FxKnobs({ p, ox, theme }: { p: 't' | 's'; ox: number; theme: TxTheme }) {
  const { slotId } = useFxEditor();
  const fx = Math.round(useParam(p + 'Fx').value);
  const tempo = useParam(p + 'Tempo');
  const off = fx === FX.OFF || fx === FX.BLUR;
  const keys: Record<number, [string, string, string, string, string]> = {
    [FX.SAT]: [p + 'SatMix', p + 'SatDrive', 'DRIVE', p + 'SatWarmth', 'WARMTH'],
    [FX.BOUNCE]: [p + 'BncMix', p + 'BncTime', 'TIME CURVE', p + 'BncAmp', 'AMP CURVE'],
    [FX.DIFF]: [p + 'DiffMix', p + 'DiffDepth', 'DIFFUSION', p + 'DiffDelay', 'DELAY'],
    [FX.DELAY]: [p + 'DlyMix', p + 'DlyFb', 'FEEDBACK', tempo.value ? p + 'DlySync' : p + 'DlyTime', 'DELAY'],
  };
  const [mix, k2, c2, k3, c3] = keys[off ? FX.SAT : fx];
  const xA = ox, xB = ox + 75;
  return (
    <>
      <TxKnob key={mix} k={mix} x={xA} y={229} size={42} theme={theme} disabled={off} caption="MIX" captionY={277} />
      <TxKnob k={p + 'Tilt'} x={xB} y={229} size={42} theme={theme} caption="TILT" captionY={277} />
      <TxKnob key={k2} k={k2} x={xA} y={287} size={42} theme={theme} disabled={off} caption={c2} captionY={335} />
      <TxKnob key={k3} k={k3} x={xB} y={287} size={42} theme={theme} disabled={off} caption={c3} captionY={335} />
      {fx === FX.DELAY && (
        <div className="fxk-abs" style={{
          left: xB + 41, top: 328, width: 12, height: 13, textAlign: 'center', cursor: 'default', borderRadius: 2,
          color: tempo.value ? theme.accent : theme.caption, font: `700 9px ${theme.font}`, lineHeight: '13px',
          background: tempo.value ? 'rgba(136,201,235,0.12)' : 'transparent',
        }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.setFxParam(slotId, p + 'Tempo', tempo.value ? 0 : 1, 'Tempo-based time'); } }}
          onPointerEnter={() => setHint(`Tempo-based time: ${tempo.value ? 'on' : 'off'}`)} onPointerLeave={clearHint}>T</div>
      )}
    </>
  );
}

function PartPanel({ p, x, theme, routes }: { p: 't' | 's'; x: number; theme: TxTheme; routes: Route[] }) {
  const { slotId } = useFxEditor();
  const on = useParam(p + 'On');
  const otherOn = useParam((p === 't' ? 's' : 't') + 'On');
  const target = useFxState<number>(p + 'Out', -1);
  const label = p === 't' ? 'TRANSIENT' : 'SUSTAIN';
  const o = x - 247; // offset from the transient panel
  const pos = routes.findIndex((r) => r.index === target) + 1;
  const setTarget = (i: number) => {
    const t = i <= 0 ? -1 : routes[i - 1]?.index ?? -1;
    if (t === target) return;
    A.editFx(slotId, `${p === 't' ? 'Transient' : 'Sustain'} envelope send track`, (q) => {
      q[p + 'Out'] = t;
      // FL drops the level slider to zero so the part is not heard twice
      if (t >= 0) q[p + 'Level'] = 0;
    });
  };
  const menu = (cx: number, cy: number) => {
    const items: MenuItem[] = [
      { label: '(none)', checked: target < 0, radio: true, onClick: () => setTarget(0) },
      ...routes.map((r, i) => ({ label: r.name, checked: r.index === target, radio: true, onClick: () => setTarget(i + 1) } as MenuItem)),
    ];
    if (!routes.length) items.push({ label: 'Route this track to other tracks to send to them', disabled: true });
    openMenu(cx, cy, items);
  };
  const solo = () => {
    const soloed = on.value && !otherOn.value;
    A.editFx(slotId, `${label.charAt(0) + label.slice(1).toLowerCase()} solo`, (q) => {
      q[p + 'On'] = 1;
      q[(p === 't' ? 's' : 't') + 'On'] = soloed ? 1 : 0;
    });
  };
  return (
    <>
      <Panel x={x} y={205} w={243} h={139} theme={theme} />
      <SectionTab x={x} y={207} w={14} h={p === 't' ? 79 : 62} label={label} theme={theme} led ledOn={!!on.value}
        onLed={() => A.setFxParam(slotId, p + 'On', on.value ? 0 : 1, 'Enabled')} onLedMenu={solo}
        ledHint={`${label.charAt(0) + label.slice(1).toLowerCase()} enabled: ${on.value ? 'on' : 'off'} (right-click: solo)`} />
      <Level p={p} x={284 + o} theme={theme} />
      <LinkButton x={260 + o} y={327} theme={theme} />
      <Caption x={274 + o} y={335} theme={theme} align="left" w={50}>— LEVEL</Caption>
      <TxCombo k={p + 'Fx'} x={(p === 't' ? 357 : 606)} y={209} w={79} h={13} items={FX_NAMES} theme={theme} />
      <RouteBox x={(p === 't' ? 462 : 708)} y={207} w={26} h={15} value={pos} count={routes.length} onSet={setTarget} menu={menu} theme={theme}
        hint={() => `${p === 't' ? 'Transient' : 'Sustain'} envelope send track: ${target < 0 ? '(none)' : routes.find((r) => r.index === target)?.name ?? `track ${target} (not routed)`}`} />
      <FxKnobs p={p} ox={336 + o + (p === 's' ? 0 : 0)} theme={theme} />
    </>
  );
}

function DetectionPanel({ theme, inputs }: { theme: TxTheme; inputs: Route[] }) {
  const { slotId } = useFxEditor();
  const scIn = useFxState<number>('scIn', 0);
  const setIn = (v: number) => {
    if (v === scIn) return;
    A.editFx(slotId, 'Detection sidechain track number', (q) => { q.scIn = v; }, `tx-scin:${slotId}`);
  };
  const menu = (cx: number, cy: number) => {
    const items: MenuItem[] = [
      { label: '(none)', checked: scIn === 0, radio: true, onClick: () => setIn(0) },
      ...inputs.map((r, i) => ({ label: r.name, checked: scIn === i + 1, radio: true, onClick: () => setIn(i + 1) } as MenuItem)),
    ];
    if (!inputs.length) items.push({ label: 'Sidechain a track to this track to use it here', disabled: true });
    openMenu(cx, cy, items);
  };
  return (
    <>
      <Panel x={3} y={205} w={241} h={139} theme={theme} />
      <SectionTab x={3} y={206} w={14} h={66} label="DETECTION" theme={theme} />
      <RouteBox x={216} y={207} w={26} h={15} value={scIn} count={Math.max(scIn, inputs.length)} onSet={setIn} menu={menu} theme={theme}
        hint={() => `Detection sidechain track number: ${scIn === 0 ? '(none)' : inputs[scIn - 1]?.name ?? `input ${scIn} (not routed)`}`} />
      <TxKnob k="sens" x={47} y={231} size={80} theme={theme} fontSize={10.5} />
      <Caption x={52} y={319} theme={theme}>SENSITIVITY</Caption>
      <TxCombo k="mode" x={84} y={313} w={56} h={13} items={MODE_NAMES} theme={theme} header="Mode" />
      <TxKnob k="hold" x={160} y={212} size={46} theme={theme} caption="HOLD" captionY={268} fontSize={9.5} />
      <TxKnob k="release" x={160} y={279} size={46} theme={theme} caption="RELEASE" captionY={335} fontSize={9.5} />
    </>
  );
}

function themeMenu(slotId: string, cur: number): MenuItem[] {
  return [
    { header: true, label: 'Theme' },
    ...THEMES.map((t, i) => ({ label: t.name, checked: i === cur, radio: true, onClick: () => A.editFx(slotId, 'Theme', (q) => { q.theme = i; }) } as MenuItem)),
  ];
}

function TransmitterEditor() {
  const { slotId } = useFxEditor();
  const theme = themeOf(useFxState<number>('theme', 0));
  const themeIdx = useFxState<number>('theme', 0);
  const outs = useRoutes(slotId, 'out');
  const ins = useRoutes(slotId, 'in');
  const la = useParam('lookahead');
  const link = useParam('stereoLink');
  const toggle = (b: ReturnType<typeof useParam>) => { b.control.onBegin?.(); b.set(b.value ? 0 : 1); b.control.onEnd?.(); };
  return (
    <FxPanel width={740} height={366} style={{ background: theme.bg, boxShadow: `inset 0 0 0 1px ${theme.border}`, fontFamily: theme.font }}>
      <TxDisplay x={4} y={4} w={732} h={196} theme={theme} />
      <DetectionPanel theme={theme} inputs={ins} />
      <PartPanel p="t" x={247} theme={theme} routes={outs} />
      <PartPanel p="s" x={493} theme={theme} routes={outs} />
      {/* bottom bar */}
      <div className="fxk-abs" style={{
        left: 8, top: 345, width: 133, height: 20, color: theme.logo,
        font: `500 12px ${theme.font}`, lineHeight: '20px', letterSpacing: '0.42em', whiteSpace: 'nowrap', pointerEvents: 'none',
      }}>TRANSMITTER</div>
      <div className="fxk-abs" style={{ left: 571, top: 350, width: 1, height: 12, background: theme.sep }} />
      <TextSwitch x={576} y={347} w={69} h={18} label="STEREO LINK" on={!!link.value} onClick={() => toggle(link)} theme={theme}
        hint={`Stereo link: ${link.value ? 'on' : 'off'}`} />
      <TextSwitch x={643} y={347} w={67} h={18} label="LOOKAHEAD" on={!!la.value} onClick={() => toggle(la)} theme={theme}
        hint={`Lookahead: ${la.value ? 'on (2 ms latency)' : 'off (zero latency)'}`} />
      <div className="fxk-abs" style={{ left: 713, top: 350, width: 1, height: 12, background: theme.sep }} />
      <div className="fxk-abs" style={{ left: 720, top: 346, width: 18, height: 18, cursor: 'default' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, themeMenu(slotId, themeIdx));
        }}
        onPointerEnter={() => setHint('Options')} onPointerLeave={clearHint}>
        <svg width={18} height={18} viewBox="0 0 18 18">
          <path fill={theme.switchOff} d="M9 3.2l1.1.2.4 1.6 1 .5 1.5-.8.8.8-.8 1.5.5 1 1.6.4.2 1.1-.2 1.1-1.6.4-.5 1 .8 1.5-.8.8-1.5-.8-1 .5-.4 1.6L9 14.8l-1.1-.2-.4-1.6-1-.5-1.5.8-.8-.8.8-1.5-.5-1-1.6-.4L3.2 9l.2-1.1 1.6-.4.5-1-.8-1.5.8-.8 1.5.8 1-.5.4-1.6zM9 6.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z" />
        </svg>
      </div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'transmitter',
  Editor: TransmitterEditor,
  menu: (slotId) => {
    const p = findFx(store.project, slotId);
    const cur = Number((p?.fx.params as Record<string, unknown> | undefined)?.theme ?? 0);
    return [{ label: 'Theme', submenu: themeMenu(slotId, cur) }];
  },
};
