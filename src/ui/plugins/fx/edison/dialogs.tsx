// Edison's tool dialogs (Amp, Time stretch / pitch shift, Equalize, Reverb,
// Blur, Clean up, Generate noise, Run script, Settings, Sample properties),
// drawn as FL-style windows over the editor. FL's tools preview live; these
// apply on Accept (one undo step each).

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { store } from '../../../../store';
import { WheelControl } from '../../kit';
import type { ControlProps } from '../../../widgets/control';
import { edState } from '../../../../model/fx/plugins/edison';
import * as C from './commands';
import { getNoiseProfile, setNoiseProfile, setTransient } from './audio';
import { ampTool } from './ops';
import {
  EQ_DEFAULT, blurRange, denoiseRange, eqResponseDb, equalizeRange, noiseProfile, reverbRange, stretchRange,
  type EqBand, type EdScript,
} from './tools';

function Dlg({ title, w, h, children, onClose, onAccept, accept = 'Accept' }: {
  title: string; w: number; h: number; children: ReactNode; onClose: () => void; onAccept?: () => void; accept?: string;
}) {
  return (
    <div className="ed-dlg-back" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ed-dlg" style={{ width: w, height: h, left: (744 - w) / 2, top: Math.max(4, (487 - h) / 2) }} onPointerDown={(e) => e.stopPropagation()}>
        <div className="ed-dlg-title">
          <span>{title}</span>
          <div className="ed-dlg-x" onPointerDown={(e) => { e.stopPropagation(); onClose(); }}>
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5 L8.5 8.5 M8.5 1.5 L1.5 8.5" stroke="currentColor" strokeWidth="1.6" /></svg>
          </div>
        </div>
        <div className="ed-dlg-body">{children}</div>
        {onAccept && <div className="ed-dlg-accept" onPointerDown={(e) => { if (e.button === 0) { e.stopPropagation(); onAccept(); } }}>{accept}</div>}
      </div>
    </div>
  );
}

function Knob({ x, y, label, value, min, max, def, fmt, onChange, color = '#8fc6f0', step = 0 }: {
  x: number; y: number; label: string; value: number; min: number; max: number; def: number; fmt: (v: number) => string; onChange: (v: number) => void; color?: string; step?: number;
}) {
  const control: ControlProps = { value, min, max, defaultValue: def, label, format: fmt, onChange, step };
  return (
    <>
      <div className="ed-knob-label" style={{ left: x - 20, top: y - 15, width: 80 }}>{label}</div>
      <WheelControl x={x} y={y} size={40} color={color} control={control} />
      <div className="ed-knob-val" style={{ left: x - 20, top: y + 42, width: 80 }}>{fmt(value)}</div>
    </>
  );
}

