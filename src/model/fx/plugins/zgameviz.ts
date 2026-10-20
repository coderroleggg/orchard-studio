// ZGameEditor Visualizer (FL: ZGameEditor Visualizer), reduced. FL's plugin
// hosts ZGameEditor projects (hundreds of OpenGL shader effects) in up to 100
// layers and renders them to a video window. This version keeps its main
// window layout, layer columns (effect, enable, parameter sliders, layer
// menu), the right-hand panel (freeze, window mode, frame rate, aspect ratio,
// rotate, zoom) and FL's parameter indexing, with 17 built-in audio-reactive
// effects named after FL's (drawn with Canvas 2D) and 8 layers at most.
//
// FL parameters (host): 0 Camera zoom, 1 Camera angle (0..65535), then for
// layer n (A = 0): 16 + 48n "Layer A - Effect select", 20 + 48n "Layer A -
// Enabled" (65535 = on) and 32 + 48n + k "Layer A - Parameter k" (0..65535).
// FL's value texts are empty except "(none)" for an empty effect select.

import type { FxParamDef, FxPluginDef, FxPreset } from '../types';

export const ZGE_LAYERS = 8;
export const ZGE_PARAMS = 16;
export const ZGE_MAX = 65535;
export const LAYER_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export interface ZgeParamDef {
  name: string;
  /** Default 0..1. */
  def: number;
  kind?: 'checkbox' | 'list';
  items?: string[];
}

export interface ZgeEffect {
  id: string;
  name: string;
  category: string;
  params: ZgeParamDef[];
}

const hsl = (h: number, s: number, l: number, a = 0): ZgeParamDef[] => [
  { name: 'Alpha', def: a }, { name: 'Hue', def: h }, { name: 'Saturation', def: s }, { name: 'Lightness', def: l },
];
const p = (name: string, def: number): ZgeParamDef => ({ name, def });
const check = (name: string, def: number): ZgeParamDef => ({ name, def, kind: 'checkbox' });
const list = (name: string, items: string[], def: number): ZgeParamDef => ({ name, def, kind: 'list', items });

