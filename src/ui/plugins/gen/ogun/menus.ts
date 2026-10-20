// Ogun's options menu (FL: SynthResModule.OptionsMenu, opened by the editor's menu button and the plugin window's menu): copy / paste
// preset, the random preset items, the unison / chorus / reverb presets, portamento, key and velocity links, processing quality, the
// timbre / EQ switches and "Import FL content...". Every switch writes the state field FL's handler does (settings.ts).

import * as A from '../../../../store/actions';
import { store } from '../../../../store';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { flashHint } from '../../../hint';
import { CHORUS_KEYS, CHORUS_PRESETS, REVERB_KEYS, REVERB_PRESETS, UNISON_KEYS, UNISON_PRESETS } from './presets';
import { MENU_SETTINGS, setXi, type Params } from './settings';
import { menuSetting, setMenuSetting } from './use';
import { OGUN_PARAMS } from '../../../../model/gen/plugins/ogun/params';
import { enterRandomNumber, generateRandom } from './random';
import { ogunImportHook } from './hooks';

const paramsOf = (slotId: string): Params => (A.findFx(store.project, slotId)?.fx.params ?? {}) as Params;

const DEFS = new Map(OGUN_PARAMS.map((p) => [p.key, p]));

/** Set parameters to the values of a preset row (clamped to FL's ranges). */
function applyRow(d: Params, keys: string[], vals: number[]): void {
  keys.forEach((k, i) => {
    const def = DEFS.get(k);
    d[k] = def ? Math.min(def.max, Math.max(def.min, vals[i])) : vals[i];
  });
}

/** FL's unison preset (UPres1MenuClick: parameters 12..16). */
export function applyUnison(slotId: string, tag: number): void {
  const row = UNISON_PRESETS[tag];
  if (!row) return;
  A.editFx(slotId, `Unison: ${row[0]}`, (d) => applyRow(d as Params, UNISON_KEYS, row[1]));
}

/** FL's chorus preset (CPres1MenuClick: parameters 19..24, the mix is not touched). */
export function applyChorus(slotId: string, tag: number): void {
  const row = CHORUS_PRESETS[tag];
  if (!row) return;
  A.editFx(slotId, `Chorus: ${row[0]}`, (d) => applyRow(d as Params, CHORUS_KEYS, row[1]));
}

/** FL's reverb preset (RPres1MenuClick: parameters 31..39; the reverb is switched on unless "None", tempo-based predelay off). */
export function applyReverb(slotId: string, tag: number): void {
  const row = REVERB_PRESETS[tag];
  if (!row) return;
  A.editFx(slotId, `Reverb: ${row[0]}`, (d) => {
    const s = d as Params;
    applyRow(s, REVERB_KEYS, row[1]);
    const x = Array.isArray(s.xi) ? (s.xi as number[]) : [];
    // xi[4]: byte0 reverb enabled, byte1 tempo-based predelay
    setXi(s, 4, (((x[4] ?? 0) & ~0xffff) | (tag === 6 ? 0 : 1)) | 0);
  });
}

// --------------------------------------------------- copy / paste preset

/** The state of a preset as text (the plugin's state without the editor view). */
export function presetText(p: Params): string {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) if (k !== 'view' && k !== '__preset') out[k] = v;
  return JSON.stringify({ ogun: 1, state: out });
}

/** Parse a pasted preset text (null when it is not one); only the known state keys are taken. */
export function parsePresetText(text: string): Params | null {
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object' || (j as Record<string, unknown>).ogun !== 1) return null;
  const s = (j as Record<string, unknown>).state;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  const out: Params = {};
  const allowed = new Set<string>([...OGUN_PARAMS.map((p) => p.key), 'xi', 'b3', 'i2', 'info', 'arts', 'maps', 'missing']);
  for (const [k, v] of Object.entries(s as Record<string, unknown>)) if (allowed.has(k)) out[k] = v;
  return out;
}

async function copyPreset(slotId: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(presetText(paramsOf(slotId)));
    flashHint('Ogun: preset copied');
  } catch {
    flashHint('Ogun: the preset could not be copied (clipboard access refused)');
  }
}

