// Module factory for the FL Studio Mobile Rack: FL Studio Mobile module type id -> DSP.

import type { MrModule } from './common';
import { Filter, GraphicEq, ParamEq, TunedEq } from './eq';
import { Autoduck, Compressor, Gate, Leveller, Limiter, MultibandComp } from './dynamics';
import { Distortion, Waveshaper } from './drive';
import { Chorus, CombFilter, Flanger, Phaser, Tremolo, WowFlutter } from './modulation';
import { Reverb2, TapeDelay, TapeStop, TranceDelay } from './time';
import { Spacer, Spreader, Stereoizer } from './stereo';
import { Analyzer, MultiFx, Pitcher2, Tuner } from './misc';

export type { MrModule, MrCtx, MrMonitor } from './common';

export function createModule(type: number, sr: number, bs: number): MrModule | null {
  switch (type) {
    case 3: return new ParamEq(sr);
    case 4: return new MultiFx(sr, bs);
    case 6: return new Distortion(sr);
    case 7: return new GraphicEq(sr);
    case 8: return new Compressor(sr);
    case 9: return new Filter(sr);
    case 11: return new Chorus(sr);
    case 13: return new Flanger(sr);
    case 14: return new Phaser(sr);
    case 15: return new Stereoizer(sr);
    case 16: return new TranceDelay(sr);
    case 18: return new TapeDelay(sr);
    case 20: return new Leveller(sr);
    case 24: return new Tuner(sr);
    case 26: return new Analyzer(sr);
    case 27: return new Gate(sr);
    case 28: return new Limiter(sr);
    case 29: return new Autoduck(sr);
    case 30: return new TunedEq(sr);
    case 34: return new Spacer(sr);
    case 35: return new Reverb2(sr);
    case 36: return new MultibandComp(sr, bs);
    case 40: return new CombFilter(sr);
    case 41: return new Waveshaper(sr);
    case 42: return new TapeStop(sr);
    case 43: return new WowFlutter(sr);
    case 44: return new Spreader(sr);
    case 45: return new Pitcher2(sr, bs);
    case 46: return new Tremolo(sr);
    default: return null;
  }
}