/** Built-in effects (index 0 = none). Parameter names and order follow FL's effects of the same name. */
export const ZGE_EFFECTS: ZgeEffect[] = [
  { id: 'none', name: '(none)', category: '', params: [] },
  { id: 'solid', name: 'SolidColor', category: 'Background', params: hsl(0.6, 0.4, 0.08) },
  { id: 'grid', name: 'Grid', category: 'Background', params: [...hsl(0.55, 0.6, 0.45), p('Soft Edge X', 0.3), p('Soft Edge Y', 0.3), p('Resolution', 0.3)] },
  { id: 'stars', name: 'ItsFullOfStars', category: 'Background', params: [...hsl(0.6, 0.2, 0.85), p('Size', 0.4), p('Position X', 0.5), p('Position Y', 0.5), p('Movement', 0.3), p('Centrality', 0.5), p('Holding', 0.3), p('Peakishness', 0.5)] },
  { id: 'linear', name: 'Linear', category: 'Peak Effects', params: [...hsl(0.55, 0.65, 0.5), p('Size', 0.6), p('Position X', 0.5), p('Position Y', 0.5), p('Bands', 0.3), p('Rotation', 0), p('Gradient', 0.5), p('Gap Width', 0.25), p('Power', 0.45), p('Polarity', 0), check('Hide Floor', 0), list('Draw', ['Curve', 'Bars'], 1)] },
  { id: 'polar', name: 'Polar', category: 'Peak Effects', params: [...hsl(0.82, 0.7, 0.55), p('Radius', 0.35), p('Position x', 0.5), p('Position y', 0.5), p('Bands', 0.45), p('Polarity', 0), p('Threshold', 0.05), p('Magnitude', 0.5), p('Thickness', 0.35), p('Softness', 0.2), p('Rotation', 0)] },
  { id: 'wave', name: 'WaveSimple', category: 'Peak Effects', params: [...hsl(0.33, 0.6, 0.6), p('Size', 0.5), p('Position X', 0.5), p('Position Y', 0.5), p('Thickness', 0.25), p('Rotation', 0)] },
  { id: 'vector', name: 'VectorScope', category: 'Peak Effects', params: [...hsl(0.1, 0.75, 0.6), p('Size', 0.55), p('Line Width', 0.25), list('Aspect Ratio', ['4:3', '16:9', 'Full Screen'], 1), check('Vector Color', 1)] },
  { id: 'sphere', name: 'Reactive Sphere', category: 'Peak Effects', params: [...hsl(0.62, 0.6, 0.5), p('Size', 0.45), p('Position X', 0.5), p('Position Y', 0.5), p('Speed', 0.3), p('Power', 0.5), check('Less Power', 0)] },
  { id: 'blobs', name: 'ColorBlobs', category: 'Particles', params: [...hsl(0.9, 0.7, 0.55), p('Size', 0.5), p('Position X', 0.5), p('Position Y', 0.5), p('Point Size', 0.4), p('Sound Influence', 0.6), p('Speed', 0.4)] },
  { id: 'freqring', name: 'FreqRing', category: 'Canvas effects', params: [...hsl(0.5, 0.65, 0.55), p('Size', 0.5), p('Position X', 0.5), p('Position Y', 0.5), p('Point Size', 0.3), p('Rotation', 0), p('Pattern', 0.3), p('Density', 0.5), p('Activity', 0.5), p('Hue Slur', 0.3), p('Slur Speed', 0.3)] },
  { id: 'tube', name: 'Oldschool Tube', category: 'Tunnel', params: [...hsl(0.6, 0.6, 0.5), p('Speed', 0.4)] },
  { id: 'warpback', name: 'WarpBack', category: 'Feedback', params: [...hsl(0, 0, 0, 0.15), p('Position X', 0.5), p('Position Y', 0.5), p('Warp', 0.5)] },
  { id: 'text', name: 'TextDraw', category: 'Text', params: [...hsl(0, 0, 1), p('Size', 0.3), p('Position X', 0.5), p('Position Y', 0.5), p('Angle', 0.5), p('Text Line', 0), p('Glitch', 0.1)] },
  { id: 'blur', name: 'Blur', category: 'Postprocess', params: [p('Amount', 0.15)] },
  { id: 'rgbshift', name: 'RGB Shift', category: 'Postprocess', params: [p('Amount', 0.2), p('Angle', 0), check('Transparent', 0)] },
  { id: 'scanlines', name: 'ScanLines', category: 'Postprocess', params: [list('Scanlines X', ['0', '2', '4', '8', '10', '16', '20', '24', '32', '40', '48', '64', '96', '128'], 0), list('Scanlines Y', ['0', '2', '4', '8', '10', '16', '20', '24', '32', '40', '48', '64', '96', '128'], 2 / 13), p('Fade Edge X', 0), p('Fade Edge Y', 0), p('Threshold', 0.5)] },
  { id: 'vignette', name: 'Vignette', category: 'Postprocess', params: [...hsl(0, 0, 0), p('Outer radius', 0.8), p('Inner radius', 0.3)] },
];

export const ZGE_CATEGORIES = [...new Set(ZGE_EFFECTS.slice(1).map((e) => e.category))];

/** Parameter keys of layer n. */
export const zk = {
  fx: (n: number) => `l${n}fx`,
  on: (n: number) => `l${n}on`,
  p: (n: number, k: number) => `l${n}p${k}`,
};

/** A list parameter's value (0..1) <-> item index. */
export function zListIndex(v01: number, items: number): number {
  return Math.max(0, Math.min(items - 1, Math.round(v01 * (items - 1))));
}

/** Parameter values (0..1) of an effect's defaults, as FL control units. */
export function zgeDefaults(effect: number): number[] {
  const e = ZGE_EFFECTS[effect] ?? ZGE_EFFECTS[0];
  return Array.from({ length: ZGE_PARAMS }, (_, k) => Math.round((e.params[k]?.def ?? 0) * ZGE_MAX));
}

