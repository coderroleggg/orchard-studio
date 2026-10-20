// Love Philter editor (FL: Fruity Love Philter, 670 x 400) at the coordinates
// of FL's form: unit switches with routing arrows and unit tabs; the IN /
// FILTER / WS / OUT sections of the edited unit; the envelope area (target
// tabs, pattern number, source tabs PAT / LFO / MOD X / MOD Y / IEF and the
// envelope editor); the right panel with master / LFO / IEF faders, the X / Y
// pad, SMOOTH, the envelope follower, CENTER, HQ ENVELOPES, oversampling and
// the preset info text.

import { useMemo, useRef, useState } from 'react';
import { FxPanel, DigiWheel, DigiWheelControl, useFxEditor, useFxEdit, useFxState, useFxView, useParam, useFxMonitor } from '../../kit';
import type { FxEditorModule } from '../../registry';
import type { ControlProps } from '../../../widgets/control';
import { openMenu } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { store } from '../../../../store';
import {
  LP_ADDITIVE, LP_MODES, LP_TABS, LP_TYPES, LP_TYPE_NAMES, LP_UNITS, lpDefaultTarget, lpDefaultUnit, lpGain, lpKey, lpLfoKey,
  lpNormalizeState, type LpEnv, type LpState, type LpTarget,
} from '../../../../model/fx/plugins/lovephilter';
import { EnvEditor, LfoView } from './envEditor';
import { Cap, LP, Led, LedRadio, LpKnob, MenuBox, RoundBtn, TabBar, UnitTabs, VFader } from './widgets';

const font = 'Arial, Helvetica, sans-serif';
const MODE_CAPTIONS = ['OFF', 'SINGLE', 'DUAL', 'TRIPLE', 'ALT DUAL', 'ALT TRIPL'];
const SOURCES = ['PAT', 'LFO', 'MOD X', 'MOD Y', 'IEF'];
const OS_TEXT = ['off', '2x', '4x', '8x', '16x'];

interface LpUi { unit: number; tab: number; src: number }

type EditLp = (label: string, fn: (lp: LpState) => void, merge?: string) => void;

function useLp(): { lp: LpState; editLp: EditLp } {
  const raw = useFxState<unknown>('lp', null);
  const lp = useMemo(() => lpNormalizeState(raw), [raw]);
  const edit = useFxEdit();
  const editLp: EditLp = (label, fn, merge) => edit(label, (p) => {
    const cur = p.lp as LpState | undefined;
    if (!cur || !Array.isArray(cur.units) || cur.units.length !== LP_UNITS) p.lp = lpNormalizeState(cur) as unknown as Record<string, unknown>;
    fn(p.lp as unknown as LpState);
  }, merge);
  return { lp, editLp };
}

/** Does a target carry any modulation (for the orange tab markers)? */
function targetActive(t: LpTarget, pat: number | null): boolean {
  const pats = pat === null ? t.pats : [t.pats[pat]];
  return pats.some((e) => !!e && !e.off && e.p.length >= 2) || (!!t.lfo[1] && t.lfo[0] !== 0.5) || !!t.mx || !!t.my || !!t.ief;
}

function SectionTitle({ x, y, w, children, right }: { x: number; y: number; w: number; children: string; right?: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: 16, background: LP.sectionTitle, borderRadius: '4px 4px 0 0', color: '#eef2f5',
      fontFamily: font, fontSize: 11.5, lineHeight: '16px', textAlign: 'center', letterSpacing: '0.04em', fontStyle: 'italic',
    }}>{children}{right}</div>
  );
}

function SectionBody({ x, y, w, h, color }: { x: number; y: number; w: number; h: number; color: string }) {
  return <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: color, borderRadius: '0 0 4px 4px' }} />;
}

// ---------------------------------------------------------------- left panel

