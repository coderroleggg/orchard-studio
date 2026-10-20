// Granulizer editor (FL: Fruity Granulizer, SynthPanel 392 x 429), at FL's form coordinates: the
// GRAINS panel (ATTACK, HOLD, GR. SPACING, WAVE SPACING wheels), EFFECTS (PAN, DEPTH, SPEED, RAND),
// TRANSIENTS (HOLD, the source selector OFF / USE REGIONS / DETECT), TIME (START, LOOP, TEMPO
// LOCKED, the HOLD button, the KEY TO combo) and the waveform display with the open button.
// Colours from the form (#454b4f panel, #4c5256 groups) and FL's editor thumbnail; original drawing.
// The audio comes from a drop (OS files or the Browser's samples), the open button or the window
// menu; it is kept in the project's sample pool (state key "sample").

import { useEffect, useRef, useState } from 'react';
import {
  AnimatedDisplay, Check, CheckView, FxPanel, Label, TextButton, Wheel, useFxEdit, useFxEditor, useFxMonitor, useFxView, useParam,
} from '../../kit';
import type { FxEditorModule } from '../../registry';
import { openMenu, type MenuItem } from '../../../widgets/ContextMenu';
import { setHint, clearHint } from '../../../hint';
import { pickFiles } from '../bassdrum/flimport';
import {
  TRANSIENT_MODES, TRIGGER_HINTS, TRIGGER_MODES, granulizerState, type GranulizerState,
} from '../../../../model/gen/plugins/granulizer/state';
import { audioOf, ensureDetected, loadFile, loadPool, onSamplesChanged, transientsOf, type Audio } from './ops';

const W = 392;
const H = 429;
const COL = {
  bg: '#454b4f', panel: '#4c5256', title: '#aeb7bb', line: '#3e4447', label: '#cdd3d7', dim: '#8c969b',
  scope: '#1b2125', wave: '#c8d0d4', center: '#3a4247', marker: '#f0903c', cursor: '#ffe9a0', combo: '#262b2f',
};

/** Re-render when pool samples finish loading. */
function useSamplesVersion(): number {
  const [v, setV] = useState(0);
  useEffect(() => onSamplesChanged(() => setV((x) => x + 1)), []);
  return v;
}

/** A group (FL's TVectorPanel with its title). */
function Group({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title?: string; children?: React.ReactNode }) {
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h, background: COL.panel, borderRadius: 2, boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.07), inset 0 0 0 1px rgba(0,0,0,0.18)' }}>
      {title && (
        <>
          <div className="fxk-abs" style={{ left: 7, top: 3, height: 14, color: COL.title, font: 'bold 10px Arial, sans-serif', letterSpacing: '0.04em', lineHeight: '14px', pointerEvents: 'none' }}>{title}</div>
          <div className="fxk-abs" style={{ left: 0, top: 19, width: w, height: 1, background: COL.line }} />
        </>
      )}
      {children}
    </div>
  );
}

/** A 56 px wheel of FL's form with its caption below. */
function GWheel({ k, x, y, caption, cw, cx }: { k: string; x: number; y: number; caption: string; cw: number; cx: number }) {
  return (
    <>
      <Wheel k={k} x={x} y={y} size={56} look="flat" color="#d4dadd" track="#2d3337" />
      <Label x={cx} y={y + 55} w={cw} h={15} size={9} bold color={COL.label}>{caption}</Label>
    </>
  );
}

