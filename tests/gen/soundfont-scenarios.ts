// The scenarios behind tests/gen/soundfont-golden.ts: small fonts built by tests/gen/soundfont-util.ts (own data) and the notes
// / states they are played with. The golden numbers are the output of FL's SoundFont Player for exactly these fonts, rendered
// with the test host (`flfxhost render "Soundfont Player" --load-file F.sf2 --notes ...`, see docs/research/gen/soundfont.md,
// "Regenerating the golden numbers"). `params` are this instrument's state keys: the host gets the same values (FL parameters
// 2..12 by index, the options through the saved state).
import {
  G, MOD_KEY, MOD_VEL, Sf2Writer, noiseData, simpleFont, sineData, modSrc,
  type RenderNote, type SfGenValue, type SfModDef, type SfZoneDef,
} from './soundfont-util';

export interface GoldenScenario {
  name: string;
  font: () => Uint8Array;
  notes: RenderNote[];
  secs: number;
  params?: Record<string, unknown>;
  /** [note index, seconds]: the host's polyphony limit (--poly 1) kills the note when the next one starts at that time. */
  kills?: [number, number][];
  /** Waveform tolerance as a fraction of the scenario's peak (default 3e-6, about -110 dB). */
  tol?: number;
  /** Tolerance of the windows' levels in dB (default 0.02: the golden levels are rounded to 0.01 dB). */
  winTol?: number;
  /** Sample rate (default 44100). */
  sr?: number;
  /** What the scenario pins. */
  pins: string;
}

const LOOP = { [G.sampleModes]: 1 };
const NOISE = noiseData();
const mk = (gens: Record<number, SfGenValue> = {}, o: Parameters<typeof simpleFont>[0] = {}): Uint8Array => simpleFont({ ...o, gens: { ...LOOP, ...gens } });
const mkn = (gens: Record<number, SfGenValue> = {}, o: Parameters<typeof simpleFont>[0] = {}): Uint8Array => simpleFont({ data: NOISE, loop: 'all', ...o, gens: { ...LOOP, ...gens } });

/** Two looped sines (441 Hz and 882 Hz) and a preset made of the given instrument zones (the zone tests). */
function zonesFont(zs: (a: number, b: number) => SfZoneDef[], pgens: Record<number, SfGenValue> = {}, pmods: SfModDef[] = [], preset?: (i: number) => SfZoneDef[]): Uint8Array {
  const w = new Sf2Writer();
  const a = w.addSample({ name: 'a', data: sineData(100, 4), root: 60, loop: [0, 400] });
  const b = w.addSample({ name: 'b', data: sineData(50, 8, 20000), root: 60, loop: [0, 400] });
  const i = w.addInstrument('inst', zs(a, b));
  w.addPreset('p', 0, 0, preset ? preset(i) : [{ gens: { [G.instrument]: i, ...pgens }, mods: pmods }]);
  return w.build();
}
const one = (gens: Record<number, SfGenValue> = {}, mods: SfModDef[] = []) => (a: number): SfZoneDef[] => [{ gens: { [G.sampleID]: a, ...LOOP, ...gens }, mods }];

/** A click (30000, -20000) in a short unlooped sample: the reverb's impulse response. */
const click = (): Uint8Array => {
  const d = new Array<number>(400).fill(0);
  d[100] = 30000; d[101] = -20000;
  return simpleFont({ data: d, gens: { [G.sampleModes]: 0 }, loop: [0, 0] });
};

const n = (key: number, vel: number, start: number, dur: number): RenderNote => ({ key, vel, start, dur });
export const SCENARIOS: GoldenScenario[] = [];
const add = (name: string, pins: string, font: () => Uint8Array, notes: RenderNote[], secs: number, extra: Partial<GoldenScenario> = {}): void => {
  SCENARIOS.push({ name, pins, font, notes, secs, ...extra });
};

