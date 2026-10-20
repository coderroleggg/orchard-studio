// Kepler Exo's effects panel (FL: the TWPControls SatPanel, ChorusPanel (Hyper chorus), EQPanel, DelayPanel and ReverbPanel at
// (640, 398), 420 x 164, with the EffectPageSelect strip at the top: Saturation, Hyper Chorus, EQ, Delay, Reverb; each tab has its
// own Active LED). Control coordinates are relative to the panel, as in FL's form. The page selection is the editor's own view
// state (FL does not store it).

import { Fragment, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { Display, paramDefOf, useFxEditor } from '../../kit';
import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import { Cap, Cap2, KKnob, KLed, KLever, KSlider } from '../keplercommon/widgets';
import { SkinContext, type ExoTheme } from '../keplercommon/skin';
import { EQ_BANDS, drawEq, drawSat, eqNodeXY, type DisplayColors } from './displays';

// ------------------------------------------------------------------ page selection (not part of the project)
// (kept on globalThis so a hot reload of this module keeps the subscriptions of the open editors)
const store_ = ((globalThis as unknown as { __orchardKeplerExoPages?: { pages: Map<string, number>; listeners: Set<() => void> } }).__orchardKeplerExoPages ??= {
  pages: new Map<string, number>(), listeners: new Set<() => void>(),
});
const { pages, listeners } = store_;
const DEFAULT_PAGE = 2; // FL opens on EQ (EffectPageSelect.DefaultValue = 2)

export function useEffectPage(slotId: string): [number, (n: number) => void] {
  const page = useSyncExternalStore(
    (fn) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    () => pages.get(slotId) ?? DEFAULT_PAGE,
    () => pages.get(slotId) ?? DEFAULT_PAGE,
  );
  return [page, (n) => { pages.set(slotId, n); listeners.forEach((l) => l()); }];
}

const TABS: { title: string; hint: string; on: string }[] = [
  { title: 'SAT', hint: 'Saturation', on: 'satOn' },
  { title: 'HYCHOR', hint: 'Hyper Chorus', on: 'hcOn' },
  { title: 'EQ', hint: 'EQ', on: 'eqOn' },
  { title: 'DELAY', hint: 'Delay', on: 'delayOn' },
  { title: 'REVERB', hint: 'Reverb', on: 'reverbOn' },
];

/** Numeric state values of the edited plugin (parameter defaults for missing ones). */
function useNums(keys: string[]): Record<string, number> {
  const c = useFxEditor();
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = c.params[k];
    out[k] = typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : paramDefOf(c, k)?.def ?? 0;
  }
  return out;
}

const SAT_KEYS = ['satOn', 'satAmount'];
const EQ_KEYS = ['eqOn', ...EQ_BANDS.flatMap((b) => [b.freq, b.gain, b.q])];

// ------------------------------------------------------------------ the displays
function displayColors(theme: ExoTheme): DisplayColors {
  if (theme.name === 'Light') {
    return { bg: theme.lowerDisplay, grid: 'rgba(0,0,0,0.12)', gridStrong: 'rgba(0,0,0,0.34)', text: 'rgba(0,0,0,0.55)', line: '#202020', fill: 'rgba(0,0,0,0.07)' };
  }
  return { bg: theme.lowerDisplay, grid: 'rgba(255,255,255,0.09)', gridStrong: 'rgba(255,255,255,0.28)', text: 'rgba(255,255,255,0.5)', line: '#f2f2f2', fill: 'rgba(255,255,255,0.07)' };
}

function SatDisplay({ theme }: { theme: ExoTheme }) {
  const n = useNums(SAT_KEYS);
  const colors = displayColors(theme);
  return <Display x={126} y={41} w={276} h={114} deps={[n.satAmount, n.satOn, theme.name]} draw={(g, w, h) => drawSat(g, w, h, n.satAmount / 6000, n.satOn >= 0.5, colors)} />;
}

