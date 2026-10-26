// The recording options (right-click Record, the toolbar switches, Mixer > Options > Disk recording)
// are program settings, not project data: FL keeps them across projects. They are
// remembered in the browser's local storage.

import { normalizeRecSettings, type RecSettings } from '../model/recording';

const KEY = 'orchard-recording';

/** The browser's local storage (not in the worklet or in Node, where touching it would only warn). */
function storage(): Storage | null {
  return typeof document !== 'undefined' && typeof localStorage !== 'undefined' ? localStorage : null;
}

export function loadRecSettings(): RecSettings {
  try {
    const raw = storage()?.getItem(KEY);
    return normalizeRecSettings(raw ? JSON.parse(raw) : null);
  } catch {
    return normalizeRecSettings(null);
  }
}

export function saveRecSettings(s: RecSettings): void {
  try {
    storage()?.setItem(KEY, JSON.stringify(s));
  } catch { /* private mode or quota: the options last for this session */ }
}
