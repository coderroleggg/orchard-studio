// Distructor editor (FL: Distructor, 924 x 385): four module slots between
// five peak meters, each slot with its type header and power switch, the
// model's controls, Center / Smooth and oversampling, the model selector,
// In / Mix / Out and the move / options / add footer; the global Soft clip
// output and Show peakmeters switches below. Layout measured on FL's
// screenshot (form coordinates).

import { memo, useRef, type CSSProperties, type ReactNode } from 'react';
import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import {
  DX_CABS, DX_CAB_GROUPS, DX_CHORUS_MODELS, DX_DIST_MODELS, DX_FILTER_MODELS, DX_FILTER_RES, DX_KEYS, DX_MODULE_DEFAULTS,
  DX_OVERSAMPLE, DX_TYPES, DX_TYPE_MENU, dxKey, dxModules, dxNewModule, type DxModule,
} from '../../../../model/fx/plugins/distructor';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { useControl } from '../../../widgets/control';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../../kit';
import { clearHint, setHint } from '../../../hint';
import type { FxEditorModule } from '../../registry';
import { DxKnob, GEOM } from './DxKnob';

const W = 924;
const H = 385;
/** Slot s: panel at x = SLOT_X + s * PITCH, meters at x = METER_X + s * PITCH. */
const SLOT_X = 29;
const PITCH = 224;
const PANEL_W = 196;
const METER_X = 5;
const TOP = 5;
const BOTTOM = 351;

/** Accent per module colour (arcs, pointers, titles, selector text) and LED colours. */
const ACCENT = ['#e2b1a9', '#a7dca7', '#a1d5ee', '#c9b0e2'];
const TITLE = ['#e6a491', '#a6dba6', '#99cfec', '#c6a9e9'];
const LED = ['#ff4a29', '#43e13f', '#38c7ff', '#da96ff'];
const FONT = 'Arial, Helvetica, sans-serif';
/** FL's UI font is narrower than Arial: squeeze texts to FL's measured widths. */
const NARROW: CSSProperties = { display: 'inline-block', transform: 'scaleX(0.82)', transformOrigin: '50% 50%' };

const label = (x: number, y: number, text: string, extra?: CSSProperties): ReactNode => (
  <div className="fxk-abs" style={{
    left: x - 50, top: y - 6, width: 100, height: 12, textAlign: 'center', font: `400 10px ${FONT}`, lineHeight: '12px', WebkitTextStroke: '0.35px #c2d1d5',
    color: '#c2d1d5', pointerEvents: 'none', whiteSpace: 'nowrap', ...extra,
  }}><span style={NARROW}>{text}</span></div>
);

function slotOf(slotId: string): Record<string, unknown> | null {
  const loc = A.findFx(store.project, slotId);
  return loc ? (loc.fx.params as Record<string, unknown>) : null;
}

/** Edit the module list (and per-slot parameters) as one undo step. */
function editModules(slotId: string, label: string, f: (mods: DxModule[], p: Record<string, unknown>) => void): void {
  A.editFx(slotId, label, (p) => {
    const mods = dxModules(p.modules);
    f(mods, p as Record<string, unknown>);
    p.modules = mods.map((m) => ({ ...m }));
  });
}

function swapSlots(p: Record<string, unknown>, a: number, b: number): void {
  for (let k = 0; k < DX_KEYS.length; k++) {
    const ka = dxKey(a, k), kb = dxKey(b, k);
    const t = p[ka]; p[ka] = p[kb]; p[kb] = t;
  }
}

function resetSlot(p: Record<string, unknown>, s: number): void {
  for (let k = 0; k < DX_KEYS.length; k++) p[dxKey(s, k)] = DX_MODULE_DEFAULTS[k];
}

// ---------------------------------------------------------------- small widgets

function Led({ x, y, r = 6.5, on, color }: { x: number; y: number; r?: number; on: boolean; color: string }) {
  return (
    <div className="fxk-abs" style={{
      left: x - r, top: y - r, width: 2 * r, height: 2 * r, borderRadius: '50%', pointerEvents: 'none',
      background: on ? `radial-gradient(circle at 50% 42%, #fff6f0 0%, ${color} 38%, ${color} 62%, rgba(0,0,0,0.55) 100%)`
        : 'radial-gradient(circle at 50% 42%, #4d4645 0%, #2f2a2a 60%, #1d1b1b 100%)',
      boxShadow: on ? `0 0 0 1.4px #2a2020, 0 0 5px ${color}66` : '0 0 0 1.4px #1a1c1e',
    }} />
  );
}