function UnitStrip({ lp, editLp, ui, setUi }: { lp: LpState; editLp: EditLp; ui: LpUi; setUi: (u: Partial<LpUi>) => void }) {
  const ed = useFxEditor();
  const ledX = [4, 34, 64, 94, 124, 154, 183, 212];
  const arrowX = [22, 52, 82, 112, 142, 171, 200];
  return (
    <>
      {ledX.map((lx, u) => {
        const on = !!lp.units[u].on;
        const soloed = lp.solo >= 0;
        return (
          <Led key={u} x={3 + lx} y={5} w={20} h={20} size={14} on={on} dim={soloed && lp.solo !== u}
            hint={`Enable unit ${u + 1} (right-click to solo)`}
            onClick={() => editLp(`Love Philter: unit ${u + 1} ${on ? 'off' : 'on'}`, (L) => { L.units[u].on = on ? 0 : 1; })}
            onRightClick={() => editLp(`Love Philter: solo unit ${u + 1}`, (L) => { L.solo = L.solo === u ? -1 : u; })} />
        );
      })}
      {arrowX.map((ax, u) => {
        const nxt = ed.params[lpKey(u, 'next')];
        const shown = typeof nxt === 'number' && nxt !== 0;
        return shown ? (
          <svg key={u} className="fxk-abs" style={{ left: 3 + ax + 3, top: 10 }} width={8} height={10}><path d="M1 0 L7 5 L1 10 Z" fill="#3e474d" /></svg>
        ) : null;
      })}
      <UnitTabs x={3} y={26} w={240} h={31} value={ui.unit} enabled={lp.units.map((U) => !!U.on)} onPick={(u) => setUi({ unit: u })} />
    </>
  );
}

function FilterSection({ u, lp, editLp }: { u: number; lp: LpState; editLp: EditLp }) {
  const U = lp.units[u];
  const typeCtl: ControlProps = {
    value: U.type, min: 0, max: 11, step: 1, defaultValue: 0, label: 'Filter type',
    format: (v) => LP_TYPE_NAMES[Math.round(v)] ?? '',
    onChange: (v) => editLp('Love Philter: filter type', (L) => { L.units[u].type = Math.round(v); }, `lp-type-${u}`),
  };
  const svf = U.type === 0;
  const gainCap = U.type === 11 ? 'DRIVE' : U.type >= 8 && U.type <= 10 ? 'GAIN' : null;
  return (
    <>
      <SectionTitle x={55} y={59} w={235}>FILTER</SectionTitle>
      <Led x={246} y={61} w={40} h={12} on={!!U.alt} size={10} hint="Alternate resonance / bandwidth"
        onClick={() => editLp('Love Philter: ALT', (L) => { L.units[u].alt = L.units[u].alt ? 0 : 1; })} />
      <Cap x={222} y={62} w={24} h={11} size={10} color="#eef2f5">ALT</Cap>
      <SectionBody x={55} y={75} w={235} h={118} color={LP.sectionAlt} />
      <div className="fxk-abs" style={{ left: 68, top: 79, width: 146, height: 53, background: LP.selector, borderRadius: 4 }} />
      <MenuBox x={72} y={95} w={27} h={21} text={LP_TYPES[U.type]} control={typeCtl} hint={`Filter type: ${LP_TYPE_NAMES[U.type]} (right-click for the list)`}
        items={LP_TYPE_NAMES.map((n, i) => ({ label: n, radio: true, checked: i === U.type, onClick: () => editLp('Love Philter: filter type', (L) => { L.units[u].type = i; }) }))} />
      <LedRadio x={108} y={82} w={106} h={46} options={MODE_CAPTIONS} value={U.mode} cols={2} hint="Filter mode"
        onPick={(m) => editLp(`Love Philter: ${LP_MODES[m].toLowerCase()} mode`, (L) => { L.units[u].mode = m; })} />
      <LpKnob k={lpKey(u, 'env')} x={80} y={143} w={36} h={36} />
      <LpKnob k={lpKey(u, 'cut')} x={120} y={138} w={42} h={42} />
      <LpKnob k={lpKey(u, 'res')} x={167} y={143} w={36} h={36} />
      <Cap x={80} y={181} w={36}>ENV</Cap>
      <Cap x={128} y={181} w={26}>CUT</Cap>
      <Cap x={167} y={181} w={36}>RES</Cap>
      {svf ? (
        <>
          <VFader k={lpKey(u, 'low')} x={225} y={81} w={16} h={96} />
          <VFader k={lpKey(u, 'band')} x={245} y={81} w={16} h={96} />
          <VFader k={lpKey(u, 'high')} x={265} y={81} w={16} h={96} />
          <Cap x={223} y={181} w={18}>L</Cap>
          <Cap x={245} y={181} w={17}>B</Cap>
          <Cap x={265} y={181} w={19}>H</Cap>
        </>
      ) : gainCap ? (
        <>
          <LpKnob k={lpKey(u, 'low')} x={235} y={143} w={36} h={36} />
          <Cap x={233} y={181} w={40}>{gainCap}</Cap>
        </>
      ) : null}
    </>
  );
}