function Section({ x, y, w, h, title, children }: { x: number; y: number; w: number; h: number; title: string; children?: ReactNode }) {
  return (
    <div className="ed-sec" style={{ left: x, top: y, width: w, height: h }}>
      <div className="ed-sec-title">{title}</div>
      {children}
    </div>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
const signedPct = (v: number) => (Math.abs(v) < 0.005 ? 'Centered' : `${Math.round(Math.abs(v) * 100)}% ${v < 0 ? 'left' : 'right'}`);

// ------------------------------------------------------------------ Amp
function AmpDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [v, setV] = useState({ volL: 1, volR: 1, pan: 0, sep: 0 });
  const set = (k: keyof typeof v) => (x: number) => setV((o) => ({ ...o, [k]: x }));
  return (
    <Dlg title="Amp" w={330} h={170} onClose={close} onAccept={() => { C.applyProcess(api, 'Amp', (c) => ampTool(c.ch, c.a, c.b, v)); close(); }}>
      <Knob x={30} y={36} label="Left" value={v.volL} min={0} max={2} def={1} fmt={pct} onChange={set('volL')} />
      <Knob x={105} y={36} label="Right" value={v.volR} min={0} max={2} def={1} fmt={pct} onChange={set('volR')} />
      <Knob x={180} y={36} label="Panning" value={v.pan} min={-1} max={1} def={0} fmt={signedPct} onChange={set('pan')} color="#c58ce8" />
      <Knob x={255} y={36} label="Stereo" value={v.sep} min={-1} max={1} def={0} fmt={(x) => (Math.abs(x) < 0.005 ? 'Unchanged' : x < 0 ? `${Math.round(-x * 100)}% merged` : `${Math.round(x * 100)}% wider`)} onChange={set('sep')} color="#8de07a" />
    </Dlg>
  );
}

// ------------------------------------------------------------ Time stretch
function StretchDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [pitch, setPitch] = useState(0);
  const [time, setTime] = useState(1);
  const [resample, setResample] = useState(false);
  return (
    <Dlg title="Time stretch / pitch shift" w={330} h={224} onClose={close} onAccept={() => {
      C.applyProcess(api, resample ? 'Resample' : 'Time stretch', (c) => stretchRange(c.ch, c.a, c.b, c.sr, pitch, time, resample));
      close();
    }}>
      <Knob x={40} y={36} label="Pitch" value={pitch} min={-24} max={24} def={0} step={0.01} fmt={(x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)} st`} onChange={setPitch} color="#f0b050" />
      <Knob x={140} y={36} label="Time" value={time} min={0.25} max={4} def={1} step={0.001} fmt={(x) => `${Math.round(x * 1000) / 10}%`} onChange={(x) => !resample && setTime(x)} color={resample ? '#59626a' : '#8fc6f0'} />
      <div className="ed-opt-group" style={{ left: 214, top: 38 }}>
        <div className="ed-opt-title">Method</div>
        {[['Stretch', false], ['Resample', true]].map(([l, r]) => (
          <div key={String(l)} className={'ed-opt' + (resample === r ? ' on' : '')} onPointerDown={() => setResample(r as boolean)}>
            <span className="ed-radio" />{String(l)}
          </div>
        ))}
      </div>
      <div className="ed-dlg-note" style={{ left: 12, top: 116, width: 306 }}>
        Stretch keeps pitch and length independent (WSOLA); Resample changes both like tape speed. Formants are not preserved.
      </div>
    </Dlg>
  );
}

// ------------------------------------------------------------------ EQ
function EqCurve({ bands, sr, w, h }: { bands: EqBand[]; sr: number; w: number; h: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    const c = ref.current;
    if (!c) return;
    const dpr = 2;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#2a3036';
    g.fillRect(0, 0, w, h);
    const fx = (f: number) => (Math.log(f / 20) / Math.log(1000)) * w;
    const fy = (db: number) => h / 2 - (db / 18) * (h / 2 - 4);
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.beginPath(); g.moveTo(fx(f) + 0.5, 0); g.lineTo(fx(f) + 0.5, h); g.stroke(); }
    for (const d of [-12, -6, 0, 6, 12]) { g.beginPath(); g.moveTo(0, fy(d) + 0.5); g.lineTo(w, fy(d) + 0.5); g.stroke(); }
    g.strokeStyle = '#8fd14f';
    g.lineWidth = 1.6;
    g.beginPath();
    for (let x = 0; x <= w; x++) {
      const f = 20 * Math.pow(1000, x / w);
      const y = fy(Math.max(-24, Math.min(24, eqResponseDb(bands, f, sr))));
      if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  });
  return <canvas ref={ref} style={{ position: 'absolute', left: 12, top: 34, width: w, height: h, borderRadius: 3 }} />;
}

function EqDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [bands, setBands] = useState<EqBand[]>(() => EQ_DEFAULT.map((b) => ({ ...b })));
  const sr = C.cur(api.slotId).sr;
  const set = (i: number, k: keyof EqBand, v: number | boolean) => setBands((bs) => bs.map((b, j) => (j === i ? { ...b, [k]: v } : b)));
  const names = ['Low cut', 'Low shelf', 'Band 1', 'Band 2', 'High shelf', 'High cut'];
  const hz = (f: number) => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 1 : 2)}kHz` : `${Math.round(f)}Hz`);
  return (
    <Dlg title="Equalize" w={520} h={300} onClose={close} onAccept={() => { C.applyProcess(api, 'Equalize', (c) => equalizeRange(c.ch, c.a, c.b, c.sr, bands)); close(); }}>
      <EqCurve bands={bands} sr={sr} w={496} h={96} />
      {bands.map((b, i) => {
        const x = 14 + i * 83;
        const cut = b.kind === 'highpass' || b.kind === 'lowpass';
        return (
          <div key={i}>
            <div className={'ed-eq-name' + (b.on ? ' on' : '')} style={{ left: x, top: 138, width: 76 }} onPointerDown={() => set(i, 'on', !b.on)}>
              <span className="ed-led" />{names[i]}
            </div>
            <Knob x={x + 18} y={172} label="" value={Math.log(b.freq / 20) / Math.log(1000)} min={0} max={1} def={Math.log(EQ_DEFAULT[i].freq / 20) / Math.log(1000)} step={0}
              fmt={(t) => hz(20 * Math.pow(1000, t))} onChange={(t) => set(i, 'freq', 20 * Math.pow(1000, t))} color={b.on ? '#8fc6f0' : '#59626a'} />
            {!cut && (
              <div className="ed-eq-gain" style={{ left: x, top: 230, width: 76 }}>
                <input type="range" min={-18} max={18} step={0.1} value={b.gain} onChange={(e) => set(i, 'gain', Number(e.target.value))}
                  onDoubleClick={() => set(i, 'gain', 0)} />
                <span>{`${b.gain >= 0 ? '+' : ''}${b.gain.toFixed(1)} dB`}</span>
              </div>
            )}
          </div>
        );
      })}
    </Dlg>
  );
}

