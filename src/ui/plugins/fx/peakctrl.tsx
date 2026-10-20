// Peak Controller editor (FL: Fruity Peak Controller, 521 x 209): Peak and LFO
// panels, the scrolling output graph (orange Peak, green LFO, white Peak+LFO
// over the input level, beat bands, current value) and the Ramp / Mute switches.

import { useRef } from 'react';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useFxState, useParam } from '../kit';
import { editFx } from '../../../store/actions';
import { openMenu, type MenuItem } from '../../widgets/ContextMenu';
import { setHint, clearHint } from '../../hint';
import { FlKnob, KnobLabel, LedSwitch, SoberPanel } from './controllers/kit';
import { LFO_SHAPES } from '../../../model/fx/plugins/peakctrl';
import type { FxEditorModule } from '../registry';

const ORANGE = '#ffc33e';
const LIME = '#d9ff3f';
const HIST = 760;

/** Which envelopes the graph shows: all, or one in isolation while its knobs are held. */
let isolate: 'all' | 'peak' | 'lfo' = 'all';

function ShapeIcon({ shape }: { shape: number }) {
  const w = 30, h = 18;
  let d = '';
  for (let i = 0; i <= 40; i++) {
    const x = i / 40;
    let v: number;
    switch (shape) {
      case 0: v = Math.sin(2 * Math.PI * x); break;
      case 1: v = x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4; break;
      case 2: v = x < 0.5 ? 1 : -1; break;
      case 3: v = -1 + 2 * x; break;
      default: v = [0.2, -0.6, 0.8, -0.2, 0.5, -0.9, 0.1, 0.7][Math.min(7, Math.floor(x * 8))]; break;
    }
    const px = 2 + x * (w - 4), py = h / 2 - v * (h / 2 - 2);
    if (shape === 2 && i > 0 && Math.abs(x - 0.5) < 0.026) d += `L${px.toFixed(1)} ${(h / 2 - (h / 2 - 2)).toFixed(1)}`;
    d += `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
  }
  return <svg width={w} height={h}><path d={d} stroke="#e2e8eb" strokeWidth={1.6} fill="none" strokeLinejoin="round" /></svg>;
}

function ShapeSelect({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const p = useParam('lfoShape');
  const v = Math.round(p.value);
  const pick = (i: number) => { p.control.onBegin?.(); p.set(i); p.control.onEnd?.(); };
  return (
    <div className="fxk-abs" style={{
      left: x, top: y, width: w, height: h, borderRadius: 3, border: '1px solid #262b2f',
      background: 'linear-gradient(180deg, #2c3236, #383e42)', display: 'flex', alignItems: 'center', paddingLeft: 6, gap: 2, cursor: 'default',
    }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        openMenu(r.left, r.bottom, LFO_SHAPES.map((s, i) => ({ label: s, checked: i === v, radio: true, onClick: () => pick(i) } as MenuItem)));
      }}
      onWheel={(e) => { e.stopPropagation(); pick((v + (e.deltaY > 0 ? 1 : 4)) % 5); }}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); p.control.onChange(p.def.def); }}
      onPointerEnter={() => setHint(`LFO shape: ${LFO_SHAPES[v]}`)} onPointerLeave={clearHint}>
      <ShapeIcon shape={v} />
      <svg width={8} height={12} style={{ marginLeft: 3 }}><path d="M1 1 L7 6 L1 11 Z" fill="#6f777c" /></svg>
    </div>
  );
}

interface Hist { lv: Float32Array; pk: Float32Array; lf: Float32Array; sm: Float32Array; bt: Float32Array; w: number; n: number; out: number; frozen: boolean }

function Graph({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { slotId } = useFxEditor();
  const st = useRef<Hist>({
    lv: new Float32Array(HIST), pk: new Float32Array(HIST), lf: new Float32Array(HIST), sm: new Float32Array(HIST), bt: new Float32Array(HIST),
    w: 0, n: 0, out: 0, frozen: false,
  });
  useFxMonitor(slotId, (d) => {
    const s = st.current;
    if (s.frozen) return;
    const lv = d.lv as number[] | undefined;
    if (!lv) return;
    const pk = d.pk as number[], lf = d.lf as number[], sm = d.sm as number[], bt = d.bt as number[];
    for (let i = 0; i < lv.length; i++) {
      const j = s.w;
      s.lv[j] = lv[i]; s.pk[j] = pk[i]; s.lf[j] = lf[i]; s.sm[j] = sm[i]; s.bt[j] = bt[i];
      s.w = (j + 1) % HIST;
      s.n = Math.min(HIST, s.n + 1);
    }
    s.out = Number(d.out) || 0;
  });
  return (
    <AnimatedDisplay x={x} y={y} w={w} h={h}
      onPointerDown={(e) => { if (e.button === 0) st.current.frozen = !st.current.frozen; }}
      frame={(g, W, H) => {
        const s = st.current;
        const per = HIST / W; // records per pixel
        const at = (k: number) => (s.w - s.n + k + HIST * 2) % HIST; // k-th oldest of the n records
        const first = Math.max(0, s.n - HIST);
        // beat bands
        g.fillStyle = '#4d5a5d';
        g.fillRect(0, 0, W, H);
        g.fillStyle = '#525f61';
        for (let px = 0; px < W; px++) {
          const k = Math.floor((px - (W - s.n / per)) * per);
          if (k < first || k >= s.n) continue;
          if (Math.floor(s.bt[at(k)]) % 2 === 1) g.fillRect(px, 0, 1, H);
        }
        g.fillStyle = '#495557';
        for (let i = 1; i < 4; i++) g.fillRect(0, Math.round((H * i) / 4), W, 1);
        const top = 3, span = H - 5;
        const line = (arr: Float32Array, color: string, lw: number) => {
          g.strokeStyle = color;
          g.lineWidth = lw;
          g.beginPath();
          let started = false;
          for (let px = 0; px < W; px++) {
            const k = Math.floor((px - (W - s.n / per)) * per);
            if (k < 0 || k >= s.n) continue;
            const v = Math.min(1.02, Math.max(0, arr[at(k)]));
            const yy = top + (1 - v) * span;
            if (started) g.lineTo(px + 0.5, yy); else { g.moveTo(px + 0.5, yy); started = true; }
          }
          g.stroke();
        };
        if (s.n > 1) {
          line(s.lv, '#374446', 1.6);
          if (isolate !== 'lfo') line(s.pk, ORANGE, 1.4);
          if (isolate !== 'peak') line(s.lf, '#c7ec3a', 1.4);
          if (isolate === 'all') line(s.sm, '#e8f6f8', 1.4);
        }
        g.font = '300 21px "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
        g.textAlign = 'right';
        g.textBaseline = 'alphabetic';
        g.fillStyle = 'rgba(30, 37, 40, 0.72)';
        g.fillText(s.out.toFixed(3), W - 6, H - 6);
      }} />
  );
}

function PeakCtrlEditor() {
  const { slotId } = useFxEditor();
  const mute = useFxState<boolean>('mute', false);
  const ramp = useFxState<boolean>('ramp', false);
  const hold = (which: 'peak' | 'lfo') => ({
    onPointerDownCapture: (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      isolate = which;
      const up = () => { isolate = 'all'; window.removeEventListener('pointerup', up, true); };
      window.addEventListener('pointerup', up, true);
    },
  });
  return (
    <FxPanel width={521} height={209} style={{ background: '#3f454a' }}>
      <SoberPanel x={7} y={7} w={188} h={83} title="Peak" tabW={46}>
        <div {...hold('peak')}>
          <FlKnob k="base" x={6} y={26} color={ORANGE} />
          <FlKnob k="vol" x={52} y={26} color={ORANGE} />
          <FlKnob k="tension" x={98} y={26} color={ORANGE} tension />
          <FlKnob k="decay" x={144} y={26} color={ORANGE} />
        </div>
        <KnobLabel x={6} y={69} w={38}>BASE</KnobLabel>
        <KnobLabel x={52} y={69} w={38}>VOL</KnobLabel>
        <KnobLabel x={95} y={69} w={44}>TENSION</KnobLabel>
        <KnobLabel x={144} y={69} w={38}>DECAY</KnobLabel>
      </SoberPanel>
      <SoberPanel x={203} y={7} w={311} h={83} title="LFO" tabW={40}>
        <div {...hold('lfo')}>
          <FlKnob k="lfoBase" x={6} y={26} color={LIME} />
          <FlKnob k="lfoVol" x={52} y={26} color={LIME} />
          <FlKnob k="lfoTension" x={98} y={26} color={LIME} tension />
          <ShapeSelect x={159} y={28} w={52} h={34} />
          <FlKnob k="lfoSpeed" x={219} y={26} color={LIME} />
          <FlKnob k="lfoPhase" x={265} y={25} size={40} color={LIME} tick />
        </div>
        <KnobLabel x={6} y={69} w={38}>BASE</KnobLabel>
        <KnobLabel x={52} y={69} w={38}>VOL</KnobLabel>
        <KnobLabel x={95} y={69} w={44}>TENSION</KnobLabel>
        <KnobLabel x={164} y={69} w={41}>SHAPE</KnobLabel>
        <KnobLabel x={219} y={69} w={38}>SPEED</KnobLabel>
        <KnobLabel x={266} y={69} w={38}>PHASE</KnobLabel>
      </SoberPanel>
      <SoberPanel x={7} y={98} w={507} h={83}>
        <Graph x={7} y={7} w={493} h={69} />
      </SoberPanel>
      <LedSwitch x={392} y={184} w={64} h={23} caption="Ramp" on={ramp} color="#ff6a3d" hint="Ramp controllers"
        onToggle={() => editFx(slotId, 'Ramp', (p) => { p.ramp = !ramp; })} />
      <LedSwitch x={461} y={184} w={54} h={23} caption="Mute" on={mute} color="#ff6a3d" hint="Mute output sound"
        onToggle={() => editFx(slotId, 'Mute', (p) => { p.mute = !mute; })} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'peakctrl', Editor: PeakCtrlEditor };