// ---- notes, keys, velocity, levels
add('basic', 'unity pitch (exact copy path), velocity 100, default modulators', () => mk(), [n(60, 100, 0, 0.5)], 1.0);
add('vel127', 'velocity -> attenuation curve', () => mk(), [n(60, 127, 0, 0.5)], 1.0);
add('vel30', 'low velocity (filter cutoff clamp of the velocity modulator)', () => mk(), [n(60, 30, 0, 0.5)], 1.0);
add('n_vel127', 'noise through the velocity -> cutoff default modulator', () => mkn(), [n(60, 127, 0, 0.6)], 1.0);
add('n_vel100', 'noise, velocity 100', () => mkn(), [n(60, 100, 0, 0.6)], 1.0);
add('n_vel30', 'noise, velocity 30 (cutoff -1200 cents)', () => mkn(), [n(60, 30, 0, 0.6)], 1.0);
add('key72', 'sinc resampling, an octave up', () => mk(), [n(72, 100, 0, 0.5)], 1.0);
add('key55', 'sinc resampling, down a fifth', () => mk(), [n(55, 100, 0, 0.5)], 1.0);
add('key66', 'sinc resampling, a tritone up', () => mk(), [n(66, 100, 0, 0.5)], 1.0);
add('key84', 'sinc resampling, two octaves up (band 24)', () => mk(), [n(84, 100, 0, 0.5)], 1.0);
add('key100', 'sinc resampling, three and a half octaves up', () => mk(), [n(100, 100, 0, 0.5)], 1.0);
add('fine5', 'fine tune generator', () => mk({ [G.fineTune]: 5 }), [n(60, 100, 0, 0.5)], 1.0);
add('pan300', 'pan generator', () => mk({ [G.pan]: 300 }), [n(60, 100, 0, 0.5)], 1.0);
add('att200', 'initial attenuation generator (EMU scale 0.4)', () => mk({ [G.initialAttenuation]: 200 }), [n(60, 100, 0, 0.5)], 1.0);
add('chord', 'three voices', () => mk(), [n(60, 100, 0, 0.5), n(64, 90, 0.1, 0.5), n(67, 80, 0.2, 0.5)], 1.2);

// ---- volume envelope
add('e_att', 'attack time (linear amplitude)', () => mk({ [G.attackVolEnv]: -3000 }), [n(60, 100, 0, 0.8)], 1.2);
add('e_att1s', 'one second attack, released during it', () => mk({ [G.attackVolEnv]: 0 }), [n(60, 100, 0, 0.5)], 1.5);
add('e_delay', 'delay time', () => mk({ [G.delayVolEnv]: -2400 }), [n(60, 100, 0, 0.8)], 1.2);
add('e_hold', 'hold, decay and sustain (dB linear)', () => mk({ [G.holdVolEnv]: -2400, [G.decayVolEnv]: -1200, [G.sustainVolEnv]: 300 }), [n(60, 100, 0, 1.0)], 1.5);
add('e_decay', 'long decay to a sustain level', () => mk({ [G.decayVolEnv]: 0, [G.sustainVolEnv]: 600 }), [n(60, 100, 0, 1.5)], 2.5);
add('e_rel', 'release time', () => mk({ [G.releaseVolEnv]: -1200 }), [n(60, 100, 0, 0.4)], 1.0);
add('e_keydec72', 'key -> volume envelope decay', () => mk({ [G.decayVolEnv]: -1200, [G.keynumToVolEnvDecay]: 50, [G.sustainVolEnv]: 400 }), [n(72, 100, 0, 1.0)], 1.5);
add('e_keyhold72', 'key -> volume envelope hold', () => mk({ [G.holdVolEnv]: -1200, [G.keynumToVolEnvHold]: 100, [G.decayVolEnv]: -1200, [G.sustainVolEnv]: 500 }), [n(72, 100, 0, 1.0)], 1.5);
add('e_offatt', 'note off during the attack', () => mk({ [G.attackVolEnv]: 0 }), [n(60, 100, 0, 0.05)], 1.5);
add('e_rel2', 'two overlapping notes with envelopes', () => mk({ [G.attackVolEnv]: -1200, [G.decayVolEnv]: -600, [G.sustainVolEnv]: 200, [G.releaseVolEnv]: -600 }), [n(60, 100, 0, 0.3), n(64, 100, 0.1, 0.3)], 1.5);

