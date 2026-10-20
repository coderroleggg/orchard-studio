// VFX Keyboard Splitter editor (FL: 941 x 388). Zone buttons 1-16 (PartSelect
// 7,7 432x39) in the zones' colours, "Zone N", the Keyboard / Velocity mapping
// switch (EnvSelect 544,7 122x39), the zone's Transpose slider and its Random
// (keyboard view) / Absolute (velocity view) switch, and FL's envelope editor
// (MEnvEditor 8,54 925x270) showing every zone's mapping in its colour with
// the current zone's envelope editable. Manual mapping (812,339): while on,
// each click on the keyboard display starts the next zone at that key (FL
// takes the keys from the preview keyboard / MIDI input, which do not reach
// effects in this clone); zone 16 or switching it off closes the last zone.

import { useRef, useState } from 'react';
import { FxPanel, Label, useFxEdit, useFxEditor, useFxView } from '../kit';
import type { FxEditorModule } from '../registry';
import { store } from '../../../store';
import { clearHint, setHint } from '../../hint';
import { KEY_SPAN, ZONES, defaultZone, normalizeZones, type SplitZone } from '../../../model/fx/plugins/vfxkeysplitter';
import { envAt, flatEnv } from '../../../model/fx/plugins/vfx/envelope';
import { keyText } from '../../../model/fx/plugins/vfx/notes';
import { EnvEdit, type EnvView, type Pts } from './vfx/EnvEdit';
import { LedSwitchView, TickSliderControl, VfxTitle } from './vfx/common';

/** Zone colours (digits / outlines), sampled from FL's screenshots. */
export const ZONE_COLORS = [
  '#ff8a9a', '#f9f871', '#84f57a', '#71f5ec', '#81b9fb', '#e98cfb', '#fe7cbd', '#ffc871',
  '#b6f665', '#6bfeae', '#6fd4ff', '#a59cff', '#ff81ea', '#fd714f', '#fff06b', '#8af27a',
];

const BLACK = new Set([1, 3, 6, 8, 10]);

