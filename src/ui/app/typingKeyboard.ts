// Computer keyboard -> notes on the selected channel (when enabled).

import { store, host } from '../../store';

// two rows, lower starts at C4 (key 48) and upper at C5 (key 60)
const MAP: Record<string, number> = {
  z: 48, s: 49, x: 50, d: 51, c: 52, v: 53, g: 54, b: 55, h: 56, n: 57, j: 58, m: 59, ',': 60,
  q: 60, '2': 61, w: 62, '3': 63, e: 64, r: 65, '5': 66, t: 67, '6': 68, y: 69, '7': 70, u: 71, i: 72, '9': 73, o: 74, '0': 75, p: 76,
};

const held = new Map<string, { ch: string; key: number; tag: number }>();

export function handleTypingKeyboard(e: KeyboardEvent, down: boolean): boolean {
  if (!store.ui.typingKeyboard) return false;
  if (e.ctrlKey || e.metaKey || e.altKey) return false;
  const k = e.key.toLowerCase();
  const key = MAP[k];
  if (key === undefined) return false;
  if (down) {
    if (e.repeat || held.has(k)) return true;
    const ch = store.ui.selectedChannels[0] ?? store.project.channels[0]?.id;
    if (!ch) return true;
    const tag = host.noteOn(ch, key, 100);
    held.set(k, { ch, key, tag });
  } else {
    const h = held.get(k);
    if (h) {
      host.noteOff(h.ch, h.key, h.tag);
      held.delete(k);
    }
  }
  return true;
}