// ---- modulation envelope and LFOs
add('m_pitch', 'modulation envelope -> pitch', () => mk({ [G.modEnvToPitch]: 1200, [G.attackModEnv]: -1200, [G.decayModEnv]: -1200, [G.sustainModEnv]: 500 }), [n(60, 100, 0, 0.8)], 1.2);
add('m_fc', 'modulation envelope -> filter cutoff', () => mkn({ [G.initialFilterFc]: 4000, [G.modEnvToFilterFc]: 4800, [G.attackModEnv]: -1200, [G.decayModEnv]: -600, [G.sustainModEnv]: 500 }), [n(60, 127, 0, 0.8)], 1.2);
add('l_modpitch', 'modulation LFO -> pitch with delay', () => mk({ [G.modLfoToPitch]: 100, [G.freqModLFO]: 0, [G.delayModLFO]: -2000 }), [n(60, 100, 0, 1.0)], 1.3);
add('l_vibpitch', 'vibrato LFO -> pitch', () => mk({ [G.vibLfoToPitch]: 100, [G.freqVibLFO]: 1200, [G.delayVibLFO]: -1000 }), [n(60, 100, 0, 1.0)], 1.3);
add('l_modfc', 'modulation LFO -> filter cutoff', () => mkn({ [G.initialFilterFc]: 6000, [G.modLfoToFilterFc]: 2400, [G.freqModLFO]: 600 }), [n(60, 127, 0, 1.0)], 1.3);
add('l_modvol', 'modulation LFO -> volume', () => mk({ [G.modLfoToVolume]: 120, [G.freqModLFO]: 1200 }), [n(60, 100, 0, 1.0)], 1.3);
add('l_wheel', 'Modulation parameter (CC1) -> vibrato by the default modulator', () => mk(), [n(60, 100, 0, 1.0)], 1.3, { params: { mod: 100 } });

// ---- sample addresses, loops, tuning
add('o_start', 'start address offset', () => mkn({ [G.sampleModes]: 0, [G.startAddrsOffset]: 200 }), [n(66, 127, 0, 0.4)], 0.8);
add('o_end', 'end address offset', () => mkn({ [G.sampleModes]: 0, [G.endAddrsOffset]: -5000 }), [n(66, 127, 0, 0.4)], 0.8);
add('o_loop', 'loop address offsets', () => mkn({ [G.startloopAddrsOffset]: 50, [G.endloopAddrsOffset]: -3000 }), [n(66, 127, 0, 0.6)], 1.0);
add('o_loop3', 'loop until release, then play on', () => mkn({ [G.sampleModes]: 3, [G.endloopAddrsOffset]: -12000 }), [n(60, 127, 0, 0.5)], 1.5);
add('o_noloop', 'sample without a loop mode, loop points ignored', () => simpleFont({ data: NOISE, gens: { [G.sampleModes]: 0 }, loop: [100, 8000] }), [n(60, 127, 0, 0.6)], 1.0);
// loops far shorter than a render call: the voice is asked for the rest of the call (up to 4096 frames) and the loop guard is decided
// for that chunk, so these pin the chunk logic (loop entry, wraps, small and large steps, low rates)
const shortLoop = (len: number) => (): Uint8Array => simpleFont({ data: NOISE, loop: [2000, 2000 + len], gens: { ...LOOP, [G.attackVolEnv]: -12000 } });
add('lp_k67_100', 'a 100 point loop at +7 semitones', shortLoop(100), [n(67, 127, 0, 0.5)], 0.7);
add('lp_k67_300', 'a 300 point loop at +7 semitones', shortLoop(300), [n(67, 127, 0, 0.5)], 0.7);
add('lp_k60_40k', 'a 100 point loop at 40 kHz (the step is not 1)', shortLoop(100), [n(60, 127, 0, 0.5)], 0.7, { sr: 40000 });
add('lp_k67_22k', 'a 100 point loop at 22.05 kHz, +7 semitones (step 3)', shortLoop(100), [n(67, 127, 0, 0.5)], 0.7, { sr: 22050 });
add('t_root', 'overriding root key', () => mk({ [G.overridingRootKey]: 64 }), [n(60, 100, 0, 0.5)], 1.0);
add('t_scale0', 'scale tuning 0', () => mk({ [G.scaleTuning]: 0 }), [n(72, 100, 0, 0.5), n(48, 100, 0.6, 0.5)], 1.5);
add('t_coarse', 'coarse and fine tune', () => mk({ [G.coarseTune]: 7, [G.fineTune]: -33 }), [n(60, 100, 0, 0.5)], 1.0);
add('t_corr', 'sample pitch correction', () => mk({}, { corr: -30 }), [n(60, 100, 0, 0.5)], 1.0);
add('t_rate22', 'sample rate 22050', () => mk({}, { rate: 22050 }), [n(60, 100, 0, 0.5)], 1.0);
add('t_rate48', 'sample rate 48000', () => mk({}, { rate: 48000 }), [n(60, 100, 0, 0.5)], 1.0);