/** The EQ response; the three band nodes can be dragged (x: frequency, y: gain). */
function EqDisplay({ theme }: { theme: ExoTheme }) {
  const c = useFxEditor();
  const n = useNums(EQ_KEYS);
  const colors = displayColors(theme);
  const drag = useRef<number | null>(null);
  const W = 273, H = 114;
  const local = (e: React.PointerEvent<HTMLCanvasElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect();
    return [(e.clientX - r.left) * (W / (r.width || W)), (e.clientY - r.top) * (H / (r.height || H))];
  };
  return (
    <Display x={126} y={41} w={W} h={H} deps={[theme.name, ...EQ_KEYS.map((k) => n[k])]}
      draw={(g, w, h) => drawEq(g, w, h, n, n.eqOn >= 0.5, colors)}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        const [px, py] = local(e);
        let best = -1, bd = 15 * 15;
        EQ_BANDS.forEach((_, i) => {
          const [nx, ny] = eqNodeXY(n, i, W, H);
          const d = (nx - px) ** 2 + (ny - py) ** 2;
          if (d < bd) { bd = d; best = i; }
        });
        if (best < 0) return;
        drag.current = best;
        try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* a pointer that is not active (synthetic events) */ }
        store.beginGesture(`EQ ${['low', 'mid', 'high'][best]} band`);
      }}
      onPointerMove={(e) => {
        const band = drag.current;
        if (band === null) return;
        const [px, py] = local(e);
        const f = Math.round(Math.min(1, Math.max(0, px / W)) * 21000);
        const gdb = (0.5 - py / H) * 32;
        const gv = Math.round(Math.min(1, Math.max(0, (gdb + 16) / 32)) * 6000);
        A.setFxParam(c.slotId, EQ_BANDS[band].freq, f);
        A.setFxParam(c.slotId, EQ_BANDS[band].gain, gv);
      }}
      onPointerUp={() => { if (drag.current !== null) { drag.current = null; store.endGesture(); } }} />
  );
}

// ------------------------------------------------------------------ pages
/** A slider with its caption (`label` or two lines) at panel coordinates. */
function Sl({ k, x, w = 23, label, size }: { k: string; x: number; w?: number; label: string | [string, string]; size?: number }) {
  const longest = typeof label === 'string' ? label.length : Math.max(label[0].length, label[1].length);
  const lw = longest >= 8 ? 48 : Math.max(w + 14, 38);
  return (
    <Fragment>
      <KSlider k={k} x={x} y={55} w={w} h={104} />
      {typeof label === 'string' ? <Cap cx={x + w / 2} y={43} w={lw} size={size}>{label}</Cap> : <Cap2 cx={x + w / 2} y={36} lines={label} w={lw} size={size} />}
    </Fragment>
  );
}

function SatPage({ theme }: { theme: ExoTheme }) {
  return (
    <>
      <Cap cx={103.5} y={43} w={44}>AMOUNT</Cap>
      <KSlider k="satAmount" x={92} y={55} w={23} h={104} />
      <Cap cx={62.5} y={80} w={50}>PRE/POST</Cap>
      <KLever k="satPost" x={44} y={92} w={37} h={30} barW={11} gap={4} capSize={7.5} labels={['PRE', 'POST']} />
      <KLed k="satHq" x={44} y={146} w={14} h={13} caption="HQ" />
      <SatDisplay theme={theme} />
    </>
  );
}

function HyperChorusPage() {
  return (
    <>
      <Sl k="hcDelay" x={15} label="DELAY" />
      <Sl k="hcFeedback" x={52} label="FEEDBCK" size={6.8} />
      <Sl k="hcModulation" x={90} label="MOD" />
      <Sl k="hcModRate" x={127} label="RATE" />
      <Sl k="hcMovement" x={165} label="MOVEMENT" size={6.5} />
      <Sl k="hcMovementRate" x={203} label={['MOVE', 'RATE']} />
      <Cap2 cx={255} y={78} lines={['DELAY', 'LINES']} w={44} />
      <KLever k="hcLines" x={240} y={92} w={30} h={30} barW={11} gap={4} capSize={9} labels={['4', '8']} />
      <Sl k="hcHighPass" x={279} label={['HIGH', 'PASS']} />
      <Sl k="hcLowPass" x={315} label={['LOW', 'PASS']} />
      <Sl k="hcPhase" x={351} label={['LFO PHASE', 'DIF']} size={6.5} />
      <Sl k="hcMix" x={387} label="MIX" />
    </>
  );
}