function layerParams(n: number): FxParamDef[] {
  const L = LAYER_LETTERS[n];
  const out: FxParamDef[] = [
    { key: zk.fx(n), name: `Layer ${L} - Effect select`, index: 16 + 48 * n, min: 0, max: ZGE_EFFECTS.length - 1, def: 0, options: ZGE_EFFECTS.map((e) => (e.category ? `${e.category}/${e.name}` : e.name)), format: (v) => (Math.round(v) === 0 ? '(none)' : ZGE_EFFECTS[Math.round(v)]?.name ?? '') },
    { key: zk.on(n), name: `Layer ${L} - Enabled`, index: 20 + 48 * n, min: 0, max: ZGE_MAX, def: ZGE_MAX, format: () => '' },
  ];
  for (let k = 0; k < ZGE_PARAMS; k++) out.push({ key: zk.p(n, k), name: `Layer ${L} - Parameter ${k}`, index: 32 + 48 * n + k, min: 0, max: ZGE_MAX, def: 0, format: () => '' });
  return out;
}

export const ZGE_WINDOW_MODES = ['Attached', 'Detached', 'Wallpaper'];
/** FL's "Max" frame rate list (FL Default preset: FPS=1 = 30). */
export const ZGE_FPS = [15, 30, 60, 75, 90, 120, 144];
/** FL's aspect ratio list (FL Default preset: AspectRatio=16:9). */
export const ZGE_ASPECTS = ['4:3', '16:9', '4:5', '9:16', '1:1'];
export const ZGE_ASPECT_VALUES = [4 / 3, 16 / 9, 4 / 5, 9 / 16, 1];
/** "Render to buffer quality" (shown when TO BUFFER is on). */
export const ZGE_RQ = ['100%', '50%', '25%', '128px', '256px', '512px', '1024px'];
export const ZGE_DEFAULT_TEXT = ['This is the default text.'];

export interface ZgeLayerState {
  name: string;
  collapsed: boolean;
  toBuffer: boolean;
  /** Render to buffer quality (index into ZGE_RQ). */
  rq: number;
  /** IMAGE SRC: index of the layer whose buffer feeds this one, -1 = (none). */
  imgSrc: number;
}

export const emptyLayerState = (): ZgeLayerState => ({ name: '', collapsed: false, toBuffer: false, rq: 0, imgSrc: -1 });

function layerState(r: Partial<ZgeLayerState> | undefined): ZgeLayerState {
  return {
    name: typeof r?.name === 'string' ? r.name.slice(0, 40) : '',
    collapsed: !!r?.collapsed,
    toBuffer: !!r?.toBuffer,
    rq: Math.max(0, Math.min(ZGE_RQ.length - 1, Math.round(Number(r?.rq) || 0))),
    imgSrc: Number.isInteger(r?.imgSrc) && (r!.imgSrc as number) >= 0 && (r!.imgSrc as number) < ZGE_LAYERS ? (r!.imgSrc as number) : -1,
  };
}

export function zgeState(p: Record<string, unknown>) {
  const n = Math.max(1, Math.min(ZGE_LAYERS, Math.round(Number(p.layerCount) || 1)));
  const raw = Array.isArray(p.layers) ? (p.layers as Partial<ZgeLayerState>[]) : [];
  const layers: ZgeLayerState[] = Array.from({ length: ZGE_LAYERS }, (_, i) => layerState(raw[i]));
  const r = Array.isArray(p.rect) && p.rect.length === 4 ? (p.rect as number[]).map((x) => Math.round(Number(x) || 0)) : [1005, 207, 689, 577];
  const int = (v: unknown, def: number, max: number) => Math.max(0, Math.min(max, Math.round(Number(v ?? def)) || 0));
  return {
    layerCount: n,
    layers,
    windowMode: int(p.windowMode, 1, ZGE_WINDOW_MODES.length - 1),
    fps: int(p.fps, 1, ZGE_FPS.length - 1),
    aspect: int(p.aspect, 1, ZGE_ASPECTS.length - 1),
    freeze: !!p.freeze,
    visible: p.visible === undefined ? true : !!p.visible,
    antialias: p.antialias === undefined ? true : !!p.antialias,
    autoCollapse: !!p.autoCollapse,
    gamut: !!p.gamut,
    text: Array.isArray(p.text) ? (p.text as unknown[]).map((t) => String(t).slice(0, 200)).slice(0, 64) : [...ZGE_DEFAULT_TEXT],
    rect: r,
  };
}
export type ZgeState = ReturnType<typeof zgeState>;