function Toggle({ x, y, w, text, on, color, onClick, hint }: { x: number; y: number; w: number; text: string; on: boolean; color: string; onClick: () => void; hint: string }) {
  return (
    <div className="fxk-abs" style={{ left: x - 9, top: y - 9, width: w, height: 18, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); onClick(); }}
      onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      <Led x={9} y={9} on={on} color={color} />
      <div className="fxk-abs" style={{ left: 22, top: 3, height: 12, font: `700 10px ${FONT}`, color: '#c2d1d5', lineHeight: '12px', whiteSpace: 'nowrap', pointerEvents: 'none' }}><span style={{ ...NARROW, transformOrigin: '0 50%' }}>{text}</span></div>
    </div>
  );
}

/** Square switch (X100, TYPE, MODE, FILTER): label above, dark key that lights in the accent colour. */
const KeySwitch = memo(function KeySwitch({ k, x, y, text, color, glyph }: { k: string; x: number; y: number; text: string; color: string; glyph?: (v: number) => string }) {
  const p = useParam(k);
  const h = useControl(p.control, 'vertical');
  const on = p.value >= 0.5;
  return (
    <>
      {label(x, y - 20, text)}
      <div className="fxk-abs" style={{ left: x - 11, top: y - 11, width: 22, height: 22, borderRadius: 3, cursor: 'default',
        background: on ? `radial-gradient(circle at 50% 45%, ${color} 0%, ${color}cc 55%, #4a4a48 100%)` : 'linear-gradient(180deg, #6f6f6e 0%, #5f5f5e 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.35), 0 1px 1px rgba(0,0,0,0.4)' }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); setHint(`${p.def.name}: ${p.control.format?.(on ? 0 : 1)}`); }}
        onContextMenu={h.onContextMenu}
        onPointerEnter={() => setHint(`${p.def.name}: ${p.control.format?.(p.value)}`)} onPointerLeave={clearHint}>
        <div style={{ position: 'absolute', inset: 4, borderRadius: 2, background: on ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.12)', boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.18)' }} />
        {glyph && <div style={{ position: 'absolute', inset: 0, textAlign: 'center', font: `700 10px ${FONT}`, lineHeight: '22px', color: on ? '#2a2020' : '#2b2f31' }}>{glyph(p.value)}</div>}
      </div>
    </>
  );
});

// ---------------------------------------------------------------- module controls

type Cell = { k: number; text: string; key?: boolean; glyph?: (v: number) => string };

const DIST_CELLS: Cell[][] = [
  [{ k: 0, text: 'PRE BAND' }, { k: 1, text: 'COLOR' }, { k: 2, text: 'PRE AMP' }, { k: 3, text: 'POST GAIN' }, { k: 4, text: 'POST FILTER' }, { k: 5, text: 'X100', key: true }],
  [{ k: 16, text: 'PRE AMP' }, { k: 17, text: 'THRESHOLD' }, { k: 18, text: 'POSTGAIN' }, { k: 19, text: 'MIX' }, { k: 20, text: 'TYPE', key: true, glyph: (v) => (v >= 0.5 ? 'B' : 'A') }],
  [{ k: 21, text: 'THRESHOLD' }, { k: 22, text: 'POST GAIN' }],
];
const HARMOR_CELLS: Cell[] = [{ k: 23, text: 'PRE AMP' }, { k: 24, text: 'ASYMMETRY' }, { k: 25, text: 'WET VOL' }, { k: 26, text: 'DRY MIX' }, { k: 27, text: 'FILTER CUT' }];
const FOLD_CELLS: Cell[] = [{ k: 6, text: 'PRE AMP' }, { k: 7, text: 'CROSSOVER' }, { k: 8, text: 'ASYMMETRY' }, { k: 9, text: 'THRESHOLD' }];
const APE_CELLS: Cell[] = [{ k: 10, text: 'PRE AMP' }, { k: 11, text: 'CROSSOVER' }, { k: 12, text: 'ASYMMETRY' }, { k: 13, text: 'THRESHOLD' }, { k: 14, text: 'WARP POINT' }, { k: 15, text: 'MODE', key: true, glyph: (v) => (v >= 0.5 ? 'B' : 'A') }];
const ABR_CELLS: Cell[] = [{ k: 28, text: 'PRE AMP' }, { k: 29, text: 'GATE THRESH' }, { k: 30, text: 'DRY/WET' }, { k: 31, text: 'POST GAIN' }, { k: 32, text: 'NOISE BP' }, { k: 33, text: 'FILTER', key: true }];
const CRUSH_CELLS: Cell[] = [{ k: 34, text: 'RATE CRUSH' }, { k: 35, text: 'BIT CRUSH' }];

