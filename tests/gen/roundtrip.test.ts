// Every instrument plugin: its state survives a project save / load (JSON)
// round trip, normalising a stored state is stable, defaults and every
// factory preset lie in the controls' ranges, and the default state and every
// preset render finite audio for a few notes through an instrument channel.
import { describe, it, expect } from 'vitest';
import { GEN_DEFS, defaultGenParams, genPresetState, normalizeGenParams } from '../../src/model/gen/registry';
import { hasGen } from '../../src/engine/gen';
import { createGenChannel } from '../../src/model/defaults';
import { makeEngine, play } from './util';

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
    if (v === undefined) continue;
    unstable(v, `${path}.${k}`, out);
  }
  return out;
}

/** Play a chord, a low and a high note on a channel holding the plugin with `params`; true when every sample is finite. */
function finite(plugin: string, params: Record<string, unknown>, frames = 9600): boolean {
  const e = makeEngine();
  const ch = createGenChannel(plugin);
  ch.plugin!.params = params;
  const [L, R] = play(e, [ch], { [ch.id]: [{ pos: 0, len: 12, key: 60 }, { pos: 0, len: 12, key: 64 }, { pos: 6, len: 6, key: 24, vel: 128 }, { pos: 12, len: 6, key: 108, vel: 1 }] }, frames);
  for (let i = 0; i < frames; i++) if (!Number.isFinite(L[i]) || !Number.isFinite(R[i])) return false;
  return true;
}

/**
 * JSON with object keys sorted recursively (arrays keep their order): comparing
 * canonical(normalize(json(st))) with canonical(st) is exactly "survives the JSON
 * round trip", independent of key order, and much cheaper than a deep toEqual on
 * large states (Harmor: ~68 kB per preset x 325 presets).
 */
function canonical(x: unknown): string {
  if (x === null || typeof x !== 'object') return JSON.stringify(x) ?? 'null';
  if (Array.isArray(x)) return '[' + x.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonical(v))).join(',') + ']';
  const o = x as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== 'function').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}';
}

const real = GEN_DEFS.filter((d) => !d.id.startsWith('test-'));

describe('instrument states round-trip through project files', () => {
  it('has the plugins', () => {
    expect(real.length).toBeGreaterThan(0);
  });

  for (const d of real) {
    it(`${d.id} (${d.name}): default state and presets`, () => {
      const def = normalizeGenParams(d.id, defaultGenParams(d.id));
      expect(unstable(def), 'default state holds values JSON does not keep').toEqual([]);
      expect(normalizeGenParams(d.id, json(def))).toEqual(def);
      expect(normalizeGenParams(d.id, json(normalizeGenParams(d.id, json(def))))).toEqual(def);
      expect(() => normalizeGenParams(d.id, {})).not.toThrow();
      expect(['voices', 'events']).toContain(d.notes);
      expect(d.width).toBeGreaterThan(0);
      expect(d.height).toBeGreaterThan(0);
      const keys = new Set<string>();
      for (const q of d.params) {
        expect(keys.has(q.key), `duplicate key ${q.key}`).toBe(false);
        keys.add(q.key);
        expect(q.def, `${q.key} default`).toBeGreaterThanOrEqual(q.min);
        expect(q.def, `${q.key} default`).toBeLessThanOrEqual(q.max);
      }
      for (const pr of d.presets ?? []) {
        const st = genPresetState(d.id, pr, def);
        expect(unstable(st), `preset ${pr.name}`).toEqual([]);
        expect(canonical(normalizeGenParams(d.id, json(st))), `preset ${pr.name}`).toBe(canonical(st));
        for (const q of d.params) {
          const v = st[q.key];
          if (typeof v !== 'number') continue;
          expect(v >= q.min && v <= q.max, `preset ${pr.name}: ${q.key} = ${v} outside ${q.min}..${q.max}`).toBe(true);
        }
      }
    }, 5000 + 50 * (d.presets?.length ?? 0)); // scaled to the preset count (~12 ms each idle; full parallel suites run 3-4x slower)
  }
});

describe('instrument presets render finite audio', () => {
  for (const d of real) {
    if (!hasGen(d.id)) continue;
    it(`${d.id}: default state and every factory preset`, () => {
      const def = normalizeGenParams(d.id, defaultGenParams(d.id));
      expect(finite(d.id, def), 'default state').toBe(true);
      for (const pr of d.presets ?? []) expect(finite(d.id, genPresetState(d.id, pr, def), 4800), `preset ${pr.name}`).toBe(true);
    }, 60_000 + 200 * (d.presets?.length ?? 0)); // scaled to the preset count (each preset plays through a whole engine)
  }
});