/** A layer's parameter values (FL units) and state, for copy / paste and the layer operations. */
export interface ZgeLayerData { fx: number; on: number; vals: number[]; state: ZgeLayerState }

export function zgeReadLayer(p: Record<string, unknown>, n: number): ZgeLayerData {
  const num = (k: string, d: number) => (typeof p[k] === 'number' ? (p[k] as number) : d);
  const raw = Array.isArray(p.layers) ? (p.layers as Partial<ZgeLayerState>[]) : [];
  return {
    fx: Math.max(0, Math.min(ZGE_EFFECTS.length - 1, Math.round(num(zk.fx(n), 0)))),
    on: num(zk.on(n), ZGE_MAX),
    vals: Array.from({ length: ZGE_PARAMS }, (_, k) => num(zk.p(n, k), 0)),
    state: layerState(raw[n]),
  };
}

export function zgeWriteLayer(p: Record<string, unknown>, n: number, d: ZgeLayerData): void {
  p[zk.fx(n)] = d.fx;
  p[zk.on(n)] = d.on;
  d.vals.forEach((v, k) => { p[zk.p(n, k)] = v; });
  const layers = (Array.isArray(p.layers) ? (p.layers as Partial<ZgeLayerState>[]) : []).slice();
  while (layers.length < ZGE_LAYERS) layers.push(emptyLayerState());
  layers[n] = { ...d.state };
  p.layers = layers;
}

export const emptyLayer = (): ZgeLayerData => ({ fx: 0, on: ZGE_MAX, vals: zgeDefaults(0), state: emptyLayerState() });

/** Select layer n's effect: FL loads the effect with its default parameter values. */
export function zgeSetEffect(p: Record<string, unknown>, n: number, fx: number): void {
  p[zk.fx(n)] = fx;
  zgeDefaults(fx).forEach((v, k) => { p[zk.p(n, k)] = v; });
}

export type ZgeLayerOp = 'insert' | 'clone' | 'delete' | 'left' | 'right';

/**
 * FL's layer menu operations on a parameter record (in place): Insert layer
 * (an empty layer before n), Clone layer (a copy after n), Delete layer, Move
 * layer left / right. IMAGE SRC references follow the layers they point at.
 * Returns the index of the layer to select afterwards.
 */
export function zgeLayerOp(p: Record<string, unknown>, op: ZgeLayerOp, n: number, data?: ZgeLayerData): number {
  const count = Math.max(1, Math.min(ZGE_LAYERS, Math.round(Number(p.layerCount) || 1)));
  const list = Array.from({ length: count }, (_, i) => zgeReadLayer(p, i));
  const remap = (f: (i: number) => number) => list.forEach((l) => { if (l.state.imgSrc >= 0) l.state.imgSrc = f(l.state.imgSrc); });
  let sel = n;
  if (op === 'insert' || op === 'clone') {
    if (count >= ZGE_LAYERS) return n;
    const at = op === 'insert' ? n : n + 1;
    const item = data ?? (op === 'insert' ? emptyLayer() : { ...list[n], vals: [...list[n].vals], state: { ...list[n].state, imgSrc: list[n].state.imgSrc } });
    remap((i) => (i >= at ? i + 1 : i));
    list.splice(at, 0, item);
    sel = at;
  } else if (op === 'delete') {
    remap((i) => (i === n ? -1 : i > n ? i - 1 : i));
    list.splice(n, 1);
    if (!list.length) list.push(emptyLayer());
    sel = Math.min(n, list.length - 1);
  } else {
    const m = op === 'left' ? n - 1 : n + 1;
    if (m < 0 || m >= count) return n;
    remap((i) => (i === n ? m : i === m ? n : i));
    [list[n], list[m]] = [list[m], list[n]];
    sel = m;
  }
  for (let i = 0; i < ZGE_LAYERS; i++) zgeWriteLayer(p, i, list[i] ?? emptyLayer());
  p.layerCount = list.length;
  return sel;
}

