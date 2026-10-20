// Parametric EQ 2 right-hand panel (docs/research/peq2.md 5.6, 6.3-6.5):
// main level fader and caption column, then per band the type/slope selector,
// level fader, mute/solo switch, FREQ and BW knobs.

import { memo, useMemo, useRef } from 'react';
import { store, useProject } from '../../store';
import { findFx } from '../../store/actions';
import { mixerTrackName } from '../../model/defaults';
import { Fader } from '../widgets/Fader';
import { Knob } from '../widgets/Knob';
import { openMenu } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import { clamp } from '../../engine/dsp/math';
import {
  defaultBand, freqHz, freqNorm, formatFreq, typeHasLevel, PEQ2_BAND_COLORS, PEQ2_TYPES, PEQ2_TYPE_LABELS,
  type PEQ2Band, type PEQ2Options, type PEQ2Params, type PEQ2Type,
} from '../../model/peq2';
import { edit, editOnce } from './peq2Edit';
import { fmtBw, fmtDb, fmtOrder, typedDefault } from './peq2Format';
import { keyMenu, soloMenu, tileMenu } from './peq2Menus';
import type { Layout } from './peq2Layout';
import { pluginTargetOf } from '../../model/fx/hosted';

const LEVEL_TICKS = [0, 1 / 6, 1 / 3, 0.5, 2 / 3, 5 / 6, 1];
const STEP_PX = 12; // vertical travel per type / order step

// "Type in value..." in context-aware units (docs/research/peq2.md 6.4)
const parseDb = (typed: number) => typed;

/** Accepting the pre-filled text unchanged keeps the value (it may not parse back exactly). */
function typeIn(value: number, format: (v: number) => string, parse: (typed: number) => number) {
  return (typed: number) => (typed === typedDefault(format(value)) ? value : parse(typed));
}

/** Hz, or kHz when the number is below the 20 Hz bottom of the range (or 20 while in kHz). */
function parseFreq(typed: number, current: number): number {
  const kHz = typed < 20 || (typed === 20 && freqHz(current) >= 1000);
  return freqNorm(kHz ? typed * 1000 : typed);
}

const fmtHz = (v: number) => formatFreq(freqHz(v));
const parsePercent = (typed: number) => typed / 100;

export const PEQ2Panel = memo(function PEQ2Panel({ slotId, params, lay }: { slotId: string; params: PEQ2Params; lay: Layout }) {
  return (
    <div className="peq2-panel" style={{ left: lay.graphW, width: lay.panelW, height: lay.topH }}>
      <MainColumn slotId={slotId} mainLevel={params.mainLevel} opts={params.opts} lay={lay} />
      {params.bands.map((b, k) => <BandStrip key={k} slotId={slotId} k={k} band={b} lay={lay} />)}
    </div>
  );
});

// ------------------------------------------------------------- main column
/** Automation clip names follow FL: "Param. EQ 2 (Slot 3) - Insert 1 - Band 7 level". */
function useAutoPrefix(slotId: string): string {
  return useProject((p) => {
    const loc = findFx(p, slotId);
    if (!loc) return 'Param. EQ 2';
    return `Param. EQ 2 (Slot ${loc.slot + 1}) - ${mixerTrackName(p.mixer.tracks[loc.track])}`;
  });
}

const MainColumn = memo(function MainColumn({ slotId, mainLevel, opts, lay }: {
  slotId: string; mainLevel: number; opts: PEQ2Options; lay: Layout;
}) {
  const prefix = useAutoPrefix(slotId);
  const phones = Math.max(10, Math.round(14 * lay.s));
  const capStyle = (top: number, h: number): React.CSSProperties => ({ top, height: h, lineHeight: `${h}px` });
  return (
    <div className="peq2-strip" style={{ left: lay.colX0, width: lay.colW, height: lay.topH }}>
      <div className="peq2-cap" style={capStyle(lay.tileY, lay.tileH)}>MAIN</div>
      <div className="peq2-abs" style={{ left: (lay.colW - lay.faderThick) / 2, top: lay.faderY }}>
        <Fader
          length={lay.faderLen} thickness={lay.faderThick} capLength={lay.capLen}
          value={mainLevel} min={-18} max={18} defaultValue={0} label="Main level" format={fmtDb} parse={parseDb}
          auto={{ ...pluginTargetOf(slotId, 'mainLevel'), label: `${prefix} - Main level` }}
          ticks={LEVEL_TICKS} centerLine={0.5}
          onBegin={() => store.beginGesture('Main level')} onEnd={() => store.endGesture()}
          onChange={(v) => edit(slotId, 'Main level', (p) => { p.mainLevel = Math.round(v * 100) / 100; })}
        />
      </div>
      <SoloShiftIcon slotId={slotId} opts={opts} size={phones}
        left={(lay.colW - phones) / 2} top={lay.switchY + lay.switchH / 2 - phones / 2} />
      <div className="peq2-cap" style={capStyle(lay.knob1Y, lay.knobSize)}>FREQ</div>
      <div className="peq2-cap" style={capStyle(lay.knob2Y, lay.knobSize)}>BW</div>
    </div>
  );
});

