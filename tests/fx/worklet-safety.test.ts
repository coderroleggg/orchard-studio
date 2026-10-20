// Every plugin definition and DSP module also runs inside the AudioWorklet,
// which lacks structuredClone (polyfilled), fetch, timers, DOM and storage.
// Load all plugins with those globals removed (as the worklet would), then
// run each one at its defaults: output must stay finite.
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

describe('plugins in a worklet-like scope', () => {
  it('load, create and process at default settings', async () => {
    await import('../../src/engine/polyfills');
    const { FX_DEFS, defaultFxParams } = await import('../../src/model/fx/registry');
    const { createEffect, hasEffect } = await import('../../src/engine/effects');
    const { makeCtx } = await import('./util');
    const failures: string[] = [];
    for (const d of FX_DEFS) {
      if (!hasEffect(d.id)) continue;
      try {
        const fx = createEffect(d.id, 48000, 128);
        fx.setParams(defaultFxParams(d.id));
        const ctx = makeCtx();
        const L = new Float32Array(128), R = new Float32Array(128);
        let seed = 1;
        for (let b = 0; b < 40; b++) {
          for (let i = 0; i < 128; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; L[i] = (seed / 0x7fffffff - 0.5) * 0.5; R[i] = -L[i] * 0.8; }
          fx.process(L, R, 128, ctx);
          ctx.pos += 128 / 48000 * 2 * 96;
          for (let i = 0; i < 128; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) throw new Error(`non-finite output in block ${b}`);
        }
        fx.monitor?.();
        fx.reset();
      } catch (e) {
        failures.push(`${d.id}: ${(e as Error).message}`);
      }
    }
    expect(failures).toEqual([]);
  }, 180_000);
});
