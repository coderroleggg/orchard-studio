// Module panel contents for the FL Studio Mobile Rack editor: one layout per
// module (knob rows, slider banks, X/Y pads, keyboards) plus the displays
// (EQ curve, spectrum, tuner, gain reduction and level meters).

import { useRef } from 'react';
import { AnimatedDisplay, useFxEditor, useFxMonitor } from '../../kit';
import type { FxMonitor } from '../../../../engine/effects/types';
import { flmBand } from '../../../../engine/effects/plugins/mobilerack/eq';
import { mrModuleDef, type MrMod } from '../../../../model/fx/plugins/mobilerack';
import { MR_NOTES, mrIndex, mrMap, type MrParam } from '../../../../model/fx/plugins/mobilerack/modules';
import { RingKnob, Segmented, Spinner, Toggle, VSlider, XYPad, useModMix, useModParam, type KnobSize } from './controls';

// ---- bound widgets (one component per control keeps the hook rules simple)

function K({ m, k, size = 'mid', label }: { m: MrMod; k: number; size?: KnobSize; label?: string }) {
  return <RingKnob b={useModParam(m, k)} size={size} label={label} />;
}
function S({ m, k, h, label }: { m: MrMod; k: number; h?: number; label?: string }) {
  return <VSlider b={useModParam(m, k)} h={h} label={label} />;
}
function Sp({ m, k, label }: { m: MrMod; k: number; label?: string }) {
  return <Spinner b={useModParam(m, k)} label={label} />;
}
function Seg({ m, k, labels, width }: { m: MrMod; k: number; labels?: string[]; width?: number }) {
  return <Segmented b={useModParam(m, k)} labels={labels} width={width} />;
}
function T({ m, k, label, big }: { m: MrMod; k: number; label?: string; big?: boolean }) {
  return <Toggle b={useModParam(m, k)} label={label} big={big} />;
}
export function MixKnob({ m, k }: { m: MrMod; k: number }) {
  return <RingKnob b={useModMix(m, k)} size="small" />;
}