function distCells(model: number): Cell[] {
  if (model <= 2) return DIST_CELLS[model];
  if (model <= 13) return HARMOR_CELLS;
  return model === 14 ? FOLD_CELLS : model === 15 ? APE_CELLS : model === 16 ? ABR_CELLS : CRUSH_CELLS;
}

const COLS = [33, 97, 162];

function Grid({ s, cells, color, rows }: { s: number; cells: Cell[]; color: string; rows: [number, number][] }) {
  return (
    <>
      {cells.map((c, i) => {
        const x = COLS[i % 3], [ly, ky] = rows[Math.floor(i / 3)];
        const key = dxKey(s, c.k);
        if (c.key) return <KeySwitch key={key} k={key} x={x} y={ky + 2} text={c.text} color={color} glyph={c.glyph} />;
        return (
          <div key={key}>
            {label(x, ly, c.text)}
            <DxKnob k={key} x={x} y={ky} g={GEOM.std} color={color} />
          </div>
        );
      })}
    </>
  );
}

function OsStepper({ slotId, s, mod, color }: { slotId: string; s: number; mod: DxModule; color: string }) {
  const set = (v: number) => {
    const c = Math.max(0, Math.min(4, v));
    if (c !== mod.os) editModules(slotId, 'Oversampling', (m) => { m[s].os = c; });
    setHint(`Oversampling: ${DX_OVERSAMPLE[c]}`);
  };
  return (
    <>
      {label(117, 225.7, 'OVERSAMPLING')}
      <div className="fxk-abs" style={{ left: 157.5, top: 214.3, width: 31.5, height: 22, borderRadius: 2, background: 'linear-gradient(180deg, #313335 0%, #2a2b2c 100%)', boxShadow: 'inset 0 0 0 1px #1d2022', cursor: 'ns-resize', pointerEvents: 'auto' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          if ((e.clientX - r.left) / r.width > 0.68) set(mod.os + ((e.clientY - r.top) / r.height < 0.5 ? 1 : -1));
          else openMenu(r.left, r.bottom, DX_OVERSAMPLE.map((t, i) => ({ label: t, checked: i === mod.os, radio: true, onClick: () => set(i) })));
        }}
        onWheel={(e) => set(mod.os + (e.deltaY < 0 ? 1 : -1))}
        onPointerEnter={() => setHint(`Oversampling: ${DX_OVERSAMPLE[mod.os]}`)} onPointerLeave={clearHint}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: 22, height: 22, textAlign: 'right', font: `400 12.6px ${FONT}`, lineHeight: '22px', color }}>{DX_OVERSAMPLE[mod.os]}</div>
        <svg width={8} height={22} style={{ position: 'absolute', left: 23, top: 0 }}>
          <path d="M1 9 L4 5 L7 9 Z" fill="#c6ced3" /><path d="M1 13 L4 17 L7 13 Z" fill="#c6ced3" />
        </svg>
      </div>
    </>
  );
}

function modelName(m: DxModule): string {
  switch (m.type) {
    case 0: return DX_DIST_MODELS[m.dist];
    case 1: return DX_FILTER_MODELS[m.filter];
    case 2: return DX_CHORUS_MODELS[m.chorus];
    default: return DX_CABS[m.cab] ?? '(none)';
  }
}