function WsSection({ u, lp, editLp }: { u: number; lp: LpState; editLp: EditLp }) {
  const U = lp.units[u];
  const on = !!U.ws;
  return (
    <>
      <SectionTitle x={294} y={59} w={72}>WS</SectionTitle>
      <SectionBody x={294} y={75} w={72} h={118} color={LP.sectionAlt} />
      <Led x={305} y={101} w={14} h={14} on={on} size={13} hint="Enable waveshaper"
        onClick={() => editLp(`Love Philter: waveshaper ${on ? 'off' : 'on'}`, (L) => { L.units[u].ws = on ? 0 : 1; })} />
      <Cap x={298} y={121} w={26}>ON</Cap>
      <LpKnob k={lpKey(u, 'wsAmp')} x={326} y={83} w={36} h={36} dim={!on} />
      <LpKnob k={lpKey(u, 'wsMix')} x={326} y={143} w={36} h={36} dim={!on} />
      <Cap x={326} y={121} w={36}>AMP</Cap>
      <Cap x={326} y={181} w={36}>MIX</Cap>
      <div className="fxk-abs" style={{ left: 300, top: 154, width: 22, height: 24, color: '#ffffff', fontFamily: font, fontSize: 19, fontWeight: 700, lineHeight: '24px', textAlign: 'center', cursor: 'default' }}
        onPointerEnter={() => setHint(`Unipolar / bipolar mode: ${U.wsb ? 'bipolar' : 'unipolar'}`)} onPointerLeave={clearHint}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); editLp('Love Philter: waveshaper mode', (L) => { L.units[u].wsb = L.units[u].wsb ? 0 : 1; }); } }}>
        {U.wsb ? '±' : '+'}
      </div>
      <Cap x={293} y={181} w={34}>MODE</Cap>
    </>
  );
}

function IoSections({ u }: { u: number }) {
  return (
    <>
      <SectionTitle x={4} y={59} w={47}>IN</SectionTitle>
      <SectionBody x={4} y={75} w={47} h={118} color={LP.section} />
      <LpKnob k={lpKey(u, 'in')} x={9} y={143} w={36} h={36} />
      <Cap x={9} y={181} w={36}>VOL</Cap>
      <SectionTitle x={370} y={59} w={69}>OUT</SectionTitle>
      <SectionBody x={370} y={75} w={69} h={118} color={LP.section} />
      <LpKnob k={lpKey(u, 'pan')} x={374} y={83} w={36} h={36} />
      <LpKnob k={lpKey(u, 'vol')} x={374} y={143} w={36} h={36} />
      <Cap x={374} y={121} w={36}>PAN</Cap>
      <Cap x={374} y={181} w={36}>VOL</Cap>
      {u < LP_UNITS - 1 ? <VFader k={lpKey(u, 'next')} x={417} y={81} w={16} h={98} /> : null}
      <Cap x={410} y={181} w={30}>NEXT</Cap>
    </>
  );
}

// ---------------------------------------------------------------- envelope area

