// Vocoder editor (FL: Fruity Vocoder, 406 x 300): FREQ, ENV and MIX sections
// and the band display, every control at FL's form coordinates. The band
// display shows each band's modulator envelope and its level line; drag in it
// to draw the band levels (FL's "sliders in the view").

import { useRef } from 'react';
import * as A from '../../../../store/actions';
import { setHint, clearHint } from '../../../hint';
import {
  VOC_BANDS, VOC_ORDERS, vocBandCount, vocEdges, vocKnobHz, vocResampleLevels,
} from '../../../../model/fx/plugins/vocoder';
import { AnimatedDisplay, FxPanel, useFxEditor, useFxMonitor, useParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { BG, C, Caption, EDITOR_H, EDITOR_W, LedButton, MetalKnob, Section, TickSlider } from './widgets';

// band display geometry (BandVisual: 12, 183, 384 x 85)
const BV = { x: 12, y: 183, w: 384, h: 85 };
/** Level line: 0 dB at 68.5 px above the bottom, 0.4788 dB per pixel (from FL's screenshot and presets). */
const LV_ZERO = 68.5;
const LV_DB_PX = 0.4788;
const LV_MAX = Math.pow(10, ((BV.h - LV_ZERO) * LV_DB_PX) / 20);

function levelToY(level: number): number {
  if (!(level > 0)) return 0;
  return Math.min(BV.h, Math.max(0, LV_ZERO + (20 * Math.log10(level)) / LV_DB_PX));
}

function yToLevel(y: number): number {
  if (y <= 0.75) return 0;
  return Math.min(LV_MAX, Math.pow(10, ((Math.min(BV.h, y) - LV_ZERO) * LV_DB_PX) / 20));
}

function levelText(l: number): string {
  if (!(l > 0)) return '-inf dB';
  const db = 20 * Math.log10(l);
  return `${db > 0.05 ? '+' : ''}${db.toFixed(1)} dB`;
}

function hzText(f: number): string {
  return f >= 1000 ? `${(f / 1000).toFixed(2)} kHz` : `${Math.round(f)} Hz`;
}

/** Envelope bars: -60 .. 0 dB (a full-scale sine in the band reads 0 dB). */
function envFrac(e: number): number {
  if (!(e > 1e-6)) return 0;
  return Math.min(1, Math.max(0, (20 * Math.log10(e) + 60) / 60));
}

/** Horizontal light across the display (brightest in the middle). */
function light(u: number): number {
  return 1 - 0.5 * Math.pow(Math.abs(2 * u - 1), 1.6);
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number, k = 1): string {
  const f = (i: number) => Math.round(Math.min(255, (a[i] + (b[i] - a[i]) * t) * k));
  return `rgb(${f(0)},${f(1)},${f(2)})`;
}

function BandDisplay() {
  const { slotId, params } = useFxEditor();
  const n = vocBandCount(params);
  const levels = vocResampleLevels(Array.isArray(params.levels) ? (params.levels as number[]) : [], n);
  const st = useRef({ env: new Float32Array(128), shown: new Float32Array(128), n: 0, last: 0 });
  const drag = useRef<{ band: number; id: number } | null>(null);
  const lvRef = useRef(levels);
  lvRef.current = levels;
  useFxMonitor(slotId, (d) => {
    const b = d.bands;
    if (b && typeof b === 'object' && 'length' in b) {
      const arr = b as ArrayLike<number>;
      for (let i = 0; i < Math.min(128, arr.length); i++) st.current.env[i] = Number(arr[i]) || 0;
      st.current.n = Number(d.n) || arr.length;
    }
  });

  const bandAt = (clientX: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    const u = (clientX - r.left) / r.width;
    return Math.min(n - 1, Math.max(0, Math.floor(u * n)));
  };
  const yAt = (clientY: number, el: HTMLElement): number => {
    const r = el.getBoundingClientRect();
    return (1 - (clientY - r.top) / r.height) * BV.h;
  };
  const bandHz = (i: number): number => {
    const e = vocEdges(n, vocKnobHz(Number(params.fmin ?? 0)), vocKnobHz(Number(params.fmax ?? 65536)), Number(params.scale ?? 64) / 128);
    return Math.sqrt(Math.max(0, e[i] * e[i + 1]));
  };
  const setBands = (a: number, b: number, level: number, id: number) => {
    const lo = Math.min(a, b), hi = Math.max(a, b);
    A.editFx(slotId, 'Band levels', (p) => {
      const cur = vocResampleLevels(Array.isArray(p.levels) ? (p.levels as number[]) : [], n);
      for (let i = lo; i <= hi; i++) cur[i] = level;
      p.levels = cur;
    }, `voc-levels:${slotId}:${id}`);
    setHint(`Band ${b + 1} (${hzText(bandHz(b))}): ${levelText(level)}`);
  };

  return (
    <AnimatedDisplay x={BV.x} y={BV.y} w={BV.w} h={BV.h}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const band = bandAt(e.clientX, e.currentTarget);
        const id = Date.now();
        drag.current = { band, id };
        setBands(band, band, yToLevel(yAt(e.clientY, e.currentTarget)), id);
      }}
      onPointerMove={(e) => {
        const band = bandAt(e.clientX, e.currentTarget);
        const g = drag.current;
        if (!g) {
          setHint(`Band ${band + 1} (${hzText(bandHz(band))}): ${levelText(lvRef.current[band] ?? 1)}`);
          return;
        }
        setBands(g.band, band, yToLevel(yAt(e.clientY, e.currentTarget)), g.id);
        g.band = band;
      }}
      onPointerUp={() => { drag.current = null; }}
      frame={(g, W, H, t) => {
        const s = st.current;
        const dt = s.last ? Math.min(0.1, (t - s.last) / 1000) : 0;
        s.last = t;
        g.fillStyle = '#000';
        g.fillRect(0, 0, W, H);
        const colW = W / n;
        const gap = colW >= 8 ? 2 : colW >= 4 ? 1 : 0;
        const fall = Math.pow(10, (-24 * dt) / 20); // display fall: 24 dB/s
        const lv = lvRef.current;
        for (let i = 0; i < n; i++) {
          const x0 = Math.round(i * colW + (i === 0 ? 1 : gap / 2));
          const x1 = Math.round((i + 1) * colW - (i === n - 1 ? 1 : gap / 2));
          const w = Math.max(1, x1 - x0);
          const u = (i + 0.5) / n;
          const k = light(u);
          // column background: navy, slightly darker towards the bottom
          const grad = g.createLinearGradient(0, 0, 0, H);
          grad.addColorStop(0, mixRgb([24, 24, 70], [34, 34, 94], k));
          grad.addColorStop(1, mixRgb([22, 22, 64], [31, 31, 86], k));
          g.fillStyle = grad;
          g.fillRect(x0, 0, w, H);
          // envelope bar
          const e = s.env[i] ?? 0;
          s.shown[i] = Math.max(e, (s.shown[i] ?? 0) * fall);
          const f = envFrac(s.shown[i]);
          const bh = Math.round(f * H);
          if (bh > 0) {
            const c = Math.min(1, f / 0.5);
            const bar = g.createLinearGradient(0, H - bh, 0, H);
            bar.addColorStop(0, mixRgb([104, 104, 172], [228, 228, 252], c, 0.96 + 0.04 * k));
            bar.addColorStop(1, mixRgb([100, 100, 165], [212, 212, 236], c, 0.96 + 0.04 * k));
            g.fillStyle = bar;
            g.fillRect(x0, H - bh, w, bh);
          }
          // band level line
          const ly = Math.round(H - levelToY(lv[i] ?? 1)) - 0.5;
          g.fillStyle = mixRgb([126, 126, 190], [173, 173, 254], k);
          g.fillRect(x0, Math.min(H - 1, Math.max(0, ly - 0.5)), w, 1);
        }
      }} />
  );
}

