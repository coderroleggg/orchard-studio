// Ogun's value texts against FL Studio 2026: the whole range of 82 parameters swept through the real plugin (FNV-1a digests of FL's
// "value<TAB>text" lines, tests/gen/ogun-texts.golden.ts), the two texts that follow the plugin's tempo switches, and the rounding quirks
// the sweeps showed. No FL files are used.
import { describe, it, expect } from 'vitest';
import { OGUN_PARAMS } from '../../src/model/gen/plugins/ogun/params';
import { freshState } from '../../src/model/gen/plugins/ogun/state';
import { decayText, eqFreqText, eqLevelText, releaseText } from '../../src/model/gen/plugins/ogun/texts';
import { TEXT_GOLDEN, TEXT_GOLDEN_TEMPO } from './ogun-texts.golden';

function fnv(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h >>> 0;
}

/** The sweep lines of a parameter in a state, as the test host prints them. */
function sweep(i: number, first: number, count: number, state: Record<string, unknown>): string {
  const p = OGUN_PARAMS[i];
  const lines: string[] = [];
  for (let k = 0; k < count; k++) {
    const v = first + k;
    lines.push(`${v}\t${p.options ? p.options[v - p.min] : p.format!(v, state)}`);
  }
  return lines.join('\n') + '\n';
}

describe('Ogun: value texts (pinned to FL Studio 2026)', () => {
  const st = freshState() as Record<string, unknown>;

  it('reproduces FL\'s text at every value of 82 parameters', () => {
    const bad: number[] = [];
    for (const [k, [first, count, digest]] of Object.entries(TEXT_GOLDEN)) {
      if (fnv(sweep(+k, first, count, st)) !== digest) bad.push(+k);
    }
    expect(bad).toEqual([]);
  });

  it('shows the delay time and the reverb predelay in beats or in milliseconds by the tempo switches', () => {
    const withState = (patch: Record<string, unknown>) => ({ ...st, ...patch });
    const x = (reverbTempo: number) => [...(st.xi as number[])].map((v, i) => (i === 4 ? (v & ~0xff00) | (reverbTempo << 8) : v));
    const cases: [string, number, Record<string, unknown>][] = [
      ['27_delay_ms', 27, withState({ b3: [0, 1, 0] })],
      ['27_delay_tempo', 27, withState({ b3: [1, 1, 0] })],
      ['33_rev_ms', 33, withState({ xi: x(0) })],
      ['33_rev_tempo', 33, withState({ xi: x(1) })],
    ];
    for (const [name, index, state] of cases) {
      const [first, count, digest] = TEXT_GOLDEN_TEMPO[name];
      expect(fnv(sweep(index, first, count, state)), name).toBe(digest);
    }
    // a few values by hand
    expect(OGUN_PARAMS[27].format!(145, withState({ b3: [1, 1, 0] }))).toBe('3:01');
    expect(OGUN_PARAMS[27].format!(144, withState({ b3: [0, 1, 0] }))).toBe('375ms');
  });

  it('prints one coarse / fine unit for 0 and +-1 and rounds the time, frequency and level texts like the plugin', () => {
    const coarse = OGUN_PARAMS[1].format!, fine = OGUN_PARAMS[2].format!;
    expect([coarse(0), coarse(1), coarse(-1), coarse(2), coarse(-24)]).toEqual([
      '+0.00 semitone', '+1.00 semitone', '-1.00 semitone', '+2.00 semitones', '-24.00 semitones',
    ]);
    expect([fine(0), fine(1), fine(2)]).toEqual(['+0.00 cent', '+1.00 cent', '+2.00 cents']);
    // single-precision steps and ties to even: 9865.499 reads 9866 ms, 10986.5 reads 10986, 15627.5 reads 15628
    expect([7828, 8152, 9231, 9279].map(decayText)).toEqual(['9866ms', '10986ms', '15628ms', '15872ms']);
    expect(releaseText(7828)).toBe('9866ms');
    expect(decayText(10000)).toBe('Infinite');
    expect(eqFreqText(10771)).toBe('192Hz');
    // the single just below a tie rounds up from 10 dB on
    expect([-1595, -1545, -1765, -995, -1725].map(eqLevelText)).toEqual(['-16.0dB', '-15.5dB', '-17.6dB', '-9.9dB', '-17.3dB']);
  });
});
