// Harmor's options menu (FL: SynthResModule.OptionsMenu): copy / paste preset
// or part, the chorus and reverb presets (FL's tables: chorus 0x8ec078, 7
// values per preset for parameters 804..810; reverb 0x8ec190, 10 values for
// 794..803), the "Import FL content..." hook and About. Also the extra items
// of part controls' right-click menus (FL's WheelMenu: Copy to part B, Edit
// articulator).

import { store } from '../../../../store';
import * as A from '../../../../store/actions';
import type { MenuItem } from '../../../widgets/ContextMenu';
import { flashHint } from '../../../hint';
import { GLOBAL_PARAMS, HARMOR_KEYS, PART_MAIN } from '../../../../model/gen/plugins/harmor/params';
import { harmorImportHook } from './hooks';
import { viewOf } from './bind';

/** FL's chorus presets [chOrder, chDepth, chSpeed, chDelay, chSpread, chCross, chMix] by menu tag. */
export const CHORUS_PRESETS: number[][] = [
  [4, 512, 768, 8, 128, -32, 500], [5, 1024, 856, 0, 128, 68, 750], [7, 512, 512, 128, 128, 54, 500],
  [6, 561, 854, 0, 0, 38, 1000], [1, 136, 312, 0, 0, 128, -1000], [2, 86, 632, 0, 0, 0, 750],
  [1, 42, 944, 0, 0, -22, 1000], [9, 81, 170, 0, 0, -66, 900], [7, 19, 985, 0, 0, 0, 700],
  [0, 512, 768, 8, 128, -32, 500],
];
export const CHORUS_MENU: [string, number][] = [
  ['Off', 9], ['-', -1], ['Classic', 0], ['Thick', 1], ['Deep chorus', 2], ['Flanger', 3], ['Alt flanger', 4],
  ['Stereoized', 5], ['Modulation', 6], ['Surround flanger', 7], ['Vibration', 8],
];

/** FL's reverb presets [revOn, revLC, revHC, revPredelay, revRoom, revDiff, revDecay, revHD, revColor, revWet]. */
export const REVERB_PRESETS: number[][] = [
  [1, 220, 796, 0, 40, 100, 390, 796, 2, 500], [1, 0, 946, -128, 40, 100, 447, 828, 2, 600],
  [1, 110, 706, -160, 90, 100, 550, 758, 3, 600], [1, 460, 854, -168, 60, 65, 456, 783, 1, 525],
  [1, 260, 780, 0, 35, 100, 260, 778, 2, 550], [1, 260, 854, 0, 17, 100, 230, 752, 2, 550],
  [0, 220, 796, 0, 40, 100, 390, 796, 2, 500],
];
export const REVERB_MENU: [string, number][] = [
  ['Off', 6], ['-', -1], ['Classic', 0], ['Large hall', 1], ['Cathedral', 2], ['The venue', 3], ['Drum room', 4], ['Small studio', 5],
];

const CHORUS_KEYS = GLOBAL_PARAMS.slice(804 - 772, 811 - 772).map((g) => g[0]);
const REVERB_KEYS = GLOBAL_PARAMS.slice(794 - 772, 804 - 772).map((g) => g[0]);

function applyValues(slotId: string, label: string, keys: string[], vals: number[]): void {
  A.editFx(slotId, label, (d) => { keys.forEach((k, i) => { d[k] = vals[i]; }); });
  flashHint(label);
}

export function chorusMenu(slotId: string): MenuItem[] {
  return CHORUS_MENU.map(([n, t]) => (t < 0 ? { separator: true } : { label: n, onClick: () => applyValues(slotId, `Chorus preset: ${n}`, CHORUS_KEYS, CHORUS_PRESETS[t]) }));
}

export function reverbMenu(slotId: string): MenuItem[] {
  return REVERB_MENU.map(([n, t]) => (t < 0 ? { separator: true } : { label: n, onClick: () => applyValues(slotId, `Reverb preset: ${n}`, REVERB_KEYS, REVERB_PRESETS[t]) }));
}

// ------------------------------------------------------ copy / paste

interface Clip {
  kind: 'preset' | 'part';
  /** Part clips: the source part's parameters without prefix and its settings. */
  data: Record<string, unknown>;
}

let clip: Clip | null = null;

function paramsOf(slotId: string): Record<string, unknown> | null {
  const loc = A.findFx(store.project, slotId);
  return loc ? (loc.fx.params as Record<string, unknown>) : null;
}

/** Part parameter keys of part p (a_* or b_*). */
function partKeys(p: 'a' | 'b'): string[] {
  return HARMOR_KEYS.filter((k) => k.startsWith(`${p}_`));
}

export function copyPreset(slotId: string): void {
  const ps = paramsOf(slotId);
  if (!ps) return;
  const data = structuredClone(ps);
  delete data.hView;
  clip = { kind: 'preset', data };
  flashHint('Preset copied');
}

