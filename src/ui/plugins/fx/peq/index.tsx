// Parametric EQ editor (FL: Fruity Parametric EQ, 240 x 350) at the
// coordinates of FL 2026's form, in the plugin's brushed-metal look: type
// spinners, level sliders, frequency read-outs, frequency and width wheels,
// the band response graph (drag: left = level / frequency, right = level /
// width of the nearest band) and the main level wheel.

import { useRef } from 'react';
import { Display, FxPanel, useParam, type BoundParam } from '../../kit';
import type { FxEditorModule } from '../../registry';
import { host } from '../../../../store';
import { magnitude, type BiquadCoefs } from '../../../../engine/dsp/biquad';
import { peqDesign, peqUsesLevel } from '../../../../engine/effects/plugins/peq';
import { PEQ_BANDS, peqFreqHz } from '../../../../model/fx/plugins/peq';
import { setHint } from '../../../hint';
import { LevelSlider, MetalKnob, TypeSpinner } from './widgets';

const COL_X = [6, 39, 72, 106, 138, 171, 204]; // frequency wheel lefts (form)
const TYPE_X = [10, 43, 76, 110, 142, 175, 208];
const LEVEL_X = [12, 45, 78, 112, 144, 177, 210];
const LABEL_X = [7, 40, 73, 107, 139, 172, 205];
const BW_X = [9, 42, 75, 109, 141, 174, 207];

interface BandView { type: number; level: number; freq: number; width: number }

function useBands(): { views: BandView[]; level: BoundParam[]; freq: BoundParam[]; width: BoundParam[] } {
  const level: BoundParam[] = [], freq: BoundParam[] = [], width: BoundParam[] = [], type: BoundParam[] = [];
  for (let b = 1; b <= PEQ_BANDS; b++) {
    /* eslint-disable react-hooks/rules-of-hooks */
    level.push(useParam(`level${b}`));
    freq.push(useParam(`freq${b}`));
    width.push(useParam(`width${b}`));
    type.push(useParam(`type${b}`));
  }
  const views = type.map((t, i) => ({ type: Math.round(t.value), level: level[i].value / 100, freq: freq[i].value, width: width[i].value }));
  return { views, level, freq, width };
}

/** Graph x (0..1) for a frequency wheel value: the axis follows the wheel mapping (10 Hz .. 16 kHz). */
const xOf = (freqWheel: number) => freqWheel / 65536;

function BandGraph({ x, y, w, h }: { x: number; y: number; w: number; h: number }) {
  const { views, level, freq, width } = useBands();
  const drag = useRef<{ band: number; right: boolean; x0: number; y0: number; l0: number; f0: number; w0: number } | null>(null);
  const coefs = useRef<BiquadCoefs[]>(Array.from({ length: PEQ_BANDS }, () => ({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 })));
  const key = JSON.stringify(views);

  const draw = (g: CanvasRenderingContext2D, W: number, H: number) => {
    const fs = host.sampleRate || 44100;
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(22,28,32,0.2)';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = 'rgba(176,190,198,0.42)';
    g.lineWidth = 1;
    g.strokeRect(0.5, 0.5, W - 1, H - 1);
    // band lines
    g.strokeStyle = 'rgba(176,190,198,0.26)';
    g.beginPath();
    for (const b of views) {
      if (b.type === 0) continue;
      const xx = Math.round(1 + xOf(b.freq) * (W - 2)) + 0.5;
      g.moveTo(xx, 1); g.lineTo(xx, H - 1);
    }
    g.stroke();
    // response
    const on = views.map((b, i) => peqDesign(coefs.current[i], b.type, b.level, b.freq, b.width, fs));
    g.strokeStyle = '#dde5e9';
    g.lineWidth = 1.1;
    g.beginPath();
    const mid = H / 2, span = H / 2 - 1.5;
    for (let px = 0; px <= W - 2; px++) {
      const f = peqFreqHz((px / (W - 2)) * 65536);
      let m = 1;
      for (let i = 0; i < PEQ_BANDS; i++) if (on[i]) m *= magnitude(coefs.current[i], Math.min(f, fs * 0.499), fs);
      const db = m > 1e-9 ? 20 * Math.log10(m) : -200;
      const yy = Math.min(H - 1, Math.max(1, mid - (db / 18) * span));
      if (px === 0) g.moveTo(px + 1, yy); else g.lineTo(px + 1, yy);
    }
    g.stroke();
  };

  const nearest = (fx: number): number => {
    let best = 0, bd = Infinity;
    views.forEach((b, i) => {
      if (b.type === 0) return;
      const d = Math.abs(xOf(b.freq) - fx);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  return (
    <Display x={x} y={y} w={w} h={h} deps={[key]} draw={draw}
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0 && e.button !== 2) return;
        e.preventDefault();
        const r = e.currentTarget.getBoundingClientRect();
        const band = nearest((e.clientX - r.left) / r.width);
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
        const right = e.button === 2;
        drag.current = { band, right, x0: e.clientX, y0: e.clientY, l0: level[band].value, f0: freq[band].value, w0: width[band].value };
        level[band].control.onBegin?.();
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        const r = e.currentTarget.getBoundingClientRect();
        if (!d) {
          const b = nearest((e.clientX - r.left) / r.width);
          setHint(`Band ${b + 1}: ${Math.round(peqFreqHz(views[b].freq))} Hz, ${views[b].level.toFixed(1)} dB`);
          return;
        }
        const sx = r.width / w, sy = r.height / h; // screen px per editor px
        const dx = (e.clientX - d.x0) / sx, dy = (e.clientY - d.y0) / sy;
        if (peqUsesLevel(views[d.band].type)) level[d.band].set(Math.round(Math.min(1800, Math.max(-1800, d.l0 - (dy / (h / 2 - 1.5)) * 1800))));
        if (d.right) width[d.band].set(Math.round(Math.min(65536, Math.max(0, d.w0 + (dx / (w - 2)) * 65536))));
        else freq[d.band].set(Math.round(Math.min(65536, Math.max(0, d.f0 + (dx / (w - 2)) * 65536))));
        const b = views[d.band];
        setHint(`Band ${d.band + 1}: ${Math.round(peqFreqHz(b.freq))} Hz, ${b.level.toFixed(1)} dB`);
      }}
      onPointerUp={() => {
        if (!drag.current) return;
        level[drag.current.band].control.onEnd?.();
        drag.current = null;
      }} />
  );
}

