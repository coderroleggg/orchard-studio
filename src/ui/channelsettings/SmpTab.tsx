// SMP tab (Sample settings): file, content flags, playback, declicking, time
// stretching / pitch shifting, precomputed tools and effects, sample view.

import { useRef, useState, useSyncExternalStore } from 'react';
import { store, host, useProject } from '../../store';
import type { Channel, SampleInfo } from '../../model/types';
import {
  DECLICK_LABELS, declickTimes, defaultSampler, stretchMultiplier,
  type DeclickMode, type SamplerSettings, type StretchMode,
} from '../../model/sampler';
import { keyName } from '../../model/notes';
import { getRaw, onSamplesChanged, samplesVersion, type RawSample } from '../../audio/samples';
import { openMenu, type MenuItem } from '../widgets/ContextMenu';
import { setHint, clearHint } from '../hint';
import {
  Section, Cell, KnobCell, Toggle, Choice, Segmented, editSampler, useViewState, useCanvas, useTimeBase, uiFont,
  type ChoiceOption, type SamplerRecipe, chAuto } from './controls';
import { pct, signedPct, fmtSeconds, fmtCents, fmtBeats } from './format';
import { loadSampleFile, sampleMenuItems, acceptsSampleDrag, dropSample } from './sampleActions';
import { IconFolder, IconMenu } from './icons';

const D = defaultSampler();

const DECLICK_MODES = Object.keys(DECLICK_LABELS) as DeclickMode[];
const DECLICK_OPTIONS: ChoiceOption<DeclickMode>[] = DECLICK_MODES.map((m) => ({ v: m, label: DECLICK_LABELS[m] }));
const BLEEDING: Record<DeclickMode, boolean> = {
  out: false, transient: false, transientBleed: true, generic: true, smooth: true, crossfade: true,
};

const STRETCH_LABELS: Record<StretchMode, string> = {
  resample: 'Resample', stretch: 'Stretch', e3generic: 'E3 Generic', e3mono: 'E3 Mono',
  slicestretch: 'Slice stretch', slicemap: 'Slice map', auto: 'Auto',
};
const STRETCH_GROUPS: { title: string; modes: StretchMode[] }[] = [
  { title: 'Realtime', modes: ['resample', 'stretch'] },
  { title: 'Offline', modes: ['e3generic', 'e3mono'] },
  { title: 'Special', modes: ['slicestretch', 'slicemap', 'auto'] },
];
const STRETCH_OPTIONS: ChoiceOption<StretchMode>[] = STRETCH_GROUPS.flatMap((g) => g.modes.map((m) => ({ v: m, label: STRETCH_LABELS[m] })));

const TIME_BEATS = [0, 1, 2, 4, 8, 16, 32, 64];