function EnvArea({ lp, editLp, ui, setUi }: { lp: LpState; editLp: EditLp; ui: LpUi; setUi: (u: Partial<LpUi>) => void }) {
  const ed = useFxEditor();
  const u = ui.unit;
  const U = lp.units[u];
  const isWs = LP_TABS[ui.tab] === 'WS';
  const k = isWs ? -1 : ui.tab > 7 ? 7 : ui.tab; // target index
  const T = k >= 0 ? U.t[k] : null;
  const neutral = k >= 0 ? (LP_ADDITIVE[k] ? 0.5 : 1) : null;
  const patParam = useParam('pattern');
  const pi = Math.min(9, Math.max(0, Math.round(patParam.value) - 1));
  const [mon, setMon] = useState<{ pos: number; level: number }>({ pos: 0, level: 0 });
  useFxMonitor(ed.slotId, (d) => {
    const pos = typeof d.pos === 'number' ? d.pos : 0, level = typeof d.level === 'number' ? d.level : 0;
    setMon((m) => (Math.abs(m.pos - pos) < 1e-4 && Math.abs(m.level - level) < 1e-4 ? m : { pos, level }));
  });
  const tabMarks = LP_TABS.map((name, i) => (name === 'WS' ? !!U.ws : targetActive(U.t[i > 7 ? 7 : i], null)));
  const srcMarks = T ? [targetActive({ ...lpDefaultTarget(), pats: [T.pats[pi]] }, 0), !!T.lfo[1], !!T.mx, !!T.my, !!T.ief] : [];
  const mergeKey = `lp-env-${u}-${ui.tab}-${ui.src}-${pi}`;

  let body: React.ReactNode = null;
  if (isWs) {
    body = (
      <EnvEditor x={4} y={235} w={434} h={163} env={U.wsc} time={false} neutral={null} enabled={!!U.ws} caption="WS"
        onToggle={() => editLp('Love Philter: waveshaper', (L) => { L.units[u].ws = L.units[u].ws ? 0 : 1; })}
        onChange={(e, label) => editLp(label, (L) => { L.units[u].wsc = e; }, mergeKey)} />
    );
  } else if (T && neutral !== null) {
    if (ui.src === 0) {
      const cur = T.pats[pi];
      const env: LpEnv = cur ?? { p: [[0, neutral, 0, 0], [4, neutral, 0, 0]], ls: 0, le: 1, off: 1 };
      body = (
        <EnvEditor x={4} y={235} w={434} h={163} env={env} time neutral={neutral} enabled={!!cur && !cur.off} marker={mon.pos} caption={`PAT ${pi + 1}`}
          onToggle={() => editLp('Love Philter: pattern envelope switch', (L) => {
            const P = L.units[u].t[k].pats;
            const e = P[pi];
            if (!e) { P[pi] = { p: [[0, neutral, 0, 0], [4, neutral, 0, 0]], ls: 0, le: 1 }; return; }
            if (e.off) delete e.off; else e.off = 1;
          })}
          onChange={(e, label) => editLp(label, (L) => {
            const old = L.units[u].t[k].pats[pi];
            const ne: LpEnv = { p: e.p, ls: e.ls, le: e.le };
            if (old ? old.off : true) ne.off = 1;
            L.units[u].t[k].pats[pi] = ne;
          }, mergeKey)} />
      );
    } else if (ui.src === 1) {
      const key = (j: number) => lpLfoKey(u, k, j);
      const v = (j: number, d: number) => { const x = ed.params[key(j)]; return typeof x === 'number' ? x : d; };
      body = (
        <LfoView x={4} y={235} w={434} h={163} amount={T.lfo[0]} on={!!T.lfo[1]} neutral={neutral} marker={mon.pos}
          speed={v(0, 40000)} tension={v(1, 0)} skew={v(2, 0)} pw={v(3, 0)}
          onAmount={(a) => editLp('Love Philter: LFO amount', (L) => { L.units[u].t[k].lfo[0] = a; }, mergeKey)}
          onToggle={() => editLp('Love Philter: LFO switch', (L) => { const l = L.units[u].t[k].lfo; l[1] = l[1] ? 0 : 1; })}
          panel={(
            <>
              <LpKnob k={key(0)} x={14} y={10} w={34} h={34} />
              <LpKnob k={key(1)} x={78} y={10} w={34} h={34} />
              <LpKnob k={key(2)} x={14} y={62} w={34} h={34} />
              <LpKnob k={key(3)} x={78} y={62} w={34} h={34} />
              <Cap x={4} y={46} w={54} size={8.5}>SPEED</Cap>
              <Cap x={68} y={46} w={54} size={8.5}>TENSION</Cap>
              <Cap x={4} y={98} w={54} size={8.5}>SKEW</Cap>
              <Cap x={68} y={98} w={54} size={8.5}>PULSE</Cap>
            </>
          )} />
      );
    } else {
      const field = (['mx', 'my', 'ief'] as const)[ui.src - 2];
      const cur = T[field];
      const flat: LpEnv = { p: [[0, neutral, 0, 0], [1, neutral, 0, 0]], ls: -1, le: -1 };
      const env = cur ?? flat;
      const mx = ed.params.modX, my = ed.params.modY, efl = ed.params.efLevel;
      const marker = field === 'mx' ? (typeof mx === 'number' ? mx : 512) / 1024 : field === 'my' ? (typeof my === 'number' ? my : 512) / 1024
        : Math.min(1, mon.level * lpGain((typeof efl === 'number' ? efl : 128) / 128));
      body = (
        <EnvEditor x={4} y={235} w={434} h={163} env={env} time={false} neutral={neutral} enabled={!!cur && !cur.off} marker={marker}
          caption={SOURCES[ui.src]}
          onToggle={() => editLp('Love Philter: mapping switch', (L) => {
            const Tt = L.units[u].t[k];
            const e = Tt[field];
            if (!e) { Tt[field] = { ...flat }; return; }
            if (e.off) delete e.off; else e.off = 1;
          })}
          onChange={(e, label) => editLp(label, (L) => {
            const old = L.units[u].t[k][field];
            const ne: LpEnv = { p: e.p, ls: e.ls, le: e.le };
            if (old?.off) ne.off = 1;
            L.units[u].t[k][field] = ne;
          }, mergeKey)} />
      );
    }
  }

  return (
    <>
      <TabBar x={4} y={199} w={434} h={15} options={[...LP_TABS]} value={ui.tab} marks={tabMarks} size={11.5} hint="Editor target"
        onPick={(i) => setUi({ tab: i })} />
      {isWs ? (
        <div className="fxk-abs" style={{ left: 4, top: 216, width: 434, height: 17, background: LP.tabsBg, color: '#cfd7db', fontFamily: font, fontSize: 10.5, lineHeight: '17px', paddingLeft: 8, boxSizing: 'border-box' }}>
          WAVESHAPER CURVE ({U.wsb ? 'bipolar' : 'unipolar'})
        </div>
      ) : (
        <>
          <DigiWheel k="pattern" x={4} y={216} w={41} h={17} text={(v) => String(Math.round(v))} />
          <TabBar x={46} y={217} w={392} h={15} options={SOURCES} value={ui.src} marks={srcMarks} size={11.5} hint="Articulator part"
            onPick={(i) => setUi({ src: i })} />
        </>
      )}
      {body}
    </>
  );
}