/** Headphone icon: Band solo on Shift (right-click: mode). */
function SoloShiftIcon({ slotId, opts, size, left, top }: { slotId: string; opts: PEQ2Options; size: number; left: number; top: number }) {
  const on = opts.soloOnShift;
  const hint = `Band solo on Shift: ${on ? 'on' : 'off'} (${opts.soloMode === 'bandpass' ? 'Bandpass' : 'Adaptive'} mode) - click to toggle, right-click for options`;
  return (
    <div
      className={'peq2-phones' + (on ? ' on' : '')}
      style={{ left, top, width: size, height: size }}
      onPointerDown={(e) => {
        if (e.button !== 0 || e.ctrlKey) return;
        e.preventDefault();
        e.stopPropagation();
        editOnce(slotId, 'Band solo on shift', (p) => { p.opts.soloOnShift = !p.opts.soloOnShift; });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, soloMenu(slotId, opts));
      }}
      onPointerEnter={() => setHint(hint)}
      onPointerMove={() => setHint(hint)}
      onPointerLeave={clearHint}
    >
      <svg viewBox="0 0 16 16" width={size} height={size}>
        <path d="M2.6 10.5 V8.4 A5.4 5.4 0 0 1 13.4 8.4 V10.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="1.4" y="9.2" width="3.4" height="5.4" rx="1.2" fill="currentColor" />
        <rect x="11.2" y="9.2" width="3.4" height="5.4" rx="1.2" fill="currentColor" />
      </svg>
    </div>
  );
}

// -------------------------------------------------------------- band strip
const BandStrip = memo(function BandStrip({ slotId, k, band, lay }: { slotId: string; k: number; band: PEQ2Band; lay: Layout }) {
  const n = k + 1;
  const prefix = useAutoPrefix(slotId);
  const color = PEQ2_BAND_COLORS[k];
  const def = defaultBand(k);
  const hasLevel = typeHasLevel(band.type);
  const x = lay.colX0 + n * lay.colW;
  const dim = band.type === 'off' || !band.enabled;
  const freqMenu = useMemo(() => [{ label: 'Key', submenu: keyMenu(slotId, k, band.freq) }], [slotId, k, band.freq]);
  const noLevelHint = `Band ${n} level: not used by ${PEQ2_TYPE_LABELS[band.type].toLowerCase()}`;
  return (
    <div className={'peq2-strip' + (dim ? ' dim' : '')} style={{ left: x, width: lay.colW, height: lay.topH }}>
      <TypeTile slotId={slotId} k={k} band={band} s={lay.s}
        left={(lay.colW - lay.tileW) / 2} top={lay.tileY} w={lay.tileW} h={lay.tileH} />
      <div
        className={'peq2-abs' + (hasLevel ? '' : ' peq2-disabled')}
        style={{ left: (lay.colW - lay.faderThick) / 2, top: lay.faderY }}
        onPointerEnter={hasLevel ? undefined : () => setHint(noLevelHint)}
        onPointerLeave={hasLevel ? undefined : clearHint}
      >
        <Fader
          length={lay.faderLen} thickness={lay.faderThick} capLength={lay.capLen}
          value={band.level} min={-18} max={18} defaultValue={0} label={`Band ${n} level`} format={fmtDb} parse={parseDb}
          auto={{ ...pluginTargetOf(slotId, `bands.${k}.level`), label: `${prefix} - Band ${n} level` }}
          ticks={LEVEL_TICKS} centerLine={0.5} capColor={hasLevel ? color : '#5b656c'} disabled={!hasLevel}
          onBegin={() => store.beginGesture('Band level')} onEnd={() => store.endGesture()}
          onChange={(v) => edit(slotId, 'Band level', (p) => { p.bands[k].level = Math.round(v * 100) / 100; })}
        />
      </div>
      <MuteSwitch slotId={slotId} k={k} band={band}
        left={(lay.colW - lay.switchW) / 2} top={lay.switchY} w={lay.switchW} h={lay.switchH} />
      <div className="peq2-abs" style={{ left: (lay.colW - lay.knobSize) / 2, top: lay.knob1Y }}>
        <Knob
          size={lay.knobSize} value={band.freq} defaultValue={def.freq} label={`Band ${n} frequency`}
          auto={{ ...pluginTargetOf(slotId, `bands.${k}.freq`), label: `${prefix} - Band ${n} freq` }}
          format={fmtHz} parse={typeIn(band.freq, fmtHz, (t) => parseFreq(t, band.freq))}
          arcColor={color} extraMenu={freqMenu}
          onBegin={() => store.beginGesture('Band frequency')} onEnd={() => store.endGesture()}
          onChange={(v) => edit(slotId, 'Band frequency', (p) => { p.bands[k].freq = v; })}
        />
      </div>
      <div className="peq2-abs" style={{ left: (lay.colW - lay.knobSize) / 2, top: lay.knob2Y }}>
        <Knob
          size={lay.knobSize} value={band.bw} defaultValue={def.bw} label={`Band ${n} bandwidth`}
          auto={{ ...pluginTargetOf(slotId, `bands.${k}.bw`), label: `${prefix} - Band ${n} width` }}
          format={fmtBw} parse={typeIn(band.bw, fmtBw, parsePercent)} arcColor={color}
          onBegin={() => store.beginGesture('Band bandwidth')} onEnd={() => store.endGesture()}
          onChange={(v) => edit(slotId, 'Band bandwidth', (p) => { p.bands[k].bw = v; })}
        />
      </div>
    </div>
  );
});