// ---- filter
add('n_fc3000', 'low pass, cutoff 3000 cents', () => mkn({ [G.initialFilterFc]: 3000 }), [n(60, 127, 0, 0.6)], 1.0);
add('n_fc8000q200', 'low pass with resonance 20 dB', () => mkn({ [G.initialFilterFc]: 8000, [G.initialFilterQ]: 200 }), [n(60, 127, 0, 0.6)], 1.0);
add('n_fc5000q400', 'low pass with resonance 40 dB', () => mkn({ [G.initialFilterFc]: 5000, [G.initialFilterQ]: 400 }), [n(60, 127, 0, 0.6)], 1.0);
add('n_fc13400', 'cutoff just below the bypass', () => mkn({ [G.initialFilterFc]: 13400 }), [n(60, 127, 0, 0.6)], 1.0);

// ---- zones
add('z_keysplit', 'key ranges', () => zonesFont((a, b) => [{ gens: { [G.keyRange]: [0, 63], [G.sampleID]: a, ...LOOP } }, { gens: { [G.keyRange]: [64, 127], [G.sampleID]: b, ...LOOP } }]), [n(60, 100, 0, 0.3), n(70, 100, 0.4, 0.3)], 1.2);
add('z_velsplit', 'velocity ranges', () => zonesFont((a, b) => [{ gens: { [G.velRange]: [1, 64], [G.sampleID]: a, ...LOOP } }, { gens: { [G.velRange]: [65, 127], [G.sampleID]: b, ...LOOP } }]), [n(60, 40, 0, 0.3), n(60, 100, 0.4, 0.3)], 1.2);
add('z_layer', 'two layers with opposite pans', () => zonesFont((a, b) => [{ gens: { [G.pan]: -500, [G.sampleID]: a, ...LOOP } }, { gens: { [G.pan]: 500, [G.sampleID]: b, ...LOOP } }]), [n(60, 100, 0, 0.5)], 1.0);
add('z_global', 'global instrument zone', () => zonesFont((a, b): SfZoneDef[] => [{ gens: { [G.attackVolEnv]: -2000, [G.fineTune]: 20 } }, { gens: { [G.sampleID]: a, ...LOOP } }, { gens: { [G.sampleID]: b, [G.fineTune]: -20, ...LOOP } }]), [n(60, 100, 0, 0.5)], 1.0);
add('z_pgens', 'preset level generators add', () => zonesFont((a) => one()(a), { [G.fineTune]: 50, [G.initialAttenuation]: 100, [G.attackVolEnv]: 1200, [G.releaseVolEnv]: -600 }), [n(60, 100, 0, 0.5)], 1.0);
add('z_pgens_ig', 'preset and instrument generators add (scale tuning, coarse)', () => zonesFont((a) => one({ [G.initialAttenuation]: 100, [G.coarseTune]: 2 })(a), { [G.initialAttenuation]: 60, [G.coarseTune]: 3, [G.scaleTuning]: -50 }), [n(60, 100, 0, 0.5)], 1.0);
add('z_pglobal', 'global preset zone', () => zonesFont((a) => one()(a), {}, [], (i): SfZoneDef[] => [{ gens: { [G.pan]: 300, [G.fineTune]: 10 } }, { gens: { [G.instrument]: i, [G.fineTune]: 15 } }]), [n(60, 100, 0, 0.5)], 1.0);
add('z_excl', 'exclusive class: the second note cuts the first with a fixed release', () => zonesFont((a) => one({ [G.exclusiveClass]: 3, [G.releaseVolEnv]: 600 })(a)), [n(60, 100, 0, 1.0), n(62, 100, 0.3, 0.5)], 2.0);
add('z_excl2', 'exclusive class across zones', () => zonesFont((a, b) => [{ gens: { [G.keyRange]: [0, 63], [G.sampleID]: a, [G.exclusiveClass]: 5, ...LOOP } }, { gens: { [G.keyRange]: [64, 127], [G.sampleID]: b, [G.exclusiveClass]: 5, ...LOOP } }]), [n(60, 100, 0, 1.0), n(72, 100, 0.3, 0.5)], 2.0);

