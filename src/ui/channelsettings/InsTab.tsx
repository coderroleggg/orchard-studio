// INS tab (Envelope / instrument settings): target tabs PAN | VOL | MOD X |
// MOD Y | PITCH, the DAHDSR envelope and its graph, the LFO, the filter and
// the preview keyboard.

import type { Draft } from 'immer';
import { useProject } from '../../store';
import type { Channel } from '../../model/types';
import type { TimeBase } from '../../model/timing';
import {
  ENV_TARGETS, ENV_TARGET_LABELS, HAS_ENVELOPE, FILTER_TYPES, FILTER_LABELS, defaultEnvLfo, defaultSampler,
  envSeconds, envTempoSeconds, tensionShape, lfoHz, lfoTempoSteps, filterCutoffHz, filterQ,
  type EnvTarget, type EnvSettings, type LfoSettings, type LfoShape, type FilterType,
} from '../../model/sampler';
import { formatHz } from '../../model/scales';
import { keyName } from '../../model/notes';
import { Led } from '../widgets/Led';
import type { MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint, flashHint } from '../hint';
import {
  Section, Cell, KnobCell, MiniKnob, Pill, Segmented, Choice, MenuArrow, editSampler, useViewState, useCanvas,
  useTimeBase, uiFont, type ChoiceOption, type SegOption, chAuto } from './controls';
import { pct, signedPct, fmtSemitones, fmtStageTime, fmtLfoHz, fmtSteps, fmtBeats, fmtSeconds } from './format';
import { PreviewKeyboard } from './PreviewKeyboard';
import { IconPulse, IconSine, IconTriangle } from './icons';

const T100 = 100 / 65536; // shortest stage time (raw 100 of 65536)
const D = defaultSampler();

const TARGET_NAMES: Record<EnvTarget, string> = { pan: 'Panning', vol: 'Volume', modX: 'Mod X', modY: 'Mod Y', pitch: 'Pitch' };

const FILTER_OPTIONS: ChoiceOption<FilterType>[] = FILTER_TYPES.map((t) => ({ v: t, label: FILTER_LABELS[t] }));

const SHAPES: SegOption<LfoShape>[] = [
  { v: 'sine', label: <IconSine />, hint: 'sine' },
  { v: 'triangle', label: <IconTriangle />, hint: 'triangle' },
  { v: 'pulse', label: <IconPulse />, hint: 'pulse' },
];

type TimeKey = 'delay' | 'attack' | 'hold' | 'decay' | 'release';
type TensionKey = 'attackTension' | 'decayTension' | 'releaseTension';

const ENV_COLS: { cap: string; label: string; key: TimeKey | 'sustain'; tension?: TensionKey }[] = [
  { cap: 'DEL', label: 'Delay', key: 'delay' },
  { cap: 'ATT', label: 'Attack', key: 'attack', tension: 'attackTension' },
  { cap: 'HOLD', label: 'Hold', key: 'hold' },
  { cap: 'DEC', label: 'Decay', key: 'decay', tension: 'decayTension' },
  { cap: 'SUS', label: 'Sustain', key: 'sustain' },
  { cap: 'REL', label: 'Release', key: 'release', tension: 'releaseTension' },
];

/** AMT readout: pitch envelopes / LFOs span +/-24 semitones at 100%. */
function amountFormat(target: EnvTarget): (v: number) => string {
  if (target === 'pitch') return (v) => `${signedPct(v)} (${fmtSemitones(v * 24)})`;
  return signedPct;
}

/** "Set" presets for tempo-synced stage times (picking one turns TEMPO on). */
function stageTimePresets(ts: TimeBase, apply: (x: number) => void): MenuItem[] {
  const items: MenuItem[] = [];
  for (let n = 0; n <= 8; n++) {
    const x = Math.max(T100, n / 8); // envTempoSeconds: 1/4 beat x 2^round(8x)
    items.push({ label: fmtBeats(envTempoSeconds(x, 60), ts), onClick: () => apply(x) });
  }
  return [{ label: 'Set', submenu: items }];
}

