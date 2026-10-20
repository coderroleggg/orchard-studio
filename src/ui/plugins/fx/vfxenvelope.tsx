// VFX Envelope editor (FL: 768 x 400). Articulator buttons 1-16 (8 + 24i, 8),
// target tabs Velocity / Pitch / Pan / Mod X / Mod Y (TargetSelect 483,11),
// and on the control panel (ctrlPanel 8,41 752x297): the articulator's note
// colour and key range (Low / High), MODE (Envelope / LFO part of the
// editor), BASE / ENV / LFO level knobs, and FL's envelope editor (MEnvEditor
// 0,44 752x253) with its knob strip: the "activate" switch, ATT / DEC / SUS /
// REL with TEMPO / GLOBAL (Envelope part) or SPD / TNS / SKW / PW with GLOBAL
// (LFO part). D and S mark the decay (loop start) and sustain (loop end)
// points; a point's menu sets them and the loop.

import { useRef } from 'react';
import { FxPanel, Label, Wheel, useFxEdit, useFxEditor, useFxView } from '../kit';
import type { FxEditorModule } from '../registry';
import { store } from '../../../store';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { clearHint, setHint } from '../../hint';
import {
  ARTICULATORS, ENV_TARGETS, envKey, lfoCyclesPerBeat, normalizeArticulators, type Articulator, type EnvField, type EnvTarget,
} from '../../../model/fx/plugins/vfxenvelope';
import { keyText } from '../../../model/fx/plugins/vfx/notes';
import { lfoWave } from '../../../engine/effects/plugins/vfxenvelope';
import { EnvEdit, type EnvView, type Pts } from './vfx/EnvEdit';
import { CANVAS_FONT, LedSwitchView, SheetTabs, VfxTitle } from './vfx/common';

const NOTE_BOX = [
  '#b8f0bf', '#b8eccb', '#b8e7d7', '#b8e2e2', '#b8dcf0', '#c5d3ec', '#d2cae7', '#dfc2e2',
  '#ecb9dd', '#f0c3cb', '#f5ccbf', '#f8d6b5', '#fbe1aa', '#ede2ae', '#dde5b3', '#cbe8b9',
];

function NoteBox({ x, y, value, label, onChange }: { x: number; y: number; value: number; label: string; onChange: (v: number) => void }) {
  const drag = useRef<{ y: number; v: number } | null>(null);
  return (
    <div className="fxk-abs vfx-notebox" style={{ left: x, top: y, width: 48, height: 25 }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { y: e.clientY, v: value };
        store.beginGesture(label);
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) { setHint(`${label}: ${keyText(value)}`); return; }
        const v = Math.max(0, Math.min(131, Math.round(d.v + (d.y - e.clientY) / 4)));
        if (v !== value) onChange(v);
        setHint(`${label}: ${keyText(v)}`);
      }}
      onPointerUp={() => { if (drag.current) { drag.current = null; store.endGesture(); } }}
      onWheel={(e) => { e.stopPropagation(); onChange(Math.max(0, Math.min(131, value + (e.deltaY < 0 ? 1 : -1)))); }}
      onPointerLeave={clearHint}>
      <span>{keyText(value)}</span>
      <svg width="5" height="12" viewBox="0 0 5 12" style={{ position: 'absolute', right: 3, top: 6 }}><path d="M0.5 4.5 L2.5 1.5 L4.5 4.5 M0.5 7.5 L2.5 10.5 L4.5 7.5" stroke="rgba(255,255,255,0.55)" fill="none" /></svg>
    </div>
  );
}