function rgba(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function KeySplitterEditor() {
  const { params } = useFxEditor();
  const edit = useFxEdit();
  const writeView = useFxView();
  const zones = normalizeZones(params.zones);
  const zone = Math.min(ZONES - 1, Math.max(0, Math.round(Number(params.zone ?? 0)) || 0));
  const view = Number(params.view ?? 0) === 1 ? 1 : 0;
  const z = zones[zone];
  const col = ZONE_COLORS[zone];
  const [manual, setManual] = useState<{ zone: number; start: number } | null>(null);
  const manualRef = useRef(manual);
  manualRef.current = manual;

  const setUi = (patch: Record<string, number>) => writeView('Splitter view', (p) => { Object.assign(p, patch); });
  const editZones = (label: string, f: (zs: SplitZone[]) => void, mergeKey?: string) => edit(label, (p) => {
    const zs = normalizeZones(p.zones);
    f(zs);
    p.zones = zs;
  }, mergeKey);

  const setRange = (zs: SplitZone[], i: number, lo: number, hi: number) => {
    // keys lo..hi (inclusive) at 1, hard edges one key wide
    const a = lo / KEY_SPAN, b = hi / KEY_SPAN, s = 1 / KEY_SPAN;
    const pts: Pts = [{ pos: 0, value: lo <= 0 ? 1 : 0, tension: 0, mode: 'single' }];
    if (lo > 0) { pts.push({ pos: a - s, value: 0, tension: 0, mode: 'single' }, { pos: a, value: 1, tension: 0, mode: 'single' }); }
    if (hi < KEY_SPAN - 1) { pts.push({ pos: b, value: 1, tension: 0, mode: 'single' }, { pos: Math.min(1, b + s), value: 0, tension: 0, mode: 'single' }); }
    pts.push({ pos: 1, value: hi >= KEY_SPAN - 1 ? 1 : 0, tension: 0, mode: 'single' });
    zs[i] = { ...zs[i], key: pts.filter((p, k, arr) => k === 0 || p.pos > arr[k - 1].pos || k === arr.length - 1) };
  };

  const finishManual = (m: { zone: number; start: number }) => {
    editZones('Manual mapping', (zs) => {
      setRange(zs, m.zone, m.start, KEY_SPAN - 1);
      for (let i = m.zone + 1; i < ZONES; i++) zs[i] = { ...zs[i], key: flatEnv(0) };
    });
    setManual(null);
  };

  const drawKeyboard = (g: CanvasRenderingContext2D, v: EnvView) => {
    // every zone's keyboard mapping in its colour
    for (let i = 0; i < ZONES; i++) {
      const pts = zones[i].key;
      if (pts.every((p) => p.value <= 0)) continue;
      g.beginPath();
      g.moveTo(v.X(v.v0), v.Y(0));
      const n = Math.max(64, Math.round(v.w));
      for (let k = 0; k <= n; k++) { const pos = v.v0 + ((v.v1 - v.v0) * k) / n; g.lineTo(v.X(pos), v.Y(envAt(pts, pos))); }
      g.lineTo(v.X(v.v1), v.Y(0));
      g.closePath();
      g.fillStyle = rgba(ZONE_COLORS[i], i === zone ? 0.2 : 0.16);
      g.fill();
    }
    // key stripes (black keys darker) and octave lines
    for (let k = 0; k < KEY_SPAN; k++) {
      const x0 = v.X(k / KEY_SPAN), x1 = v.X((k + 1) / KEY_SPAN);
      if (x1 < 0 || x0 > v.w) continue;
      if (BLACK.has(k % 12)) { g.fillStyle = 'rgba(0,0,0,0.09)'; g.fillRect(x0, 0, x1 - x0, v.h); }
      if (k % 12 === 0) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(Math.round(x0), 0, 1, v.h); }
    }
    if (manualRef.current) {
      const x = v.X(manualRef.current.start / KEY_SPAN);
      g.fillStyle = 'rgba(255,255,255,0.8)';
      g.fillRect(Math.round(x), 0, 1, v.h);
    }
  };

  const drawVelocity = (g: CanvasRenderingContext2D, v: EnvView) => {
    g.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let i = 1; i < 4; i++) {
      g.beginPath(); g.moveTo(v.X(v.v0 + ((v.v1 - v.v0) * i) / 4), 0); g.lineTo(v.X(v.v0 + ((v.v1 - v.v0) * i) / 4), v.h); g.stroke();
      g.beginPath(); g.moveTo(0, v.Y(i / 4)); g.lineTo(v.w, v.Y(i / 4)); g.stroke();
    }
    for (let i = 0; i < ZONES; i++) {
      if (zones[i].key.every((p) => p.value <= 0)) continue; // unused zones
      const pts = zones[i].vel;
      g.beginPath();
      g.moveTo(v.X(v.v0), v.Y(0));
      const n = Math.max(64, Math.round(v.w));
      for (let k = 0; k <= n; k++) { const pos = v.v0 + ((v.v1 - v.v0) * k) / n; g.lineTo(v.X(pos), v.Y(envAt(pts, pos))); }
      g.lineTo(v.X(v.v1), v.Y(0));
      g.closePath();
      g.fillStyle = rgba(ZONE_COLORS[i], 0.2);
      g.fill();
    }
  };

  const transposeControl = {
    value: z.transpose, min: -48, max: 48, defaultValue: 0, step: 1, label: 'Offset (transpose)',
    format: (v: number) => `${v > 0 ? '+' : ''}${v} semitone${Math.abs(v) === 1 ? '' : 's'}`,
    onChange: (v: number) => editZones('Zone transpose', (zs) => { zs[zone] = { ...zs[zone], transpose: Math.round(v) }; }),
    onBegin: () => store.beginGesture('Zone transpose'), onEnd: () => store.endGesture(),
  };

  return (
    <FxPanel width={941} height={388} style={{ background: '#3f484d' }}>
      {Array.from({ length: ZONES }, (_, i) => {
        const on = i === zone;
        return (
          <div key={i} className="fxk-abs vfx-zone" style={{ left: 7 + i * 27, top: 7, width: 27, height: 39, background: on ? ZONE_COLORS[i] : undefined, color: on ? '#2a2f33' : ZONE_COLORS[i] }}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ zone: i }); } }}
            onPointerEnter={() => setHint(`Zone ${i + 1}`)} onPointerLeave={clearHint}>{i + 1}</div>
        );
      })}
      <Label x={446} y={7} w={96} h={39} size={19} color="#eef1f3" align="left" style={{ textTransform: 'none', fontStretch: 'condensed', paddingLeft: 4 }}>Zone {zone + 1}</Label>
      {['Keyboard', 'Velocity'].map((t, i) => (
        <div key={t} className={'fxk-abs vfx-envsel' + (view === i ? ' on' : '')} style={{ left: 544 + i * 61, top: 7, width: 61, height: 39 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ view: i }); } }}
          onPointerEnter={() => setHint('Current mapping')} onPointerLeave={clearHint}>{t}</div>
      ))}
      <Label x={672} y={10} w={56} h={17} size={12} color="#e3e8ea" align="left" style={{ textTransform: 'none', overflow: 'visible' }}>Transpose</Label>
      <TickSliderControl x={728} y={5} w={207} h={22} ticks={32} id="ksTranspose" control={transposeControl} mark="#5febff" />
      {view === 0 ? (
        <LedSwitchView x={667} y={28} w={72} h={17} caption="Random" on={z.random} color="#5febff" hint="Mapping output = probability"
          onToggle={() => editZones('Zone random', (zs) => { zs[zone] = { ...zs[zone], random: !zs[zone].random }; })} />
      ) : (
        <LedSwitchView x={667} y={28} w={72} h={17} caption="Absolute" on={z.abs} color="#5febff" hint="Override volume"
          onToggle={() => editZones('Zone absolute', (zs) => { zs[zone] = { ...zs[zone], abs: !zs[zone].abs }; })} />
      )}
      <EnvEdit key={`${zone}-${view}`} x={8} y={54} w={925} h={270}
        points={view === 0 ? z.key : z.vel} color={col}
        grid={view === 0 ? 1 / KEY_SPAN : 1 / 128}
        defaultPoints={view === 0 ? defaultZone(zone).key : flatEnv(1)}
        deps={[JSON.stringify(zones), view, manual?.start ?? -1, manual?.zone ?? -1]}
        drawBackground={view === 0 ? drawKeyboard : drawVelocity}
        hint={(pos, val) => (view === 0
          ? `${keyText(Math.min(KEY_SPAN - 1, Math.max(0, Math.floor(pos * KEY_SPAN))))}: ${Math.round(val * 100)}%${manual ? ' - click to start the next zone here' : ''}`
          : `Velocity ${Math.round(pos * 100)}%: ${z.abs ? 'output' : 'multiplier'} ${Math.round(val * 100)}%`)}
        onDisplayDown={(pos, _v, e) => {
          const m = manualRef.current;
          if (!m || view !== 0 || e.button !== 0) return false;
          const key = Math.min(KEY_SPAN - 1, Math.max(0, Math.round(pos * KEY_SPAN)));
          if (key <= m.start) return true;
          editZones('Manual mapping', (zs) => setRange(zs, m.zone, m.start, key - 1));
          const next = { zone: m.zone + 1, start: key };
          if (next.zone >= ZONES - 1) finishManual(next);
          else { setManual(next); setUi({ zone: next.zone }); }
          return true;
        }}
        onChange={(pts, label) => editZones(label, (zs) => { zs[zone] = { ...zs[zone], [view === 0 ? 'key' : 'vel']: pts }; })} />
      <VfxTitle y={332} w={941} h={56} name="Keyboard Splitter" />
      <div className={'fxk-abs vfx-manual' + (manual ? ' on' : '')} style={{ left: 812, top: 339, width: 122, height: 42 }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          if (manual) finishManual(manual);
          else { setManual({ zone: 0, start: 0 }); setUi({ zone: 0, view: 0 }); }
        }}
        onPointerEnter={() => setHint('Press keys to map (here: click the keyboard display where the next zone starts)')} onPointerLeave={clearHint}>Manual mapping</div>
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxkeysplitter', Editor: KeySplitterEditor };