export function SmpTab({ ch }: { ch: Channel }) {
  const s = ch.sampler;
  const id = ch.id;
  const info = useProject((p) => (s.sampleId ? p.samples[s.sampleId] : undefined));
  const tempo = useProject((p) => p.tempo);
  const ts = useTimeBase();
  const [dropping, setDropping] = useState(false);
  const set = (label: string, r: SamplerRecipe) => editSampler(id, label, r);
  const dur = info && info.sampleRate > 0 ? info.frames / info.sampleRate : 0;
  const withTime = (v: number) => (dur > 0 ? `${pct(v)} (${fmtSeconds(v * dur)})` : pct(v));

  // ---- time stretching
  const timeOptions: ChoiceOption<number>[] = TIME_BEATS.map((b) => ({ v: b, label: b === 0 ? '(none)' : fmtBeats(b, ts) }));
  const timeMenu = (): MenuItem[] => [
    ...timeOptions.map((o): MenuItem => ({ label: o.label, checked: o.v === s.stretchTimeBeats, radio: true, onClick: () => setTime(o.v) })),
    { separator: true },
    { label: 'Autodetect', disabled: dur <= 0, onClick: () => setTime(Math.pow(2, Math.round(Math.log2(Math.max(1e-3, (dur * tempo) / 60))))) },
    {
      label: 'Type in beats...',
      onClick: () => {
        const v = prompt('Stretch time in beats (0 = none)', String(s.stretchTimeBeats || 4));
        const n = v === null ? NaN : parseFloat(v);
        if (isFinite(n) && n >= 0) setTime(Math.min(512, n));
      },
    },
  ];
  const setTime = (beats: number) => set('Stretch time', (d) => { d.stretchTimeBeats = beats; });
  const modeMenu = (): MenuItem[] => STRETCH_GROUPS.flatMap((g): MenuItem[] => [
    { header: true, label: g.title },
    ...g.modes.map((m): MenuItem => ({ label: STRETCH_LABELS[m], checked: s.stretchMode === m, radio: true, onClick: () => set('Stretch mode', (d) => { d.stretchMode = m; }) })),
  ]);
  const mul = stretchMultiplier(s.stretchMul);
  const outLen = s.stretchTimeBeats > 0 ? ((s.stretchTimeBeats * 60) / tempo) * mul : dur * mul;
  const [fadeInMs, fadeOutMs] = declickTimes(s.declick);

  return (
    <div className={'cs-page' + (dropping ? ' dropping' : '')}
      onDragOver={(e) => {
        if (!acceptsSampleDrag(e.dataTransfer)) return;
        e.preventDefault();
        if (!dropping) setDropping(true);
      }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false); }}
      onDrop={(e) => {
        setDropping(false);
        if (dropSample(id, e.dataTransfer)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }}>
      <FileBar ch={ch} info={info} />

      <div className="cs-row">
        <Section title="Content" className="fixed">
          <div className="cs-grid2">
            <Toggle on={s.keepOnDisk} label="Keep on disk" name="Keep on disk" set={(v) => set('Keep on disk', (d) => { d.keepOnDisk = v; })} />
            <Toggle on={s.resample} label="Resample" name="Resample" set={(v) => set('Resample', (d) => { d.resample = v; })} />
            <Toggle on={s.loadRegions} label="Load regions" name="Load regions" set={(v) => set('Load regions', (d) => { d.loadRegions = v; })} />
            <Toggle on={s.loadSliceMarkers} label="Load slice markers" name="Load slice markers"
              set={(v) => set('Load slice markers', (d) => { d.loadSliceMarkers = v; })} />
          </div>
        </Section>
        {/* an Audio Clip plays its sample once through each clip: the clip sets where it starts and ends, no start offset or loop */}
        {ch.kind !== 'audioclip' && (
          <Section title="Playback" className="fixed">
            <KnobCell cap="START" label="Start offset" auto={chAuto(id, 'sampler.startOffset')} value={s.startOffset} def={D.startOffset} format={withTime}
              set={(v) => set('Start offset', (d) => { d.startOffset = Math.min(0.9999, v); })} />
            <div className="cs-col">
              <Toggle on={s.useLoopPoints} label="Use loop points" name="Use loop points" set={(v) => set('Use loop points', (d) => { d.useLoopPoints = v; })} />
              <Toggle on={s.pingPong} label="Ping pong loop" name="Ping pong loop" set={(v) => set('Ping pong loop', (d) => { d.pingPong = v; })} />
            </div>
          </Section>
        )}
        <Section title="Declicking">
          <div className="cs-col cs-fill">
            <Choice value={s.declick} options={DECLICK_OPTIONS} name="Declicking" onSelect={(v) => set('Declicking', (d) => { d.declick = v; })} />
            <div className="cs-note">
              in {fadeInMs < 1 ? (fadeInMs > 0 ? 'transient' : 'none') : `${fadeInMs} ms`} · out {fadeOutMs} ms{BLEEDING[s.declick] ? ' · bleeding' : ''}
            </div>
          </div>
        </Section>
      </div>

      <Section title="Time stretching / pitch shifting">
        <KnobCell cap="PITCH" label="Pitch shift" auto={chAuto(id, 'sampler.stretchPitch')} value={s.stretchPitch} min={-1200} max={1200} bipolar def={D.stretchPitch} format={fmtCents}
          set={(v) => set('Stretch pitch', (d) => {
            d.stretchPitch = Math.round(v);
            // FL: moving PITCH while in Resample mode switches the mode to Auto
            if (d.stretchMode === 'resample' && d.stretchPitch !== 0) d.stretchMode = 'auto';
          })} />
        <KnobCell cap="MUL" label="Time multiplier" auto={chAuto(id, 'sampler.stretchMul')} value={s.stretchMul} def={D.stretchMul}
          format={(v) => `${Math.round(stretchMultiplier(v) * 100)}%`} set={(v) => set('Time multiplier', (d) => { d.stretchMul = v; })} />
        <Cell cap="TIME">
          <Choice value={s.stretchTimeBeats} options={timeOptions} name="Stretch time" width={78} text={fmtBeats(s.stretchTimeBeats, ts)}
            menuItems={timeMenu} onSelect={setTime} />
        </Cell>
        <Cell cap="MODE">
          <Choice value={s.stretchMode} options={STRETCH_OPTIONS} name="Stretch mode" width={98} menuItems={modeMenu}
            onSelect={(v) => set('Stretch mode', (d) => { d.stretchMode = v; })} />
        </Cell>
        <div className="cs-note cs-push">
          {dur > 0 ? <>Length {fmtSeconds(dur)}{Math.abs(outLen - dur) > 0.0005 ? <> → <b>{fmtSeconds(outLen)}</b></> : null}</> : 'No sample'}
        </div>
      </Section>

      <Precomputed ch={ch} dur={dur} />
      <SampleView ch={ch} info={info} />
    </div>
  );
}