function speedPresets(ts: TimeBase, apply: (x: number) => void): MenuItem[] {
  const items: MenuItem[] = [];
  for (let m = 8; m >= 0; m--) {
    const x = m / 8; // lfoTempoSteps: 16 steps x 2^round(8 (0.5 - x))
    items.push({ label: fmtSteps(lfoTempoSteps(x), ts), onClick: () => apply(x) });
  }
  return [{ label: 'Set', submenu: items }];
}

let envClipboard: EnvSettings | null = null;

export function InsTab({ ch }: { ch: Channel }) {
  const s = ch.sampler;
  const [target, setTarget] = useViewState<EnvTarget>(ch.id, 'insTarget', 'vol');
  const tempo = useProject((p) => p.tempo);
  const ts = useTimeBase();
  return (
    <div className="cs-page">
      <div className="cs-targets">
        {ENV_TARGETS.map((t) => {
          const el = s.envlfo[t];
          const active = (HAS_ENVELOPE[t] && el.env.enabled) || el.lfo.amount !== 0;
          return (
            <button key={t} className={'cs-target' + (t === target ? ' on' : '')}
              onPointerDown={(e) => { if (e.button === 0) { e.preventDefault(); setTarget(t); } }}
              onPointerEnter={() => setHint(`Target: ${TARGET_NAMES[t]}${HAS_ENVELOPE[t] ? '' : ' (LFO only)'}${active ? ' - active' : ''}`)}
              onPointerLeave={clearHint}>
              <span className={'cs-dot' + (active ? ' on' : '')} />
              {ENV_TARGET_LABELS[t]}
            </button>
          );
        })}
      </div>
      {HAS_ENVELOPE[target] ? (
        <EnvelopeSection ch={ch} target={target} ts={ts} tempo={tempo} />
      ) : (
        <Section title="Envelope" className="cs-env none">
          <div className="cs-empty">No panning envelope in this version - use the LFO below to modulate the panning.</div>
        </Section>
      )}
      <div className="cs-row">
        <LfoSection ch={ch} target={target} ts={ts} tempo={tempo} />
        <FilterSection ch={ch} />
      </div>
      <Section title="Keyboard" className="col" tools={<span className="cs-note">Root note {keyName(s.rootKey)} · right-click a key to change</span>}>
        <PreviewKeyboard ch={ch} />
      </Section>
    </div>
  );
}