function EnvelopeEditor() {
  const { params } = useFxEditor();
  const edit = useFxEdit();
  const writeView = useFxView();
  const arts = normalizeArticulators(params.arts);
  const art = Math.max(0, Math.min(ARTICULATORS - 1, Math.round(Number(params.art ?? 0)) || 0));
  const tgi = Math.max(0, Math.min(4, Math.round(Number(params.target ?? 0)) || 0));
  const mode = Number(params.mode ?? 0) === 1 ? 1 : 0;
  const enable = Number(params.enable ?? 1) >= 0.5;
  const ar = arts[art];
  const t = ar.targets[tgi];
  const setUi = (patch: Record<string, number>) => writeView('Envelope view', (p) => { Object.assign(p, patch); });
  const editArts = (label: string, f: (as: Articulator[]) => void, mergeKey?: string) => edit(label, (p) => {
    const as = normalizeArticulators(p.arts);
    f(as);
    p.arts = as;
  }, mergeKey);
  const editTarget = (label: string, f: (x: EnvTarget) => EnvTarget, mergeKey?: string) => editArts(label, (as) => { as[art].targets[tgi] = f(as[art].targets[tgi]); }, mergeKey);
  const k = (f: EnvField) => envKey(art, tgi, f);
  const pts = mode === 0 ? t.env : t.lfo;
  const length = Math.max(4, Math.ceil(pts[pts.length - 1].pos * 1.25 * 4) / 4);
  const markers = mode === 0 ? { loop: t.loop, dec: t.dec, sus: t.sus } : { loop: t.lfoLoop, dec: t.lfoDec, sus: t.lfoSus };
  const setMarkers = (m: Partial<{ loop: boolean; dec: number; sus: number }>) => editTarget('Envelope markers', (x) => (mode === 0
    ? { ...x, ...('loop' in m ? { loop: !!m.loop } : {}), ...('dec' in m ? { dec: m.dec! } : {}), ...('sus' in m ? { sus: m.sus! } : {}) }
    : { ...x, ...('loop' in m ? { lfoLoop: !!m.loop } : {}), ...('dec' in m ? { lfoDec: m.dec! } : {}), ...('sus' in m ? { lfoSus: m.sus! } : {}) }));

  const drawBg = (g: CanvasRenderingContext2D, v: EnvView) => {
    g.fillStyle = '#434b5d';
    g.fillRect(0, 0, v.w, v.h);
    // beat grid
    for (let b = Math.ceil(v.v0 * 4) / 4; b <= v.v1; b += 0.25) {
      const xx = Math.round(v.X(b)) + 0.5;
      g.fillStyle = Math.abs(b - Math.round(b)) < 1e-6 ? '#4f5c6a' : '#485264';
      g.fillRect(xx, 0, 1, v.h);
    }
    for (let i = 1; i < 8; i++) { g.fillStyle = i === 4 ? '#4f5c6a' : '#485264'; g.fillRect(0, Math.round(v.Y(i / 8)) + 0.5, v.w, 1); }
    if (mode === 1) {
      // LFO wave preview (faint) scaled by the amount envelope
      const cpb = lfoCyclesPerBeat(Number(params[k('LfoSpd')] ?? 40898));
      const tn = Number(params[k('LfoTns')] ?? 0) / 128, sk = Number(params[k('LfoSkw')] ?? 0) / 128, pw = Number(params[k('LfoPw')] ?? 0) / 112;
      g.beginPath();
      for (let i = 0; i <= v.w; i++) {
        const pos = v.v0 + ((v.v1 - v.v0) * i) / v.w;
        const yv = 0.5 + 0.45 * lfoWave(pos * cpb, tn, sk, pw);
        if (i === 0) g.moveTo(i, v.Y(yv)); else g.lineTo(i, v.Y(yv));
      }
      g.strokeStyle = 'rgba(159,205,170,0.28)';
      g.lineWidth = 1;
      g.stroke();
    }
  };
  const drawMarkers = (g: CanvasRenderingContext2D, v: EnvView) => {
    g.font = `bold 10px ${CANVAS_FONT}`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const mark = (i: number, ch: string) => {
      if (i < 0 || i >= pts.length) return;
      const xx = Math.round(v.X(pts[i].pos)) + 0.5;
      g.fillStyle = 'rgba(235,240,245,0.85)';
      g.fillRect(xx - 0.5, 0, 1, v.h);
      g.fillStyle = '#c9d0db';
      g.beginPath();
      g.moveTo(xx - 6, v.h - 14); g.lineTo(xx + 6, v.h - 14); g.lineTo(xx + 6, v.h - 4); g.lineTo(xx, v.h); g.lineTo(xx - 6, v.h - 4); g.closePath();
      g.fill();
      g.fillStyle = '#2b3240';
      g.fillText(ch, xx, v.h - 8.5);
    };
    mark(markers.dec, markers.loop ? 'L' : 'D');
    mark(markers.sus, 'S');
  };

  const strip = mode === 0
    ? [['Att', 'ATT'], ['Dec', 'DEC'], ['Sus', 'SUS'], ['Rel', 'REL']] as [EnvField, string][]
    : [['LfoSpd', 'SPD'], ['LfoTns', 'TNS'], ['LfoSkw', 'SKW'], ['LfoPw', 'PW']] as [EnvField, string][];
  const ENV_Y = 85, ENV_H = 253, STRIP_Y = ENV_Y + ENV_H - 32;

  return (
    <FxPanel width={768} height={400} className="vfx-cond" style={{ background: '#3e474c' }}>
      {Array.from({ length: ARTICULATORS }, (_, i) => (
        <div key={i} className={'fxk-abs vfx-artbtn' + (i === art ? ' on' : '')} style={{ left: 8 + i * 24, top: 8, width: 20, height: 24 }}
          onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); setUi({ art: i }); } }}
          onPointerEnter={() => setHint('Articulator number')} onPointerLeave={clearHint}>{i + 1}</div>
      ))}
      <div className="fxk-abs" style={{ left: 8, top: 41, width: 752, height: 297, background: '#444b4f', borderRadius: 3 }} />
      <SheetTabs x={483} y={11} h={30} value={tgi} onChange={(i) => setUi({ target: i })}
        look={{ on: '#444b4f', off: '#3a4247', onText: '#4fd4ff', offText: '#d5dbde', font: '15px var(--font-ui)', slant: 12, line: '#353d42' }}
        tabs={[{ label: 'Velocity', w: 72 }, { label: 'Pitch', w: 48 }, { label: 'Pan', w: 38 }, { label: 'Mod X', w: 52 }, { label: 'Mod Y', w: 52 }]} />
      <Label x={16} y={51} w={32} h={23} size={12} color="#e3e8ea" style={{ textTransform: 'none' }}>Color</Label>
      <div className="fxk-abs vfx-colorbtn" style={{ left: 56, top: 51, width: 32, height: 24, background: NOTE_BOX[ar.color] }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          openMenu(e.clientX, e.clientY, Array.from({ length: 16 }, (_, c) => ({ label: `Color ${c + 1}`, radio: true, checked: c === ar.color, onClick: () => editArts('Articulator color', (as) => { as[art].color = c; }) } as MenuItem)));
        }}
        onPointerEnter={() => setHint('Note color')} onPointerLeave={clearHint}>{ar.color + 1}</div>
      <Label x={96} y={51} w={24} h={23} size={12} color="#e3e8ea" style={{ textTransform: 'none' }}>Low</Label>
      <NoteBox x={128} y={51} value={ar.low} label="Low note" onChange={(v) => editArts('Low note', (as) => { as[art].low = v; if (as[art].high < v) as[art].high = v; })} />
      <Label x={176} y={51} w={32} h={23} size={12} color="#e3e8ea" style={{ textTransform: 'none' }}>High</Label>
      <NoteBox x={216} y={51} value={ar.high} label="High note" onChange={(v) => editArts('High note', (as) => { as[art].high = v; if (as[art].low > v) as[art].low = v; })} />
      <Label x={401} y={51} w={36} h={23} size={12} color="#e3e8ea" style={{ textTransform: 'none' }}>MODE</Label>
      <div className="fxk-abs vfx-combo" style={{ left: 441, top: 51, width: 72, height: 23, background: '#2c3337', color: '#e3e8ea', borderRadius: 2, fontSize: 12, boxShadow: 'inset 0 0 0 1px #20262a' }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          openMenu(r.left, r.bottom, ['Envelope', 'LFO'].map((m, i) => ({ label: m, radio: true, checked: i === mode, onClick: () => setUi({ mode: i }) } as MenuItem)));
        }}
        onPointerEnter={() => setHint('Articulator part')} onPointerLeave={clearHint}>
        <span className="vfx-combo-text">{mode === 0 ? 'Envelope' : 'LFO'}</span>
        <svg className="vfx-combo-arrow" width="7" height="10" viewBox="0 0 7 10"><path d="M0.5 0.5 L6.5 5 L0.5 9.5 Z" fill="#8d979c" /></svg>
      </div>
      {([['Base', 'BASE', 561], ['Env', 'ENV', 625], ['Lfo', 'LFO', 689]] as [EnvField, string, number][]).map(([f, cap, lx]) => (
        <div key={f}>
          <Label x={lx} y={51} w={28} h={23} size={12} color="#e3e8ea" style={{ textTransform: 'none' }}>{cap}</Label>
          <Wheel key={`${f}${art}${tgi}`} k={k(f)} x={lx + 32} y={49} size={28} look="flat" color="#ffad3a" track="#2b3135" />
        </div>
      ))}
      <EnvEdit key={`${art}-${tgi}-${mode}`} x={8} y={ENV_Y} w={752} h={ENV_H} points={pts} length={length} color="#9fcdaa" fill="rgba(159,205,170,0.12)"
        grid={1 / 16} freeEnd bottomLeft={232}
        defaultPoints={mode === 0 ? (tgi === 0 ? [{ pos: 0, value: 0, tension: 0, mode: 'single' }, { pos: 0.75, value: 1, tension: 0.2, mode: 'single' }, { pos: 2.25, value: 0.5, tension: 0.2, mode: 'single' }, { pos: 2.5, value: 0, tension: 0.2, mode: 'single' }] : [{ pos: 0, value: 0.5, tension: 0, mode: 'single' }, { pos: 0.25, value: 0.5, tension: 0.2, mode: 'single' }]) : [{ pos: 0, value: 0, tension: 0, mode: 'single' }, { pos: 0.25, value: 0, tension: 0, mode: 'single' }]}
        deps={[markers.dec, markers.sus, markers.loop, mode, params[k('LfoSpd')], params[k('LfoTns')], params[k('LfoSkw')], params[k('LfoPw')]]}
        drawBackground={drawBg} drawOverlay={drawMarkers}
        hint={(pos, val) => `${pos.toFixed(2)} beats: ${Math.round(val * 100)}%`}
        pointMenuExtra={(i) => [
          { separator: true },
          { label: 'Decay / loop start (D)', checked: markers.dec === i, onClick: () => setMarkers({ dec: markers.dec === i ? -1 : i }) },
          { label: 'Sustain / loop end (S)', checked: markers.sus === i, onClick: () => setMarkers({ sus: markers.sus === i ? -1 : i }) },
          { label: 'Loop between D and S', checked: markers.loop, onClick: () => setMarkers({ loop: !markers.loop }) },
          { separator: true },
        ]}
        onChange={(np: Pts, label) => {
          // keep the markers on their points when points are added / deleted
          const remap = (idx: number) => {
            if (idx < 0) return idx;
            const p = pts[idx];
            const j = np.findIndex((q) => q.pos === p.pos && q.value === p.value);
            return j >= 0 ? j : Math.min(idx, np.length - 1);
          };
          editTarget(label, (x) => (mode === 0
            ? { ...x, env: np, dec: np.length === pts.length ? x.dec : remap(x.dec), sus: np.length === pts.length ? x.sus : remap(x.sus) }
            : { ...x, lfo: np, lfoDec: np.length === pts.length ? x.lfoDec : remap(x.lfoDec), lfoSus: np.length === pts.length ? x.lfoSus : remap(x.lfoSus) }));
        }} />
      <div className="fxk-abs" style={{ left: 8, top: STRIP_Y, width: 232, height: 32, background: '#373f50', borderTop: '1px solid #2c3343' }} />
      <div className={'fxk-abs vfx-radio' + (t.on ? ' on' : '')} style={{ left: 14, top: STRIP_Y + 9, width: 14, height: 14 }}
        onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); editTarget(t.on ? 'Deactivate envelope' : 'Activate envelope', (x) => ({ ...x, on: !x.on })); } }}
        onPointerEnter={() => setHint(`${ENV_TARGETS[tgi].name} envelope: ${t.on ? 'active' : 'off'} - click to switch`)} onPointerLeave={clearHint} />
      {strip.map(([f, cap], i) => (
        <div key={f}>
          <Wheel key={`${f}${art}${tgi}`} k={k(f)} x={34 + i * 32} y={STRIP_Y + 2} size={22} look="flat" color="#d8dee8" track="#2a3140" />
          <Label x={30 + i * 32} y={STRIP_Y + 23} w={30} h={9} size={7.5} color="#c8d0dc">{cap}</Label>
        </div>
      ))}
      <LedSwitchView x={166} y={STRIP_Y + 2} w={68} h={13} caption="TEMPO" color="#d8dee8" align="left" on={mode === 0 ? t.tempo : false}
        hint={mode === 0 ? 'Tempo-based envelope (beats instead of seconds)' : 'The LFO follows the tempo'}
        onToggle={() => { if (mode === 0) editTarget('Envelope tempo', (x) => ({ ...x, tempo: !x.tempo })); }} />
      <LedSwitchView x={166} y={STRIP_Y + 17} w={68} h={13} caption="GLOBAL" color="#d8dee8" align="left" on={mode === 0 ? t.global : t.lfoGlobal}
        hint={mode === 0 ? 'Global envelope' : 'Global LFO (phase follows the song, not the note)'}
        onToggle={() => editTarget('Global', (x) => (mode === 0 ? { ...x, global: !x.global } : { ...x, lfoGlobal: !x.lfoGlobal }))} />
      <VfxTitle y={344} w={768} h={56} name="Envelope" />
      <LedSwitchView x={680} y={371} w={82} h={21} caption="Enable" color="#a6f04c" on={enable} hint="Enable plugin processing"
        onToggle={() => edit(enable ? 'Disable' : 'Enable', (p) => { p.enable = enable ? 0 : 1; })} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'vfxenvelope', Editor: EnvelopeEditor };
