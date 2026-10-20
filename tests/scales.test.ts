import { describe, it, expect } from 'vitest';
import { faderToDb, channelVolumeToDb, panGains, dbToFader, flGain } from '../src/model/scales';
import { velocityGain } from '../src/model/sampler';

const db = (g: number) => 20 * Math.log10(g);

describe('FL volume law', () => {
  it('mixer fader: 0.8 = 0 dB, max = +5.6 dB, 0.6309 = -5 dB', () => {
    expect(faderToDb(0.8)).toBeCloseTo(0, 6);
    expect(faderToDb(1)).toBeCloseTo(5.594, 2);
    expect(faderToDb(0.6309)).toBeCloseTo(-5, 1);
    expect(dbToFader(-12)).toBeCloseTo(0.419, 2);
  });

  it('channel volume: 100% = 0 dB, default 78.125% = -5.18 dB', () => {
    expect(channelVolumeToDb(1)).toBeCloseTo(0, 6);
    expect(channelVolumeToDb(100 / 128)).toBeCloseTo(-5.18, 1);
    expect(channelVolumeToDb(0.5)).toBeCloseTo(-12.71, 1);
  });

  it('velocity: 100 = unity, 128 = +6.25 dB, 64 = -8.78 dB', () => {
    expect(db(velocityGain(100))).toBeCloseTo(0, 6);
    expect(db(velocityGain(128))).toBeCloseTo(6.25, 1);
    expect(db(velocityGain(64))).toBeCloseTo(-8.78, 1);
  });

  it('default sampler state sits about 8.2 dB below the sample level', () => {
    const [l] = panGains(0);
    const total = db(flGain(100 / 128)) + db(velocityGain(100)) + db(l);
    expect(total).toBeCloseTo(-8.19, 1);
  });

  it('circular pan law: -3 dB at centre, 0 dB at the extremes', () => {
    expect(db(panGains(0)[0])).toBeCloseTo(-3.01, 1);
    expect(db(panGains(-1)[0])).toBeCloseTo(0, 6);
    expect(panGains(-1)[1]).toBeCloseTo(0, 6);
  });
});