// ---------------------------------------------------------------- right panel

function XyPad({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const px = useParam('modX'), py = useParam('modY');
  const drag = useRef(false);
  const setFrom = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const fx = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), fy = Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / r.height));
    px.set(Math.round(fx * 1024)); py.set(Math.round(fy * 1024));
    setHint(`X ${Math.round(fx * 100)}%  Y ${Math.round(fy * 100)}%`);
  };
  const cx = (px.value / 1024) * w, cy = (1 - py.value / 1024) * h;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: LP.pad, cursor: 'default', touchAction: 'none' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture(e.pointerId); drag.current = true; store.beginGesture('X / Y modulation'); setFrom(e); }}
      onPointerMove={(e) => { if (drag.current) setFrom(e); else setHint('X / Y modulation'); }}
      onPointerUp={() => { if (drag.current) { drag.current = false; store.endGesture(); } }}
      onPointerLeave={clearHint}>
      <svg width={w} height={h} style={{ display: 'block' }}>
        {[1, 2, 3].map((i) => (
          <g key={i}>
            <line x1={(i * w) / 4} x2={(i * w) / 4} y1={0} y2={h} stroke={i === 2 ? '#56606a' : '#4a535b'} strokeWidth={1} />
            <line y1={(i * h) / 4} y2={(i * h) / 4} x1={0} x2={w} stroke={i === 2 ? '#56606a' : '#4a535b'} strokeWidth={1} />
          </g>
        ))}
        <circle cx={cx} cy={cy} r={6} fill="none" stroke="#e2e8ec" strokeWidth={1.8} />
      </svg>
    </div>
  );
}