/** A preset layer: effect name plus parameter overrides (0..1). */
type PresetLayer = [string, Record<string, number>?];

function presetParams(layers: PresetLayer[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { layerCount: Math.max(1, layers.length), layers: [], ...extra };
  for (let n = 0; n < ZGE_LAYERS; n++) {
    const l = layers[n];
    const fx = l ? Math.max(0, ZGE_EFFECTS.findIndex((e) => e.name === l[0])) : 0;
    out[zk.fx(n)] = fx;
    out[zk.on(n)] = ZGE_MAX;
    const vals = zgeDefaults(fx);
    const eff = ZGE_EFFECTS[fx];
    for (const [name, v] of Object.entries(l?.[1] ?? {})) {
      const k = eff.params.findIndex((q) => q.name === name);
      if (k >= 0) vals[k] = Math.round(v * ZGE_MAX);
    }
    vals.forEach((v, k) => { out[zk.p(n, k)] = v; });
  }
  return out;
}

/** Our presets: FL's Default (one empty layer) and demonstrations of the built-in effects. */
export const ZGE_PRESETS: FxPreset[] = [
  { name: 'Default', params: presetParams([['(none)']]) },
  { name: 'Spectrum bars', params: presetParams([['SolidColor', { Lightness: 0.06 }], ['Grid', { Alpha: 0.6, Resolution: 0.2 }], ['Linear'], ['Vignette']]) },
  { name: 'Polar rings', params: presetParams([['SolidColor', { Hue: 0.75, Lightness: 0.05 }], ['Polar'], ['FreqRing', { Hue: 0.12, Alpha: 0.3 }], ['RGB Shift', { Amount: 0.15 }]]) },
  { name: 'Starfield', params: presetParams([['ItsFullOfStars'], ['WaveSimple', { Hue: 0.5 }], ['ScanLines']]) },
  { name: 'Tunnel', params: presetParams([['Oldschool Tube'], ['Reactive Sphere', { Alpha: 0.2, Size: 0.3 }], ['TextDraw', { 'Position Y': 0.82, Size: 0.22 }]], { text: ['ZGameEditor Visualizer', '[title]'] }) },
  { name: 'Color blobs', params: presetParams([['SolidColor', { Lightness: 0.03 }], ['ColorBlobs'], ['WarpBack'], ['Blur', { Amount: 0.1 }]]) },
  { name: 'Vectorscope', params: presetParams([['SolidColor', { Hue: 0.55, Lightness: 0.04 }], ['VectorScope'], ['Vignette', { 'Outer radius': 0.9 }]]) },
];

export const def: FxPluginDef = {
  id: 'zgameviz',
  name: 'ZGameEditor Visualizer',
  category: 'Visual',
  width: 736,
  height: 584,
  description: 'Audio-reactive visual layers (reduced ZGameEditor Visualizer)',
  params: [
    { key: 'zoom', name: 'Camera zoom', index: 0, min: 0, max: ZGE_MAX, def: 0, format: () => '' },
    { key: 'angle', name: 'Camera angle', index: 1, min: 0, max: ZGE_MAX, def: 0, format: () => '' },
    ...Array.from({ length: ZGE_LAYERS }, (_, n) => layerParams(n)).flat(),
  ],
  state: () => ({ layerCount: 1, layers: [], windowMode: 1, fps: 1, aspect: 1, freeze: false, visible: true, antialias: true, autoCollapse: false, gamut: false, text: [...ZGE_DEFAULT_TEXT], rect: [1005, 207, 689, 577] }),
  normalize: (q) => ({ ...q, ...zgeState(q) }),
  presets: ZGE_PRESETS,
};