// ------------------------------------------------------ type/slope selector
type Zone = 'type' | 'order';

/** Shapes in a 20 x 10 box (y down). */
const SHAPES: Record<PEQ2Type, string> = {
  off: 'M5 5 H15',
  lowpass: 'M0 3 H8 Q12.5 3 15.5 10',
  bandpass: 'M1 10 Q6.5 1.5 10 1.5 Q13.5 1.5 19 10',
  highpass: 'M4.5 10 Q7.5 3 12 3 H20',
  notch: 'M0 2.5 H6 Q9 2.5 10 10 Q11 2.5 14 2.5 H20',
  lowshelf: 'M0 2 H5 C9 2 11 8 15 8 H20',
  peaking: 'M0 8.5 H5 C8 8.5 8 1.5 10 1.5 C12 1.5 12 8.5 15 8.5 H20',
  highshelf: 'M0 8 H5 C9 8 11 2 15 2 H20',
};

function TileGraphic({ type, order, w, h, color, muted }: { type: PEQ2Type; order: number; w: number; h: number; color: string; muted: boolean }) {
  const off = type === 'off';
  const ink = '#10171c';
  const x0 = w * 0.14, x1 = w * 0.86, y0 = h * 0.33, y1 = h * 0.67;
  const n = Math.abs(Math.round(order));
  const r = Math.max(0.9, h * 0.05);
  const sp = r * 3.2;
  const dotY = order > 0 ? h * 0.165 : h * 0.835; // Gentle: dots above the shape, Steep: below
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <rect x={0.5} y={0.5} width={w - 1} height={h - 1} rx={Math.max(2, w * 0.12)}
        fill={off ? '#232a2f' : color} fillOpacity={muted && !off ? 0.5 : 1}
        stroke={off ? color : 'rgba(0, 0, 0, 0.55)'} strokeOpacity={off ? 0.6 : 1} />
      {!off && <rect x={1.5} y={1.5} width={w - 3} height={(h - 3) * 0.45} rx={Math.max(1.5, w * 0.1)} fill="rgba(255, 255, 255, 0.16)" />}
      <g transform={`translate(${x0} ${y0}) scale(${(x1 - x0) / 20} ${(y1 - y0) / 10})`}>
        <path d={SHAPES[type]} fill="none" stroke={off ? color : ink} strokeWidth={1.6}
          vectorEffect="non-scaling-stroke" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      {Array.from({ length: n }, (_, i) => (
        <circle key={i} cx={w / 2 + (i - (n - 1) / 2) * sp} cy={dotY} r={r} fill={off ? color : ink} />
      ))}
    </svg>
  );
}