// ---- modulators
const sc = (src: number, dest: number, amount: number, amtSrc = 0): SfModDef => [src, dest, amount, amtSrc, 0];
add('mod_velpan', 'velocity -> pan', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL), G.pan, 500)])(a)), [n(60, 30, 0, 0.4), n(60, 120, 0.5, 0.4)], 1.2);
add('mod_keyfc', 'key -> filter cutoff', () => zonesFont((a) => one({ [G.initialFilterFc]: 12000 }, [sc(modSrc(MOD_KEY), G.initialFilterFc, -3000)])(a)), [n(30, 127, 0, 0.3), n(90, 127, 0.4, 0.3)], 1.2);
add('mod_cc1att', 'CC1 (Modulation 127) -> attenuation', () => zonesFont((a) => one({}, [sc(modSrc(1, { cc: true }), G.initialAttenuation, 400)])(a)), [n(60, 100, 0, 0.4)], 1.0, { params: { mod: 127 } });
add('mod_cc1att90', 'CC1 (Modulation 90) -> attenuation, and the default CC1 -> vibrato', () => zonesFont((a) => one({}, [sc(modSrc(1, { cc: true }), G.initialAttenuation, 400)])(a)), [n(60, 100, 0, 0.4)], 1.0, { params: { mod: 90 } });
add('mod_bipolar', 'bipolar velocity source -> fine tune', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL, { bipolar: true }), G.fineTune, 100)])(a)), [n(60, 20, 0, 0.4), n(60, 120, 0.5, 0.4)], 1.2);
add('mod_convex', 'convex velocity curve -> attenuation', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL, { type: 2 }), G.initialAttenuation, 300)])(a)), [n(60, 50, 0, 0.4)], 1.0);
add('mod_switch', 'switch velocity curve -> attenuation', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL, { type: 3 }), G.initialAttenuation, 300)])(a)), [n(60, 50, 0, 0.4), n(60, 100, 0.5, 0.4)], 1.2);
add('mod_amtsrc', 'amount source (key) scales a velocity modulator', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL), G.fineTune, 200, modSrc(MOD_KEY))])(a)), [n(48, 100, 0, 0.4), n(84, 100, 0.5, 0.4)], 1.2);
add('mod_pmod', 'preset modulators add to the instrument modulators of the same identity', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL), G.pan, 200)])(a), {}, [sc(modSrc(MOD_VEL), G.pan, 100)]), [n(60, 60, 0, 0.4)], 1.0);
add('mod_overdef', 'a zero-amount modulator replaces the default velocity -> attenuation', () => zonesFont((a) => one({}, [sc(modSrc(MOD_VEL, { neg: true, type: 1 }), G.initialAttenuation, 0)])(a)), [n(60, 50, 0, 0.4)], 1.0);

// ---- the OPTIONS menu: "EMU volume envelope" (attenuation scale) and "Velocity filter cutoff"
add('att200_noemu', 'EMU volume envelope off: the attenuation generator at full scale', () => mk({ [G.initialAttenuation]: 200 }), [n(60, 100, 0, 0.5)], 1.0, { params: { emu: 0 } });
add('n_vel30_nofc', 'Velocity filter cutoff off: no velocity -> cutoff modulator', () => mkn(), [n(60, 30, 0, 0.6)], 1.0, { params: { velFc: 0 } });

// ---- presets: FL lists them sorted by (bank, program); the percussion channel (bank 128, or program mode Drum) ignores note offs
function presetsFont(): Uint8Array {
  const w = new Sf2Writer();
  const a = w.addSample({ name: 'a', data: sineData(100, 4), root: 60, loop: [0, 400] });
  const b = w.addSample({ name: 'b', data: sineData(50, 8, 20000), root: 60, loop: [0, 400] });
  const c = w.addSample({ name: 'c', data: sineData(25, 16, 20000), root: 60, loop: [0, 400] });
  const ia = w.addInstrument('ia', [{ gens: { [G.sampleID]: a, ...LOOP } }]);
  const ib = w.addInstrument('ib', [{ gens: { [G.sampleID]: b, ...LOOP } }]);
  const ic = w.addInstrument('ic', [{ gens: { [G.sampleID]: c, ...LOOP } }]);
  w.addPreset('Zeta', 5, 1, [{ gens: { [G.instrument]: ib } }]);
  w.addPreset('Kit', 0, 128, [{ gens: { [G.instrument]: ic } }]);
  w.addPreset('Piano', 0, 0, [{ gens: { [G.instrument]: ia } }]);
  w.addPreset('Organ', 16, 0, [{ gens: { [G.instrument]: ib } }]);
  w.addPreset('Late', 2, 0, [{ gens: { [G.instrument]: ic } }]);
  return w.build();
}
add('pr_organ', 'patch 17 = bank 0 program 16 of the sorted list', presetsFont, [n(60, 100, 0, 0.4), n(64, 50, 0.2, 0.3)], 1.0, { params: { patch: 17, bank: 0 } });
add('pr_zeta', 'patch 6 / bank 1 = bank 1 program 5', presetsFont, [n(60, 100, 0, 0.4)], 1.0, { params: { patch: 6, bank: 1 } });
add('pr_kit', 'bank 128 plays on the percussion channel: note offs are ignored', presetsFont, [n(60, 100, 0, 0.2), n(64, 50, 0.1, 0.1)], 1.0, { params: { patch: 129, bank: 0 } });
add('pr_kit_instr', 'program mode Instrument: the percussion preset is silent', presetsFont, [n(60, 100, 0, 0.4)], 1.0, { params: { patch: 129, bank: 0, programMode: 1 } });
add('pr_piano_drum', 'program mode Drum: a melodic preset is silent', presetsFont, [n(60, 100, 0, 0.4)], 1.0, { params: { patch: 1, bank: 0, programMode: 2 } });
add('pr_late_drum', 'program mode Drum on the preset list index of a melodic preset: silent', presetsFont, [n(60, 100, 0, 0.4)], 1.0, { params: { patch: 3, bank: 0, programMode: 2 } });

