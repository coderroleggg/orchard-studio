// Every effect plugin: its state survives a project save / load (JSON) round
// trip, normalising a stored state is stable, and the default state and every
// factory preset render finite audio.
import { describe, it, expect } from 'vitest';
import { FX_DEFS, defaultFxParams, normalizeFxParams, presetState } from '../../src/model/fx/registry';
import { createEffect, hasEffect } from '../../src/engine/effects';
import { makeCtx } from './util';

const json = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

/** Paths of values JSON does not keep (NaN, Infinity, undefined, functions, typed arrays, class instances). */
function unstable(x: unknown, path = 'params', out: string[] = []): string[] {
  if (out.length > 5) return out;
  if (typeof x === 'number') { if (!Number.isFinite(x)) out.push(`${path} = ${x}`); return out; }
  if (x === undefined || typeof x === 'function' || typeof x === 'bigint' || typeof x === 'symbol') { out.push(`${path}: ${typeof x}`); return out; }
  if (x === null || typeof x !== 'object') return out;
  if (ArrayBuffer.isView(x)) { out.push(`${path}: typed array`); return out; }
  const proto = Object.getPrototypeOf(x);
  if (proto !== Object.prototype && proto !== Array.prototype && proto !== null) { out.push(`${path}: ${proto?.constructor?.name ?? 'object'}`); return out; }
  if (Array.isArray(x)) x.forEach((v, i) => unstable(v, `${path}[${i}]`, out));
  else for (const [k, v] of Object.entries(x)) {
    if (v === undefined) continue; // dropped by JSON like a missing key: fine when normalize fills it
    unstable(v, `${path}.${k}`, out);
  }
  return out;
}

function noise(n: number, seed = 1): Float32Array {
  const b = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; b[i] = (s / 2 ** 32 - 0.5) * 0.8; }
  return b;
}

/** Render `frames` of noise (and a sidechain copy); true when every sample is finite. */
function finite(plugin: string, params: Record<string, unknown>, frames = 2048): boolean {
  const fx = createEffect(plugin, 48000, 128);
  fx.setParams(params);
  fx.reset();
  const inL = noise(frames, 3), inR = noise(frames, 7);
  const sc = [{ L: noise(128, 11), R: noise(128, 13) }];
  const ctx = makeCtx({ sidechain: sc as never });
  const L = new Float32Array(128), R = new Float32Array(128);
  for (let i = 0; i < frames; i += 128) {
    L.set(inL.subarray(i, i + 128));
    R.set(inR.subarray(i, i + 128));
    fx.process(L, R, 128, ctx);
    for (let k = 0; k < 128; k++) if (!Number.isFinite(L[k]) || !Number.isFinite(R[k])) return false;
    ctx.pos += (128 / 48000) * (ctx.tempo / 60) * ctx.ppq;
  }
  return true;
}

describe('effect states round-trip through project files', () => {
  it('has the plugins', () => {
    expect(FX_DEFS.length).toBeGreaterThan(80);
  });

  for (const d of FX_DEFS) {
    it(`${d.id} (${d.name}): default state and presets`, () => {
      const def = normalizeFxParams(d.id, defaultFxParams(d.id));
      expect(unstable(def), 'default state holds values JSON does not keep').toEqual([]);
      // load(save(x)) == x, and normalising again changes nothing
      expect(normalizeFxParams(d.id, json(def))).toEqual(def);
      expect(normalizeFxParams(d.id, json(normalizeFxParams(d.id, json(def))))).toEqual(def);
      // a state from an older save (no fields at all) loads
      expect(() => normalizeFxParams(d.id, {})).not.toThrow();
      // every parameter's default lies in its range
      for (const q of d.params) {
        expect(q.def, `${q.key} default`).toBeGreaterThanOrEqual(q.min);
        expect(q.def, `${q.key} default`).toBeLessThanOrEqual(q.max);
      }
      for (const pr of d.presets ?? []) {
        const st = presetState(d.id, pr, def);
        expect(unstable(st), `preset ${pr.name}`).toEqual([]);
        expect(normalizeFxParams(d.id, json(st)), `preset ${pr.name}`).toEqual(st);
        for (const q of d.params) {
          const v = st[q.key];
          if (typeof v !== 'number') continue;
          expect(v >= q.min && v <= q.max, `preset ${pr.name}: ${q.key} = ${v} outside ${q.min}..${q.max}`).toBe(true);
        }
      }
    });
  }
});

describe('effect presets render finite audio', () => {
  for (const d of FX_DEFS) {
    if (!hasEffect(d.id)) continue;
    it(`${d.id}: default state and every factory preset`, () => {
      const def = normalizeFxParams(d.id, defaultFxParams(d.id));
      expect(finite(d.id, def), 'default state').toBe(true);
      for (const pr of d.presets ?? []) {
        expect(finite(d.id, presetState(d.id, pr, def), 1024), `preset ${pr.name}`).toBe(true);
      }
    }, 60_000);
  }
});