export function copyPart(slotId: string): void {
  const ps = paramsOf(slotId);
  if (!ps) return;
  const p = viewOf(ps).part ? 'b' : 'a';
  const data: Record<string, unknown> = {};
  for (const k of partKeys(p)) data[k.slice(2)] = ps[k];
  data.__part = structuredClone(p === 'a' ? ps.hA : ps.hB);
  clip = { kind: 'part', data };
  flashHint(`Part ${p.toUpperCase()} copied`);
}

export function pastePresetOrPart(slotId: string): void {
  const ps = paramsOf(slotId);
  if (!ps || !clip) return;
  const c = clip;
  if (c.kind === 'preset') {
    A.editFx(slotId, 'Paste preset', (d) => {
      const view = d.hView;
      for (const k of Object.keys(d)) delete d[k];
      Object.assign(d, structuredClone(c.data));
      d.hView = view;
    });
    flashHint('Preset pasted');
    return;
  }
  const p = viewOf(ps).part ? 'b' : 'a';
  A.editFx(slotId, `Paste into part ${p.toUpperCase()}`, (d) => {
    for (const [k, v] of Object.entries(c.data)) {
      if (k === '__part') d[p === 'a' ? 'hA' : 'hB'] = structuredClone(v) as never;
      else d[`${p}_${k}`] = v as never;
    }
  });
  flashHint(`Pasted into part ${p.toUpperCase()}`);
}

/** Copy the displayed part to the other part (all parameters and settings). */
export function copyPartToOther(slotId: string): void {
  const ps = paramsOf(slotId);
  if (!ps) return;
  const p = viewOf(ps).part ? 'b' : 'a', q = p === 'a' ? 'b' : 'a';
  A.editFx(slotId, `Copy part ${p.toUpperCase()} to part ${q.toUpperCase()}`, (d) => {
    for (const k of partKeys(p)) d[`${q}_${k.slice(2)}`] = d[k];
    const on = (d[q === 'a' ? 'hA' : 'hB'] as { on?: number } | undefined)?.on;
    d[q === 'a' ? 'hA' : 'hB'] = structuredClone(d[p === 'a' ? 'hA' : 'hB']) as never;
    if (on !== undefined) (d[q === 'a' ? 'hA' : 'hB'] as { on: number }).on = on;
  });
}

/** The plugin menu items (FL's options menu). */
export function harmorMenu(slotId: string): MenuItem[] {
  const imp = harmorImportHook();
  return [
    { label: 'Copy preset', onClick: () => copyPreset(slotId) },
    { label: 'Copy part', onClick: () => copyPart(slotId) },
    { label: 'Paste preset / part', disabled: !clip, onClick: () => pastePresetOrPart(slotId) },
    { label: 'Copy part to the other part', onClick: () => copyPartToOther(slotId) },
    { header: true, label: 'Effects' },
    { label: 'Chorus', submenu: chorusMenu(slotId) },
    { label: 'Reverb', submenu: reverbMenu(slotId) },
    { separator: true },
    {
      label: imp.label, disabled: !imp.hook, submenu: [
        { label: "From FL's Harmor preset folder...", onClick: () => imp.hook?.(slotId, 'folder') },
        { label: 'From files (.fst, samples)...', onClick: () => imp.hook?.(slotId, 'files') },
      ],
    },
    { separator: true },
    { label: 'About Harmor', disabled: true },
  ];
}

// --------------------------------------------- part control right-click

/** Articulation target of a part parameter (FL's WheelMenu "Edit articulator"). */
export const ART_OF_PARAM: Record<string, number> = {
  vol: 1, envVol: 1, fxMix: 2, tmix: 3, f1Freq: 4, f2Freq: 5, f1Width: 6, f2Width: 7, f1Res: 8, f2Res: 9,
  f1ResWidth: 10, f2ResWidth: 11, f1ResOfs: 12, f2ResOfs: 13, fMix: 14, pluck: 15, phMix: 16, phWidth: 17, phOfs: 18,
  hzMix: 19, hzWidth: 20, clip: 21, hblur: 22, prism: 23, pitchAmt: 24, vibDepth: 25, uniPitch: 26,
  imgTime: 27, imgFine: 28, imgFormant: 29, imgFreqScale: 30, f1Env: 31, f2Env: 32, uniPhase: 41, predelay: 42,
};

/** Extra right-click items of a part parameter control. */
export function partParamMenu(slotId: string, key: string): MenuItem[] {
  const m = /^([ab])_(.+)$/.exec(key);
  if (!m || !PART_MAIN.some((r) => r[0] === m[2])) return [];
  const p = m[1], name = m[2], q = p === 'a' ? 'b' : 'a';
  const items: MenuItem[] = [{
    label: `Copy to part ${q.toUpperCase()}`,
    onClick: () => { const ps = paramsOf(slotId); if (ps) A.setFxParam(slotId, `${q}_${name}`, ps[key]); },
  }];
  const t = ART_OF_PARAM[name];
  if (t !== undefined) {
    items.push({
      label: 'Edit articulator',
      onClick: () => A.setFxStateNoHistory(slotId, 'Edit articulator', (d) => {
        const v = (d.hView ?? (d.hView = {})) as Record<string, number>;
        v.page = 0; v.target = t;
      }),
    });
  }
  return items;
}