async function pastePreset(slotId: string): Promise<void> {
  let text = '';
  try { text = await navigator.clipboard.readText(); } catch { flashHint('Ogun: the clipboard could not be read'); return; }
  const st = parsePresetText(text);
  if (!st) { flashHint('Ogun: the clipboard holds no Ogun preset'); return; }
  A.editFx(slotId, 'Paste preset', (d) => {
    const view = d.view;
    for (const k of Object.keys(d)) delete d[k];
    Object.assign(d, st);
    if (view !== undefined) d.view = view;
  });
  flashHint('Ogun: preset pasted');
}

// -------------------------------------------------------------- the menu

const check = (slotId: string, p: Params, id: string, label?: string): MenuItem => {
  const s = menuSetting(id);
  const on = s.get(p) !== 0;
  return { label: label ?? s.label, checked: on, onClick: () => setMenuSetting(slotId, id, on ? 0 : 1) };
};

const radios = (slotId: string, p: Params, id: string, labels: string[]): MenuItem[] => {
  const cur = menuSetting(id).get(p);
  return labels.map((l, i) => ({ label: l, radio: true, checked: i === cur, onClick: () => setMenuSetting(slotId, id, i) }));
};

export const PORTA_LIMITS = ['No limit', 'Octave wrap', '4 semitones limit', '3 semitones limit', '2 semitones limit', '1 semitone limit'];
export const QUALITY_NAMES = ['Draft', 'Average', 'High', 'Pristine', 'Huge waste of CPU'];

/** The options menu (FL: SynthResModule.OptionsMenu) for the instrument of `slotId`. */
export function ogunMenu(slotId: string): MenuItem[] {
  const p = paramsOf(slotId);
  const imp = ogunImportHook();
  return [
    { label: 'Copy preset', onClick: () => { void copyPreset(slotId); } },
    { label: 'Paste preset', onClick: () => { void pastePreset(slotId); } },
    { label: 'Generate random preset', onClick: () => generateRandom(slotId, paramsOf(slotId)) },
    { label: 'Enter random preset number...', onClick: () => enterRandomNumber(slotId, paramsOf(slotId)) },
    { header: true, label: 'Effects' },
    { label: 'Unison', submenu: UNISON_PRESETS.map(([n], i) => ({ label: n, onClick: () => applyUnison(slotId, i) })) },
    { label: 'Chorus', submenu: CHORUS_PRESETS.map(([n], i) => ({ label: n, onClick: () => applyChorus(slotId, i) })) },
    { label: 'Reverb', submenu: REVERB_PRESETS.map(([n], i) => ({ label: n, onClick: () => applyReverb(slotId, i) })) },
    { header: true, label: 'Tone' },
    {
      label: 'Portamento', submenu: [
        check(slotId, p, 'porta', 'Enable portamento'),
        { separator: true },
        check(slotId, p, 'portaVar', 'Variable time'),
        { separator: true },
        ...radios(slotId, p, 'portaLimit', PORTA_LIMITS),
      ],
    },
    {
      label: 'Key', submenu: [
        check(slotId, p, 'keyPitch', 'Link key to pitch'),
        check(slotId, p, 'keySeed', 'Link key to timbre seed 1'),
        { separator: true },
        check(slotId, p, 'monoKey', 'Limit to 1 voice per key'),
      ],
    },
    {
      label: 'Velocity', submenu: [
        check(slotId, p, 'velVol', 'Link velocity to volume'),
        check(slotId, p, 'velAttTime', 'Link velocity to attack time'),
        check(slotId, p, 'velAttLength', 'Link velocity to attack length'),
      ],
    },
    { label: 'Processing quality', submenu: radios(slotId, p, 'quality', QUALITY_NAMES) },
    { separator: true },
    check(slotId, p, 'releaseLink', 'Link timbre release to volume decay'),
    check(slotId, p, 'octEQScale', 'Natural EQ mapping scale'),
    check(slotId, p, 'natWeight', 'Natural EQ mapping weighting'),
    check(slotId, p, 'autoLoudness', 'Auto loudness'),
    { header: true, label: 'Resynthesis' },
    { label: 'Analyze timbre...', disabled: true },
    { label: 'Analyze timbre in audio clipboard', disabled: true },
    { separator: true },
    {
      label: imp.label, disabled: !imp.hook, submenu: [
        { label: "From FL's Ogun preset folder...", onClick: () => imp.hook?.(slotId, 'folder') },
        { label: 'From files (.fst)...', onClick: () => imp.hook?.(slotId, 'files') },
      ],
    },
  ];
}

/** Every menu item id the options menu wires (tests). */
export const MENU_IDS = Object.keys(MENU_SETTINGS);
