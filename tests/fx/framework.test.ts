import { describe, it, expect } from 'vitest';
import { MixerEngine } from '../../src/engine/Mixer';
import { registerEffect } from '../../src/engine/effects';
import type { EffectInstance, FxContext } from '../../src/engine/effects/types';
import { createMixerTrack } from '../../src/model/defaults';
import type { FxSlot, MixerTrack } from '../../src/model/types';

const BS = 128;

// test effects: output = sidechain input 1; a "ringing" effect with a tail; a sender
registerEffect({ id: 'test-sc', create: () => ({
  setParams() {}, reset() {},
  process(L, R, n, ctx: FxContext) { const sc = ctx.sidechain[0]; for (let i = 0; i < n; i++) { L[i] = sc ? sc.L[i] : 0; R[i] = sc ? sc.R[i] : 0; } },
} as EffectInstance) });
registerEffect({ id: 'test-tail', create: () => {
  let level = 0;
  return {
    tail: 2, setParams() {}, reset() { level = 0; },
    process(L: Float32Array, R: Float32Array, n: number) { for (let i = 0; i < n; i++) { level = Math.max(level * 0.99999, Math.abs(L[i])); L[i] = R[i] = level; } },
  } as EffectInstance;
} });
// counts the blocks it is run for
const runs = { n: 0 };
registerEffect({ id: 'test-count', create: () => ({
  setParams() {}, reset() {},
  process() { runs.n++; },
} as EffectInstance) });
registerEffect({ id: 'test-send', create: () => ({
  setParams() {}, reset() {}, sendTargets: () => [3],
  process(L, R, n, ctx: FxContext) { ctx.sendTo(3, L, R, n, 1, 1); for (let i = 0; i < n; i++) { L[i] = 0; R[i] = 0; } },
} as EffectInstance) });

function slot(plugin: string): FxSlot {
  return { id: 'fx-' + plugin + Math.random(), plugin, name: plugin, enabled: true, mix: 1, params: {} };
}

function mixer(setup: (tracks: MixerTrack[]) => void): MixerEngine {
  const m = new MixerEngine(6, 48000, BS);
  const tracks = Array.from({ length: 6 }, (_, i) => createMixerTrack(i));
  setup(tracks);
  for (const t of tracks) m.setTrack(t);
  return m;
}

function run(m: MixerEngine, feed: (m: MixerEngine) => void, blocks = 1) {
  const L = new Float32Array(BS), R = new Float32Array(BS);
  for (let b = 0; b < blocks; b++) { m.beginBlock(BS); feed(m); m.process(L, R, BS); }
  return L;
}

describe('effect framework in the mixer', () => {
  it('gives a plugin every routed track as a sidechain input, even at zero send level', () => {
    const m = mixer((t) => {
      t[1].sends = { 2: 0 }; // "sidechain to this track": level 0
      t[2].slots[0] = slot('test-sc');
      t[2].sends = { 0: 0.8 };
    });
    const out = run(m, (mx) => { const t1 = mx.tracks[1]; t1.chL.fill(0.5); t1.chR.fill(0.5); t1.hasChannelInput = true; });
    // track 1 is not mixed into track 2 (level 0) but track 2's plugin outputs its sidechain
    expect(out[64]).toBeCloseTo(0.5, 4);
  });

  it('keeps processing an idle track while its effects ring (tail)', () => {
    const m = mixer((t) => { t[1].slots[0] = slot('test-tail'); });
    run(m, (mx) => { const t1 = mx.tracks[1]; t1.chL.fill(1); t1.chR.fill(1); t1.hasChannelInput = true; });
    // ~1 s of silence: past the 0.5 s idle cut-off, within the 2 s tail
    const out = run(m, () => {}, Math.round(48000 / BS));
    expect(out[0]).toBeGreaterThan(0.1);
  });

  it('runs a new effect for about a second without input so its start-up glides settle (FL runs plugins always)', () => {
    runs.n = 0;
    const m = mixer((t) => { t[1].slots[0] = slot('test-count'); });
    const settle = Math.ceil(48000 / BS);
    run(m, () => {}, settle + 300);
    expect(runs.n).toBe(settle); // then the silent track is skipped again
    // an existing effect does not restart the window when its parameters change
    const t = createMixerTrack(1);
    t.slots[0] = { ...m.tracks[1].slots[0]!, params: { x: 1 } } as unknown as FxSlot;
    m.setTrack(t);
    run(m, () => {}, 10);
    expect(runs.n).toBe(settle);
  });

  it('routes audio from a Send-style plugin into another track', () => {
    const m = mixer((t) => {
      t[1].slots[0] = slot('test-send');
      t[3].sends = { 0: 0.8 };
    });
    const out = run(m, (mx) => { const t1 = mx.tracks[1]; t1.chL.fill(0.25); t1.chR.fill(0.25); t1.hasChannelInput = true; });
    expect(out[10]).toBeCloseTo(0.25, 4);
    expect(m.order.indexOf(1)).toBeLessThan(m.order.indexOf(3));
  });
});