function modelMenu(slotId: string, s: number, m: DxModule): MenuItem[] {
  const pick = (f: (x: DxModule) => void, name: string) => () => { editModules(slotId, `Model: ${name}`, (mods) => f(mods[s])); setHint(name); };
  switch (m.type) {
    case 0: {
      const it = (i: number, text = DX_DIST_MODELS[i]): MenuItem => ({ label: text, checked: m.dist === i, radio: true, onClick: pick((x) => { x.dist = i; }, DX_DIST_MODELS[i]) });
      return [
        it(0), it(1), it(2),
        { label: 'Harmor', submenu: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13].map((i) => it(i, DX_DIST_MODELS[i].replace('Harmor ', ''))) },
        { label: 'Distructor', submenu: [it(14), it(15), it(16)] },
        it(17),
      ];
    }
    case 1: return DX_FILTER_MODELS.map((name, i) => ({ label: name, checked: m.filter === i, radio: true, onClick: pick((x) => { x.filter = i; }, name) }));
    case 2: return [1, 0, 2].map((i) => ({ label: DX_CHORUS_MODELS[i], checked: m.chorus === i, radio: true, onClick: pick((x) => { x.chorus = i; }, DX_CHORUS_MODELS[i]) }));
    default: return DX_CAB_GROUPS.map(([g, h], gi) => {
      const end = gi + 1 < DX_CAB_GROUPS.length ? DX_CAB_GROUPS[gi + 1][1] : DX_CABS.length;
      const items: MenuItem[] = [];
      for (let i = h + 1; i < end; i++) items.push({ label: DX_CABS[i] ?? '', checked: m.cab === i, radio: true, onClick: pick((x) => { x.cab = i; }, DX_CABS[i] ?? '') });
      return { label: g, submenu: items };
    });
  }
}

/** Step the model with the mouse wheel over the selector. */
function stepModel(slotId: string, s: number, m: DxModule, d: number): void {
  editModules(slotId, 'Model', (mods) => {
    const x = mods[s];
    if (x.type === 0) x.dist = (x.dist + d + 18) % 18;
    else if (x.type === 1) x.filter = (x.filter + d + 22) % 22;
    else if (x.type === 2) x.chorus = [1, 0, 2][([1, 0, 2].indexOf(x.chorus) + d + 3) % 3];
    else {
      let c = x.cab;
      do { c = (c + d + DX_CABS.length) % DX_CABS.length; } while (DX_CABS[c] === null);
      x.cab = c;
    }
  });
  void m;
}