// ------------------------------------------------------------------ Reverb
function ReverbDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [o, setO] = useState({ decay: 2, predelay: 0.02, damp: 0.4, mix: 0.35, dry: 1 });
  const set = (k: keyof typeof o) => (x: number) => setO((p) => ({ ...p, [k]: x }));
  return (
    <Dlg title="Convolution reverb" w={410} h={170} onClose={close} onAccept={() => {
      const c = C.cur(api.slotId);
      if (!c.len) return;
      C.applyProcess(api, 'Reverb', (cc) => reverbRange(cc.ch, cc.a, cc.b, cc.sr, o));
      close();
    }}>
      <Knob x={26} y={36} label="Decay" value={o.decay} min={0.1} max={10} def={2} fmt={(x) => `${x.toFixed(1)} s`} onChange={set('decay')} />
      <Knob x={104} y={36} label="Pre-delay" value={o.predelay} min={0} max={0.2} def={0.02} fmt={(x) => `${Math.round(x * 1000)} ms`} onChange={set('predelay')} />
      <Knob x={182} y={36} label="Damping" value={o.damp} min={0} max={0.95} def={0.4} fmt={pct} onChange={set('damp')} />
      <Knob x={260} y={36} label="Wet" value={o.mix} min={0} max={1} def={0.35} fmt={pct} onChange={set('mix')} color="#f0b050" />
      <Knob x={338} y={36} label="Dry" value={o.dry} min={0} max={1} def={1} fmt={pct} onChange={set('dry')} color="#f0b050" />
    </Dlg>
  );
}

// ------------------------------------------------------------------ Blur
function BlurDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [time, setTime] = useState(0.3);
  const [mix, setMix] = useState(1);
  return (
    <Dlg title="Blur" w={220} h={170} onClose={close} onAccept={() => { C.applyProcess(api, 'Blur', (c) => blurRange(c.ch, c.a, c.b, c.sr, time, mix)); close(); }}>
      <Knob x={30} y={36} label="Time" value={time} min={0.01} max={3} def={0.3} fmt={(x) => `${Math.round(x * 1000)} ms`} onChange={setTime} />
      <Knob x={130} y={36} label="Mix" value={mix} min={0} max={1} def={1} fmt={pct} onChange={setMix} color="#f0b050" />
    </Dlg>
  );
}

// ---------------------------------------------------------------- Clean up
function DenoiseDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [amount, setAmount] = useState(1);
  const [floor, setFloor] = useState(-24);
  const [, bump] = useState(0);
  const prof = getNoiseProfile();
  return (
    <Dlg title="Clean up (denoise)" w={300} h={190} onClose={close} accept={prof ? 'Accept' : 'Close'} onAccept={() => {
      const p = getNoiseProfile();
      if (p) C.applyProcess(api, 'Clean up', (c) => denoiseRange(c.ch, c.a, c.b, p, amount, floor));
      close();
    }}>
      <Knob x={40} y={36} label="Amount" value={amount} min={0} max={3} def={1} fmt={pct} onChange={setAmount} />
      <Knob x={130} y={36} label="Floor" value={floor} min={-80} max={0} def={-24} fmt={(x) => `${x.toFixed(0)} dB`} onChange={setFloor} color="#f0b050" />
      <div className="ed-dlg-note" style={{ left: 12, top: 116, width: 200 }}>
        {prof ? 'Noise profile acquired.' : 'No noise profile: select a piece of noise and acquire it.'}
      </div>
      <div className="ed-btn" style={{ left: 196, top: 44, width: 92 }} onPointerDown={() => {
        const c = C.cur(api.slotId);
        const p = noiseProfile(c.ch, c.a, c.b);
        setNoiseProfile(p);
        bump((x) => x + 1);
      }}>Acquire profile</div>
    </Dlg>
  );
}