/** FL's TPaintBoxSelector in the display: one outlined box per option. */
function BoxSelector({ x, y, w, h, options, value, onPick, hint }: {
  x: number; y: number; w: number; h: number; options: string[]; value: number; onPick: (i: number) => void; hint: string;
}) {
  const cell = (w + 1) / options.length;
  return (
    <div className="fxk-abs" style={{ left: x, top: y, width: w, height: h }} onPointerEnter={() => setHint(hint)} onPointerLeave={clearHint}>
      {options.map((o, i) => {
        const on = i === value;
        return (
          <div key={o} style={{
            position: 'absolute', left: Math.round(i * cell), top: 0, width: Math.round((i + 1) * cell) - Math.round(i * cell) - 1, height: h,
            boxSizing: 'border-box', border: `1px solid ${on ? '#9a9ad0' : '#45457a'}`, color: on ? '#ececff' : '#4f4f82',
            fontSize: 11.5, lineHeight: `${h - 2}px`, textAlign: 'center', cursor: 'default',
          }} onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onPick(i); } }}>{o}</div>
        );
      })}
    </div>
  );
}

function HoldButton() {
  const p = useParam('hold');
  const on = p.value >= 0.5;
  return (
    <div className="fxk-abs" style={{
      left: 342, top: 164, width: 51, height: 16, boxSizing: 'border-box', border: `1px solid ${on ? '#9a9ad0' : '#4b4b80'}`,
      color: on ? '#ececff' : '#525284', background: on ? 'rgba(90,90,170,0.25)' : 'transparent',
      fontSize: 11.5, lineHeight: '14px', textAlign: 'center', cursor: 'default', letterSpacing: '0.02em',
    }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); p.control.onBegin?.(); p.set(on ? 0 : 1); p.control.onEnd?.(); } }}
      onPointerEnter={() => setHint(`${p.def.name}: ${on ? 'ON' : 'OFF'}`)} onPointerLeave={clearHint}>HOLD</div>
  );
}