const Module = memo(function Module({ slotId, s, mod }: { slotId: string; s: number; mod: DxModule }) {
  const color = ACCENT[mod.color];
  const x0 = SLOT_X + s * PITCH;
  const k = (i: number) => dxKey(s, i);
  const name = modelName(mod);
  const typeMenu = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, DX_TYPE_MENU.map((t, i) => ({
      label: t, checked: mod.type === i, radio: true,
      onClick: () => editModules(slotId, `Module ${s + 1}: ${t}`, (m) => { m[s].type = i; }),
    })), { minWidth: 120 });
  };
  return (
    <div className="fxk-abs" style={{ left: x0, top: TOP, width: PANEL_W, height: BOTTOM - TOP, borderRadius: 4, overflow: 'hidden',
      background: 'linear-gradient(90deg, #232b2e 0%, #2b3439 50%, #232b2e 100%)' }}>
      {/* header */}
      <div className="fxk-abs" style={{ left: 0, top: 0, width: 146, height: 46, background: 'linear-gradient(180deg, #4c5f68 0%, #3f4c53 100%)', cursor: 'default' }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); typeMenu(e); }}
        onPointerEnter={() => setHint(`Module ${s + 1} type`)} onPointerLeave={clearHint}>
        <div style={{ position: 'absolute', left: 0, width: 128, top: 0, height: 46, textAlign: 'center', font: `400 17px ${FONT}`, lineHeight: '46px', color: TITLE[mod.color] }}><span style={{ ...NARROW, transform: 'scaleX(0.84)' }}>{DX_TYPES[mod.type]}</span></div>
        <svg width={10} height={6} style={{ position: 'absolute', left: 122, top: 20 }}><path d="M0 0 L10 0 L5 6 Z" fill="#7b8b93" /></svg>
      </div>
      <div className="fxk-abs" style={{ left: 146, top: 0, width: 50, height: 46, background: 'linear-gradient(180deg, #3b474c 0%, #313a3f 100%)', cursor: 'default' }}
        onPointerDown={(e) => { if (e.button !== 0) return; e.stopPropagation(); editModules(slotId, mod.bypass ? 'Module on' : 'Module off', (m) => { m[s].bypass = m[s].bypass ? 0 : 1; }); }}
        onPointerEnter={() => setHint(`Module ${s + 1}: ${mod.bypass ? 'off' : 'on'}`)} onPointerLeave={clearHint}>
        <Power x={26} y={23} on={!mod.bypass} color={LED[mod.color]} />
      </div>
      {/* body */}
      <div className="fxk-abs" style={{ left: 0, top: 46, width: PANEL_W, height: 300 }}>
        <div className="fxk-abs" style={{ left: 0, top: -46, width: PANEL_W, height: 346, opacity: mod.bypass ? 0.55 : 1 }}>
          {mod.type === 0 && <Grid s={s} cells={distCells(mod.dist)} color={color} rows={[[67, 98], [142, 173]]} />}
          {mod.type === 1 && (
            <>
              {label(55.6, 79.3, 'CUTOFF')}
              <DxKnob k={k(39)} x={55.6} y={131.7} g={GEOM.cutoff} color={color} />
              {DX_FILTER_RES[mod.filter] && label(155, 95.3, DX_FILTER_RES[mod.filter])}
              <DxKnob k={k(40)} x={155} y={134.3} g={GEOM.res} color={color} disabled={!DX_FILTER_RES[mod.filter]} />
            </>
          )}
          {mod.type === 2 && <Grid s={s} cells={[{ k: 43, text: 'DELAY' }, { k: 44, text: 'FEEDBACK' }, { k: 45, text: 'SPEED' }, { k: 46, text: 'DEPTH' }, { k: 47, text: 'BLUR' }, { k: 48, text: 'COLOR' }]} color={color} rows={[[87.7, 118.3], [163, 193.7]]} />}
          {mod.type === 3 && (
            <>
              {label(48.6, 109, 'STEREO SEP IN')}
              <DxKnob k={k(41)} x={48.6} y={153} g={GEOM.big} color={color} />
              {label(146.6, 109, 'STEREO SEP OUT')}
              <DxKnob k={k(42)} x={146.6} y={153} g={GEOM.big} color={color} />
            </>
          )}
          {mod.type <= 1 && (
            <>
              <Toggle x={17} y={220.7} w={70} text={mod.type === 0 ? 'CENTER' : 'SMOOTH'} on={mod.type === 0 ? !!mod.center : !!mod.smooth} color={LED[mod.color]}
                hint={mod.type === 0 ? 'Center (remove DC offset)' : 'Smooth parameter changes'}
                onClick={() => editModules(slotId, mod.type === 0 ? 'Center' : 'Smooth', (m) => { if (mod.type === 0) m[s].center = m[s].center ? 0 : 1; else m[s].smooth = m[s].smooth ? 0 : 1; })} />
              {/* positioning frame only: it covers the module, so it must let the knobs below get the mouse */}
              <div className="fxk-abs" style={{ left: 0, top: -5, width: PANEL_W, height: 346, pointerEvents: 'none' }}>
                <OsStepper slotId={slotId} s={s} mod={mod} color={color} />
              </div>
            </>
          )}
          {/* model selector */}
          <div className="fxk-abs" style={{ left: 44.3, top: 238.3, width: 110.7, height: 23.4, borderRadius: 2, background: 'linear-gradient(180deg, #2c2d2e 0%, #222629 100%)', boxShadow: 'inset 0 0 0 1px #1b1f21', cursor: 'default' }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              openMenu(r.left, r.bottom, modelMenu(slotId, s, mod), { minWidth: 140 });
            }}
            onWheel={(e) => stepModel(slotId, s, mod, e.deltaY > 0 ? 1 : -1)}
            onPointerEnter={() => setHint(`Model: ${name}`)} onPointerLeave={clearHint}>
            <div style={{ position: 'absolute', left: 4, right: 12, top: 0, height: 23.4, textAlign: 'center', font: `400 12px ${FONT}`, lineHeight: '23px', color, whiteSpace: 'nowrap' }}><span style={{ ...NARROW, transform: 'scaleX(0.88)' }}>{name}</span></div>
            <svg width={6} height={8} style={{ position: 'absolute', right: 5, top: 8 }}><path d="M0 0 L5 4 L0 8 Z" fill="#6b777d" /></svg>
          </div>
          {/* in / mix / out */}
          <div className="fxk-abs" style={{ left: 0, top: 267, width: PANEL_W, height: 54, background: 'linear-gradient(180deg, #3f4b50 0%, #2f373c 100%)' }} />
          {label(40, 277, 'IN', { color: '#d9e9ef' })}
          {label(97, 277, 'MIX', { color: '#d9e9ef' })}
          {label(155, 277, 'OUT', { color: '#d9e9ef' })}
          <DxKnob k={k(36)} x={40} y={300} g={GEOM.small} color={color} />
          <DxKnob k={k(37)} x={97} y={300} g={GEOM.small} color={color} />
          <DxKnob k={k(38)} x={155} y={300} g={GEOM.small} color={color} />
        </div>
      </div>
      <Footer slotId={slotId} s={s} />
    </div>
  );
});