// ------------------------------------------------------------ Generate noise
function NoiseDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const [vol, setVol] = useState(0.5);
  return (
    <Dlg title="Generate noise" w={200} h={160} onClose={close} onAccept={() => { C.noise(api, vol); close(); }}>
      <Knob x={78} y={36} label="Volume" value={vol} min={0} max={1} def={0.5} fmt={pct} onChange={setVol} />
    </Dlg>
  );
}

// -------------------------------------------------------------- Run script
function ScriptDialogView({ api, script, close }: { api: C.EdApi; script: EdScript; close: () => void }) {
  const [vals, setVals] = useState<number[]>(() => script.inputs.map((i) => i.def));
  const set = (k: number, v: number) => setVals((o) => o.map((x, j) => (j === k ? v : x)));
  // FL's ScriptDialog: 480 x 335, parameters panel then a Run button
  const n = script.inputs.length;
  return (
    <Dlg title={script.title} w={480} h={Math.min(335, 150 + Math.ceil(n / 5) * 90)} onClose={close} accept="Run" onAccept={() => { C.runScript(api, script, vals); close(); }}>
      <div className="ed-dlg-note" style={{ left: 12, top: 8, width: 456 }}>{script.desc}</div>
      {script.inputs.map((inp, k) => {
        const x = 26 + (k % 5) * 90, y = 64 + Math.floor(k / 5) * 90;
        if (inp.kind === 'combo') {
          return (
            <div key={k} className="ed-opt-group" style={{ left: x - 14, top: y - 12 }}>
              <div className="ed-opt-title">{inp.name}</div>
              {(inp.options ?? []).map((o, i) => (
                <div key={o} className={'ed-opt' + (vals[k] === i ? ' on' : '')} onPointerDown={() => set(k, i)}><span className="ed-radio" />{o}</div>
              ))}
            </div>
          );
        }
        if (inp.kind === 'input') {
          return (
            <div key={k} className="ed-input-wrap" style={{ left: x - 18, top: y - 12, width: 80 }}>
              <div className="ed-opt-title">{inp.name}</div>
              <input className="ed-input" type="number" step="any" value={vals[k]} onChange={(e) => set(k, Number(e.target.value) || 0)} />
            </div>
          );
        }
        const dec = inp.max - inp.min > 100 ? 0 : 2;
        return <Knob key={k} x={x} y={y} label={inp.name} value={vals[k]} min={inp.min} max={inp.max} def={inp.def} fmt={(v) => v.toFixed(dec)} onChange={(v) => set(k, v)} />;
      })}
    </Dlg>
  );
}

// ------------------------------------------------------------------ Settings
function SettingsDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const st = C.cur(api.slotId).st;
  const [keyLink, setKeyLink] = useState(st.keyLink);
  const [noHost, setNoHost] = useState(st.syncNoHostSel);
  const [noOwn, setNoOwn] = useState(st.syncNoOwnSel);
  // FL's EdisonSettingsForm: 185 x 248
  return (
    <Dlg title="Settings" w={185} h={248} onClose={close} onAccept={() => {
      setTransient(api.slotId, 'Edison settings', (s) => { s.keyLink = keyLink; s.syncNoHostSel = noHost; s.syncNoOwnSel = noOwn; });
      close();
    }}>
      <Section x={1} y={2} w={183} h={67} title="Piano keyboard preview">
        <div className="ed-label" style={{ left: 7, top: 30, width: 57 }}>Link key to</div>
        <select className="ed-select" style={{ left: 70, top: 30, width: 107 }} value={keyLink} onChange={(e) => setKeyLink(Number(e.target.value))}>
          {['(none)', 'Note preview', 'Slice preview', 'Auto'].map((o, i) => <option key={o} value={i}>{o}</option>)}
        </select>
      </Section>
      <Section x={1} y={77} w={183} h={80} title="Slave playback to host">
        <div className={'ed-check' + (noHost ? ' on' : '')} style={{ left: 6, top: 30 }} onPointerDown={() => setNoHost(!noHost)}><span className="ed-led" />Ignore host selection</div>
        <div className={'ed-check' + (noOwn ? ' on' : '')} style={{ left: 6, top: 51 }} onPointerDown={() => setNoOwn(!noOwn)}><span className="ed-led" />Ignore own selection</div>
      </Section>
    </Dlg>
  );
}