// --------------------------------------------------------------- envelope
function EnvelopeSection({ ch, target, ts, tempo }: { ch: Channel; target: EnvTarget; ts: TimeBase; tempo: number }) {
  const id = ch.id;
  const env = ch.sampler.envlfo[target].env;
  const def = defaultEnvLfo(target).env;
  const name = TARGET_NAMES[target];
  const set = (label: string, r: (e: Draft<EnvSettings>) => void) => editSampler(id, `${name} envelope ${label}`, (d) => r(d.envlfo[target].env));
  const tf = (v: number) => fmtStageTime(v, env.tempo, tempo, ts);
  const ledHint = (on: boolean) => `${name} envelope: ${on ? 'on' : 'off'}`;
  const applyPreset = (label: string, patch: Partial<EnvSettings>) => set(label, (e) => { Object.assign(e, patch); });

  const presets = (): MenuItem[] => [
    { header: true, label: `${name} envelope` },
    { label: 'Reset', onClick: () => applyPreset('reset', def) },
    {
      label: 'Gate (basic envelope)',
      onClick: () => applyPreset('preset', {
        enabled: true, delay: T100, attack: T100, hold: T100, decay: T100, sustain: 1, release: 0.08,
        attackTension: 0, decayTension: 0, releaseTension: 0, tempo: false,
      }),
    },
    {
      label: 'Pluck',
      onClick: () => applyPreset('preset', {
        enabled: true, delay: T100, attack: T100, hold: T100, decay: 0.45, sustain: 0, release: 0.3,
        attackTension: 0, decayTension: -0.4, releaseTension: -0.4, tempo: false,
      }),
    },
    {
      label: 'Swell',
      onClick: () => applyPreset('preset', {
        enabled: true, delay: T100, attack: 0.55, hold: T100, decay: 0.5, sustain: 0.8, release: 0.6,
        attackTension: 0.3, decayTension: 0, releaseTension: -0.5, tempo: false,
      }),
    },
    { separator: true },
    { label: 'Copy envelope', onClick: () => { envClipboard = { ...env }; flashHint(`Copied the ${name.toLowerCase()} envelope`); } },
    {
      label: 'Paste envelope', disabled: !envClipboard,
      onClick: () => { if (envClipboard) applyPreset('paste', { ...envClipboard }); },
    },
  ];

  const title = (
    <>
      <Led on={env.enabled} size={9} color="var(--accent)" hint={ledHint(env.enabled)}
        onToggle={() => {
          set('switch', (e) => { e.enabled = !e.enabled; });
          setHint(ledHint(!env.enabled));
        }} />
      Envelope
    </>
  );
  const tools = (
    <>
      <Pill on={env.tempo} label="TEMPO" name={`${name} envelope tempo sync`} set={(v) => set('tempo', (e) => { e.tempo = v; })} />
      <MenuArrow hint={`${name} envelope presets`} items={presets} />
    </>
  );

  return (
    <Section title={title} tools={tools} className={'cs-env' + (env.enabled ? '' : ' off')}>
      <div className="cs-env-knobs">
        {ENV_COLS.map((c) => {
          const key = c.key;
          const isTime = key !== 'sustain';
          const tension = c.tension;
          return (
            <div key={key} className="cs-env-col">
              <KnobCell cap={c.cap} label={c.label} auto={chAuto(id, `sampler.envlfo.${target}.env.${key}`)} value={env[key]} min={isTime ? T100 : 0} def={def[key]} format={isTime ? tf : pct}
                menu={key !== 'sustain' ? stageTimePresets(ts, (x) => set(c.label.toLowerCase(), (e) => { e[key] = x; e.tempo = true; })) : undefined}
                set={(v) => set(c.label.toLowerCase(), (e) => { e[key] = v; })} />
              {tension ? (
                <MiniKnob label={`${c.label} tension`} auto={chAuto(id, `sampler.envlfo.${target}.env.${tension}`)} value={env[tension]} min={-1} max={1} bipolar def={def[tension]} format={signedPct}
                  set={(v) => set(`${c.label.toLowerCase()} tension`, (e) => { e[tension] = v; })} />
              ) : (
                <div className="cs-mini-sp" />
              )}
            </div>
          );
        })}
        {target !== 'vol' && (
          <div className="cs-env-col">
            <KnobCell cap="AMT" label="Amount" auto={chAuto(id, `sampler.envlfo.${target}.env.amount`)} value={env.amount} min={-1} max={1} bipolar def={def.amount} format={amountFormat(target)}
              arc="#ffb066" set={(v) => set('amount', (e) => { e.amount = v; })} />
            <div className="cs-mini-sp" />
          </div>
        )}
      </div>
      <EnvGraph env={env} tempo={tempo} />
    </Section>
  );
}

function EnvGraph({ env, tempo }: { env: EnvSettings; tempo: number }) {
  const ref = useCanvas((g, w, h) => drawEnvelope(g, w, h, env, tempo), [env, tempo]);
  const sec = (x: number) => fmtSeconds(env.tempo ? envTempoSeconds(x, tempo) : envSeconds(x));
  const summary = `Envelope: DEL ${sec(env.delay)} · ATT ${sec(env.attack)} · HOLD ${sec(env.hold)} · DEC ${sec(env.decay)}`
    + ` · SUS ${pct(env.sustain)} · REL ${sec(env.release)}${env.enabled ? '' : ' (switched off)'}`;
  // the canvas is absolutely positioned so its bitmap size never feeds back into the layout
  return (
    <div className="cs-graph" onPointerMove={() => setHint(summary)} onPointerLeave={clearHint}>
      <canvas ref={ref} />
    </div>
  );
}