// -------------------------------------------------------------- file bar
function FileBar({ ch, info }: { ch: Channel; info: SampleInfo | undefined }) {
  const menu = (x: number, y: number) => openMenu(x, y, [{ header: true, label: info?.name ?? 'Sample' }, ...sampleMenuItems(ch.id)], { minWidth: 160 });
  return (
    <div className="cs-file">
      <button className="cs-ibtn" tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => { void loadSampleFile(ch.id); }}
        onPointerEnter={() => setHint('Load sample: open a file')} onPointerLeave={clearHint}>
        <IconFolder />
      </button>
      <div className={'cs-file-name' + (info ? '' : ' empty')}
        onClick={() => { void loadSampleFile(ch.id); }}
        onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); menu(e.clientX, e.clientY); }}
        onPointerEnter={() => setHint(`Sample: ${info ? info.name : '(none)'} - click to load a file, right-click for options, or drop a file here`)}
        onPointerLeave={clearHint}>
        {info ? info.name : '(no sample loaded)'}
      </div>
      <button className="cs-ibtn" tabIndex={-1}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          menu(r.left, r.bottom + 1);
        }}
        onPointerEnter={() => setHint('Sample options: load, sample pool, remove')} onPointerLeave={clearHint}>
        <IconMenu />
      </button>
    </div>
  );
}

