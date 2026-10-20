// Every instrument definition and DSP module also runs inside the
// AudioWorklet, which lacks structuredClone (polyfilled), fetch, timers, DOM
// and storage. Load all instruments with those globals removed (as the worklet
// would), then play notes on each at its defaults: output must stay finite.
import { describe, it, expect } from 'vitest';

const g = globalThis as Record<string, unknown>;
delete g.structuredClone;
delete g.fetch;
delete g.localStorage;
delete g.requestAnimationFrame;
// also missing from AudioWorkletGlobalScope (polyfilled by src/engine/polyfills.ts or must not be used at load)
delete g.atob;
delete g.btoa;
delete g.TextDecoder;
delete g.TextEncoder;

describe('instruments in a worklet-like scope', () => {
  it('load, create, trigger and render at default settings', async () => {
    await import('../../src/engine/polyfills');
    const { GEN_DEFS, defaultGenParams } = await import('../../src/model/gen/registry');
    const { createGen, hasGen } = await import('../../src/engine/gen');
    const { newLevels, setInitLevels } = await import('../../src/engine/gen/levels');
    const failures: string[] = [];
    for (const d of GEN_DEFS) {
      if (!hasGen(d.id)) continue;
      try {
        const inst = createGen(d.id, 48000, 128)!;
        inst.setParams(defaultGenParams(d.id));
        const ctx = { sampleRate: 48000, blockSize: 128, tempo: 120, ppq: 96, playing: true, pos: 0, songMode: false, track: 0 };
        const L = new Float32Array(128), R = new Float32Array(128);
        const notes = [48, 60, 72].map((key, i) => {
          const init = newLevels(), levels = newLevels();
          setInitLevels(init, (key - 60) * 100, 100, 0, 0, 0);
          Object.assign(levels, init);
          return { id: i + 1, key, velocity: 100, release: 64, color: 0, length: 4800, frame: 0, init, levels };
        });
        const voices = d.notes === 'voices' ? notes.map((p) => inst.triggerVoice?.(p) ?? null) : [];
        if (d.notes === 'events') notes.forEach((p) => inst.noteOn?.(p, 0));
        for (let b = 0; b < 40; b++) {
          L.fill(0); R.fill(0);
          if (b === 20) { voices.forEach((v) => v?.release()); if (d.notes === 'events') notes.forEach((p) => inst.noteOff?.(p, 0)); }
          for (const v of voices) if (v) for (let o = 0; o < 128; o += 16) v.render(L.subarray(o, o + 16), R.subarray(o, o + 16), 16);
          inst.render?.(L, R, 128, ctx);
          ctx.pos += (128 / 48000) * 2 * 96;
          for (let i = 0; i < 128; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite output in block ${b}`);
        }
        voices.forEach((v) => v?.kill());
        inst.monitor?.();
        inst.controls?.();
        inst.reset();
      } catch (e) {
        failures.push(`${d.id}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);
});
