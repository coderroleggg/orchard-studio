// Note naming follows FL Studio's convention: MIDI key 60 is "C5".

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const FL_OCTAVE_OFFSET = 0; // key 60 -> octave 5 (60 / 12 = 5)

export function keyName(key: number): string {
  const oct = Math.floor(key / 12) + FL_OCTAVE_OFFSET;
  return NOTE_NAMES[((key % 12) + 12) % 12] + oct;
}

export function isBlackKey(key: number): boolean {
  const n = ((key % 12) + 12) % 12;
  return n === 1 || n === 3 || n === 6 || n === 8 || n === 10;
}

export const KEY_MIN = 0; // C0
export const KEY_MAX = 131; // B10 (FL's piano roll spans C0..B10)
export const DEFAULT_KEY = 60; // C5