/** DAHDSR shape using the engine's own time and tension curves; the time axis is scaled to fit. */
function drawEnvelope(g: CanvasRenderingContext2D, w: number, h: number, env: EnvSettings, bpm: number) {
  const sec = (x: number) => (env.tempo ? envTempoSeconds(x, bpm) : envSeconds(x));
  const d = sec(env.delay), a = sec(env.attack), ho = sec(env.hold), de = sec(env.decay), r = sec(env.release);
  const pre = d + a + ho + de;
  const susLen = Math.max(0.2 * (pre + r), 0.02);
  const total = Math.max(1e-3, pre + susLen + r);
  const L = 6, R = 6, T = 6, B = 11;
  const X = (t: number) => L + (t / total) * (w - L - R);
  const Y = (v: number) => T + (1 - v) * (h - T - B);
  const on = env.enabled;

  g.fillStyle = '#15181b';
  g.fillRect(0, 0, w, h);
  g.lineWidth = 1;
  g.strokeStyle = '#232a2f';
  for (const v of [0, 0.5, 1]) {
    const y = Math.round(Y(v)) + 0.5;
    g.beginPath();
    g.moveTo(L, y);
    g.lineTo(w - R, y);
    g.stroke();
  }
  // stage boundaries
  g.setLineDash([2, 3]);
  g.strokeStyle = '#2c343a';
  for (const t of [d, d + a, d + a + ho, pre]) {
    const x = Math.round(X(t)) + 0.5;
    g.beginPath();
    g.moveTo(x, T);
    g.lineTo(x, h - B);
    g.stroke();
  }
  // note off (start of the release)
  const xr = Math.round(X(pre + susLen)) + 0.5;
  g.strokeStyle = on ? 'rgba(255, 159, 67, 0.6)' : 'rgba(255, 159, 67, 0.25)';
  g.beginPath();
  g.moveTo(xr, T);
  g.lineTo(xr, h - B);
  g.stroke();
  g.setLineDash([]);

  // curve
  const pts: number[] = [];
  const seg = (t0: number, dur: number, fn: (u: number) => number) => {
    const n = Math.max(1, Math.ceil(((dur / total) * (w - L - R)) / 2));
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      pts.push(X(t0 + dur * u), Y(fn(u)));
    }
  };
  seg(0, d, () => 0);
  seg(d, a, (u) => tensionShape(u, env.attackTension));
  seg(d + a, ho, () => 1);
  seg(d + a + ho, de, (u) => 1 - (1 - env.sustain) * tensionShape(u, env.decayTension));
  seg(pre, susLen, () => env.sustain);
  seg(pre + susLen, r, (u) => env.sustain * (1 - tensionShape(u, env.releaseTension)));

  g.beginPath();
  g.moveTo(pts[0], Y(0));
  for (let i = 0; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
  g.lineTo(pts[pts.length - 2], Y(0));
  g.closePath();
  g.fillStyle = on ? 'rgba(159, 217, 107, 0.16)' : 'rgba(133, 145, 154, 0.07)';
  g.fill();
  g.beginPath();
  for (let i = 0; i < pts.length; i += 2) {
    if (i === 0) g.moveTo(pts[i], pts[i + 1]);
    else g.lineTo(pts[i], pts[i + 1]);
  }
  g.strokeStyle = on ? '#9fd96b' : '#5d6870';
  g.lineWidth = 1.5;
  g.lineJoin = 'round';
  g.stroke();

  // stage points
  g.fillStyle = on ? '#e8eef2' : '#6c7880';
  const nodes: [number, number][] = [[d, 0], [d + a, 1], [d + a + ho, 1], [pre, env.sustain], [pre + susLen, env.sustain], [total, 0]];
  for (const [t, v] of nodes) {
    g.beginPath();
    g.arc(X(t), Y(v), 2.2, 0, Math.PI * 2);
    g.fill();
  }
  // stage letters
  g.font = `8px ${uiFont()}`;
  g.textAlign = 'center';
  g.textBaseline = 'bottom';
  g.fillStyle = '#5d6870';
  const stages: [string, number, number][] = [['D', 0, d], ['A', d, a], ['H', d + a, ho], ['D', d + a + ho, de], ['S', pre, susLen], ['R', pre + susLen, r]];
  for (const [label, t0, dur] of stages) {
    if ((dur / total) * (w - L - R) >= 9) g.fillText(label, X(t0 + dur / 2), h - 1);
  }
}