// ----------------------------------------------------------- precomputed
function Precomputed({ ch, dur }: { ch: Channel; dur: number }) {
  const s = ch.sampler;
  const id = ch.id;
  const [page, setPage] = useViewState<'tools' | 'effects'>(id, 'precomputed', 'tools');
  const set = (label: string, r: SamplerRecipe) => editSampler(id, label, r);
  const offPct = (v: number) => (v <= 0 ? 'off' : pct(v));
  const offTime = (v: number) => (v <= 0 ? 'off' : dur > 0 ? `${pct(v)} (${fmtSeconds(v * dur)})` : pct(v));
  const tabs = (
    <Segmented value={page} name="Precomputed" set={setPage} options={[
      { v: 'tools', label: 'TOOLS', hint: 'tools' },
      { v: 'effects', label: 'EFFECTS', hint: 'effects' },
    ]} />
  );
  return (
    <Section title="Precomputed" tools={tabs} className="cs-pre">
      {page === 'tools' ? (
        <>
          <div className="cs-grid2">
            <Toggle on={s.removeDC} label="Remove DC offset" name="Remove DC offset" set={(v) => set('Remove DC offset', (d) => { d.removeDC = v; })} />
            <Toggle on={s.normalize} label="Normalize" name="Normalize" set={(v) => set('Normalize', (d) => { d.normalize = v; })} />
            <Toggle on={s.reversePolarity} label="Reverse polarity" name="Reverse polarity" set={(v) => set('Reverse polarity', (d) => { d.reversePolarity = v; })} />
            <Toggle on={s.fadeStereo} label="Fade stereo" name="Fade stereo" set={(v) => set('Fade stereo', (d) => { d.fadeStereo = v; })} />
            <Toggle on={s.reverse} label="Reverse" name="Reverse" set={(v) => set('Reverse', (d) => { d.reverse = v; })} />
            <Toggle on={s.swapStereo} label="Swap stereo" name="Swap stereo" set={(v) => set('Swap stereo', (d) => { d.swapStereo = v; })} />
          </div>
          <div className="cs-knobs cs-push">
            <KnobCell cap="SMP START" label="Sample start" value={s.smpStart} def={D.smpStart} format={(v) => (dur > 0 ? `${pct(v)} (${fmtSeconds(v * dur)})` : pct(v))}
              set={(v) => set('Sample start', (d) => { d.smpStart = v; })} />
            <KnobCell cap="LENGTH" label="Length" value={s.length} def={D.length} format={pct} set={(v) => set('Sample length', (d) => { d.length = v; })} />
            <KnobCell cap="IN" label="Fade in" value={s.fadeIn} def={D.fadeIn} format={offTime} set={(v) => set('Fade in', (d) => { d.fadeIn = v; })} />
            <KnobCell cap="OUT" label="Fade out" value={s.fadeOut} def={D.fadeOut} format={offTime} set={(v) => set('Fade out', (d) => { d.fadeOut = v; })} />
            <KnobCell cap="CROSSFADE" label="Loop crossfade" value={s.crossfade} def={D.crossfade} format={offPct}
              set={(v) => set('Loop crossfade', (d) => { d.crossfade = v; })} />
            <KnobCell cap="TRIM" label="Trim threshold" value={s.trim} def={D.trim} format={(v) => (v <= 0 ? '0% (digital silence only)' : pct(v))}
              set={(v) => set('Trim threshold', (d) => { d.trim = v; })} />
          </div>
        </>
      ) : (
        <div className="cs-knobs">
          <KnobCell cap="BOOST" label="Boost" value={s.boost} def={D.boost} format={offPct} set={(v) => set('Boost', (d) => { d.boost = v; })} />
          <Cell cap="CLIP">
            <Toggle on={s.clip} label="" name="Clip" className="solo" set={(v) => set('Clip', (d) => { d.clip = v; })} />
          </Cell>
          <KnobCell cap="EQ" label="EQ (tilt)" value={s.eq} def={D.eq} bipolar
            format={(v) => (Math.abs(v - 0.5) < 0.005 ? 'flat' : v > 0.5 ? `boost highs ${Math.round((v - 0.5) * 200)}%` : `cut highs ${Math.round((0.5 - v) * 200)}%`)}
            set={(v) => set('EQ', (d) => { d.eq = v; })} />
          <KnobCell cap="RM MIX" label="Ring mod mix" value={s.rmMix} def={D.rmMix} format={offPct} set={(v) => set('Ring mod mix', (d) => { d.rmMix = v; })} />
          <KnobCell cap="RM FREQ" label="Ring mod frequency" value={s.rmFreq} def={D.rmFreq} format={pct} set={(v) => set('Ring mod frequency', (d) => { d.rmFreq = v; })} />
          <KnobCell cap="CUT" label="Lowpass cutoff" value={s.cut} def={D.cut} format={(v) => (v >= 0.999 ? 'open' : pct(v))} set={(v) => set('Precomputed cutoff', (d) => { d.cut = v; })} />
          <KnobCell cap="RES" label="Lowpass resonance" value={s.res} def={D.res} format={pct} set={(v) => set('Precomputed resonance', (d) => { d.res = v; })} />
          <div className="cs-reverb">
            <KnobCell cap="REVERB" label="Reverb mix" value={s.reverbMix} def={D.reverbMix} format={offPct} set={(v) => set('Reverb mix', (d) => { d.reverbMix = v; })} />
            <Segmented vertical value={s.reverbType} name="Reverb type" set={(v) => set('Reverb type', (d) => { d.reverbType = v; })} options={[
              { v: 'A', label: 'A', hint: 'A (closer, tighter)' },
              { v: 'B', label: 'B', hint: 'B (farther, larger)' },
            ]} />
          </div>
          <KnobCell cap="STEREO DELAY" label="Stereo delay" value={s.stereoDelay} min={-1} max={1} bipolar def={D.stereoDelay}
            format={(v) => (Math.abs(v) < 0.005 ? 'none' : `${pct(Math.abs(v))} (${v > 0 ? 'left' : 'right'} channel earlier)`)}
            set={(v) => set('Stereo delay', (d) => { d.stereoDelay = v; })} />
          <KnobCell cap="POGO" label="Pogo" value={s.pogo} min={-1} max={1} bipolar def={D.pogo}
            format={(v) => (Math.abs(v) < 0.005 ? 'none' : `${signedPct(v)} (${v < 0 ? 'attack' : 'tail'})`)}
            set={(v) => set('Pogo', (d) => { d.pogo = v; })} />
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------ sample view
type Marker = 'start' | 'loopStart' | 'loopEnd';
const MARKER_NAMES: Record<Marker, string> = { start: 'Start offset', loopStart: 'Loop start', loopEnd: 'Loop end' };
const MIN_LOOP = 0.001;

interface Peaks {
  min: Float32Array[];
  max: Float32Array[];
}

// Min / max envelopes: one base resolution per sample (computed once from the
// audio), reduced to the canvas column count on demand (cheap on resize).
const BASE_BINS = 16384;
const baseCache = new WeakMap<Float32Array, Peaks>();
const colCache = new Map<string, Peaks>();
const dataIds = new WeakMap<Float32Array, number>();
let nextDataId = 1;

function dataId(a: Float32Array): number {
  let n = dataIds.get(a);
  if (!n) {
    n = nextDataId++;
    dataIds.set(a, n);
  }
  return n;
}

function reduce(mins: Float32Array, maxs: Float32Array, n: number, cols: number): [Float32Array, Float32Array] {
  const mn = new Float32Array(cols), mx = new Float32Array(cols);
  for (let x = 0; x < cols; x++) {
    const a = Math.min(n - 1, Math.floor((x * n) / cols));
    const b = Math.min(n, Math.max(a + 1, Math.floor(((x + 1) * n) / cols)));
    let lo = Infinity, hi = -Infinity;
    for (let i = a; i < b; i++) {
      if (mins[i] < lo) lo = mins[i];
      if (maxs[i] > hi) hi = maxs[i];
    }
    mn[x] = lo === Infinity ? 0 : lo;
    mx[x] = hi === -Infinity ? 0 : hi;
  }
  return [mn, mx];
}

function basePeaks(raw: RawSample): Peaks {
  const k = raw.channels[0];
  const hit = baseCache.get(k);
  if (hit) return hit;
  const chans = raw.channels.slice(0, 2);
  const n = chans[0].length;
  const bins = Math.max(1, Math.min(n, BASE_BINS));
  const out: Peaks = { min: [], max: [] };
  for (const c of chans) {
    const [mn, mx] = reduce(c, c, n, bins);
    out.min.push(mn);
    out.max.push(mx);
  }
  baseCache.set(k, out);
  return out;
}

function getPeaks(raw: RawSample, cols: number): Peaks {
  const key = raw.channels.slice(0, 2).map((c) => dataId(c)).join(',') + ':' + cols;
  const hit = colCache.get(key);
  if (hit) return hit;
  const base = basePeaks(raw);
  const bins = base.min[0].length;
  const out: Peaks = { min: [], max: [] };
  base.min.forEach((mins, ci) => {
    const [mn, mx] = reduce(mins, base.max[ci], bins, cols);
    out.min.push(mn);
    out.max.push(mx);
  });
  colCache.set(key, out);
  if (colCache.size > 12) {
    const first = colCache.keys().next().value;
    if (first !== undefined) colCache.delete(first);
  }
  return out;
}

interface Stats {
  dc: number[];
  peak: number; // max |x|
  peakDc: number; // max |x - dc|
}
const statCache = new WeakMap<Float32Array, Stats>();

function getStats(raw: RawSample): Stats {
  const k = raw.channels[0];
  const hit = statCache.get(k);
  if (hit) return hit;
  const chans = raw.channels.slice(0, 2);
  const dc = chans.map((c) => {
    let sum = 0;
    for (let i = 0; i < c.length; i++) sum += c[i];
    return c.length ? sum / c.length : 0;
  });
  let peak = 0, peakDc = 0;
  chans.forEach((c, ci) => {
    const m = dc[ci];
    for (let i = 0; i < c.length; i++) {
      const a = Math.abs(c[i]);
      if (a > peak) peak = a;
      const b = Math.abs(c[i] - m);
      if (b > peakDc) peakDc = b;
    }
  });
  const st = { dc, peak, peakDc };
  statCache.set(k, st);
  return st;
}

/** Linear fade gain at position p (0..1 of the source) for the precomputed IN / OUT fades. */
function fadeAt(p: number, fi: number, fo: number): number {
  let f = 1;
  if (fi > 0 && p < fi) f *= p / fi;
  if (fo > 0 && p > 1 - fo) f *= (1 - p) / fo;
  return Math.max(0, f);
}

/**
 * Draw the sample as the engine plays it: the main precomputed tools (DC,
 * normalize, polarity, swap, fades, reverse) are applied to the peaks, the
 * trimmed area and the area before the start offset are dimmed, the start /
 * loop markers are drawn in red and bleeding declick fades in orange.
 */
function drawWave(g: CanvasRenderingContext2D, w: number, h: number, dpr: number, raw: RawSample | undefined, s: SamplerSettings, hot: Marker | null) {
  g.fillStyle = '#15181b';
  g.fillRect(0, 0, w, h);
  g.font = `10px ${uiFont()}`;
  if (!raw || !raw.channels.length || !raw.channels[0].length) {
    g.fillStyle = '#5d6870';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(s.sampleId ? 'Sample data not available' : 'No sample - drop an audio file here or click the folder button', w / 2, h / 2);
    return;
  }
  const cols = Math.max(1, Math.min(4096, Math.round(w * dpr)));
  const peaks = getPeaks(raw, cols);
  const nch = peaks.min.length;
  const st = s.removeDC || s.normalize ? getStats(raw) : null;
  const gain = s.normalize && st ? 1 / Math.max(1e-6, s.removeDC ? st.peakDc : st.peak) : 1;
  const pol = s.reversePolarity ? -1 : 1;
  const laneH = h / nch;
  const top = new Float32Array(cols), bot = new Float32Array(cols);

  for (let li = 0; li < nch; li++) {
    const src = s.swapStereo && nch === 2 ? 1 - li : li;
    const mid = laneH * (li + 0.5);
    const amp = laneH / 2 - 2;
    const dc = s.removeDC && st ? st.dc[src] : 0;
    g.fillStyle = '#262c31';
    g.fillRect(0, Math.floor(mid), w, 1);
    if (li > 0) {
      g.fillStyle = '#20252a';
      g.fillRect(0, Math.floor(laneH * li), w, 1);
    }
    for (let x = 0; x < cols; x++) {
      const sx = s.reverse ? cols - 1 - x : x;
      const f = fadeAt((sx + 0.5) / cols, s.fadeIn, s.fadeOut) * gain * pol;
      let lo = (peaks.min[src][sx] - dc) * f;
      let hi = (peaks.max[src][sx] - dc) * f;
      if (pol < 0) { const t = lo; lo = hi; hi = t; }
      top[x] = mid - Math.min(1, hi) * amp;
      bot[x] = mid - Math.max(-1, lo) * amp;
    }
    g.beginPath();
    g.moveTo(0, top[0]);
    for (let x = 1; x < cols; x++) g.lineTo(x / dpr, top[x]);
    for (let x = cols - 1; x >= 0; x--) g.lineTo(x / dpr, Math.max(bot[x], top[x] + 1 / dpr));
    g.closePath();
    g.fillStyle = '#93cf6c';
    g.fill();
  }

  const X = (f: number) => f * w;
  // trimmed by SMP START / LENGTH (source positions, so mirrored when reversed)
  let t0 = s.smpStart, t1 = s.smpStart + (1 - s.smpStart) * s.length;
  if (s.reverse) [t0, t1] = [1 - t1, 1 - t0];
  g.fillStyle = 'rgba(8, 10, 12, 0.62)';
  if (t0 > 0) g.fillRect(0, 0, X(t0), h);
  if (t1 < 1) g.fillRect(X(t1), 0, w - X(t1), h);
  // before the start offset
  if (s.startOffset > 0) {
    g.fillStyle = 'rgba(0, 0, 0, 0.4)';
    g.fillRect(0, 0, X(s.startOffset), h);
  }

  const marker = (x: number, kind: Marker, enabled: boolean) => {
    const xx = Math.min(w - 0.5, Math.round(x) + 0.5);
    const col = !enabled ? 'rgba(255, 90, 90, 0.45)' : hot === kind ? '#ff9b8f' : '#ff5a5a';
    g.strokeStyle = col;
    g.fillStyle = col;
    g.lineWidth = hot === kind ? 2 : 1;
    g.beginPath();
    g.moveTo(xx, 0);
    g.lineTo(xx, h);
    g.stroke();
    g.beginPath();
    if (kind === 'start') { g.moveTo(xx - 4.5, h); g.lineTo(xx + 4.5, h); g.lineTo(xx, h - 6); }
    else if (kind === 'loopStart') { g.moveTo(xx, 0); g.lineTo(xx + 7, 0); g.lineTo(xx, 7); }
    else { g.moveTo(xx, 0); g.lineTo(xx - 7, 0); g.lineTo(xx, 7); }
    g.closePath();
    g.fill();
  };

  const frames = raw.channels[0].length;
  const dur = frames / raw.sampleRate;
  // declick fades of the bleeding modes run past the start / end points
  if (BLEEDING[s.declick] && dur > 0) {
    const [fi, fo] = declickTimes(s.declick);
    const xs = X(s.startOffset);
    const fiW = Math.max(2, (fi / 1000 / dur) * w), foW = Math.max(2, (fo / 1000 / dur) * w);
    g.strokeStyle = 'rgba(255, 159, 67, 0.85)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(xs - fiW, h - 1);
    g.lineTo(xs, 1);
    g.moveTo(w - foW, 1);
    g.lineTo(w, h - 1);
    g.stroke();
  }

  if (s.useLoopPoints) {
    const a = X(Math.min(s.loopStart, s.loopEnd)), b = X(Math.max(s.loopStart, s.loopEnd));
    g.fillStyle = 'rgba(255, 90, 90, 0.08)';
    g.fillRect(a, 0, b - a, h);
    marker(a, 'loopStart', !s.pingPong);
    marker(b, 'loopEnd', !s.pingPong);
  }
  marker(X(s.startOffset), 'start', true);

  // format readout (lower right)
  const txt = `${(raw.sampleRate / 1000).toFixed(1)} kHz · ${nch > 1 ? 'stereo' : 'mono'} · 32-bit · ${fmtSeconds(dur)}`;
  g.font = `9px ${uiFont()}`;
  const tw = g.measureText(txt).width;
  g.fillStyle = 'rgba(21, 24, 27, 0.78)';
  g.fillRect(w - tw - 9, h - 13, tw + 9, 13);
  g.fillStyle = '#8b979f';
  g.textAlign = 'right';
  g.textBaseline = 'middle';
  g.fillText(txt, w - 4, h - 6.5);
}

function SampleView({ ch, info }: { ch: Channel; info: SampleInfo | undefined }) {
  const s = ch.sampler;
  const id = ch.id;
  const version = useSyncExternalStore(onSamplesChanged, samplesVersion);
  const raw = s.sampleId ? getRaw(s.sampleId) : undefined;
  const [hot, setHot] = useState<Marker | null>(null);
  const drag = useRef<{ m: Marker; x0: number; ls: number; le: number } | null>(null);
  const preview = useRef<{ key: number; tag: number } | null>(null);
  const ref = useCanvas((g, w, h, dpr) => drawWave(g, w, h, dpr, raw, s, hot), [
    raw, version, hot, s.startOffset, s.useLoopPoints, s.loopStart, s.loopEnd, s.pingPong, s.reverse, s.reversePolarity,
    s.normalize, s.removeDC, s.swapStereo, s.fadeIn, s.fadeOut, s.smpStart, s.length, s.declick,
  ]);
  const dur = raw ? raw.channels[0].length / raw.sampleRate : 0;
  const posText = (v: number) => (dur > 0 ? `${pct(v)} (${fmtSeconds(v * dur)})` : pct(v));

  // positions inside the canvas content box (the bitmap excludes the border)
  const locate = (e: React.PointerEvent | React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement;
    const r = el.getBoundingClientRect();
    return { x: e.clientX - r.left - el.clientLeft, w: Math.max(1, el.clientWidth) };
  };

  const markerAt = (x: number, w: number): Marker | null => {
    const cands: [Marker, number][] = [['start', s.startOffset * w]];
    if (s.useLoopPoints && !s.pingPong) cands.push(['loopStart', s.loopStart * w], ['loopEnd', s.loopEnd * w]);
    let best: Marker | null = null;
    let bd = 5;
    for (const [m, mx] of cands) {
      const d = Math.abs(mx - x);
      if (d <= bd) { bd = d; best = m; }
    }
    return best;
  };

  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || e.ctrlKey || !raw) return; // macOS ctrl+click is a right-click
    e.preventDefault();
    const { x, w } = locate(e);
    e.currentTarget.setPointerCapture(e.pointerId);
    const m = markerAt(x, w);
    if (m) {
      drag.current = { m, x0: x, ls: s.loopStart, le: s.loopEnd };
      store.beginGesture(m === 'start' ? 'Start offset' : 'Loop points');
      return;
    }
    preview.current = { key: s.rootKey, tag: host.noteOn(id, s.rootKey, 100) };
    setHint(`Preview: ${keyName(s.rootKey)} (root note)`);
  };

  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, w } = locate(e);
    const d = drag.current;
    if (d) {
      const v = Math.max(0, Math.min(1, x / w));
      if (d.m === 'start') {
        const nv = Math.min(0.9999, v);
        editSampler(id, 'Start offset', (sd) => { sd.startOffset = nv; });
        setHint(`Start offset: ${posText(nv)}`);
      } else if (e.shiftKey) {
        const len = Math.abs(d.le - d.ls);
        const ns = Math.max(0, Math.min(1 - len, Math.min(d.ls, d.le) + (x - d.x0) / w));
        editSampler(id, 'Loop points', (sd) => { sd.loopStart = ns; sd.loopEnd = ns + len; });
        setHint(`Loop: ${posText(ns)} to ${posText(ns + len)}`);
      } else if (d.m === 'loopStart') {
        const nv = Math.max(0, Math.min(v, s.loopEnd - MIN_LOOP));
        editSampler(id, 'Loop points', (sd) => { sd.loopStart = nv; });
        setHint(`Loop start: ${posText(nv)}`);
      } else {
        const nv = Math.min(1, Math.max(v, s.loopStart + MIN_LOOP));
        editSampler(id, 'Loop points', (sd) => { sd.loopEnd = nv; });
        setHint(`Loop end: ${posText(nv)}`);
      }
      return;
    }
    if (preview.current) return;
    const m = raw ? markerAt(x, w) : null;
    if (m !== hot) setHot(m);
    if (m) {
      const v = m === 'start' ? s.startOffset : m === 'loopStart' ? s.loopStart : s.loopEnd;
      setHint(`${MARKER_NAMES[m]}: ${posText(v)} - drag to move${m === 'start' ? '' : ' (Shift: move both)'}`);
    } else if (raw) {
      setHint(`Sample: ${info?.name ?? raw.name} - click to preview, drag the red markers, right-click for options`);
    } else {
      setHint('Sample: none - drop an audio file here or right-click to load one');
    }
  };

  const onUp = () => {
    if (drag.current) {
      drag.current = null;
      store.endGesture();
    }
    const p = preview.current;
    if (p) {
      host.noteOff(id, p.key, p.tag);
      preview.current = null;
    }
  };

  const onContextMenu = (e: React.MouseEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const loopReset = (): [number, number] => {
      if (info && info.frames > 0 && info.loopStart !== undefined && info.loopEnd !== undefined) {
        return [info.loopStart / info.frames, info.loopEnd / info.frames];
      }
      return [0, 1];
    };
    openMenu(e.clientX, e.clientY, [
      { header: true, label: info?.name ?? 'Sample' },
      ...sampleMenuItems(id),
      { separator: true },
      { label: 'Use loop points', checked: s.useLoopPoints, onClick: () => editSampler(id, 'Use loop points', (d) => { d.useLoopPoints = !d.useLoopPoints; }) },
      { label: 'Ping pong loop', checked: s.pingPong, onClick: () => editSampler(id, 'Ping pong loop', (d) => { d.pingPong = !d.pingPong; }) },
      {
        label: 'Reset loop points', disabled: !raw,
        onClick: () => { const [a, b] = loopReset(); editSampler(id, 'Loop points', (d) => { d.loopStart = a; d.loopEnd = b; }); },
      },
      { label: 'Reset start offset', disabled: s.startOffset === 0, onClick: () => editSampler(id, 'Start offset', (d) => { d.startOffset = 0; }) },
    ], { minWidth: 170 });
  };

  return (
    <canvas ref={ref} className={'cs-wave' + (hot ? ' hot' : '')}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onLostPointerCapture={onUp}
      onContextMenu={onContextMenu}
      onPointerLeave={() => {
        if (drag.current || preview.current) return;
        if (hot) setHot(null);
        clearHint();
      }} />
  );
}