function Power({ x, y, on, color }: { x: number; y: number; on: boolean; color: string }) {
  return (
    <div className="fxk-abs" style={{ left: x - 9, top: y - 9, width: 18, height: 18, borderRadius: '50%', pointerEvents: 'none',
      background: on ? `radial-gradient(circle at 50% 40%, #ffd9c9 0%, ${color} 45%, ${color} 70%, #3a2a26 100%)` : 'radial-gradient(circle at 50% 40%, #6c6966 0%, #4f4c49 70%, #2e2c2b 100%)',
      boxShadow: '0 0 0 2.2px #23292c, 0 0 0 3.2px #4a5653' }}>
      <div style={{ position: 'absolute', left: 7.6, top: 4, width: 2.8, height: 10, borderRadius: 1.4, background: on ? '#fbf7f5' : '#2c2a29', boxShadow: on ? '0 0 2px rgba(255,255,255,0.6)' : 'none' }} />
    </div>
  );
}

function Footer({ slotId, s }: { slotId: string; s: number }) {
  const move = (d: number) => editModules(slotId, d < 0 ? 'Move module left' : 'Move module right', (m, p) => {
    const t = s + d;
    if (t < 0 || t >= m.length) return;
    const a = m[s]; m[s] = m[t]; m[t] = a;
    swapSlots(p, s, t);
  });
  const options = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, [
      { label: 'Remove module', onClick: () => editModules(slotId, 'Remove module', (m, p) => {
        for (let i = s; i < m.length - 1; i++) swapSlots(p, i, i + 1);
        m.splice(s, 1);
        resetSlot(p, m.length);
      }) },
      { label: 'Reset module', onClick: () => editModules(slotId, 'Reset module', (_m, p) => resetSlot(p, s)) },
      { separator: true },
      { label: 'Move left', disabled: s === 0, onClick: () => move(-1) },
      { label: 'Move right', onClick: () => move(1) },
    ], { minWidth: 130 });
  };
  const icon = { position: 'absolute' as const, top: 0, height: 25, cursor: 'default' };
  return (
    <div className="fxk-abs" style={{ left: 0, top: 321, width: PANEL_W, height: 25, background: '#445257' }}>
      <div style={{ ...icon, left: 20, width: 24 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); move(-1); } }}
        onPointerEnter={() => setHint('Move module left')} onPointerLeave={clearHint}>
        <svg width={24} height={25}><path d="M14.5 7.5 L9 12.5 L14.5 17.5 Z" fill="#c9e3ee" /></svg>
      </div>
      <div style={{ ...icon, left: 85, width: 24 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); options(e); } }}
        onPointerEnter={() => setHint('Module options (remove, reset)')} onPointerLeave={clearHint}>
        <Gear />
      </div>
      <div style={{ ...icon, left: 151, width: 24 }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); move(1); } }}
        onPointerEnter={() => setHint('Move module right')} onPointerLeave={clearHint}>
        <svg width={24} height={25}><path d="M9.5 7.5 L15 12.5 L9.5 17.5 Z" fill="#c9e3ee" /></svg>
      </div>
    </div>
  );
}

function Gear() {
  const teeth = [];
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3;
    teeth.push(<rect key={i} x={10.6} y={4.4} width={2.8} height={3.6} rx={0.6} fill="#c9e3ee" transform={`rotate(${(a * 180) / Math.PI} 12 12.5)`} />);
  }
  return (
    <svg width={24} height={25}>
      {teeth}
      <circle cx={12} cy={12.5} r={5.4} fill="#c9e3ee" />
      <circle cx={12} cy={12.5} r={2.4} fill="#445257" />
    </svg>
  );
}

/** An empty slot: dark panel with the + (add module) button. */
function EmptySlot({ slotId, s }: { slotId: string; s: number }) {
  const x0 = SLOT_X + s * PITCH;
  const add = (e: React.PointerEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu(r.left, r.bottom, DX_TYPE_MENU.map((t, i) => ({
      label: t, onClick: () => editModules(slotId, `Add ${t}`, (m, p) => {
        if (m.length >= 4) return;
        const used = new Set(m.map((x) => x.color));
        let c = 0;
        while (used.has(c) && c < 3) c++;
        resetSlot(p, m.length);
        m.push(dxNewModule(i, c));
      }),
    })), { minWidth: 120 });
  };
  return (
    <div className="fxk-abs" style={{ left: x0, top: TOP, width: PANEL_W, height: BOTTOM - TOP, borderRadius: 4, background: 'linear-gradient(90deg, #1f272a 0%, #252e32 50%, #1f272a 100%)' }}>
      <div className="fxk-abs" style={{ left: 0, top: 321, width: PANEL_W, height: 25, background: '#384449' }}>
        <div style={{ position: 'absolute', left: 85, top: 0, width: 26, height: 25, cursor: 'default' }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); add(e); } }}
          onPointerEnter={() => setHint('Add a module')} onPointerLeave={clearHint}>
          <svg width={26} height={25}><path d="M11.6 6.5 h2.8 v4.6 h4.6 v2.8 h-4.6 v4.6 h-2.8 v-4.6 h-4.6 v-2.8 h4.6 Z" fill="#c9e3ee" /></svg>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- meters