/** L / R boxes above the MOD and CAR sliders: click to swap the channels. */
function SwapBoxes() {
  const { slotId, params } = useFxEditor();
  const swap = !!params.swap;
  const box = (cx: number, t: string) => (
    <div style={{
      position: 'absolute', left: cx - 7, top: 0, width: 14, height: 13, boxSizing: 'border-box', border: '1px solid #c3cbd0',
      color: C.caption, fontSize: 10.5, lineHeight: '11px', textAlign: 'center',
    }}>{t}</div>
  );
  return (
    <div className="fxk-abs" style={{ left: 298, top: 17, width: 58, height: 13, cursor: 'default' }}
      onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); A.editFx(slotId, 'Swap modulator / carrier', (p) => { p.swap = !p.swap; }); } }}
      onPointerEnter={() => setHint(`Carrier / modulator location (left / right): modulator ${swap ? 'right' : 'left'}`)} onPointerLeave={clearHint}>
      {box(14, swap ? 'R' : 'L')}
      {box(45, swap ? 'L' : 'R')}
    </div>
  );
}

/** Three LCD switches: listen to the modulator, the carrier or the vocoded output. */
function ListenLcds() {
  const { slotId, params } = useFxEditor();
  const listen = typeof params.listen === 'number' ? params.listen : 2;
  const names = ['modulator', 'carrier', 'wet'];
  return (
    <div className="fxk-abs" style={{ left: 298, top: 32, width: 90, height: 10 }}
      onPointerEnter={() => setHint(`Listen to modulator / carrier / wet: ${names[listen]}`)} onPointerLeave={clearHint}>
      {[0, 1, 2].map((i) => {
        const on = i === listen;
        return (
          <div key={i} style={{
            position: 'absolute', left: i * 32 - (i === 2 ? 0 : 0), top: 1, width: 27.5, height: 8, boxSizing: 'border-box',
            border: `1px solid ${on ? '#292828' : '#2b2f33'}`,
            background: on ? 'linear-gradient(180deg, #f6963f, #e98d3b)' : 'linear-gradient(180deg, #363e46, #323a40)',
            cursor: 'default',
          }} onPointerDown={(e) => {
            if (e.button !== 0) return;
            e.stopPropagation();
            A.editFx(slotId, 'Listen', (p) => { p.listen = p.listen === i && i !== 2 ? 2 : i; });
          }} />
        );
      })}
    </div>
  );
}