// ---- FL's parameters 5..12 (Env 2 / LFO 2 / Initial filter cutoff) replace the generators
const plain = (): Uint8Array => zonesFont((a) => one()(a));
add('p_atk', 'Env 2 attack', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { envAtk: 200 } });
add('p_atk2', 'Env 2 attack, long', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { envAtk: 3000 } });
add('p_dec', 'Env 2 decay', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { envDec: 500 } });
add('p_sus', 'Env 2 sustain', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { envSus: 60 } });
add('p_rel', 'Env 2 release', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { envRel: 400 } });
add('p_cut', 'Initial filter cutoff', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { cutoff: 30 } });
add('p_lfo', 'LFO 2 predelay / amount / speed', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { lfoDelay: 300, lfoAmt: 60, lfoSpeed: 90 } });
add('p_all', 'all of them', plain, [n(60, 100, 0, 0.6)], 1.8, { params: { envAtk: 100, envDec: 300, envSus: 40, envRel: 200, cutoff: 80 } });

// ---- FL does not clamp the generators to the spec's ranges, and handles a few odd values its own way
add('x_pan700', 'pan beyond +-500 is not clamped (a negative left gain)', () => mk({ [G.pan]: 700 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_pan1000', 'pan 1000 (equal power, left inverted)', () => mk({ [G.pan]: 1000 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_att1500', 'attenuation above 1440 (EMU scale 0.4, only the sum is clamped)', () => mk({ [G.initialAttenuation]: 1500 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_attneg', 'negative attenuation', () => mk({ [G.initialAttenuation]: -100 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_scaleneg', 'negative scale tuning (pitch falls with the key)', () => mk({ [G.scaleTuning]: -100 }), [n(72, 100, 0, 0.4)], 1.0);
add('x_fine150', 'fine tune beyond +-99', () => mk({ [G.fineTune]: 150 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_root255', 'sample root key 255 plays as key 60', () => mk({}, { root: 255 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_keynum', 'keynum generator: the key of the tuning and of the envelope key scaling', () => mk({ [G.keynum]: 72, [G.decayVolEnv]: -1200, [G.keynumToVolEnvDecay]: 50, [G.sustainVolEnv]: 400 }), [n(60, 100, 0, 0.5)], 1.0);
add('x_velocity', 'velocity generator: reaches the modulators with the next render block (512 frames in the host)', () => mk({ [G.velocity]: 40 }), [n(60, 100, 0, 0.4)], 1.0);
add('x_modes2', 'sample mode 2 loops until the note is released, like mode 3', () => simpleFont({ data: NOISE, gens: { [G.sampleModes]: 2 }, loop: [2000, 12000] }), [n(60, 127, 0, 0.8)], 1.4);
add('x_modes4', 'sample modes above 3 play the sample once', () => simpleFont({ data: NOISE, gens: { [G.sampleModes]: 4 }, loop: [2000, 12000] }), [n(60, 127, 0, 0.8)], 1.4);
add('x_loopswap', 'a loop end before the loop start is no loop', () => simpleFont({ data: NOISE, gens: LOOP, loop: [9000, 2000] }), [n(60, 127, 0, 0.8)], 1.4);
add('x_loop9', 'a loop of 9 points loops, 8 points do not', () => simpleFont({ data: NOISE, gens: LOOP, loop: [2000, 2009] }), [n(60, 127, 0, 0.8)], 1.4);
add('x_loop8', 'a loop of 8 points is ignored', () => simpleFont({ data: NOISE, gens: LOOP, loop: [2000, 2008] }), [n(60, 127, 0, 0.8)], 1.4);
add('x_keydec3000', 'key scaling pushing the decay time below the minimum', () => mk({ [G.decayVolEnv]: -1200, [G.keynumToVolEnvDecay]: 3000, [G.sustainVolEnv]: 400 }), [n(72, 100, 0, 0.5)], 1.0);

// ---- a generator with a preset level addend is clamped to the spec's range (an instrument value alone is not)
const withPreset = (pgens: Record<number, SfGenValue>, gens: Record<number, SfGenValue> = {}): Uint8Array => simpleFont({ gens: { ...LOOP, ...gens }, pgens });
add('pc_att_neg', 'a negative preset level attenuation cannot boost: the sum is clamped to 0', () => withPreset({ [G.initialAttenuation]: -50 }), [n(60, 100, 0, 0.4)], 1.0);
add('pc_att_sum', 'preset + instrument attenuation inside the range add', () => withPreset({ [G.initialAttenuation]: -50 }, { [G.initialAttenuation]: 100 }), [n(60, 100, 0, 0.4)], 1.0);
add('pc_pan900', 'preset level pan 900 is clamped to 500', () => withPreset({ [G.pan]: 900 }), [n(60, 100, 0, 0.4)], 1.0);
add('pc_fine150', 'preset level fine tune 150 is clamped to 99', () => withPreset({ [G.fineTune]: 150 }), [n(60, 100, 0, 0.4)], 1.0);
add('pc_scale1500', 'preset level scale tuning: 100 + 1500 is clamped to 1200', () => withPreset({ [G.scaleTuning]: 1500 }), [n(72, 100, 0, 0.4)], 1.0);
add('pc_scale_neg', 'preset level scale tuning: 100 - 300 is clamped to 0', () => withPreset({ [G.scaleTuning]: -300 }), [n(72, 100, 0, 0.4)], 1.0);

// ---- Voice_Kill (the polyphony limit): a release of -12000 timecents, whatever the voice does; the second note is nearly silent
add('kill_sustain', 'a note killed while sustaining fades over the shortest release (2 control blocks at 44.1 kHz)', () => mk(), [n(60, 100, 0, 1.0), n(67, 1, 0.3, 0.5)], 1.0, { kills: [[0, 0.3]] });
add('kill_attack', 'a note killed during its attack', () => mk({ [G.attackVolEnv]: 0 }), [n(60, 100, 0, 1.0), n(67, 1, 0.3, 0.5)], 1.0, { kills: [[0, 0.3]] });
add('kill_decay', 'a note killed during its decay', () => mk({ [G.holdVolEnv]: -2400, [G.decayVolEnv]: -1200, [G.sustainVolEnv]: 500 }), [n(60, 100, 0, 1.0), n(67, 1, 0.5, 0.5)], 1.0, { kills: [[0, 0.5]] });

// ---- other sample rates: from 44250 Hz the voice's two spare low-pass filters (19.9 kHz, no resonance) stop being bypassed
const noise127 = (gens: Record<number, SfGenValue> = {}): Uint8Array => mkn({ [G.initialFilterFc]: 13500, ...gens });
add('sr48_basic', 'sine at 48 kHz: +3.01 dB from the two spare filters, not the exact copy path', () => mk(), [n(60, 100, 0, 0.5)], 1.0, { sr: 48000 });
add('sr48_noise', 'noise at 48 kHz: the spare filters roll off above 8 kHz', () => noise127(), [n(60, 127, 0, 0.6)], 1.0, { sr: 48000 });
add('sr48_key84', 'two octaves up at 48 kHz', () => mk(), [n(84, 100, 0, 0.5)], 1.0, { sr: 48000 });
add('sr48_env', 'envelopes and a modulated cutoff at 48 kHz', () => mkn({ [G.initialFilterFc]: 6000, [G.modEnvToFilterFc]: 3000, [G.attackModEnv]: -1200, [G.decayModEnv]: -600, [G.sustainModEnv]: 500, [G.releaseVolEnv]: -1200 }), [n(60, 127, 0, 0.5)], 1.2, { sr: 48000 });
add('sr96_noise', 'noise at 96 kHz', () => noise127(), [n(60, 127, 0, 0.6)], 1.0, { sr: 96000 });
add('sr44250_noise', 'noise at 44250 Hz: the spare filters switch on exactly here', () => noise127(), [n(60, 127, 0, 0.6)], 1.0, { sr: 44250 });
add('sr44249_noise', 'noise at 44249 Hz: still bypassed', () => noise127(), [n(60, 127, 0, 0.6)], 1.0, { sr: 44249 });
add('sr22_noise', 'noise at 22.05 kHz', () => noise127(), [n(60, 127, 0, 0.6)], 1.0, { sr: 22050 });
add('sr48_rev', 'reverb at 48 kHz: the sizes follow the rate, the damping stays that of 44.1 kHz (set up before the rate change)', () => mk(), [n(60, 100, 0, 0.4)], 3.0, { sr: 48000, params: { revOn: 1 } });
add('sr96_rev', 'reverb impulse response at 96 kHz', click, [n(60, 127, 0, 0.05)], 3.0, { sr: 96000, params: { revOn: 1 }, tol: 1e-6 });
add('sr22_rev', 'reverb impulse response at 22.05 kHz', click, [n(60, 127, 0, 0.1)], 3.0, { sr: 22050, params: { revOn: 1 }, tol: 1e-6 });

// ---- built-in effects
add('fx_rev', 'reverb impulse response (bit exact)', click, [n(60, 127, 0, 0.05)], 4.0, { params: { revOn: 1 } });
add('r_knob64', 'reverb send level knob 64', () => mk(), [n(60, 100, 0, 0.4)], 4.0, { params: { revOn: 1, revSend: 64 } });
add('r_zone', 'reverb: the preset\'s reverb send (use level off)', () => mk({ [G.reverbEffectsSend]: 300, [G.chorusEffectsSend]: 700 }), [n(60, 100, 0, 0.4)], 4.0, { params: { revOn: 1, useRevLevel: 0 } });
add('r_poly', 'reverb tail of three voices', () => mk(), [n(60, 100, 0, 0.4), n(64, 90, 0.1, 0.4), n(67, 80, 0.2, 0.4)], 4.0, { params: { revOn: 1 } });
// (the chorus LFO is at 0.25 s x 0.366 Hz = 0.0915 cycles when the host's first note starts, at every sample rate: see the runner)
add('fx_chor_click', 'chorus on a click with the LFO pinned to the host\'s phase (bit exact)', click, [n(60, 127, 0, 0.05)], 2.0, { params: { chorOn: 1 }, tol: 2e-7 });
add('sr48_chor_click', 'chorus on a click at 48 kHz: the LFO rate (0.366 Hz) and the depth (6.25 ms) follow the sample rate', click, [n(60, 127, 0, 0.05)], 2.0, { sr: 48000, params: { chorOn: 1 }, tol: 2e-7 });
add('sr96_chor_click', 'chorus on a click at 96 kHz', click, [n(60, 127, 0, 0.05)], 2.0, { sr: 96000, params: { chorOn: 1 }, tol: 2e-7 });
add('fx_chor', 'chorus on a sine (the LFO at the host\'s phase)', () => mk(), [n(60, 100, 0, 0.5)], 2.0, { params: { chorOn: 1 }, tol: 4e-7 });
add('rc_both', 'reverb and chorus together', () => mk(), [n(60, 100, 0, 0.5)], 4.0, { params: { revOn: 1, chorOn: 1 }, tol: 1e-6 });

// ---- sample links ("Fix unexpected levels" off plays linked samples together)
function stereoFont(typL: number, typR: number, linkL: boolean): Uint8Array {
  const w = new Sf2Writer();
  const a = w.addSample({ name: 'L', data: sineData(100, 4), root: 60, loop: [0, 400], type: typL, link: linkL ? 1 : 0 });
  const b = w.addSample({ name: 'R', data: sineData(50, 8, 20000), root: 60, loop: [0, 400], type: typR, link: 0 });
  const i = w.addInstrument('inst', [{ gens: { [G.sampleID]: a, [G.pan]: -500, ...LOOP } }, { gens: { [G.sampleID]: b, [G.pan]: 500, ...LOOP } }]);
  w.addPreset('p', 0, 0, [{ gens: { [G.instrument]: i } }]);
  return w.build();
}
add('lnk_pair_i1', 'left / right pair, links ignored (default)', () => stereoFont(4, 2, true), [n(60, 100, 0, 0.4)], 1.0, { params: { ignoreLinks: 1 } });
add('lnk_pair_i0', 'left / right pair, links honoured', () => stereoFont(4, 2, true), [n(60, 100, 0, 0.4)], 1.0, { params: { ignoreLinks: 0 } });
add('lnk_leftonly_i0', 'a left sample whose partner has no usable type', () => stereoFont(4, 0, true), [n(60, 100, 0, 0.4)], 1.0, { params: { ignoreLinks: 0 } });
add('lnk_mono_i0', 'mono samples with a link', () => stereoFont(1, 1, true), [n(60, 100, 0, 0.4)], 1.0, { params: { ignoreLinks: 0 } });