const isOn = (m: MrMod, k: number) => (m.p[k] ?? 0) >= 0.5;
const Row = ({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) => <div className="mr-row" style={style}>{children}</div>;
const Cap = ({ children }: { children: React.ReactNode }) => <div className="mr-label">{children}</div>;

/** Knob size for a row of n knobs. */
const sizeFor = (n: number): KnobSize => (n <= 3 ? 'big' : n <= 6 ? 'mid' : 'small');

/** Generic layout: knobs in rows, then choices and toggles. */
function Generic({ m, tab, skip = [] }: { m: MrMod; tab: string | null; skip?: number[] }) {
  const def = mrModuleDef(m.type);
  if (!def) return null;
  const vis = def.params.map((p, k) => ({ p, k })).filter(({ p, k }) => k > 0 && p.kind !== 'hidden' && !skip.includes(k) && (!tab || p.tab === tab));
  const knobs = vis.filter(({ p }) => !p.kind || p.kind === 'knob' || p.kind === 'slider');
  const choices = vis.filter(({ p }) => p.kind === 'choice');
  const toggles = vis.filter(({ p }) => p.kind === 'toggle');
  const perRow = knobs.length <= 6 ? 6 : Math.ceil(knobs.length / 2);
  const rows: typeof knobs[] = [];
  for (let i = 0; i < knobs.length; i += perRow) rows.push(knobs.slice(i, i + perRow));
  const size = sizeFor(Math.min(perRow, knobs.length));
  return (
    <>
      {rows.map((r, i) => <Row key={i}>{r.map(({ k }) => <K key={k} m={m} k={k} size={size} />)}</Row>)}
      {(choices.length > 0 || toggles.length > 0) && (
        <Row style={{ alignItems: 'center', marginTop: 6 }}>
          {choices.map(({ k }) => <Sp key={k} m={m} k={k} />)}
          {toggles.map(({ k }) => <T key={k} m={m} k={k} />)}
        </Row>
      )}
    </>
  );
}

// ---- displays

const fNorm = (f: number) => Math.log(f / 20) / Math.log(1000); // 20 Hz .. 20 kHz -> 0..1

/** Equalizer response curve from the current band settings (same design as the DSP). */
function EqCurve({ m }: { m: MrMod }) {
  const W = 488, H = 110, sr = 48000;
  const c = { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 };
  const pts: string[] = [];
  const bands = [0, 1, 2, 3].map((b) => {
    const o = 1 + b * 4;
    const gdb = 48 * ((m.p[o] ?? 0.5) - 0.5);
    const f0 = mrMap.peqFreqHz(m.p[o + 1] ?? 0.5);
    const bw = 0.25 + 7 * (m.p[o + 2] ?? 0.5);
    const kind = Math.min(2, Math.max(0, Math.trunc((m.p[o + 3] ?? 0.51) * 2 + 1e-7)));
    return { gdb, f0, c: { ...flmBand(kind, f0, gdb, bw, sr, c) } };
  });
  for (let i = 0; i <= 120; i++) {
    const f = 20 * Math.pow(1000, i / 120);
    const w = (2 * Math.PI * f) / sr;
    let db = 0;
    for (const bd of bands) {
      if (Math.abs(bd.gdb) < 1e-4) continue;
      const q = bd.c, cw = Math.cos(w), sw = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
      const nr = q.b0 + q.b1 * cw + q.b2 * c2, ni = -(q.b1 * sw + q.b2 * s2);
      const dr = 1 + q.a1 * cw + q.a2 * c2, di = -(q.a1 * sw + q.a2 * s2);
      db += 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    const y = H / 2 - (Math.max(-27, Math.min(27, db)) / 27) * (H / 2 - 6);
    pts.push(`${(i / 120) * W},${y}`);
  }
  return (
    <div className="mr-display" style={{ width: W, height: H, margin: '0 auto 6px auto' }}>
      <svg width={W} height={H}>
        {[100, 1000, 10000].map((f) => <line key={f} x1={fNorm(f) * W} y1={0} x2={fNorm(f) * W} y2={H} stroke="#3f464c" />)}
        <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#4b5359" />
        <polyline points={pts.join(' ')} fill="none" stroke="var(--mr-orange)" strokeWidth={2} />
        {bands.map((bd, i) => (
          <g key={i}>
            <circle cx={fNorm(bd.f0) * W} cy={H / 2 - (bd.gdb / 2 / 13.5) * (H / 2 - 6)} r={8} fill="var(--mr-bg)" stroke="var(--mr-orange)" strokeWidth={2} />
            <text x={fNorm(bd.f0) * W} y={H / 2 - (bd.gdb / 2 / 13.5) * (H / 2 - 6) + 4} fontSize={10} fill="#fff" textAnchor="middle">{i + 1}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

/** Polls the module's monitor values into a ref. */
function useModMonitor(id: number): React.MutableRefObject<FxMonitor> {
  const { slotId } = useFxEditor();
  const ref = useRef<FxMonitor>({});
  useFxMonitor(slotId, (d) => {
    const pre = `${id}.`;
    const o: FxMonitor = {};
    for (const k in d) if (k.startsWith(pre)) o[k.slice(pre.length)] = d[k];
    ref.current = o;
  });
  return ref;
}

function Spectrum({ m }: { m: MrMod }) {
  const mon = useModMonitor(m.id);
  const W = 488, H = 150;
  return (
    <div style={{ position: 'relative', width: W, height: H, margin: '0 auto 6px auto' }}>
      <AnimatedDisplay x={0} y={0} w={W} h={H} className="mr-display" frame={(g) => {
        g.fillStyle = '#31383d'; g.fillRect(0, 0, W, H);
        g.strokeStyle = '#3f464c'; g.lineWidth = 1;
        for (const f of [100, 1000, 10000]) { const x = fNorm(f) * W; g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
        for (let d = -20; d > -100; d -= 20) { const y = (-d / 100) * H; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); }
        const spec = mon.current.spec as Float32Array | undefined;
        const sr = Number(mon.current.sr) || 48000;
        if (spec && spec.length) {
          g.beginPath();
          const n = spec.length;
          for (let x = 0; x <= W; x += 2) {
            const f = 20 * Math.pow(1000, x / W);
            const bin = Math.min(n - 1, Math.max(1, Math.round((f / (sr / 2)) * n)));
            const db = spec[bin];
            const y = Math.min(H, Math.max(0, (-db / 100) * H));
            if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.lineTo(W, H); g.lineTo(0, H); g.closePath();
          g.fillStyle = 'rgba(255,139,93,0.35)'; g.fill();
          g.strokeStyle = '#ff8b5d'; g.lineWidth = 1.5; g.stroke();
        }
        g.fillStyle = '#8b949a'; g.font = '10px sans-serif';
        g.fillText('100', fNorm(100) * W + 3, H - 4); g.fillText('1k', fNorm(1000) * W + 3, H - 4); g.fillText('10k', fNorm(10000) * W + 3, H - 4);
      }} />
    </div>
  );
}

function Meters({ m, keys = ['l', 'r'], labels = ['L', 'R'] }: { m: MrMod; keys?: string[]; labels?: string[] }) {
  const mon = useModMonitor(m.id);
  const W = 220, H = 14 * keys.length + 6;
  return (
    <div style={{ position: 'relative', width: W, height: H, margin: '4px auto' }}>
      <AnimatedDisplay x={0} y={0} w={W} h={H} className="mr-display" frame={(g) => {
        g.fillStyle = '#31383d'; g.fillRect(0, 0, W, H);
        keys.forEach((k, i) => {
          const v = Number(mon.current[k]) || 0;
          const db = v > 1e-6 ? 20 * Math.log10(v) : -90;
          const t = Math.max(0, Math.min(1, (db + 60) / 66));
          g.fillStyle = '#3f464c'; g.fillRect(16, 4 + i * 14, W - 22, 9);
          g.fillStyle = db > 0 ? '#ff5b4d' : '#ff8b5d'; g.fillRect(16, 4 + i * 14, (W - 22) * t, 9);
          g.fillStyle = '#aab2b8'; g.font = '9px sans-serif'; g.fillText(labels[i], 4, 12 + i * 14);
        });
      }} />
    </div>
  );
}

/** Gain reduction meter (dB, 0..30). */
function GrMeter({ m, k = 'gr', label = 'GR' }: { m: MrMod; k?: string; label?: string }) {
  const mon = useModMonitor(m.id);
  const W = 240, H = 20;
  return (
    <div style={{ position: 'relative', width: W, height: H, margin: '6px auto 0 auto' }}>
      <AnimatedDisplay x={0} y={0} w={W} h={H} className="mr-display" frame={(g) => {
        const v = mon.current[k];
        const gr = Array.isArray(v) ? Math.max(...(v as number[])) : Number(v) || 0;
        g.fillStyle = '#31383d'; g.fillRect(0, 0, W, H);
        g.fillStyle = '#3f464c'; g.fillRect(28, 6, W - 34, 8);
        g.fillStyle = '#ff8b5d'; g.fillRect(28, 6, (W - 34) * Math.min(1, gr / 30), 8);
        g.fillStyle = '#aab2b8'; g.font = '9px sans-serif'; g.fillText(label, 4, 14);
      }} />
    </div>
  );
}

function TunerDisplay({ m }: { m: MrMod }) {
  const mon = useModMonitor(m.id);
  const W = 300, H = 120;
  return (
    <div style={{ position: 'relative', width: W, height: H, margin: '4px auto 8px auto' }}>
      <AnimatedDisplay x={0} y={0} w={W} h={H} className="mr-display" frame={(g) => {
        const hz = Number(mon.current.hz) || 0;
        g.fillStyle = '#31383d'; g.fillRect(0, 0, W, H);
        g.strokeStyle = '#4b5359'; g.lineWidth = 1;
        for (let c = -50; c <= 50; c += 10) { const x = W / 2 + (c / 50) * (W / 2 - 20); g.beginPath(); g.moveTo(x, 84); g.lineTo(x, c === 0 ? 70 : 78); g.stroke(); }
        g.textAlign = 'center';
        if (hz > 0) {
          const midi = 69 + 12 * Math.log2(hz / 440), n = Math.round(midi), cents = (midi - n) * 100;
          g.fillStyle = Math.abs(cents) < 5 ? '#ffffff' : '#ff8b5d';
          g.font = '38px sans-serif'; g.fillText(`${MR_NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`, W / 2, 50);
          const x = W / 2 + (Math.max(-50, Math.min(50, cents)) / 50) * (W / 2 - 20);
          g.fillStyle = '#ff8b5d'; g.beginPath(); g.arc(x, 90, 6, 0, Math.PI * 2); g.fill();
          g.fillStyle = '#aab2b8'; g.font = '11px sans-serif'; g.fillText(`${hz.toFixed(1)} Hz  ${cents >= 0 ? '+' : ''}${cents.toFixed(0)} ct`, W / 2, 112);
        } else {
          g.fillStyle = '#6b737a'; g.font = '30px sans-serif'; g.fillText('--', W / 2, 50);
        }
        g.textAlign = 'left';
      }} />
    </div>
  );
}

// ---- module layouts

const GEQ_LABELS = ['80', '160', '375', '750', '1.5k', '3k', '6k', '12k'];
const TEQ_BASE = [65.40639, 130.81278, 261.62557, 523.25113, 1046.5023, 2093.0045, 4186.009, 8372.018];

function Keyboard({ m }: { m: MrMod }) {
  // white keys C D E F G A B, black keys between
  const whites = [0, 2, 4, 5, 7, 9, 11], blacks = [1, 3, 6, 8, 10];
  const KW = 44, x0 = (492 - KW * 7) / 2;
  const names = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const bx = (n: number) => { const w = whites.filter((x) => x < n).length; return x0 + w * KW - 14; };
  return (
    <div className="mr-keys" style={{ width: 492, margin: '4px auto 6px auto' }}>
      {whites.map((n, i) => <Key key={n} m={m} k={1 + n} cls="w" style={{ left: x0 + i * KW, width: KW - 2 }} label={names[n]} />)}
      {blacks.map((n) => <Key key={n} m={m} k={1 + n} cls="b" style={{ left: bx(n), width: 28 }} label={names[n]} />)}
    </div>
  );
}

function Key({ m, k, cls, style, label }: { m: MrMod; k: number; cls: string; style: React.CSSProperties; label: string }) {
  const b = useModParam(m, k);
  const on = b.value >= 0.5;
  return (
    <div className={`mr-key ${cls}${on ? ' on' : ''}`} style={style} data-mrctl="1"
      onPointerDown={(e) => { e.stopPropagation(); b.set(on ? 0 : 1); }}>
      <div className="kl">{label}</div>
    </div>
  );
}

/** Rate knob that swaps to the synced choice when Sync is on. */
function RateSwap({ m, sync, free, synced, label = 'Rate' }: { m: MrMod; sync: number; free: number; synced: number; label?: string }) {
  return isOn(m, sync) ? <Sp m={m} k={synced} label={label} /> : <K m={m} k={free} label={label} />;
}

export function ModuleBody({ m, tab }: { m: MrMod; tab: string | null }) {
  switch (m.type) {
    case 26: // Analyzer
      return <><Spectrum m={m} /><Meters m={m} /></>;
    case 24: // Tuner
      return <TunerDisplay m={m} />;
    case 3: { // Equalizer
      const b = Math.max(0, Number(tab ?? '1') - 1), o = 1 + b * 4;
      return (
        <>
          <EqCurve m={m} />
          <Row>
            <K m={m} k={o} label="Gain" /><K m={m} k={o + 1} label="Frequency" /><K m={m} k={o + 2} label="Bandwidth" />
          </Row>
          <Row style={{ alignItems: 'center' }}>
            <Seg m={m} k={o + 3} width={300} />
            <Sp m={m} k={17 + b} label="Channel" />
          </Row>
        </>
      );
    }
    case 7: // Graphic EQ
      return <Row>{GEQ_LABELS.map((l, i) => <S key={i} m={m} k={1 + i} h={120} label={l} />)}</Row>;
    case 30: { // Tuned EQ
      const t = Math.min(11, Math.max(0, Math.trunc((m.p[9] ?? 0) * 11 + 1e-7)));
      const fl = (f: number) => { const x = f * Math.pow(2, t / 12); return x >= 1000 ? `${(x / 1000).toFixed(1)}k` : `${Math.round(x)}`; };
      return (
        <>
          <Row>{TEQ_BASE.map((f, i) => <S key={i} m={m} k={1 + i} h={110} label={fl(f)} />)}</Row>
          <Row style={{ alignItems: 'center' }}><Sp m={m} k={9} label="Tuning" /><K m={m} k={10} size="mid" /></Row>
        </>
      );
    }
    case 9: // Filter
      return (
        <>
          <Row><K m={m} k={1} size="big" /><K m={m} k={2} size="big" /></Row>
          <Row style={{ alignItems: 'center', marginTop: 6 }}><Seg m={m} k={3} width={180} /><Seg m={m} k={4} width={240} /></Row>
        </>
      );
    case 36: { // Multiband Compressor
      if (!tab || tab === 'Master') {
        return (
          <>
            <Row>
              <S m={m} k={2} /><S m={m} k={3} /><S m={m} k={27} label="Low Width" /><S m={m} k={28} label="Mid Width" /><S m={m} k={29} label="High Width" /><S m={m} k={5} /><S m={m} k={1} />
            </Row>
            <Row><Seg m={m} k={4} width={200} /></Row>
            <GrMeter m={m} />
          </>
        );
      }
      const o = 6 + 7 * ['Low', 'Mid', 'High'].indexOf(tab);
      return (
        <>
          <Row>{[0, 1, 2, 3, 4, 5].map((i) => <S key={i} m={m} k={o + i} />)}</Row>
          <Row><Seg m={m} k={o + 6} width={260} /></Row>
          <GrMeter m={m} />
        </>
      );
    }
    case 4: // Multi FX
      return (
        <>
          <Row style={{ alignItems: 'center' }}>
            <Sp m={m} k={1} label="Effect" />
            <XYPad m={m} kx={2} ky={3} w={250} h={130} />
            <div className="mr-cell"><K m={m} k={4} size="small" /><K m={m} k={5} size="small" /></div>
          </Row>
          <Row><Seg m={m} k={6} width={240} /></Row>
        </>
      );
    case 41: // Waveshaper
      if (!tab || tab === 'SHAPE') {
        return (
          <>
            <Row style={{ alignItems: 'center' }}>
              <div className="mr-cell"><Sp m={m} k={1} label="Shape" /><div style={{ height: 8 }} /><T m={m} k={2} label="Auto-Gain" /></div>
              <XYPad m={m} kx={3} ky={4} w={190} h={120} />
              <div className="mr-cell"><Row><K m={m} k={5} size="small" /><K m={m} k={6} size="small" /></Row><Row><K m={m} k={7} size="small" /><K m={m} k={8} size="small" /></Row></div>
            </Row>
          </>
        );
      }
      if (tab === 'LFO') {
        return (
          <>
            <Row>
              <RateSwap m={m} sync={16} free={18} synced={17} />
              <K m={m} k={19} /><K m={m} k={20} />
            </Row>
            <Row style={{ alignItems: 'center' }}><Seg m={m} k={15} width={220} /><T m={m} k={16} label="Sync" /></Row>
          </>
        );
      }
      return <Generic m={m} tab={tab} />;
    case 45: // Pitcher 2
      if (!tab || tab === 'SCALE') return <Keyboard m={m} />;
      return (
        <>
          <Row><K m={m} k={13} size="small" /><K m={m} k={19} size="small" /><K m={m} k={23} size="small" /><K m={m} k={20} size="small" /><K m={m} k={24} size="small" /><K m={m} k={17} size="small" /><K m={m} k={22} size="small" /></Row>
          <Row style={{ alignItems: 'center' }}><T m={m} k={16} label="Formants" /><T m={m} k={21} label="Snapping" /><T m={m} k={26} label="Sibilants" /><Sp m={m} k={18} label="Pitch Ref." /></Row>
        </>
      );
    case 42: // Tape Stop
      return (
        <>
          <Row>
            {isOn(m, 7) ? <><K m={m} k={3} size="big" label="Stop Time" /><K m={m} k={4} size="big" label="Start Time" /></> : <><K m={m} k={1} size="big" /><K m={m} k={2} size="big" /></>}
          </Row>
          <Row style={{ alignItems: 'center' }}><T m={m} k={5} label={isOn(m, 5) ? 'PLAYING' : 'STOPPED'} big /><T m={m} k={6} label="Warp" /><T m={m} k={7} label="Sync" /></Row>
        </>
      );
    case 43: // Wow & Flutter
      return (
        <>
          <Row>
            <div className="mr-cell"><RateSwap m={m} sync={7} free={1} synced={2} label="Wow" /><K m={m} k={3} size="small" label="Amount" /></div>
            <div className="mr-cell"><RateSwap m={m} sync={7} free={4} synced={5} label="Flutter" /><K m={m} k={6} size="small" label="Amount" /></div>
            <div className="mr-cell"><RateSwap m={m} sync={7} free={8} synced={9} label="Random" /><K m={m} k={10} size="small" label="Amount" /></div>
          </Row>
          <Row><T m={m} k={7} label="Sync" /></Row>
        </>
      );
    case 13: // Flanger
      if (tab === 'LFO') {
        return (
          <>
            <Row><RateSwap m={m} sync={2} free={3} synced={1} /><K m={m} k={5} /></Row>
            <Row style={{ alignItems: 'center' }}><Seg m={m} k={4} width={220} /><T m={m} k={2} label="Sync" /></Row>
          </>
        );
      }
      return <Generic m={m} tab={tab} />;
    case 14: // Phaser
      if (tab === 'LFO') {
        return (
          <>
            <Row><RateSwap m={m} sync={6} free={7} synced={1} /><K m={m} k={2} /></Row>
            <Row style={{ alignItems: 'center' }}><Seg m={m} k={8} width={220} /><T m={m} k={6} label="Sync" /></Row>
          </>
        );
      }
      return <Generic m={m} tab={tab} />;
    case 46: // Tremolo
      if (!tab || tab === 'MAIN') {
        return (
          <>
            <Row><RateSwap m={m} sync={7} free={1} synced={2} /><K m={m} k={3} /><K m={m} k={4} /></Row>
            <Row><T m={m} k={7} label="Sync" /></Row>
          </>
        );
      }
      return <Generic m={m} tab={tab} />;
    case 8: // Compressor
      return <><Generic m={m} tab={null} /><GrMeter m={m} /></>;
    case 28: // Limiter
      return <><Generic m={m} tab={null} /><GrMeter m={m} /></>;
    case 20: // Leveller
      return <><Generic m={m} tab={null} /><Meters m={m} /></>;
    case 40: // Comb Filter
      if (tab === 'TUNE') {
        return (
          <>
            <Row>
              {isOn(m, 7) ? <><K m={m} k={10} label="Octave" /><K m={m} k={11} label="Note" /></> : <K m={m} k={2} />}
              <K m={m} k={5} />
            </Row>
            <Row style={{ alignItems: 'center' }}><Seg m={m} k={1} width={300} /><T m={m} k={7} label="Snap" /></Row>
          </>
        );
      }
      return <Generic m={m} tab={tab} />;
    default:
      return <Generic m={m} tab={tab} />;
  }
}

export type { MrParam };
void mrIndex;