function FreqReadout({ x, k }: { x: number; k: string }) {
  const p = useParam(k);
  return (
    <div className="fxk-abs" style={{
      left: x, top: 159, width: 29, height: 14, lineHeight: '14px', textAlign: 'center',
      background: 'linear-gradient(180deg, #344833, #3d5139)', color: '#c1ffc0',
      fontFamily: 'Arial, Helvetica, sans-serif', fontSize: 9.5, pointerEvents: 'none', whiteSpace: 'nowrap', overflow: 'hidden',
    }}>{Math.round(peqFreqHz(p.value))}</div>
  );
}

function BandColumn({ b }: { b: number }) {
  const type = useParam(`type${b + 1}`);
  const t = Math.round(type.value);
  return (
    <>
      <TypeSpinner k={`type${b + 1}`} x={TYPE_X[b]} y={8} w={23} h={16} />
      <LevelSlider k={`level${b + 1}`} x={LEVEL_X[b]} y={26} w={18} h={b === 6 ? 123 : 124} hidden={t >= 1 && t <= 4} />
      <FreqReadout x={LABEL_X[b]} k={`freq${b + 1}`} />
      <MetalKnob k={`freq${b + 1}`} x={COL_X[b]} y={182} w={30} h={30} />
      <MetalKnob k={`width${b + 1}`} x={BW_X[b]} y={219} w={24} h={24} />
    </>
  );
}

const TITLE = { position: 'absolute' as const, top: 322, height: 30, lineHeight: '30px', fontFamily: 'Arial, Helvetica, sans-serif', fontStyle: 'italic', fontSize: 18.5, whiteSpace: 'nowrap' as const, transformOrigin: '0 50%', pointerEvents: 'none' as const };

function PeqEditor() {
  return (
    <FxPanel width={240} height={350} style={{
      background: 'linear-gradient(90deg, rgba(0,0,0,0) 0%, rgba(150,166,176,0.30) 50%, rgba(0,0,0,0) 100%), linear-gradient(180deg, #58626a 0%, #4f585d 40%, #3b4246 100%)',
    }}>
      <div className="fxk-abs" style={{
        left: 5, top: 5, width: 230, height: 147, borderRadius: 5,
        background: 'linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.07)), linear-gradient(90deg, #66717a 0%, #84909a 22%, #9ba9b1 50%, #84909a 78%, #66717a 100%)',
        boxShadow: 'inset 0 0 0 1px rgba(40,50,56,0.25)',
      }} />
      {Array.from({ length: PEQ_BANDS }, (_, b) => <BandColumn key={b} b={b} />)}
      <BandGraph x={5} y={250} w={230} h={66} />
      <div style={{ ...TITLE, left: 5, color: '#232c31', transform: 'scaleX(0.83)' }}>FRUITY</div>
      <div style={{ ...TITLE, left: 63, color: '#3c474e', transform: 'scaleX(0.83)' }}>PARAMETRIC</div>
      <div style={{ ...TITLE, left: 166, color: '#2c3439', transform: 'scaleX(0.83)' }}>EQ</div>
      <svg className="fxk-abs" style={{ left: 196, top: 323, width: 16, height: 18, pointerEvents: 'none' }} viewBox="0 0 16 18">
        <path d="M3 13.5 L11 13.5 L11 6 Z" fill="#848c90" />
      </svg>
      <MetalKnob k="main" x={212} y={321} w={24} h={24} />
    </FxPanel>
  );
}

export const editor: FxEditorModule = { id: 'peq', Editor: PeqEditor };
