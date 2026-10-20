import { describe, it, expect } from 'vitest';
import { Engine } from '../src/engine/Engine';
import { createChannel, createFxSlot, createMixerTrack, createNote, createPattern } from '../src/model/defaults';
import {
  autoOutput, CURVE_LABELS, CURVE_MODES, CURVE_MODES_EDITOR, CURVE_TAG, curveShape, defaultClipRange, defaultLfo, denormalize,
  envelopeLevel, envelopeValueOf, evalEnvelope, lfoWave, normalizeAutomation, stepCount, targetKey, TEMPO_TARGET,
  type AutomationChannel, type AutomationTarget, type AutoPoint, type CurveMode, type InitControl,
} from '../src/model/automation';
import type { Clip } from '../src/model/types';

const SR = 48000;
const BAR = 384; // ticks at 96 PPQ, 4/4; 2 s at 120 BPM

const pt = (pos: number, value: number, mode: CurveMode = 'single', tension = 0): AutoPoint => ({ pos, value, tension, mode });

describe('automation curves (FL envelope evaluator, research doc §4)', () => {
  // §4.5: S(u) at u = 0.25 / 0.5 / 0.75 for t = -0.5 / +0.5 / +1 (rounded to 4 decimals)
  const VECTORS: [CurveMode, number[][]][] = [
    ['single', [[0.0046, 0.0307, 0.1770], [0.8230, 0.9693, 0.9954], [0.9684, 0.9990, 1.0000]]],
    ['double', [[0.0153, 0.5, 0.9847], [0.4847, 0.5, 0.5153], [0.4995, 0.5, 0.5005]]],
    ['single2', [[0.1251, 0.2578, 0.4640], [0.5360, 0.7422, 0.8749], [0.8220, 0.9844, 0.9998]]],
    ['double2', [[0.1289, 0.5, 0.8711], [0.3711, 0.5, 0.6289], [0.4922, 0.5, 0.5078]]],
    ['single3', [[0.0525, 0.1426, 0.3329], [0.6671, 0.8574, 0.9475], [0.9970, 0.9990, 0.9997]]],
    ['halfSine', [[0.1631, 0.3964, 0.6837], [0.3163, 0.6036, 0.8369], [0.3827, 0.7071, 0.9239]]],
    ['stairs', [[0.2778, 0.5, 0.7222], [0.2353, 0.4706, 0.7647], [0, 0, 1]]],
    ['wave', [[0.1464, 0.5, 0.8536], [0.25, 0.5, 0.75], [0.25, 0.5, 0.75]]],
  ];

  it('matches the documented test vectors', () => {
    for (const [mode, rows] of VECTORS) {
      [-0.5, 0.5, 1].forEach((t, r) => [0.25, 0.5, 0.75].forEach((u, k) => {
        expect(Math.abs(curveShape(mode, u, t) - rows[r][k]), `${mode} t=${t} u=${u}`).toBeLessThan(6e-5);
      }));
    }
  });

  it('derives the step / cycle count from the tension', () => {
    const N = [1000, 437, 191, 83, 36, 16, 7, 3, 1, 1, 0];
    N.forEach((n, i) => {
      expect(stepCount(i / 10), `|t| = ${i / 10}`).toBe(n);
      expect(stepCount(-i / 10)).toBe(n);
    });
  });

  it('single curve: exponential over 10^(6|t|), the sign is the direction', () => {
    expect(curveShape('single', 0.37, 0)).toBe(0.37);
    expect(curveShape('single', 0.5, -1)).toBeCloseTo((1e3 - 1) / (1e6 - 1), 12);
    expect(curveShape('single', 0.5, -0.4)).toBeLessThan(0.5); // slow start
    expect(curveShape('single', 0.5, 0.4)).toBeGreaterThan(0.5); // fast start
    // t > 0 is the 180 degree rotation of -t
    for (const u of [0.1, 0.3, 0.8]) expect(curveShape('single', u, 0.7)).toBeCloseTo(1 - curveShape('single', 1 - u, -0.7), 12);
  });

  it('curve modes are straight at zero tension; stepped modes keep their shape', () => {
    for (const m of ['single', 'double', 'single2', 'double2', 'halfSine', 'single3', 'double3'] as const) {
      for (const u of [0.1, 0.5, 0.9]) expect(curveShape(m, u, 0)).toBeCloseTo(u, 12);
    }
    expect(curveShape('hold', 0.5, 0)).toBe(0);
    expect(curveShape('stairs', 0.3, 0)).toBeCloseTo(300 / 1001, 12); // 1002 levels
    // 1001 periods: half-periods of 1/2002
    expect(curveShape('pulse', 0.3, 0)).toBe(0);
    expect(curveShape('pulse', 0.3003, 0)).toBe(1);
  });

  it('every mode starts on the start value and ends on the point', () => {
    for (const m of CURVE_MODES) for (const t of [-1, -0.4, 0, 0.3, 1]) {
      expect(curveShape(m, 0, t), `${m} t=${t}`).toBeCloseTo(0, 12);
      expect(curveShape(m, 1, t)).toBe(1);
    }
  });

  it('double curves pass through the midpoint', () => {
    for (const m of ['double', 'double2', 'double3'] as const) for (const t of [-0.8, 0.3, 1]) expect(curveShape(m, 0.5, t)).toBeCloseTo(0.5, 12);
  });

  it('hold keeps the start value until the point', () => {
    expect(curveShape('hold', 0.99, 0.5)).toBe(0);
    expect(curveShape('hold', 1, 0)).toBe(1);
  });

  it('stairs: N+2 levels with both ends for t >= 0, N+1 inner levels for t < 0', () => {
    for (const u of [0.01, 0.5, 0.99]) expect(curveShape('stairs', u, -1)).toBe(0.5); // one level, the middle
    expect(curveShape('stairs', 0.49, 1)).toBe(0); // one jump at mid-segment
    expect(curveShape('stairs', 0.51, 1)).toBe(1);
    expect(new Set([0.1, 0.3, 0.5, 0.7, 0.9].map((u) => curveShape('stairs', u, 0.8)))).toEqual(new Set([0, 0.5, 1]));
  });

  it('smooth stairs: plateaus on whole levels for t >= 0, on half levels for t < 0', () => {
    // N = 1 at |t| = 0.8: two steps
    expect(curveShape('smoothStairs', 0.5, 0.8)).toBeCloseTo(0.5, 12);
    expect(curveShape('smoothStairs', 0.45, 0.8)).toBeCloseTo(0.498, 12);
    expect(curveShape('smoothStairs', 0.25, -0.8)).toBeCloseTo(0.25, 12);
    expect(curveShape('smoothStairs', 0.3, -0.8)).toBeCloseTo(0.252, 12);
    expect(curveShape('smoothStairs', 0.5, -0.8)).toBeCloseTo(0.5, 12);
  });

  it('pulse: N+1 periods, t >= 0 starts on the start value, t < 0 on the end value', () => {
    expect([0.1, 0.35, 0.6, 0.85].map((u) => curveShape('pulse', u, 0.8))).toEqual([0, 1, 0, 1]);
    expect([0.1, 0.35, 0.6, 0.85].map((u) => curveShape('pulse', u, -0.8))).toEqual([1, 0, 1, 0]);
  });

  it('wave: N+1/2 cycles, a sine for t < 0 and a triangle for t >= 0', () => {
    for (const u of [0.2, 0.5, 0.7]) expect(curveShape('wave', u, -1)).toBeCloseTo(0.5 - 0.5 * Math.cos(Math.PI * u), 12);
    expect(curveShape('wave', 1 / 3, 0.8)).toBeCloseTo(1, 9); // 1.5 triangle cycles: 0 -> 1 -> 0 -> 1
    expect(curveShape('wave', 2 / 3, 0.8)).toBeCloseTo(0, 9);
  });

  it('smooth: an isolated segment is a smoothstep, |t| blends toward the line', () => {
    expect(curveShape('smooth', 0.25, 0)).toBeCloseTo(0.15625, 12);
    expect(curveShape('smooth', 0.25, 0.5)).toBeCloseTo((0.15625 + 0.25) / 2, 12);
    expect(curveShape('smooth', 0.25, -1)).toBeCloseTo(0.25, 12);
    // between non-Smooth segments it is the same smoothstep
    const pts = [pt(0, 0), pt(100, 0.5, 'smooth'), pt(200, 1)];
    expect(evalEnvelope(pts, 25)).toBeCloseTo(0.5 * 0.15625, 12);
  });

  it('smooth chains form a monotone spline through the points', () => {
    const pts = [pt(0, 0), pt(100, 0.5, 'smooth'), pt(200, 1, 'smooth')];
    // Fritsch-Butland tangent at the shared point: 1 in each segment's normalised frame
    expect(evalEnvelope(pts, 50)).toBeCloseTo(0.1875, 12);
    expect(evalEnvelope(pts, 150)).toBeCloseTo(0.8125, 12);
    let prev = -1;
    for (let x = 0; x <= 200; x += 5) { const v = evalEnvelope(pts, x); expect(v).toBeGreaterThanOrEqual(prev); prev = v; }
    // at an extremum the tangent is flat
    const peak = [pt(0, 0.2), pt(100, 0.9, 'smooth'), pt(200, 0.4, 'smooth')];
    expect(evalEnvelope(peak, 100)).toBeCloseTo(0.9, 12);
    expect(evalEnvelope(peak, 150)).toBeCloseTo(0.65, 12);
  });

  it('evaluates an envelope between points', () => {
    const pts = [pt(0, 0), pt(100, 1), pt(200, 0.5, 'hold')];
    expect(evalEnvelope(pts, 50)).toBeCloseTo(0.5, 6);
    expect(evalEnvelope(pts, 150)).toBeCloseTo(1, 6); // hold: previous value until the point
    expect(evalEnvelope(pts, 250)).toBeCloseTo(0.5, 6); // holds after the last point
  });

  it('a zero-length segment is a jump: the last point at a time applies', () => {
    const pts = [pt(0, 0.2), pt(0, 0.6), pt(100, 0.6), pt(100, 1), pt(200, 0)];
    expect(evalEnvelope(pts, 0)).toBe(0.6);
    expect(evalEnvelope(pts, 99.9)).toBeCloseTo(0.6, 9);
    expect(evalEnvelope(pts, 100)).toBe(1);
    expect(evalEnvelope(pts, 150)).toBeCloseTo(0.5, 9);
  });

  it('lists the point modes in FL\'s menu orders', () => {
    expect(CURVE_MODES.map((m) => CURVE_LABELS[m])).toEqual([
      'Smooth', 'Hold', 'Single curve', 'Single curve 2', 'Single curve 3', 'Double curve', 'Double curve 2', 'Double curve 3',
      'Half sine', 'Stairs', 'Smooth stairs', 'Pulse', 'Wave',
    ]);
    // the automation clip editor's envelope menu has Hold before Smooth
    expect(CURVE_MODES_EDITOR).toEqual(['hold', 'smooth', ...CURVE_MODES.slice(2)]);
    expect(CURVE_MODES.map((m) => CURVE_TAG[m]).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('LFO shapes: sine at the centre, square to the left, triangle to the right', () => {
    const l = { ...defaultLfo(), on: true, amount: 128 };
    expect(lfoWave(l, 0.25)).toBeCloseTo(1, 6);
    expect(lfoWave(l, 0.75)).toBeCloseTo(-1, 6);
    expect(lfoWave({ ...l, tension: -128 }, 0.05)).toBeGreaterThan(0.85);
    expect(lfoWave({ ...l, tension: 128 }, 0.125)).toBeCloseTo(0.5, 6);
    // pulse width stretches the upper half
    expect(lfoWave({ ...l, pw: 64 }, 0.6)).toBeGreaterThan(0);
  });

  it('LFO adds to or multiplies the envelope', () => {
    const points = [pt(0, 0.8), pt(384, 0.8)];
    const off = { ...defaultLfo(), on: true, amount: 0 };
    expect(envelopeLevel({ points, lfo: off }, 100, 96)).toBeCloseTo(0.8, 6);
    const mul = { ...defaultLfo(), on: true, amount: 128, multiply: true };
    let lo = 1, hi = 0;
    for (let t = 0; t < 384; t += 2) { const v = envelopeLevel({ points, lfo: mul }, t, 96); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeLessThan(0.05);
    expect(hi).toBeCloseTo(0.8, 2);
    // new clips: AMNT +50%, added: a full swing around a centred envelope
    expect(defaultLfo().amount).toBe(64);
    const mid = [pt(0, 0.5), pt(384, 0.5)];
    lo = 1; hi = 0;
    for (let t = 0; t < 384; t += 2) { const v = envelopeLevel({ points: mid, lfo: { ...defaultLfo(), on: true } }, t, 96); lo = Math.min(lo, v); hi = Math.max(hi, v); }
    expect(lo).toBeLessThan(0.02);
    expect(hi).toBeGreaterThan(0.98);
  });
});

describe('automation defaults', () => {
  it('tempo clips cover 60..180 BPM of the 10..522 BPM tempo range', () => {
    const r = defaultClipRange(TEMPO_TARGET);
    expect(r).toEqual({ min: 1250 / 12800, max: 4250 / 12800 });
    expect(denormalize(TEMPO_TARGET, autoOutput(r, 0))).toBeCloseTo(60, 9);
    expect(denormalize(TEMPO_TARGET, autoOutput(r, 1))).toBeCloseTo(180, 9);
    // a tempo clip created at 150 BPM starts at 0.75; outside the range the value is clamped
    expect(envelopeValueOf(r, TEMPO_TARGET, 150)).toBeCloseTo(0.75, 12);
    expect(envelopeValueOf(r, TEMPO_TARGET, 200)).toBe(1);
  });

  it('channel pitch clips cover +-1200 of the +-4800 cents, others the full range', () => {
    expect(defaultClipRange({ scope: 'channel', path: 'pitch' })).toEqual({ min: 0.375, max: 0.625 });
    expect(defaultClipRange({ scope: 'mixer', path: 'volume' })).toEqual({ min: 0, max: 1 });
  });

  it('moves old 60..180 BPM tempo clips to the full tempo range with the same output', () => {
    const target: AutomationTarget = { scope: 'global', id: '', path: 'tempo', min: 60, max: 180, label: 'Tempo' };
    const a = normalizeAutomation({ id: 'x', target, points: [pt(0, 0), pt(384, 1)], min: 0.25, max: 1 });
    expect([a.target.min, a.target.max]).toEqual([10, 522]);
    for (const env of [0, 0.3, 1]) expect(denormalize(a.target, autoOutput(a, env))).toBeCloseTo(60 + 120 * (0.25 + 0.75 * env), 9);
  });

  it('keeps at least two points and clamps stored values', () => {
    const target: AutomationTarget = { scope: 'channel', id: 'c', path: 'volume', min: 0, max: 1, label: 'Kick - Channel volume' };
    const a = normalizeAutomation({ id: 'y', target, points: [{ pos: 0, value: 1.4, tension: 3, mode: 'single' }], length: 96 });
    expect(a.points).toEqual([pt(0, 1, 'single', 1), pt(96, 1)]);
  });
});

function makeEngine() {
  const e = new Engine({ sampleRate: SR, blockSize: 128 });
  e.handle({ t: 'globals', g: { tempo: 120, ppq: 96, beatsPerBar: 4, stepsPerBeat: 4, mainVolume: 0.8, mainPitch: 0, swing: 0 } });
  for (let i = 0; i < 127; i++) e.handle({ t: 'mixerTrack', tr: createMixerTrack(i) });
  // a 6-second constant tone so levels can be measured anywhere
  const len = SR * 6;
  const s = new Float32Array(len);
  for (let i = 0; i < len; i++) s[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
  e.handle({ t: 'sample', id: 'tone', data: [s], sampleRate: SR });
  return e;
}

function auto(id: string, target: AutomationTarget, points: AutoPoint[], length: number): AutomationChannel {
  return { id, name: target.label, color: '#888', enabled: true, target, points, length, loop: false, min: 0, max: 1, lfo: defaultLfo() };
}

function songWith(e: Engine, chId: string, autoClips: { auto: AutomationChannel; start: number; length: number }[], init: InitControl[] = []) {
  const pat = createPattern(1);
  pat.notes[chId] = [createNote({ pos: 0, len: BAR * 3 })];
  e.handle({ t: 'pattern', p: pat });
  const clips: Clip[] = [{ id: 'p1', track: 0, kind: 'pattern', patternId: pat.id, start: 0, length: BAR * 3, offset: 0, muted: false }];
  autoClips.forEach((a, i) => clips.push({ id: 'a' + i, track: 1 + i, kind: 'automation', patternId: '', autoId: a.auto.id, start: a.start, length: a.length, offset: 0, muted: false }));
  const tracks = Array.from({ length: 4 }, (_, i) => ({ id: 't' + i, name: 'Track ' + (i + 1), color: '#485156', height: 1, enabled: true, locked: false }));
  e.handle({ t: 'automation', list: autoClips.map((a) => a.auto), init });
  e.handle({ t: 'playlist', tracks, clips });
  e.handle({ t: 'mode', song: true, patternId: pat.id });
  e.handle({ t: 'play' });
}

function rms(b: Float32Array, a: number, z: number): number {
  let s = 0;
  for (let i = a; i < z; i++) s += b[i] * b[i];
  return Math.sqrt(s / (z - a));
}

function toneChannel(e: Engine) {
  const ch = createChannel('Tone', 'tone');
  ch.volume = 1;
  e.handle({ t: 'channel', c: ch });
  const target: AutomationTarget = { scope: 'channel', id: ch.id, path: 'volume', min: 0, max: 1, label: 'Tone - Channel volume' };
  return { ch, target };
}

describe('automation playback', () => {
  it('ramps a channel volume knob', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    const a = auto('v', target, [pt(0, 0), pt(BAR, 1)], BAR);
    songWith(e, ch.id, [{ auto: a, start: 0, length: BAR }]);
    const [L] = e.renderOffline(SR * 2);
    const early = rms(L, Math.round(SR * 0.05), Math.round(SR * 0.3));
    const late = rms(L, Math.round(SR * 1.6), Math.round(SR * 1.95));
    expect(late).toBeGreaterThan(early * 4);
    // the engine reports the moving value to the UI
    expect(e.automation.current.size).toBe(1);
  });

  it('holds the last value after the clip ends', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    // drops to silence within the first half bar, clip ends at half a bar
    const a = auto('v', target, [pt(0, 1), pt(BAR / 2, 0)], BAR / 2);
    songWith(e, ch.id, [{ auto: a, start: 0, length: BAR / 2 }]);
    const [L] = e.renderOffline(SR * 3);
    expect(rms(L, SR * 2, SR * 3)).toBeLessThan(1e-4);
  });

  it('automates a mixer fader and an EQ band', () => {
    const e = makeEngine();
    const ch = createChannel('Tone', 'tone', 1);
    ch.volume = 1;
    e.handle({ t: 'channel', c: ch });
    const tr = createMixerTrack(1);
    const fx = createFxSlot();
    fx.params.hq = false;
    tr.slots[0] = fx;
    e.handle({ t: 'mixerTrack', tr });
    const fader: AutomationTarget = { scope: 'mixer', id: '1', path: 'volume', min: 0, max: 1, label: 'Insert 1 - Volume' };
    const band: AutomationTarget = { scope: 'fx', id: fx.id, path: 'params.bands.3.level', min: -18, max: 18, label: 'Band 4 level' };
    const a1 = auto('f', fader, [pt(0, 0.8), pt(BAR, 0.8)], BAR);
    // band 4 (632 Hz) from 0 dB to -18 dB: 440 Hz sits inside its bell
    const a2 = auto('b', band, [pt(0, 0.5), pt(BAR, 0)], BAR);
    songWith(e, ch.id, [{ auto: a1, start: 0, length: BAR }, { auto: a2, start: 0, length: BAR }]);
    const [L] = e.renderOffline(SR * 2);
    const early = rms(L, Math.round(SR * 0.05), Math.round(SR * 0.3));
    const late = rms(L, Math.round(SR * 1.7), Math.round(SR * 1.95));
    expect(late).toBeLessThan(early * 0.6);
  });

  it('applies an initialized value when playback starts before the first clip', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    // the clip only starts at bar 2; the song starts silent through the initialized value
    const a = auto('v', target, [pt(0, 1), pt(BAR, 1)], BAR);
    songWith(e, ch.id, [{ auto: a, start: BAR, length: BAR }], [{ target, value: 0 }]);
    const [L] = e.renderOffline(Math.round(SR * 2.5));
    expect(rms(L, Math.round(SR * 0.2), Math.round(SR * 1.8))).toBeLessThan(1e-4);
    expect(rms(L, Math.round(SR * 2.1), Math.round(SR * 2.4))).toBeGreaterThan(0.05);
  });

  it('relocating applies initialized values again before the first clip', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    const a = auto('v', target, [pt(0, 1), pt(BAR, 1)], BAR);
    songWith(e, ch.id, [{ auto: a, start: BAR, length: BAR }], [{ target, value: 0 }]);
    e.renderOffline(Math.round(SR * 2.5)); // inside the clip: full volume
    e.handle({ t: 'seek', tick: BAR / 4 }); // back before the clip while playing
    const [L] = e.renderOffline(Math.round(SR * 0.5));
    expect(rms(L, Math.round(SR * 0.05), L.length)).toBeLessThan(1e-4);
  });

  it('a song loop wrap is a relocation: initialized values apply again', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    // the song is 3 bars (6 s): silent, then the clip raises the volume from bar 2 on (it holds after the clip)
    const a = auto('v', target, [pt(0, 1), pt(BAR, 1)], BAR);
    songWith(e, ch.id, [{ auto: a, start: BAR, length: BAR }], [{ target, value: 0 }]);
    const [L] = e.renderOffline(Math.round(SR * 6.6));
    expect(rms(L, Math.round(SR * 4.2), Math.round(SR * 5.8))).toBeGreaterThan(0.05);
    expect(rms(L, Math.round(SR * 6.15), Math.round(SR * 6.6))).toBeLessThan(1e-4);
  });

  it('drives a control only while a clip plays', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    const a = auto('v', target, [pt(0, 0), pt(BAR / 2, 0)], BAR / 2);
    songWith(e, ch.id, [{ auto: a, start: 0, length: BAR / 2 }]);
    // inside the clip an engine-side model update is overridden by the automation
    e.renderOffline(Math.round(SR * 0.3));
    e.handle({ t: 'channel', c: { ...ch, volume: 1 } });
    const [A1] = e.renderOffline(Math.round(SR * 0.3));
    expect(rms(A1, 0, A1.length)).toBeLessThan(1e-4);
    // after the clip ends (1 s) the control keeps its value until tweaked, then the tweak sticks
    e.renderOffline(Math.round(SR * 0.6));
    e.handle({ t: 'channel', c: { ...ch, volume: 1 } });
    const [A2] = e.renderOffline(Math.round(SR * 0.5));
    expect(rms(A2, Math.round(SR * 0.1), A2.length)).toBeGreaterThan(0.05);
  });

  it('a control moved by hand during song playback is released until playback restarts', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    const key = targetKey(target);
    const a = auto('v', target, [pt(0, 0), pt(BAR * 3, 0)], BAR * 3);
    songWith(e, ch.id, [{ auto: a, start: 0, length: BAR * 3 }]);
    e.renderOffline(Math.round(SR * 0.3)); // the clip holds the volume at 0
    // the host sends the release before the tweaked channel
    e.handle({ t: 'autoRelease', keys: [key] });
    e.handle({ t: 'channel', c: { ...ch, volume: 1 } });
    expect(e.automation.isReleased(key)).toBe(true);
    const [A1] = e.renderOffline(Math.round(SR * 0.5));
    expect(rms(A1, Math.round(SR * 0.1), A1.length)).toBeGreaterThan(0.05); // the tweak sticks inside the clip
    // clip edits and relocations while playing do not take it back
    e.handle({ t: 'automation', list: [{ ...a }], init: [] });
    e.handle({ t: 'seek', tick: BAR / 2 });
    const [A2] = e.renderOffline(Math.round(SR * 0.4));
    expect(rms(A2, Math.round(SR * 0.1), A2.length)).toBeGreaterThan(0.05);
    // stop, then play: the clip drives the control again
    e.handle({ t: 'pause' });
    e.handle({ t: 'seek', tick: 0 });
    e.handle({ t: 'play' });
    expect(e.automation.isReleased(key)).toBe(false);
    const [A3] = e.renderOffline(Math.round(SR * 0.3));
    expect(rms(A3, Math.round(SR * 0.05), A3.length)).toBeLessThan(1e-4);
  });

  it('a tweak while stopped does not release the control', () => {
    const e = makeEngine();
    const { ch, target } = toneChannel(e);
    const a = auto('v', target, [pt(0, 0), pt(BAR * 3, 0)], BAR * 3);
    songWith(e, ch.id, [{ auto: a, start: 0, length: BAR * 3 }]);
    e.handle({ t: 'pause' });
    e.handle({ t: 'autoRelease', keys: [targetKey(target)] });
    expect(e.automation.isReleased(targetKey(target))).toBe(false);
  });

  it('automates the tempo over its 60..180 BPM clip range', () => {
    const e = makeEngine();
    const { ch } = toneChannel(e);
    // jump straight to the clip's MAX: 180 BPM
    const a = { ...auto('t', TEMPO_TARGET, [pt(0, 1), pt(BAR * 2, 1)], BAR * 2), ...defaultClipRange(TEMPO_TARGET) };
    songWith(e, ch.id, [{ auto: a, start: 0, length: BAR * 2 }]);
    e.renderOffline(SR); // one second
    // 180 BPM = 3 beats per second = 288 ticks
    expect(e.globals.tempo).toBeCloseTo(180, 6);
    expect(e.pos).toBeGreaterThan(280);
    expect(e.pos).toBeLessThan(296);
  });
});