/** dB scale of FL's meters: [dB, y of the mark] measured on the screenshot (labels sit 6 px above). */
const SCALE: [number, number][] = [
  [6, 3.5], [3, 29.5], [0, 55.7], [-3, 81.7], [-6, 107.7], [-9, 132.7], [-12, 158], [-15, 181], [-18, 204.7], [-21, 226.4],
  [-24, 245.7], [-27, 265.7], [-30, 281.7], [-33, 295.7], [-36, 306.4], [-39, 315.7], [-60, 338], [-90, 351],
];

function dbToY(db: number): number {
  if (db >= SCALE[0][0]) return SCALE[0][1];
  for (let i = 1; i < SCALE.length; i++) {
    const [d1, y1] = SCALE[i];
    if (db >= d1) {
      const [d0, y0] = SCALE[i - 1];
      return y0 + ((db - d0) / (d1 - d0)) * (y1 - y0);
    }
  }
  return BOTTOM;
}

interface MeterState { lv: Float64Array; hold: Float64Array; holdT: Float64Array; target: Float64Array; last: number }

function Meter({ i, st, on }: { i: number; st: MeterState; on: boolean }) {
  const x = METER_X + i * PITCH;
  return (
    <AnimatedDisplay x={x} y={TOP} w={20} h={BOTTOM - TOP} frame={(g, w, h, t) => {
      const dt = Math.min(0.1, Math.max(0, (t - st.last) / 1000));
      if (i === 0) st.last = t;
      g.fillStyle = '#273035';
      g.fillRect(0, 0, w, h);
      for (let ch = 0; ch < 2; ch++) {
        const j = 2 * i + ch;
        // fall 24 dB/s from the last peak (FL-like), hold the peak marker 1.5 s
        const target = st.target[j];
        let lv = st.lv[j];
        const tdb = target > 1e-6 ? 20 * Math.log10(target) : -120;
        let ldb = lv > 1e-6 ? 20 * Math.log10(lv) : -120;
        ldb = Math.max(tdb, ldb - 24 * dt);
        lv = ldb > -119 ? Math.pow(10, ldb / 20) : 0;
        st.lv[j] = lv;
        st.target[j] = 0;
        if (tdb >= (st.hold[j] > 1e-6 ? 20 * Math.log10(st.hold[j]) : -120)) { st.hold[j] = target; st.holdT[j] = t; }
        else if (t - st.holdT[j] > 1500) st.hold[j] = Math.max(0, st.hold[j] * Math.pow(10, (-24 * dt) / 20));
        if (!on) continue;
        const bx = ch === 0 ? 1 : 10.5, bw = 8.5;
        const top = dbToY(ldb) - TOP;
        const y6 = dbToY(-6) - TOP, y0 = dbToY(0) - TOP;
        if (ldb > -90) {
          g.fillStyle = '#a8cf52';
          g.fillRect(bx, Math.max(top, y6), bw, h - Math.max(top, y6));
          if (top < y6) { g.fillStyle = '#ffe25e'; g.fillRect(bx, Math.max(top, y0), bw, y6 - Math.max(top, y0)); }
          if (top < y0) { g.fillStyle = '#ff5c3c'; g.fillRect(bx, top, bw, y0 - top); }
        }
        const hold = st.hold[j];
        if (hold > 1e-4) {
          const hy = dbToY(20 * Math.log10(hold)) - TOP;
          g.fillStyle = '#c49f36';
          g.fillRect(bx, hy - 1, bw, 2);
        }
      }
      g.fillStyle = '#1e2528';
      g.fillRect(9.5, 0, 1, h);
      // scale: FL's labels every 3 dB with a thin mark under each, lighter over the bars
      const fillTop = Math.min(dbToY(st.lv[2 * i] > 1e-6 ? 20 * Math.log10(st.lv[2 * i]) : -120), dbToY(st.lv[2 * i + 1] > 1e-6 ? 20 * Math.log10(st.lv[2 * i + 1]) : -120)) - TOP;
      g.font = `400 8.4px ${FONT}`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      for (const [d, yy] of SCALE) {
        if (d > 3 || d < -39) continue;
        const y = yy - TOP;
        const inFill = on && y > fillTop;
        g.fillStyle = inFill ? 'rgba(255,255,255,0.16)' : '#3b474d';
        g.fillRect(5, y, w - 10, 0.7);
        if (d > 0) continue;
        g.fillStyle = inFill ? 'rgba(255,255,255,0.38)' : '#8e9aa8';
        g.fillText(String(-d), w / 2, y - 6);
      }
    }} />
  );
}

