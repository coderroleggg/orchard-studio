import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { defaultFxParams, fxDef } from '../../src/model/fx/registry';
import {
  ZGE_ASPECTS, ZGE_EFFECTS, ZGE_FPS, ZGE_MAX, ZGE_PRESETS, ZGE_WINDOW_MODES, zgeDefaults, zgeLayerOp, zgeReadLayer, zgeSetEffect, zgeState, zk,
} from '../../src/model/fx/plugins/zgameviz';
import { RENDERERS } from '../../src/ui/plugins/fx/zgameviz/effects';
import { render, sine } from './util';

const fxIndex = (name: string) => ZGE_EFFECTS.findIndex((e) => e.name === name);

describe('ZGameEditor Visualizer', () => {
  it('is registered with FL parameter indexing and names', () => {
    const d = fxDef('zgameviz')!;
    expect([d.name, d.category, d.width, d.height]).toEqual(['ZGameEditor Visualizer', 'Visual', 736, 584]);
    expect(d.params).toHaveLength(2 + 8 * 18);
    const by = (k: string) => d.params.find((q) => q.key === k)!;
    expect([by('zoom').name, by('zoom').index, by('zoom').max]).toEqual(['Camera zoom', 0, 65535]);
    expect([by('angle').name, by('angle').index]).toEqual(['Camera angle', 1]);
    expect([by('l0fx').name, by('l0fx').index]).toEqual(['Layer A - Effect select', 16]);
    expect([by('l0on').name, by('l0on').index, by('l0on').def]).toEqual(['Layer A - Enabled', 20, 65535]);
    expect([by('l0p0').name, by('l0p0').index]).toEqual(['Layer A - Parameter 0', 32]);
    expect([by('l1fx').index, by('l1on').index, by('l1p15').index]).toEqual([64, 68, 95]);
    expect([by('l7p15').name, by('l7p15').index]).toEqual(['Layer H - Parameter 15', 383]);
    // FL's value texts are empty except "(none)" for an empty effect select
    expect(by('l0fx').format!(0)).toBe('(none)');
    expect(by('l0fx').format!(fxIndex('Linear'))).toBe('Linear');
    expect(by('l0p3').format!(30000)).toBe('');
    expect(new Set(d.params.map((q) => q.index)).size).toBe(d.params.length);
  });

  it('defaults to FL\'s Default preset: one empty layer, detached 689 x 577 window, 30 fps, 16:9', () => {
    const p = defaultFxParams('zgameviz');
    const s = zgeState(p);
    expect(s.layerCount).toBe(1);
    expect(ZGE_WINDOW_MODES[s.windowMode]).toBe('Detached');
    expect(ZGE_FPS[s.fps]).toBe(30);
    expect(ZGE_ASPECTS[s.aspect]).toBe('16:9');
    expect(s.rect).toEqual([1005, 207, 689, 577]);
    expect([p.l0fx, p.l0on, p.zoom, p.angle]).toEqual([0, 65535, 0, 0]);
    expect(ZGE_FPS).toEqual([15, 30, 60, 75, 90, 120, 144]);
    expect(ZGE_ASPECTS).toEqual(['4:3', '16:9', '4:5', '9:16', '1:1']);
    // normalisation of saved state
    const n = zgeState({ layerCount: 99, fps: -3, aspect: 'x', windowMode: 7, layers: [{ name: 5, imgSrc: 12, rq: 99 }], text: 'no' });
    expect([n.layerCount, n.fps, n.aspect, n.windowMode]).toEqual([8, 0, 0, 2]);
    expect(n.layers[0]).toEqual({ name: '', collapsed: false, toBuffer: false, rq: 6, imgSrc: -1 });
    expect(n.text).toEqual(['This is the default text.']);
  });

  it('has a renderer and at most 16 FL-named parameters for every built-in effect', () => {
    for (const e of ZGE_EFFECTS) {
      expect(RENDERERS[e.id], e.id).toBeTypeOf('function');
      expect(e.params.length).toBeLessThanOrEqual(16);
      for (const q of e.params) {
        expect(q.def).toBeGreaterThanOrEqual(0);
        expect(q.def).toBeLessThanOrEqual(1);
        if (q.kind === 'list') expect(q.items!.length).toBeGreaterThan(1);
      }
    }
    // FL's colour parameters come first in most effects
    expect(ZGE_EFFECTS[fxIndex('Linear')].params.slice(0, 4).map((q) => q.name)).toEqual(['Alpha', 'Hue', 'Saturation', 'Lightness']);
    expect(ZGE_EFFECTS[fxIndex('Linear')].params.map((q) => q.name)).toContain('Hide Floor');
  });

  it('ships presets whose layers use the built-in effects with their default values', () => {
    expect(ZGE_PRESETS.map((p) => p.name)).toEqual(['Default', 'Spectrum bars', 'Polar rings', 'Starfield', 'Tunnel', 'Color blobs', 'Vectorscope']);
    expect(ZGE_PRESETS[0].params).toMatchObject({ layerCount: 1, l0fx: 0, l0on: 65535 });
    for (const pr of ZGE_PRESETS) {
      const s = zgeState(pr.params);
      for (let n = 0; n < s.layerCount; n++) {
        const l = zgeReadLayer(pr.params, n);
        expect(l.vals.every((v) => v >= 0 && v <= ZGE_MAX && Number.isInteger(v))).toBe(true);
      }
    }
    const sb = ZGE_PRESETS.find((p) => p.name === 'Spectrum bars')!.params;
    expect([sb.layerCount, sb.l0fx, sb.l1fx, sb.l2fx, sb.l3fx]).toEqual([4, fxIndex('SolidColor'), fxIndex('Grid'), fxIndex('Linear'), fxIndex('Vignette')]);
    expect(sb.l1p0).toBe(Math.round(0.6 * ZGE_MAX)); // Grid Alpha override
    expect(sb.l2p4).toBe(zgeDefaults(fxIndex('Linear'))[4]); // Linear Size default
  });

  it('selects effects with their defaults and runs FL\'s layer menu operations', () => {
    const p: Record<string, unknown> = { ...defaultFxParams('zgameviz') };
    zgeSetEffect(p, 0, fxIndex('Grid'));
    expect(zgeReadLayer(p, 0).vals.slice(0, 7)).toEqual(zgeDefaults(fxIndex('Grid')).slice(0, 7));
    // A = Grid; clone -> A, B = Grid; insert before B -> A Grid, B empty, C Grid
    expect(zgeLayerOp(p, 'clone', 0)).toBe(1);
    expect(zgeLayerOp(p, 'insert', 1)).toBe(1);
    expect(p.layerCount).toBe(3);
    expect([0, 1, 2].map((n) => zgeReadLayer(p, n).fx)).toEqual([fxIndex('Grid'), 0, fxIndex('Grid')]);
    // C takes B's buffer; moving B right keeps the link
    zgeSetEffect(p, 1, fxIndex('Polar'));
    const layers = zgeState(p).layers;
    layers[1].toBuffer = true;
    layers[2].imgSrc = 1;
    p.layers = layers;
    expect(zgeLayerOp(p, 'right', 1)).toBe(2);
    expect(zgeReadLayer(p, 2).fx).toBe(fxIndex('Polar'));
    expect(zgeState(p).layers[1].imgSrc).toBe(2);
    // deleting the buffer layer clears the reference
    expect(zgeLayerOp(p, 'delete', 2)).toBe(1);
    expect(p.layerCount).toBe(2);
    expect(zgeState(p).layers[1].imgSrc).toBe(-1);
    expect(zgeReadLayer(p, 2).fx).toBe(0);
    // the last layer can't be removed: it becomes empty
    zgeLayerOp(p, 'delete', 0);
    zgeLayerOp(p, 'delete', 0);
    expect(p.layerCount).toBe(1);
    expect(zgeReadLayer(p, 0).fx).toBe(0);
    expect(p[zk.on(0)]).toBe(ZGE_MAX);
  });

  it('passes audio through untouched', () => {
    const fx = createEffect('zgameviz', 48000, 128);
    fx.setParams(defaultFxParams('zgameviz'));
    const inL = sine(440, 0.2, 0.6), inR = sine(330, 0.2, 0.2);
    const [L, R] = render(fx, inL, inR);
    expect(L).toEqual(inL);
    expect(R).toEqual(inR);
  });

  it('analyses bands, waveform and levels for the layers', () => {
    const fx = createEffect('zgameviz', 48000, 128);
    expect(fx.monitor!()).toBeNull();
    const all = sine(1000, 0.4, 0.5), warm = all.subarray(0, 4800), s = all.subarray(4800);
    render(fx, warm, warm);
    expect(fx.monitor!()).not.toBeNull(); // the onset (a click) is broadband: poll it away
    render(fx, s, s);
    const m = fx.monitor!()!;
    const bands = m.bands as Float32Array, wave = m.wave as Float32Array;
    expect(bands).toHaveLength(64);
    const top = bands.indexOf(Math.max(...bands));
    expect(top).toBeGreaterThanOrEqual(35);
    expect(top).toBeLessThanOrEqual(36); // 1 kHz on the 30 Hz..16 kHz log scale
    expect(bands[top]).toBeGreaterThan(0.85); // -6 dB on a 66 dB scale
    expect(bands[10]).toBeLessThan(0.3);
    expect(wave).toHaveLength(1024);
    expect(Array.from(wave.subarray(0, 512))).toEqual(Array.from(s.subarray(s.length - 512)));
    expect(m.peak as number).toBeCloseTo(0.5, 2);
    expect(m.rms as number).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(fx.monitor!()).toBeNull(); // nothing new
  });

  it('survives NaN and infinite input', () => {
    const fx = createEffect('zgameviz', 48000, 128);
    const bad = new Float32Array(4096).map((_, i) => (i % 3 ? NaN : i % 2 ? Infinity : 0.25));
    render(fx, bad, bad);
    const m = fx.monitor!()!;
    expect(Array.from(m.bands as Float32Array).every(Number.isFinite)).toBe(true);
    expect(Array.from(m.wave as Float32Array).every(Number.isFinite)).toBe(true);
    expect(Number.isFinite(m.peak as number) && Number.isFinite(m.rms as number)).toBe(true);
  });
});