function VocoderEditor() {
  const { slotId, params } = useFxEditor();
  const bandsIdx = typeof params.bands === 'number' ? params.bands : 2;
  const order = typeof params.order === 'number' ? params.order : 2;
  return (
    <FxPanel width={EDITOR_W} height={EDITOR_H} style={{ background: BG }}>
      {/* FREQ */}
      <Section x={5} y={5} w={206} h={145} />
      <Caption x={13} y={8} w={60} h={13} size={13.5} weight={500} align="left" color={C.captionDim} style={{ letterSpacing: '0.06em' }}>FREQ</Caption>
      <TickSlider k="formant" x={17} y={23} w={24} h={111} ticks={21} tickTop={11.2} tickBottom={99.8} shortTicks tickLen={7.5} />
      <Caption x={9} y={135} w={40} color={C.captionDim}>FORM</Caption>
      <MetalKnob k="fmin" x={61} y={31} />
      <Caption x={56} y={75} w={50}>MIN</Caption>
      <MetalKnob k="fmax" x={110} y={31} />
      <Caption x={105} y={75} w={50}>MAX</Caption>
      <MetalKnob k="scale" x={159} y={31} />
      <Caption x={154} y={75} w={50}>SCALE</Caption>
      <MetalKnob k="bw" x={61} y={90} />
      <Caption x={56} y={135} w={50}>BW</Caption>
      <LedButton k="invert" x={150} y={92} w={56} h={36} caption="INVERT" />
      {/* ENV */}
      <Section x={217} y={5} w={61} h={145} />
      <Caption x={217} y={8} w={61} h={13} size={13.5} weight={500} style={{ letterSpacing: '0.06em' }}>ENV</Caption>
      <MetalKnob k="att" x={229} y={31} />
      <Caption x={224} y={75} w={50}>ATT</Caption>
      <MetalKnob k="rel" x={229} y={90} />
      <Caption x={224} y={135} w={50}>REL</Caption>
      {/* MIX */}
      <Section x={284} y={5} w={116} h={145} />
      <Caption x={330} y={8} w={63} h={13} size={13.5} weight={500} align="right" color={C.captionDim} style={{ letterSpacing: '0.06em' }}>MIX</Caption>
      <SwapBoxes />
      <ListenLcds />
      <TickSlider k="modLvl" x={298} y={41} w={26} h={92} ticks={11} tickTop={11} tickBottom={80.6} />
      <TickSlider k="carLvl" x={330} y={41} w={26} h={92} ticks={11} tickTop={11} tickBottom={80.6} />
      <TickSlider k="wetLvl" x={362} y={41} w={26} h={92} ticks={11} tickTop={11} tickBottom={80.6} />
      <Caption x={291} y={135} w={40}>MOD</Caption>
      <Caption x={323} y={135} w={40}>CAR</Caption>
      <Caption x={355} y={135} w={40} color={C.captionDim}>WET</Caption>
      {/* band display */}
      <Section x={5} y={155} w={396} h={140} />
      <div className="fxk-abs" style={{ left: 10, top: 160, width: 386, height: 130, background: '#000', borderRadius: 1 }} />
      <Caption x={15} y={164} w={150} h={16} size={14.5} align="left" bold={false} color="#5d5e99" style={{ letterSpacing: '0.04em' }}>VOCODER</Caption>
      <HoldButton />
      <BandDisplay />
      <Caption x={14} y={272} w={56} h={14} size={12.5} align="left" bold={false} color="#6c6d9c" style={{ letterSpacing: '0.04em' }}>BANDS</Caption>
      <BoxSelector x={72} y={272} w={158} h={14} options={VOC_BANDS.map(String)} value={bandsIdx} hint="Number of bands"
        onPick={(i) => A.editFx(slotId, 'Number of bands', (p) => {
          const prevN = vocBandCount(p as Record<string, unknown>);
          const prev = vocResampleLevels(Array.isArray(p.levels) ? (p.levels as number[]) : [], prevN);
          p.bands = i;
          p.levels = vocResampleLevels(prev, VOC_BANDS[i]);
        })} />
      <Caption x={283} y={272} w={52} h={14} size={12.5} align="left" bold={false} color="#6c6d9c" style={{ letterSpacing: '0.04em' }}>FILTER</Caption>
      <BoxSelector x={339} y={272} w={54} h={14} options={VOC_ORDERS.map(String)} value={order - 1} hint="Filter order"
        onPick={(i) => A.editFx(slotId, 'Filter order', (p) => { p.order = i + 1; })} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = {
  id: 'vocoder',
  Editor: VocoderEditor,
  menu: (slotId) => [
    { label: 'Reset band levels', onClick: () => A.editFx(slotId, 'Reset band levels', (p) => {
      const n = vocBandCount(p as Record<string, unknown>);
      p.levels = new Array(n).fill(1);
    }) },
  ],
};
