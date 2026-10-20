import { describe, it, expect } from 'vitest';
import { createEffect } from '../../src/engine/effects';
import { MixerEngine } from '../../src/engine/Mixer';
import { createMixerTrack } from '../../src/model/defaults';
import type { FxSlot, MixerTrack } from '../../src/model/types';
import { defaultFxParams, fxDef, normalizeFxParams } from '../../src/model/fx/registry';
import { sendDryText, sendGain, sendPanText, sendVolText } from '../../src/model/fx/plugins/send';
import { makeCtx, peak } from './util';

const SR = 48000;

function capture() {
  const got: { track: number; L: number[]; R: number[]; gl: number; gr: number }[] = [];
  const ctx = makeCtx({
    track: 1,
    sendTo: (track, L, R, n, gl, gr) => { got.push({ track, L: Array.from(L.subarray(0, n)), R: Array.from(R.subarray(0, n)), gl, gr }); },
  });
  return { got, ctx };
}

function settled(params: Record<string, unknown>) {
  const fx = createEffect('send', SR, 128);
  fx.setParams({ ...defaultFxParams('send'), ...params });
  fx.reset();
  return fx;
}

describe('Send', () => {
  it('is registered with FL ranges, defaults and value texts', () => {
    const d = fxDef('send')!;
    expect(d.name).toBe('Send');
    expect([d.width, d.height]).toEqual([258, 84]);
    expect(d.params.map((p) => [p.key, p.index, p.min, p.max, p.def])).toEqual([
      ['pan', 0, -128, 128, 0], ['vol', 1, 0, 320, 256], ['dry', 2, 0, 256, 256],
    ]);
    expect(defaultFxParams('send')).toEqual({ pan: 0, vol: 256, dry: 256, target: -1 });
    expect(normalizeFxParams('send', { target: 'x' }).target).toBe(-1);
    // FL truncates the pan to its -64..64 scale
    expect(sendPanText(0)).toBe('Centered');
    expect(sendPanText(1)).toBe('Centered');
    expect(sendPanText(-127)).toBe('98% left');
    expect(sendPanText(-16)).toBe('12% left');
    expect(sendPanText(128)).toBe('100% right');
    expect(sendVolText(192)).toBe('-6.0dB');
    expect(sendVolText(320)).toBe('5.6dB');
    expect(sendDryText(32)).toBe('13%');
    expect(sendDryText(256)).toBe('100%');
  });

  it('sends the merge-panned input to the target track', () => {
    const fx = settled({ target: 3, pan: 128 }); // hard right
    const { got, ctx } = capture();
    const L = new Float32Array(128).fill(0.6), R = new Float32Array(128).fill(0.2);
    fx.process(L, R, 128, ctx);
    expect(got).toHaveLength(1);
    expect(got[0].track).toBe(3);
    expect(got[0].L[100]).toBeCloseTo(0, 6);
    expect(got[0].R[100]).toBeCloseTo(0.4, 6); // (L + R) / 2
    // dry at 100% passes the input untouched
    expect(L[100]).toBeCloseTo(0.6, 6);
    expect(R[100]).toBeCloseTo(0.2, 6);
    expect(fx.sendTargets!()).toEqual([3]);
  });

  it('applies FL gain law to the send volume and the dry level', () => {
    expect(sendGain(128)).toBeCloseTo(0.2316625, 6); // shown as "50%" on the Dry wheel
    const fx = settled({ target: 2, vol: 192, dry: 128 });
    const { got, ctx } = capture();
    const L = new Float32Array(128).fill(1), R = new Float32Array(128).fill(1);
    fx.process(L, R, 128, ctx);
    expect(got[0].L[64]).toBeCloseTo(0.5040106, 5);
    expect(L[64]).toBeCloseTo(0.2316625, 5);
  });

  it('does not send without a target or to its own track', () => {
    const { got, ctx } = capture();
    const fx = settled({});
    fx.process(new Float32Array(128).fill(1), new Float32Array(128).fill(1), 128, ctx);
    expect(fx.sendTargets!()).toEqual([]);
    const own = settled({ target: 1 });
    own.process(new Float32Array(128).fill(1), new Float32Array(128).fill(1), 128, ctx);
    expect(got).toHaveLength(0);
  });

  it('fades the send in at creation (44.1/sr per sample) and steps the dry level', () => {
    const fx = createEffect('send', SR, 128);
    fx.setParams({ ...defaultFxParams('send'), target: 2 });
    const { got, ctx } = capture();
    fx.process(new Float32Array(128).fill(1), new Float32Array(128).fill(1), 128, ctx);
    const rate = 44.1 / SR;
    expect(got[0].L[0]).toBe(0);
    expect(got[0].L[100]).toBeCloseTo(100 * rate, 6);
    // the dry path starts at its level (no fade) and FL steps dry changes per block (no smoothing)
    const D = new Float32Array(128).fill(1);
    fx.setParams({ ...defaultFxParams('send'), target: 2, dry: 0 });
    fx.process(D, new Float32Array(128).fill(1), 128, ctx);
    expect(D[0]).toBe(0);
    expect(D[127]).toBe(0);
  });

  it('routes audio through the mixer into the target track', () => {
    const BS = 128;
    const m = new MixerEngine(6, SR, BS);
    const tracks: MixerTrack[] = Array.from({ length: 6 }, (_, i) => createMixerTrack(i));
    const slot: FxSlot = { id: 'snd', plugin: 'send', name: 'Send', enabled: true, mix: 1, params: { ...defaultFxParams('send'), target: 3, dry: 0 } };
    tracks[1].slots[0] = slot;
    tracks[1].sends = { 0: 0.8, 3: 0 }; // "sidechain to this track"
    tracks[3].sends = { 0: 0.8 };
    for (const t of tracks) m.setTrack(t);
    expect(m.order.indexOf(1)).toBeLessThan(m.order.indexOf(3));
    const L = new Float32Array(BS), R = new Float32Array(BS);
    for (let b = 0; b < 20; b++) {
      m.beginBlock(BS);
      const t1 = m.tracks[1];
      t1.chL.fill(0.25); t1.chR.fill(0.25); t1.hasChannelInput = true;
      m.process(L, R, BS);
    }
    // dry 0: only the send path reaches the master (through track 3)
    expect(L[64]).toBeCloseTo(0.25, 3);
  });

  it('silence in, silence out; finite at extreme settings', () => {
    const fx = settled({ target: 2, vol: 320, pan: -128, dry: 0 });
    const { got, ctx } = capture();
    const L = new Float32Array(128), R = new Float32Array(128);
    fx.process(L, R, 128, ctx);
    expect(peak(L) + peak(R) + Math.max(...got[0].L.map(Math.abs))).toBe(0);
    fx.setParams({ pan: NaN, vol: 'a', dry: Infinity, target: 2 });
    const B = new Float32Array(128).fill(1e30);
    fx.process(B, new Float32Array(128).fill(-1e30), 128, ctx);
    expect(B.every(Number.isFinite)).toBe(true);
    expect(got.every((g) => g.L.every(Number.isFinite) && g.R.every(Number.isFinite))).toBe(true);
  });
});
