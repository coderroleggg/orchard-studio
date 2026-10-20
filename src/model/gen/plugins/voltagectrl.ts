// Voltage Controller (FL: Fruity Voltage Controller, Plugin database > Generators > Misc): a generator
// that turns the notes it plays into control voltages for analog hardware: audio-rate DC signals on its
// outputs (four stereo pairs: Main, Out 2, Out 3, Out 4) for a DC-coupled interface. Each of the eight
// output channels (Left / Right of each pair) takes one modulation source, adds an offset and scales:
// out = scale x (source + offset). Form: SynthPanel 302 x 472. Parameters (FL's 16, Tags 0..15): the offset
// of each channel (0..65536, 32768 = 0 V, text "00.000000 Volt(s)") and its scale (0..65536, 65536 = +1,
// text "01.000000"). Everything else is plugin state (docs/research/gen/voltagectrl.md): the sources, note
// colours, polarities, ON, pitch scale, voltage range, clock resolution, pulse length and the extra outputs'
// target mixer tracks.

import type { GenPluginDef } from '../types';
import type { FxParamDef } from '../../fx/types';

/** The modulation sources in the order of FL's combo (the plugin state stores the index). */
export const VC_SOURCES = ['Pitch', 'Gate', 'Trigger', 'Velocity', 'Volume', 'Panning', 'Mod X', 'Mod Y', 'Clock', 'None'] as const;
export const VC_PITCH = 0, VC_GATE = 1, VC_TRIGGER = 2, VC_VELOCITY = 3, VC_VOLUME = 4, VC_PANNING = 5, VC_MODX = 6, VC_MODY = 7, VC_CLOCK = 8, VC_NONE = 9;
/** Output channels: Left / Right of Main, Out 2, Out 3, Out 4. */
export const VC_CHANNELS = 8;
/** The voltage range menu: +/- 5 V, +/- 10 V (default), 0 to 10 V. */
export const VC_RANGES = ['+/- 5 V', '+/- 10 V', '0 to 10 V'] as const;
/** The clock resolutions of the settings menu (pulses per quarter note). */
export const VC_CLOCK_PPQ = [2, 4, 8, 12, 16, 24, 32, 48, 64, 96] as const;
/** The output tabs. */
export const VC_TABS = ['Main', 'Out 2', 'Out 3', 'Out 4'] as const;
/** Largest target mixer track offset of an extra output (FL's field: -125..125). */
export const VC_TARGET_MAX = 125;

/** Full-scale voltage (sample 1.0) of a voltage range: +/- 5 V reaches 5 V, the other two 10 V. */
export const vcFullScale = (range: number) => (range === 0 ? 5 : 10);

/** FL's text of a voltage: sign, two digits, six decimals ("00.000000", "-07.500000"). */
export function vcVoltText(x: number): string {
  const r = Math.round(Math.abs(x) * 1e6) / 1e6;
  const s = r.toFixed(6).padStart(9, '0');
  return (x < 0 && r > 0 ? '-' : '') + s;
}

const offsetText = (v: number, st?: Record<string, unknown>) => {
  const range = typeof st?.range === 'number' ? st.range : 1;
  return `${vcVoltText(((v - 32768) / 32768) * vcFullScale(range))} Volt(s)`;
};
const scaleText = (v: number) => vcVoltText((v - 32768) / 32768);

const SIDES = ['Left', 'Right'];
const OUTS = ['main out', 'out 2', 'out 3', 'out 4'];
/** The key of an output channel's offset / scale parameter (channel 0..7: L main, R main, L out 2, ...). */
export const vcOfsKey = (ch: number) => `ofs${ch}`;
export const vcSclKey = (ch: number) => `scl${ch}`;

function buildParams(): FxParamDef[] {
  const out: FxParamDef[] = [];
  for (let ch = 0; ch < VC_CHANNELS; ch++) {
    out.push({
      key: vcOfsKey(ch), name: `${SIDES[ch & 1]} offset, ${OUTS[ch >> 1]}`, index: ch, min: 0, max: 65536, def: 32768, bipolar: true,
      format: (v, st) => offsetText(v, st),
    });
  }
  for (let ch = 0; ch < VC_CHANNELS; ch++) {
    out.push({
      key: vcSclKey(ch), name: `${SIDES[ch & 1]} scale, ${OUTS[ch >> 1]}`, index: 8 + ch, min: 0, max: 65536, def: 65536, bipolar: true,
      format: scaleText,
    });
  }
  return out;
}

/** FL's plugin database state (a new instance): Main = Pitch + Gate, Out 2 = Velocity + Panning, Out 3 = Mod X + Mod Y, Out 4 unused; output off. */
export function vcDefaultState(): Record<string, unknown> {
  return {
    on: false,
    src: [VC_PITCH, VC_GATE, VC_VELOCITY, VC_PANNING, VC_MODX, VC_MODY, VC_NONE, VC_NONE],
    color: new Array(VC_CHANNELS).fill(1),
    bipolar: new Array(VC_CHANNELS).fill(true),
    range: 1,
    /** Pitch scale in volts per octave (1 V/Oct, 1.2 V/Oct or a custom factor). */
    pitchScale: 1,
    ppq: 24,
    /** Trigger / clock pulse length in ms. */
    pulse: 5,
    /** Target mixer track offsets of Out 2 .. Out 4 (0 = not routed). */
    target: [0, 0, 0],
    automap: false,
    /** The warning dialog (generates continuous DC signals) was dismissed with "Don't show again". */
    warned: false,
    tab: 0,
  };
}

const int = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);
const arr = <T,>(raw: unknown, n: number, f: (v: unknown, i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(Array.isArray(raw) ? raw[i] : undefined, i));

export const def: GenPluginDef = {
  id: 'voltagectrl',
  name: 'Voltage Controller',
  category: 'Misc',
  notes: 'voices',
  defPoly: 1,
  width: 302,
  height: 472,
  description: 'Interfaces with external Control Voltage (CV) hardware',
  params: buildParams(),
  state: vcDefaultState,
  normalize: (p) => {
    const d = vcDefaultState();
    const pitch = typeof p.pitchScale === 'number' && Number.isFinite(p.pitchScale) ? Math.min(100, Math.max(0.01, p.pitchScale)) : 1;
    return {
      ...p,
      on: !!p.on,
      src: arr(p.src, VC_CHANNELS, (v, i) => int(v, 0, VC_SOURCES.length - 1, (d.src as number[])[i])),
      color: arr(p.color, VC_CHANNELS, (v) => int(v, 1, 16, 1)),
      bipolar: arr(p.bipolar, VC_CHANNELS, (v) => (v === undefined ? true : !!v)),
      range: int(p.range, 0, 2, 1),
      pitchScale: pitch,
      ppq: (VC_CLOCK_PPQ as readonly number[]).includes(p.ppq as number) ? (p.ppq as number) : 24,
      pulse: typeof p.pulse === 'number' && Number.isFinite(p.pulse) ? Math.min(1000, Math.max(0.1, p.pulse)) : 5,
      target: arr(p.target, 3, (v) => int(v, -VC_TARGET_MAX, VC_TARGET_MAX, 0)),
      automap: !!p.automap,
      warned: !!p.warned,
      tab: int(p.tab, 0, VC_TABS.length - 1, 0),
    };
  },
  // the editor's tab and the dismissed warning survive preset loads (FL has no factory presets)
  viewState: ['tab', 'warned'],
};