// -------------------------------------------------------------------- LFO
function LfoSection({ ch, target, ts, tempo }: { ch: Channel; target: EnvTarget; ts: TimeBase; tempo: number }) {
  const id = ch.id;
  const lfo = ch.sampler.envlfo[target].lfo;
  const def = defaultEnvLfo(target).lfo;
  const name = TARGET_NAMES[target];
  const set = (label: string, r: (l: Draft<LfoSettings>) => void) => editSampler(id, `${name} LFO ${label}`, (d) => r(d.envlfo[target].lfo));
  const tf = (v: number) => fmtStageTime(v, lfo.tempo, tempo, ts);
  const speed = (v: number) => (lfo.tempo ? `${fmtSteps(lfoTempoSteps(v), ts)} per cycle` : fmtLfoHz(lfoHz(v)));
  const tools = (
    <>
      <Pill on={lfo.tempo} label="TEMPO" name={`${name} LFO tempo sync`} set={(v) => set('tempo', (l) => { l.tempo = v; })} />
      <Pill on={lfo.global} label="GLOBAL" name={`${name} LFO global (free running)`} set={(v) => set('global', (l) => { l.global = v; })} />
    </>
  );
  return (
    <Section title="LFO" tools={tools} className="cs-lfo">
      <Cell cap="SHAPE">
        <Segmented value={lfo.shape} options={SHAPES} name={`${name} LFO shape`} set={(v) => set('shape', (l) => { l.shape = v; })} />
      </Cell>
      <KnobCell cap="DEL" label="LFO delay" auto={chAuto(id, `sampler.envlfo.${target}.lfo.delay`)} value={lfo.delay} min={T100} def={def.delay} format={tf}
        menu={stageTimePresets(ts, (x) => set('delay', (l) => { l.delay = x; l.tempo = true; }))}
        set={(v) => set('delay', (l) => { l.delay = v; })} />
      <KnobCell cap="ATT" label="LFO attack" auto={chAuto(id, `sampler.envlfo.${target}.lfo.attack`)} value={lfo.attack} min={T100} def={def.attack} format={tf}
        menu={stageTimePresets(ts, (x) => set('attack', (l) => { l.attack = x; l.tempo = true; }))}
        set={(v) => set('attack', (l) => { l.attack = v; })} />
      <KnobCell cap="AMT" label="LFO amount" auto={chAuto(id, `sampler.envlfo.${target}.lfo.amount`)} value={lfo.amount} min={-1} max={1} bipolar def={def.amount} format={amountFormat(target)}
        arc="#ffb066" set={(v) => set('amount', (l) => { l.amount = v; })} />
      <KnobCell cap="SPD" label="LFO speed" auto={chAuto(id, `sampler.envlfo.${target}.lfo.speed`)} value={lfo.speed} def={def.speed} format={speed}
        menu={speedPresets(ts, (x) => set('speed', (l) => { l.speed = x; l.tempo = true; }))}
        set={(v) => set('speed', (l) => { l.speed = v; })} />
    </Section>
  );
}

// ----------------------------------------------------------------- filter
function FilterSection({ ch }: { ch: Channel }) {
  const s = ch.sampler;
  const id = ch.id;
  const bypass = (type: FilterType, x: number, y: number) => type === 'fastlp' && x >= 0.9999 && y <= 0.0001;
  return (
    <Section title="Filter" className="cs-filter">
      <Cell cap="TYPE">
        <Choice value={s.filterType} options={FILTER_OPTIONS} name="Filter type" width={74}
          onSelect={(v) => editSampler(id, 'Filter type', (d) => { d.filterType = v; })} />
      </Cell>
      <KnobCell cap="MOD X" label="Cutoff" auto={chAuto(id, 'sampler.modX')} value={s.modX} def={D.modX}
        format={(v) => `${formatHz(filterCutoffHz(v))}${bypass(s.filterType, v, s.modY) ? ' (filter bypassed)' : ''}`}
        set={(v) => editSampler(id, 'Filter cutoff', (d) => { d.modX = v; })} />
      <KnobCell cap="MOD Y" label="Resonance" auto={chAuto(id, 'sampler.modY')} value={s.modY} def={D.modY}
        format={(v) => `Q ${filterQ(v).toFixed(2)}${bypass(s.filterType, s.modX, v) ? ' (filter bypassed)' : ''}`}
        set={(v) => editSampler(id, 'Filter resonance', (d) => { d.modY = v; })} />
    </Section>
  );
}