function OsSpinner({ lp, editLp }: { lp: LpState; editLp: EditLp }) {
  const ctl: ControlProps = {
    value: lp.os, min: 0, max: 4, step: 1, defaultValue: 1, label: 'Oversampling factor',
    format: (v) => OS_TEXT[Math.round(v)] ?? '',
    onChange: (v) => editLp('Love Philter: oversampling', (L) => { L.os = Math.round(v); }, 'lp-os'),
  };
  return <DigiWheelControl x={443 + 191} y={321} w={32} h={20} control={ctl} text={(v) => OS_TEXT[Math.round(v)] ?? ''} />;
}

function Heart({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  return (
    <svg className="fxk-abs" style={{ left: x, top: y }} width={w} height={h} viewBox="0 0 40 40">
      <path d="M20 36 C12 29 3 23 3 13.5 C3 8 7 4 12 4 C15.6 4 18.5 6 20 9 C21.5 6 24.4 4 28 4 C33 4 37 8 37 13.5 C37 23 28 29 20 36 Z" fill="#6f777b" />
    </svg>
  );
}

function RightPanel({ lp, editLp }: { lp: LpState; editLp: EditLp }) {
  const X = 443;
  const ed = useFxEditor();
  const optionsMenu = (e: React.PointerEvent) => {
    openMenu(e.clientX, e.clientY, [
      { label: 'Reset edited unit', onClick: () => { const uu = (ed.params.lpUi as LpUi | undefined)?.unit ?? 0; editLp('Love Philter: reset unit', (L) => { L.units[uu] = lpDefaultUnit(uu === 0); }); } },
      { separator: true },
      { label: 'Copy preset', onClick: () => { void navigator.clipboard?.writeText(JSON.stringify({ lovephilter: ed.params })); } },
      {
        label: 'Paste preset', onClick: () => {
          void navigator.clipboard?.readText().then((t) => {
            try {
              const o = JSON.parse(t) as { lovephilter?: Record<string, unknown> };
              if (!o.lovephilter) return;
              const src = o.lovephilter;
              editLpParams(src);
            } catch { /* not a Love Philter preset */ }
          });
        },
      },
      { separator: true },
      { label: 'Sync pattern changes', disabled: true },
      { label: 'Note input', disabled: true },
      { label: 'HQ WaveShaper', checked: true, disabled: true, hint: 'The waveshaper always interpolates its curve' },
    ]);
  };
  const edit = useFxEdit();
  const editLpParams = (src: Record<string, unknown>) => edit('Love Philter: paste preset', (p) => {
    for (const [kk, v] of Object.entries(src)) if (kk !== 'lpUi' && (typeof v === 'number' || kk === 'lp')) p[kk] = kk === 'lp' ? (lpNormalizeState(v) as unknown as Record<string, unknown>) : v;
  });
  return (
    <>
      <div className="fxk-abs" style={{ left: X, top: 0, width: 227, height: 400, background: LP.main }} />
      <div className="fxk-abs" style={{ left: X + 5, top: 2, width: 70, height: 52, color: '#727e84', fontFamily: '"Arial Narrow", Arial, sans-serif', fontStyle: 'italic', fontWeight: 700, fontSize: 21, lineHeight: '25px', letterSpacing: '-0.01em', pointerEvents: 'none' }}>
        LOVE<br />PHILTER
      </div>
      <Heart x={X + 74} y={2} w={38} h={38} />
      <RoundBtn x={X + 151} y={4} w={22} h={22} hint="Show / hide left controls panel (not available)" onClick={() => undefined}>
        <svg width={12} height={12} viewBox="0 0 16 16"><circle cx={8} cy={8} r={3} fill="none" stroke="currentColor" strokeWidth={2} /><path d="M8 0.5 V3 M8 13 V15.5 M0.5 8 H3 M13 8 H15.5 M2.7 2.7 L4.5 4.5 M11.5 11.5 L13.3 13.3 M2.7 13.3 L4.5 11.5 M11.5 4.5 L13.3 2.7" stroke="currentColor" strokeWidth={2} /></svg>
      </RoundBtn>
      <RoundBtn x={X + 176} y={4} w={22} h={22} hint="Options" onClick={optionsMenu}>
        <svg width={10} height={10} viewBox="0 0 16 16"><path d="M2 5 L14 5 L8 12 Z" fill="currentColor" /></svg>
      </RoundBtn>
      <RoundBtn x={X + 201} y={4} w={22} h={22} hint="Love Philter: 8 filter units with pattern envelopes, LFOs, X / Y and envelope follower modulation" onClick={() => undefined}>
        <span style={{ fontFamily: font, fontWeight: 700, fontSize: 13 }}>?</span>
      </RoundBtn>
      <VFader k="master" x={X + 161} y={52} w={15} h={88} />
      <VFader k="masterLfo" x={X + 185} y={52} w={15} h={88} />
      <VFader k="efLevel" x={X + 208} y={52} w={15} h={88} />
      <svg className="fxk-abs" style={{ left: X + 162, top: 143 }} width={10} height={8}><path d="M0 8 L10 8 L10 0 Z" fill="#e8edf0" /></svg>
      <Cap x={X + 175} y={142} w={31}>LFO</Cap>
      <Cap x={X + 199} y={142} w={32}>IEF</Cap>
      <div className="fxk-abs" style={{ left: X + 5, top: 55, width: 152, height: 242, background: LP.mainBevel, borderRadius: '0 0 4px 4px' }} />
      <XyPad x={X + 12} y={63} w={138} h={138} />
      <Led x={X + 10} y={207} w={70} h={15} on={!!lp.smooth} size={12} caption="SMOOTH" hint="Smooth up modulation (X / Y)"
        onClick={() => editLp('Love Philter: smooth', (L) => { L.smooth = L.smooth ? 0 : 1; })} />
      <LpKnob k="modX" x={X + 63} y={234} w={44} h={44} />
      <LpKnob k="modY" x={X + 109} y={234} w={44} h={44} />
      <Cap x={X + 8} y={279} w={54} h={13} size={11} style={{ fontStyle: 'italic', fontWeight: 400 }}>Modulation</Cap>
      <Cap x={X + 62} y={280} w={44}>X</Cap>
      <Cap x={X + 109} y={280} w={44}>Y</Cap>
      <div className="fxk-abs" style={{ left: X + 162, top: 153, width: 61, height: 18, background: '#65717a', borderRadius: '4px 4px 0 0', color: '#eef2f5', fontFamily: font, fontStyle: 'italic', fontSize: 12, lineHeight: '18px', textAlign: 'center' }}>IEF</div>
      <div className="fxk-abs" style={{ left: X + 162, top: 171, width: 61, height: 126, background: LP.sectionAlt, borderRadius: '0 0 4px 4px' }} />
      <Led x={X + 172} y={175} w={47} h={15} on={!!lp.use1} size={11} caption="USE1" hint="Use filter unit 1 as input for envelope follower"
        onClick={() => editLp('Love Philter: USE1', (L) => { L.use1 = L.use1 ? 0 : 1; })} />
      <LpKnob k="efAtt" x={X + 174} y={192} w={38} h={38} />
      <LpKnob k="efRel" x={X + 174} y={244} w={38} h={38} />
      <Cap x={X + 171} y={231} w={44}>ATT</Cap>
      <Cap x={X + 171} y={284} w={44}>REL</Cap>
      <Led x={X + 4} y={303} w={60} h={15} on={!!lp.center} size={12} caption="CENTER" hint="Global DC offset removal"
        onClick={() => editLp('Love Philter: center', (L) => { L.center = L.center ? 0 : 1; })} />
      <Led x={X + 66} y={303} w={100} h={15} on={!!lp.hq} size={12} caption="HQ ENVELOPES" hint="Extra high envelope accuracy (8x control rate)"
        onClick={() => editLp('Love Philter: HQ envelopes', (L) => { L.hq = L.hq ? 0 : 1; })} />
      <Cap x={X + 100} y={327} w={87} h={10}>OVERSAMPLING</Cap>
      <OsSpinner lp={lp} editLp={editLp} />
      <div className="fxk-abs" style={{ left: X + 4, top: 345, width: 219, height: 51, background: LP.info, borderRadius: 4 }} />
      <textarea className="fxk-abs" value={lp.info.replace(/\r/g, '\n')} spellCheck={false}
        onChange={(e) => { const v = e.target.value.replace(/\n/g, '\r'); editLp('Love Philter: info', (L) => { L.info = v; }, 'lp-info'); }}
        onPointerEnter={() => setHint('Info / comments')} onPointerLeave={clearHint}
        style={{
          left: X + 7, top: 347, width: 213, height: 47, background: 'transparent', border: 'none', outline: 'none', resize: 'none',
          color: '#e9eef1', fontFamily: font, fontSize: 11.5, lineHeight: '13px', padding: 0, overflow: 'hidden',
        }} />
    </>
  );
}

// ---------------------------------------------------------------- editor

function LovePhilterEditor() {
  const { lp, editLp } = useLp();
  const ui = useFxState<LpUi>('lpUi', { unit: 0, tab: 2, src: 0 });
  const view = useFxView();
  const setUi = (patch: Partial<LpUi>) => view('Love Philter view', (p) => { p.lpUi = { ...(p.lpUi as LpUi | undefined ?? { unit: 0, tab: 2, src: 0 }), ...patch }; });
  const u = Math.min(LP_UNITS - 1, Math.max(0, ui.unit | 0));
  const safeUi: LpUi = { unit: u, tab: Math.min(LP_TABS.length - 1, Math.max(0, ui.tab | 0)), src: Math.min(4, Math.max(0, ui.src | 0)) };
  return (
    <FxPanel width={670} height={400} style={{ background: LP.bottom }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 443, height: 196, background: `linear-gradient(180deg, ${LP.top} 0%, #8693a2 60%, ${LP.topEdge} 100%)` }} />
      <div className="fxk-abs" style={{ left: 0, top: 193, width: 443, height: 207, background: LP.bottom }} />
      <div className="fxk-abs" style={{ left: 3, top: 197, width: 436, height: 200, background: '#2c3336' }} />
      <div className="fxk-abs" style={{ left: 6, top: 55, width: 433, height: 2, background: '#6f7b87' }} />
      <UnitStrip lp={lp} editLp={editLp} ui={safeUi} setUi={setUi} />
      <IoSections u={u} />
      <FilterSection u={u} lp={lp} editLp={editLp} />
      <WsSection u={u} lp={lp} editLp={editLp} />
      <EnvArea lp={lp} editLp={editLp} ui={safeUi} setUi={setUi} />
      <RightPanel lp={lp} editLp={editLp} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'lovephilter', Editor: LovePhilterEditor };
