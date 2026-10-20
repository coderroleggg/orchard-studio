// Importing a soundfont file into the instrument's state: parse (sf2.ts), keep the pdta as base64, turn the sample
// data into the pool WAV. No DOM: the editor, the tests and the FL content importer share it.

import { SF2_MAX_BYTES, bytesToBase64, isSf2Error, parseSf2, sf2Pcm, sf2Wav } from './sf2';
import type { SfFont } from './state';

/** The sample rate the pool WAV is written with (the pool may decode it at the audio context's rate). */
export const POOL_WAV_RATE = 44100;

export interface Sf2Import {
  /** State entry minus the pool id (assigned when the WAV is stored in the sample pool). */
  font: Omit<SfFont, 'sample'>;
  /** The sample data as floats (what the pool holds) and the WAV file bytes to persist. */
  pcm: Float32Array;
  wav: Uint8Array;
}

/** Parse an SF2 file's bytes; { error } with a message for the user when it cannot be played. */
export function importSf2(bytes: Uint8Array, fallbackName = 'SoundFont'): Sf2Import | { error: string } {
  if (bytes.length > SF2_MAX_BYTES) return { error: 'The SoundFont file is too large.' };
  const info = parseSf2(bytes);
  if (isSf2Error(info)) return info;
  const name = info.name || fallbackName;
  return {
    font: { name, rate: POOL_WAV_RATE, frames: info.frames, has24: info.has24, hydra: bytesToBase64(info.pdta) },
    pcm: sf2Pcm(bytes, info),
    wav: sf2Wav(bytes, info, POOL_WAV_RATE),
  };
}