/** Min / max per pixel column of frames [a, b) of the channels. */
function drawWave(g: CanvasRenderingContext2D, ch: readonly Float32Array[], a: number, b: number, y0: number, h: number, w: number, color: string): void {
  if (b <= a || !ch.length) return;
  const mid = y0 + h / 2, amp = h / 2 - 1;
  g.fillStyle = color;
  const n = b - a;
  for (let px = 0; px < w; px++) {
    const s = a + Math.floor((px * n) / w), e = Math.max(s + 1, a + Math.floor(((px + 1) * n) / w));
    let lo = 0, hi = 0;
    for (let c = 0; c < ch.length; c++) {
      const d = ch[c];
      for (let i = s; i < e && i < d.length; i++) { const v = d[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    const t = mid - Math.min(1, hi) * amp, bt = mid - Math.max(-1, lo) * amp;
    g.fillRect(px, t, 1, Math.max(1, bt - t));
  }
}

/** FL's View > Spectrum: a short-time magnitude spectrogram. */
function drawSpectrum(g: CanvasRenderingContext2D, d: Float32Array, w: number, h: number): void {
  const n = d.length;
  const N = 64;
  for (let px = 0; px < w; px++) {
    const o = Math.floor((px * n) / w);
    for (let b = 1; b < N / 2; b++) {
      let re = 0, im = 0;
      for (let i = 0; i < N && o + i < n; i++) {
        const a = (2 * Math.PI * b * i) / N;
        const x = d[o + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
        re += x * Math.cos(a); im -= x * Math.sin(a);
      }
      const m = Math.min(1, Math.sqrt(re * re + im * im) / 4);
      if (m < 0.02) continue;
      g.fillStyle = `rgba(200,208,212,${m})`;
      g.fillRect(px, h - (b / (N / 2)) * h, 1, h / (N / 2) + 1);
    }
  }
}

function GranulizerEditor() {
  const { params, slotId } = useFxEditor();
  const s: GranulizerState = granulizerState(params);
  const edit = useFxEdit();
  const view = useFxView();
  useSamplesVersion();
  const audio: Audio | null = audioOf(s);
  const cursors = useRef<number[]>([]);
  useFxMonitor(slotId, (d) => { cursors.current = Array.isArray(d.pos) ? (d.pos as number[]) : []; });
  const hold = useParam('holdSound');

  // the DETECT source needs the transients of the loaded audio (kept in the state for the engine)
  useEffect(() => { ensureDetected(slotId); }, [slotId, s.sample, s.trans, audio !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const onDrop = (e: React.DragEvent) => {
    const id = e.dataTransfer.getData('text/x-orchard-sample');
    if (id) { e.preventDefault(); loadPool(slotId, id); return; }
    const f = e.dataTransfer.files?.[0];
    if (f) { e.preventDefault(); void loadFile(slotId, f); }
  };
  const open = () => { void pickFiles('audio/*,.wav').then((fs) => fs[0] && loadFile(slotId, fs[0])); };

  const keyToMenu = (e: React.PointerEvent) => {
    e.stopPropagation();
    openMenu(e.clientX, e.clientY, TRIGGER_MODES.map((m, i): MenuItem => ({
      label: m, hint: TRIGGER_HINTS[i], radio: true, checked: s.trigger === i, onClick: () => edit('Key to', (d) => { d.trigger = i; if (i === 3 && d.trans === 0) d.trans = 2; }),
    })));
  };

  const trans = transientsOf(s);
  const frame = (g: CanvasRenderingContext2D, w: number, h: number) => {
    g.fillStyle = COL.scope;
    g.fillRect(0, 0, w, h);
    if (!audio) {
      g.fillStyle = COL.dim; g.font = '11px Arial'; g.textAlign = 'center';
      g.fillText('Drop a sample here or use the load button', w / 2, h / 2 + 4);
      return;
    }
    const ch = audio.channels;
    const total = ch[0].length;
    if (s.view === 1) drawSpectrum(g, ch[0], w, h);
    else if (s.view === 2 && ch.length > 1) {
      drawWave(g, [ch[0]], 0, total, 0, h / 2, w, COL.wave);
      drawWave(g, [ch[1]], 0, total, h / 2, h / 2, w, COL.wave);
    } else drawWave(g, ch, 0, total, 0, h, w, COL.wave);
    g.fillStyle = COL.center;
    g.fillRect(0, Math.floor(h / 2), w, 1);
    g.fillStyle = COL.marker;
    for (const p of trans) g.fillRect(Math.floor((p / total) * w), 0, 1, h);
    g.fillStyle = COL.cursor;
    for (const c of cursors.current) g.fillRect(Math.floor(Math.min(1, Math.max(0, c)) * w), 0, 1, h);
  };

  return (
    <FxPanel width={W} height={H} style={{ background: COL.bg }}>
      <div className="fxk-abs" style={{ left: 0, top: 0, width: W, height: H }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-orchard-sample') || e.dataTransfer.types.includes('Files')) e.preventDefault(); }}
        onDrop={onDrop}>
        <Group x={6} y={6} w={380} h={99} title="GRAINS">
          <GWheel k="attack" x={19} y={24} caption="ATTACK" cx={28} cw={38} />
          <GWheel k="hold" x={83} y={24} caption="HOLD" cx={96} cw={30} />
          <GWheel k="spacing" x={149} y={24} caption="GR. SPACING" cx={145} cw={65} />
          <GWheel k="wave" x={218} y={24} caption="WAVE SPACING" cx={210} cw={72} />
          <div className="fxk-abs" style={{ left: 299, top: 21, width: 71, height: 66, background: '#4a4742', borderRadius: 2, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.25)', pointerEvents: 'none' }}>
            <svg width="71" height="66" viewBox="0 0 71 66">
              {[[14, 38, 3], [24, 30, 4.5], [35, 36, 3.5], [46, 28, 5], [57, 34, 3], [30, 44, 2.5], [51, 44, 2.5]].map(([cx, cy, r], i) => <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke="#9a9488" strokeWidth="1" opacity={0.8} />)}
              <text x="35.5" y="17" textAnchor="middle" fontFamily="Arial, sans-serif" fontWeight="bold" fontSize="10" fill="#bcb6aa" letterSpacing="0.6">GRANULIZER</text>
            </svg>
          </div>
        </Group>
        <Group x={6} y={112} w={380} h={99} title="EFFECTS">
          <GWheel k="stereo" x={19} y={24} caption="PAN" cx={36} cw={22} />
          <GWheel k="depth" x={83} y={24} caption="DEPTH" cx={93} cw={36} />
          <GWheel k="speed" x={149} y={24} caption="SPEED" cx={159} cw={36} />
          <GWheel k="random" x={218} y={24} caption="RAND" cx={228} cw={36} />
        </Group>
        <Group x={6} y={218} w={184} h={99} title="TRANSIENTS">
          <GWheel k="transHold" x={19} y={24} caption="HOLD" cx={29} cw={36} />
          <div className="fxk-abs" style={{ left: 95, top: 27, width: 84, height: 51, background: COL.combo, borderRadius: 2, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)', overflow: 'hidden' }}
            onPointerEnter={() => setHint('Transients source')} onPointerLeave={clearHint}>
            {TRANSIENT_MODES.map((m, i) => (
              <div key={m} className="fxk-abs" style={{ left: 0, top: i * 17, width: 84, height: 17, color: s.trans === i ? '#f2f5f7' : '#8c969b', background: s.trans === i ? '#3f484d' : 'transparent', font: 'bold 9px Arial, sans-serif', textAlign: 'center', lineHeight: '17px', cursor: 'default' }}
                onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); edit('Transients source', (d) => { d.trans = i; }); } }}>{m}</div>
            ))}
          </div>
        </Group>
        <Group x={196} y={218} w={190} h={99} title="TIME">
          <GWheel k="start" x={18} y={24} caption="START" cx={29} cw={34} />
          <Check k="loop" x={42} y={4} w={53} h={14} caption="LOOP" color="#f0903c" />
          <CheckView x={90} y={4} w={97} h={14} caption="TEMPO LOCKED" on={s.tempoLocked} hint="Match song tempo" color="#f0903c"
            onToggle={() => edit('Tempo locked', (d) => { d.tempoLocked = !s.tempoLocked; })} />
          <TextButton x={116} y={35} w={61} h={25} active={hold.value > 0} hint="Hold sound"
            onClick={() => { hold.control.onBegin?.(); hold.set(hold.value > 0 ? 0 : 1); hold.control.onEnd?.(); }}>HOLD</TextButton>
          <div className="fxk-abs" style={{ left: 112, top: 72, width: 69, height: 23, background: COL.combo, borderRadius: 3, boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.3)', color: '#e4e8ea', font: 'bold 11px Arial, sans-serif', lineHeight: '23px', paddingLeft: 7, boxSizing: 'border-box', cursor: 'default' }}
            onPointerEnter={() => setHint(`Trigger mode: ${TRIGGER_HINTS[s.trigger]}`)} onPointerLeave={clearHint}
            onPointerDown={(e) => { if (e.button === 0) keyToMenu(e); }}>
            {TRIGGER_MODES[s.trigger]}
            <span className="fxk-abs" style={{ right: 6, top: 9, width: 0, height: 0, borderLeft: '4px solid transparent', borderRight: '4px solid transparent', borderTop: '5px solid #aeb7bb' }} />
          </div>
          <Label x={70} y={79} w={38} h={15} size={9} bold color={COL.label}>KEY TO</Label>
        </Group>
        <div className="fxk-abs" style={{ left: 6, top: 324, width: 380, height: 99, background: COL.panel, borderRadius: 2 }}>
          <AnimatedDisplay x={0} y={-1} w={380} h={99} frame={frame}
            onContextMenu={(e) => { e.preventDefault(); sampleMenu(e.clientX, e.clientY); }} />
          <div className="fxk-abs" style={{ left: 358, top: 2, width: 19, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'default' }}
            onPointerEnter={() => setHint('Load sample file...')} onPointerLeave={clearHint}
            onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); open(); } }}>
            <svg width="16" height="12" viewBox="0 0 16 12"><path d="M1 2 H5.5 L7 3.5 H15 V11 H1 Z" fill="none" stroke="#dfe3ea" strokeWidth="1.2" /></svg>
          </div>
        </div>
      </div>
    </FxPanel>
  );

  function sampleMenu(x: number, y: number): void {
    openMenu(x, y, [
      { label: 'Load sample...', onClick: open },
      { separator: true },
      { label: 'Spectrum view', checked: s.view === 1, onClick: () => view('View', (d) => { d.view = s.view === 1 ? 0 : 1; }) },
      { label: 'Multichannel waveform view', checked: s.view === 2, onClick: () => view('View', (d) => { d.view = s.view === 2 ? 0 : 2; }) },
    ]);
  }
}

export const editor: FxEditorModule = {
  id: 'granulizer',
  Editor: GranulizerEditor,
  menu: (slotId) => [
    { label: 'Load sample...', onClick: () => { void pickFiles('audio/*,.wav').then((fs) => fs[0] && loadFile(slotId, fs[0])); } },
  ],
};