function EqPage({ theme }: { theme: ExoTheme }) {
  const cols = [29, 60, 91];
  const names = ['Low', 'Mid', 'High'];
  const bands = [['eqLoGain', 'eqLoFreq', 'eqLoQ'], ['eqMidGain', 'eqMidFreq', 'eqMidQ'], ['eqHiGain', 'eqHiFreq', 'eqHiQ']];
  return (
    <>
      {cols.map((x, i) => (
        <Fragment key={x}>
          <Cap cx={x + 15} y={42} w={32} size={8}>{names[i]}</Cap>
          <KKnob k={bands[i][0]} x={x} y={54} w={30} h={32} />
          <KKnob k={bands[i][1]} x={x} y={90} w={30} h={32} />
          <KKnob k={bands[i][2]} x={x} y={126} w={30} h={32} />
        </Fragment>
      ))}
      <Cap x={0} y={65} w={28} align="right" size={7}>GAIN</Cap>
      <Cap x={0} y={101} w={28} align="right" size={7}>FREQ</Cap>
      <Cap x={0} y={137} w={28} align="right" size={7}>Q</Cap>
      <EqDisplay theme={theme} />
    </>
  );
}

function DelayPage() {
  return (
    <>
      <KLed k="delaySync" x={111} y={24} w={17} h={16} />
      <Cap x={82} y={28} w={26} h={9} align="right" dim>SYNC</Cap>
      <Sl k="delayAmount" x={69} label="AMOUNT" />
      <Sl k="delayTime" x={108} label="TIME" />
      <Sl k="delayRightTap" x={148} label={['RIGHT', 'TAP']} />
      <Sl k="delayFeedback" x={185} label="FEEDBCK" size={6.8} />
      <Sl k="delayFbCutoff" x={222} label="CUTOFF" />
      <KLever k="delayFbType" x={257} y={77} w={44} h={60} barW={11} gap={4} capSize={8} labels={['LP', 'HP', 'BP', 'OFF']} />
      <Sl k="delayStereo" x={307} label="STEREO" />
      <Sl k="delayBlur" x={347} label="BLUR" />
      <Sl k="delayTone" x={387} label="TONE" />
    </>
  );
}

function ReverbPage() {
  return (
    <>
      <Sl k="reverbLowCut" x={30} w={25} label={['LOW', 'CUT']} />
      <Sl k="reverbHighCut" x={57} w={25} label={['HIGH', 'CUT']} />
      <Sl k="reverbPredelay" x={85} w={25} label={['PRE', 'DELAY']} />
      <Sl k="reverbPredelayFb" x={113} w={25} label={['PRE', 'FEEDBK']} />
      <Sl k="reverbSize" x={167} w={25} label="SIZE" />
      <Sl k="reverbDiffusion" x={194} w={25} label="DIFF" />
      <Sl k="reverbDecay" x={222} w={25} label="DECAY" />
      <Sl k="reverbHighDamp" x={250} w={25} label={['HIGH', 'DAMP']} />
      <Sl k="reverbWidth" x={303} w={25} label="WIDTH" />
      <Sl k="reverbDry" x={331} w={25} label="DRY" />
      <Sl k="reverbEr" x={359} w={25} label="ER" />
      <Sl k="reverbWet" x={387} w={25} label="WET" />
    </>
  );
}

// ------------------------------------------------------------------ the panel
export function EffectsPanel({ theme, children }: { theme: ExoTheme; children?: ReactNode }) {
  const c = useFxEditor();
  const [page, setPage] = useEffectPage(c.slotId);
  return (
    <SkinContext.Provider value={theme.lower}>
      <div className="kp-abs" style={{ left: 640, top: 398, width: 420, height: 164, background: theme.lowerPanel, borderRadius: 3, overflow: 'hidden' }}>
        {TABS.map((t, i) => {
          const on = page === i;
          return (
            <div key={t.title} className="kp-btn" title={t.hint} style={{
              left: 84 * i + 1, top: 1, width: 82, height: 21, borderRadius: 3, justifyContent: 'flex-end', paddingRight: 8, boxSizing: 'border-box',
              background: on ? theme.tabOn : theme.tab, color: on ? '#1b1b1b' : theme.tabText, fontSize: 9, fontWeight: 700, letterSpacing: '0.1em',
              boxShadow: on ? 'inset 0 1px 0 rgba(255,255,255,0.35)' : 'inset 0 1px 0 rgba(255,255,255,0.06)',
            }}
              onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setPage(i); } }}>{t.title}</div>
          );
        })}
        {TABS.map((t, i) => <KLed key={t.on} k={t.on} x={4 + 84 * i} y={1} w={20} h={21} />)}
        {page === 0 && <SatPage theme={theme} />}
        {page === 1 && <HyperChorusPage />}
        {page === 2 && <EqPage theme={theme} />}
        {page === 3 && <DelayPage />}
        {page === 4 && <ReverbPage />}
        {children}
      </div>
    </SkinContext.Provider>
  );
}