// ---------------------------------------------------------------- editor

function Logo() {
  return (
    <div className="fxk-abs" style={{
      left: 700, top: 355, width: 216, height: 27, textAlign: 'right', font: `900 22px 'Arial Black', Arial, Helvetica, sans-serif`,
      lineHeight: '27px', letterSpacing: '0.6px', pointerEvents: 'none', color: '#7d8a92',
      background: 'repeating-linear-gradient(180deg, #8d9aa2 0px, #8d9aa2 1px, #6f7c84 1px, #6f7c84 2px)',
      WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
      filter: 'drop-shadow(0 0 0.6px #10161a) drop-shadow(0 1px 0 #11171a)',
    }}>DISTRUCTOR</div>
  );
}

function Editor() {
  const { slotId, params } = useFxEditor();
  const mods = dxModules(params.modules);
  const softClipOn = Number(useFxState<number>('softClip', 1)) >= 0.5;
  const metersOn = Number(useFxState<number>('meters', 1)) >= 0.5;
  const st = useRef<MeterState>({ lv: new Float64Array(10), hold: new Float64Array(10), holdT: new Float64Array(10), target: new Float64Array(10), last: 0 }).current;
  useFxMonitor(slotId, (d) => {
    const pk = d.peaks as number[] | undefined;
    if (!Array.isArray(pk)) return;
    for (let j = 0; j < 10; j++) if (pk[j] > st.target[j]) st.target[j] = pk[j];
  });
  return (
    <FxPanel width={W} height={H} style={{ background: 'linear-gradient(180deg, #1c2326 0%, #1e262c 100%)', fontFamily: FONT }}>
      {[0, 1, 2, 3, 4].map((i) => <Meter key={i} i={i} st={st} on={metersOn} />)}
      {[0, 1, 2, 3].map((s) => (s < mods.length
        ? <Module key={s} slotId={slotId} s={s} mod={mods[s]} />
        : s === mods.length ? <EmptySlot key={s} slotId={slotId} s={s} /> : <div key={s} className="fxk-abs" style={{ left: SLOT_X + s * PITCH, top: TOP, width: PANEL_W, height: BOTTOM - TOP, borderRadius: 4, background: '#1f272a' }} />))}
      <div className="fxk-abs" style={{ left: 0, top: 352, width: W, height: 33, background: '#273035', borderTop: '1px solid #1e262c' }} />
      <Toggle x={15} y={368} w={128} text="SOFT CLIP OUTPUT" on={softClipOn} color="#ff4a29" hint="Soft clip output"
        onClick={() => A.editFx(slotId, 'Soft clip output', (p) => { p.softClip = softClipOn ? 0 : 1; })} />
      <Toggle x={148} y={368} w={130} text="SHOW PEAKMETERS" on={metersOn} color="#ff4a29" hint="Show peak meters"
        onClick={() => A.editFx(slotId, 'Show peakmeters', (p) => { p.meters = metersOn ? 0 : 1; })} />
      <Logo />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'distructor',
  Editor,
  menu: (slotId) => {
    const p = slotOf(slotId);
    const flag = (k: string) => Number(p?.[k] ?? 1) >= 0.5;
    return [
      { label: 'Soft clip output', checked: flag('softClip'), onClick: () => A.editFx(slotId, 'Soft clip output', (q) => { q.softClip = flag('softClip') ? 0 : 1; }) },
      { label: 'Show peakmeters', checked: flag('meters'), onClick: () => A.editFx(slotId, 'Show peakmeters', (q) => { q.meters = flag('meters') ? 0 : 1; }) },
    ];
  },
};