// ---------------------------------------------------------- Sample properties
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (k: number) => `${NOTE_NAMES[((k % 12) + 12) % 12]}${Math.floor(k / 12)}`;

function PropsDialog({ api, close }: { api: C.EdApi; close: () => void }) {
  const c = C.cur(api.slotId);
  const st = c.st;
  const p = store.project;
  const secs = c.len / c.sr;
  const selSecs = c.hasSel ? (c.b - c.a) / c.sr : secs;
  const [title, setTitle] = useState(st.title);
  const [comments, setComments] = useState(st.comments);
  const [tempo, setTempo] = useState(st.tempo || p.tempo);
  const [tsync, setTsync] = useState(st.tsync);
  const [bits, setBits] = useState(st.bits);
  const [root, setRoot] = useState(st.root);
  const [fine, setFine] = useState(st.fine);
  const [rate, setRate] = useState(c.sr);
  const [resample, setResample] = useState(false);
  const beats = (selSecs * tempo) / 60;
  return (
    <Dlg title="Sample properties" w={520} h={444} onClose={close} onAccept={() => {
      setTransient(api.slotId, 'Sample properties', (s) => { s.title = title; s.comments = comments; s.tempo = tempo; s.tsync = tsync; s.root = root; s.fine = fine; });
      if (bits !== st.bits) C.setBits(api, bits === 16 ? 16 : 32);
      if (rate !== c.sr && c.len && rate >= 1000) C.changeRate(api, rate, resample);
      close();
    }}>
      <Section x={4} y={2} w={510} h={120} title="Info">
        <div className="ed-label r" style={{ left: 4, top: 26, width: 100 }}>Title</div>
        <input className="ed-input abs" style={{ left: 110, top: 24, width: 390 }} value={title} onChange={(e) => setTitle(e.target.value)} />
        <div className="ed-label r" style={{ left: 4, top: 52, width: 100 }}>Comments</div>
        <textarea className="ed-input abs" style={{ left: 110, top: 50, width: 390, height: 60 }} value={comments} onChange={(e) => setComments(e.target.value)} />
      </Section>
      <Section x={4} y={128} w={510} h={70} title="Format">
        <div className="ed-label r" style={{ left: 4, top: 26, width: 100 }}>Samplerate (Hz)</div>
        <input className="ed-input abs" type="number" style={{ left: 110, top: 24, width: 80 }} value={rate} onChange={(e) => setRate(Number(e.target.value) || c.sr)} />
        <div className={'ed-check' + (resample ? ' on' : '')} style={{ left: 200, top: 26 }} onPointerDown={() => setResample(!resample)}><span className="ed-led" />Resample</div>
        <div className="ed-label r" style={{ left: 4, top: 48, width: 100 }}>Format</div>
        <div className={'ed-btn' + (bits === 16 ? ' on' : '')} style={{ left: 110, top: 46, width: 70 }} onPointerDown={() => setBits(16)}>16Bit int</div>
        <div className={'ed-btn' + (bits !== 16 ? ' on' : '')} style={{ left: 184, top: 46, width: 80 }} onPointerDown={() => setBits(32)}>32Bit float</div>
        <div className="ed-label" style={{ left: 274, top: 48, width: 120 }}>{c.ch.length === 1 ? 'Mono' : 'Stereo'}</div>
      </Section>
      <Section x={4} y={204} w={510} h={100} title="Tempo">
        <div className="ed-label r" style={{ left: 4, top: 26, width: 100 }}>Tempo (BPM)</div>
        <input className="ed-input abs" type="number" step="any" style={{ left: 110, top: 24, width: 80 }} value={Math.round(tempo * 1000) / 1000} onChange={(e) => setTempo(Math.max(10, Number(e.target.value) || 120))} />
        <div className="ed-btn" style={{ left: 196, top: 24, width: 50 }} onPointerDown={() => setTempo(Math.round(tempo))}>Round</div>
        <div className="ed-btn" style={{ left: 406, top: 50, width: 94 }} onPointerDown={() => setTempo(p.tempo)}>Default</div>
        <div className="ed-label r" style={{ left: 4, top: 52, width: 100 }}>{c.hasSel ? 'Selection (beats)' : 'Length (beats)'}</div>
        <input className="ed-input abs" type="number" step="any" style={{ left: 110, top: 50, width: 80 }} value={Math.round(beats * 1000) / 1000}
          onChange={(e) => { const b = Number(e.target.value); if (b > 0 && selSecs > 0) setTempo((b * 60) / selSecs); }} />
        <div className="ed-btn" style={{ left: 196, top: 50, width: 50 }} onPointerDown={() => { const b = Math.max(1, Math.round(beats)); if (selSecs > 0) setTempo((b * 60) / selSecs); }}>Round</div>
        <div className={'ed-check' + (tsync ? ' on' : '')} style={{ left: 256, top: 52 }} onPointerDown={() => setTsync(!tsync)}><span className="ed-led" />Tempo-sync</div>
        <div className="ed-btn" style={{ left: 406, top: 24, width: 94 }} onPointerDown={() => {
          // quick estimation for short loops: the beat count closest to the host tempo, a power of two
          if (selSecs <= 0) return;
          const b0 = (selSecs * p.tempo) / 60;
          let b = Math.pow(2, Math.round(Math.log2(Math.max(1, b0))));
          if (Math.abs(b0 - b) > b * 0.3) b = Math.max(1, Math.round(b0));
          setTempo((b * 60) / selSecs);
        }}>Autodetect</div>
      </Section>
      <Section x={4} y={310} w={510} h={64} title="Sampler">
        <div className="ed-label r" style={{ left: 4, top: 30, width: 100 }}>Middle note</div>
        <select className="ed-select" style={{ left: 110, top: 28, width: 70 }} value={root} onChange={(e) => setRoot(Number(e.target.value))}>
          {Array.from({ length: 128 }, (_, k) => <option key={k} value={k}>{noteName(k)}</option>)}
        </select>
        <div className="ed-label r" style={{ left: 186, top: 30, width: 110 }}>Fine tune (cents)</div>
        <input className="ed-input abs" type="number" style={{ left: 302, top: 28, width: 60 }} value={fine} onChange={(e) => setFine(Math.max(-100, Math.min(100, Number(e.target.value) || 0)))} />
        <div className="ed-btn" style={{ left: 406, top: 28, width: 94 }} onPointerDown={() => { setRoot(60); setFine(0); }}>Default</div>
      </Section>
    </Dlg>
  );
}

export function DialogHost({ api, spec, close }: { api: C.EdApi; spec: C.DialogSpec | null; close: () => void }) {
  if (!spec) return null;
  switch (spec.kind) {
    case 'amp': return <AmpDialog api={api} close={close} />;
    case 'stretch': return <StretchDialog api={api} close={close} />;
    case 'eq': return <EqDialog api={api} close={close} />;
    case 'reverb': return <ReverbDialog api={api} close={close} />;
    case 'blur': return <BlurDialog api={api} close={close} />;
    case 'denoise': return <DenoiseDialog api={api} close={close} />;
    case 'noise': return <NoiseDialog api={api} close={close} />;
    case 'script': return spec.script ? <ScriptDialogView api={api} script={spec.script} close={close} /> : null;
    case 'settings': return <SettingsDialog api={api} close={close} />;
    case 'props': return <PropsDialog api={api} close={close} />;
    case 'message':
      return (
        <Dlg title="Edison" w={300} h={140} onClose={close} accept="OK" onAccept={close}>
          <div className="ed-dlg-note" style={{ left: 12, top: 12, width: 276, whiteSpace: 'pre-line' }}>{spec.text}</div>
        </Dlg>
      );
  }
}

export { edState };