function TypeTile({ slotId, k, band, s, left, top, w, h }: {
  slotId: string; k: number; band: PEQ2Band; s: number; left: number; top: number; w: number; h: number;
}) {
  const drag = useRef<{ zone: Zone; y0: number; base: number; cur: number; moved: boolean } | null>(null);
  const wheelAcc = useRef(0);
  const n = k + 1;
  const hintFor = (zone: Zone, type: PEQ2Type, order: number) =>
    zone === 'type' ? `Band ${n} type: ${PEQ2_TYPE_LABELS[type]}` : `Band ${n} order: ${fmtOrder(order)}`;
  // shape in the middle, slope dots in the top and bottom rows
  const zoneAt = (el: Element, clientY: number): Zone => {
    const r = el.getBoundingClientRect();
    const t = (clientY - r.top) / Math.max(1, r.height);
    return t < 0.3 || t > 0.7 ? 'order' : 'type';
  };
  const apply = (zone: Zone, v: number) => {
    if (zone === 'type') {
      const t = PEQ2_TYPES[v];
      edit(slotId, 'Band type', (p) => { p.bands[k].type = t; });
      setHint(hintFor('type', t, band.order));
    } else {
      edit(slotId, 'Band order', (p) => { p.bands[k].order = v; });
      setHint(hintFor('order', band.type, v));
    }
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) store.endGesture();
  };
  return (
    <div
      className="peq2-tile"
      style={{ left, top, width: w, height: h }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        const zone = zoneAt(e.currentTarget, e.clientY);
        if (e.altKey) {
          const def = defaultBand(k);
          editOnce(slotId, 'Reset band type', (p) => { p.bands[k].type = def.type; p.bands[k].order = def.order; });
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        const base = zone === 'type' ? Math.max(0, PEQ2_TYPES.indexOf(band.type)) : Math.round(band.order);
        drag.current = { zone, y0: e.clientY, base, cur: base, moved: false };
        setHint(hintFor(zone, band.type, band.order));
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) {
          setHint(hintFor(zoneAt(e.currentTarget, e.clientY), band.type, band.order));
          return;
        }
        // up = next type / towards Gentle; down = previous type / towards Steep
        const steps = Math.trunc((d.y0 - e.clientY) / (STEP_PX * Math.max(0.75, s)));
        const v = d.zone === 'type' ? clamp(d.base + steps, 0, PEQ2_TYPES.length - 1) : clamp(d.base + steps, -3, 3);
        if (v === d.cur) return;
        if (!d.moved) {
          d.moved = true;
          store.beginGesture(d.zone === 'type' ? 'Band type' : 'Band order');
        }
        d.cur = v;
        apply(d.zone, v);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onPointerLeave={() => { if (!drag.current) clearHint(); }}
      onWheel={(e) => {
        const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
        wheelAcc.current += -e.deltaY * unit;
        if (Math.abs(wheelAcc.current) < 1) return;
        const dir = wheelAcc.current > 0 ? 1 : -1;
        wheelAcc.current = 0;
        const zone = zoneAt(e.currentTarget, e.clientY);
        const cur = zone === 'type' ? PEQ2_TYPES.indexOf(band.type) : Math.round(band.order);
        const v = zone === 'type' ? clamp(cur + dir, 0, PEQ2_TYPES.length - 1) : clamp(cur + dir, -3, 3);
        if (v !== cur) apply(zone, v);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu(e.clientX, e.clientY, tileMenu(slotId, band, k));
      }}
    >
      <TileGraphic type={band.type} order={band.order} w={w} h={h} color={PEQ2_BAND_COLORS[k]} muted={!band.enabled} />
    </div>
  );
}

// --------------------------------------------------------- mute/solo switch
function MuteSwitch({ slotId, k, band, left, top, w, h }: {
  slotId: string; k: number; band: PEQ2Band; left: number; top: number; w: number; h: number;
}) {
  const lastSolo = useRef(0);
  const n = k + 1;
  const state = `${band.enabled ? 'enabled' : 'muted'}${band.solo ? ', solo' : ''}`;
  const hint = `Band ${n}: ${state} - click to mute, right-click or Ctrl+click to solo`;
  const toggleSolo = () => {
    lastSolo.current = performance.now();
    editOnce(slotId, 'Band solo', (p) => { p.bands[k].solo = !p.bands[k].solo; });
  };
  const pad = 3;
  return (
    <div
      className="peq2-switch-hit"
      style={{ left: left - pad, top: top - pad, width: w + 2 * pad, height: h + 2 * pad, padding: pad }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey) toggleSolo();
        else editOnce(slotId, 'Band mute', (p) => { p.bands[k].enabled = !p.bands[k].enabled; });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (performance.now() - lastSolo.current < 600) return; // the Ctrl+click on macOS already did it
        toggleSolo();
      }}
      onPointerEnter={() => setHint(hint)}
      onPointerMove={() => setHint(hint)}
      onPointerLeave={clearHint}
    >
      <div className={'peq2-switch' + (band.enabled ? ' on' : '') + (band.solo ? ' solo' : '')} style={{ ['--c' as string]: PEQ2_BAND_COLORS[k] }} />
    </div>
  );
}
