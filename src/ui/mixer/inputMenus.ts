// The mixer track's recording menus (FL's mixer track Input selector, the
// recording pickup and "Monitor external input" menu, and the input delay
// compensation menu).

import type { MenuItem } from '../widgets/ContextMenu';
import { store, host } from '../../store';
import * as A from '../../store/actions';
import { armTrack, inputLocked, setTrackInput } from '../../audio/recording';
import { inputDeviceItems } from '../app/recordingMenus';
import { flashHint } from '../hint';
import type { MixerTrack } from '../../model/types';
import {
  MONITOR_MODES, MONITOR_NAME, PICKUP_HINT, PICKUP_NAME, REC_PICKUPS, autoMapInputs, delayFromMs, delayToMs, formatDelay, inputName, monoInputs,
  sameInput, stereoPairs, MAX_INPUT_DELAY_MS, type DelayUnit,
} from '../../model/recording';

/** Click the Input selector: the device's channels as stereo pairs and mono inputs (or the devices, while none is open). */
export function inputMenu(t: MixerTrack): MenuItem[] {
  const st = host.input.state;
  if (st.status !== 'ready') {
    // no input yet: say why, and offer the devices
    return [
      { header: true, label: 'Audio input' },
      { label: host.input.describe(), disabled: true },
      { separator: true },
      ...inputDeviceItems(st),
    ];
  }
  const ch = st.channels;
  const items: MenuItem[] = [
    { label: '(none)', radio: true, checked: !t.input, onClick: () => setTrackInput(t.index, undefined) },
  ];
  if (ch >= 2) {
    items.push({ header: true, label: 'Stereo' });
    for (const p of stereoPairs(ch)) items.push({ label: inputName(p), radio: true, checked: sameInput(t.input, p), onClick: () => setTrackInput(t.index, p) });
  }
  items.push({ header: true, label: 'Mono' });
  for (const m of monoInputs(ch)) items.push({ label: inputName(m), radio: true, checked: sameInput(t.input, m), onClick: () => setTrackInput(t.index, m) });
  items.push({ separator: true });
  items.push({ label: 'Auto map', hint: 'Map the following inputs to the following mixer tracks, starting with this one', onClick: () => autoMapFrom(t.index) });
  items.push({ label: 'Reset mapping', hint: 'Default all mixer tracks', onClick: () => resetInputMapping() });
  items.push({ separator: true });
  items.push({ label: 'Audio input device', submenu: inputDeviceItems(st) });
  return items;
}

/** Right-click the Input selector. */
export function inputMappingMenu(t: MixerTrack): MenuItem[] {
  return [
    { label: 'Auto map', hint: 'Map the following inputs to the following mixer tracks, starting with this one', onClick: () => autoMapFrom(t.index) },
    { label: 'Reset mapping', hint: 'Default all mixer tracks', onClick: () => resetInputMapping() },
  ];
}

/** Auto map: this track's input (or the first one), and the next ones on the tracks that follow. */
export function autoMapFrom(first: number): void {
  const ch = host.input.state.channels;
  if (host.input.state.status !== 'ready' || ch < 1) { flashHint(host.input.describe()); return; }
  const t = store.project.mixer.tracks[first];
  const sel = t?.input ?? (ch >= 2 ? { ch: 0 } : { ch: 0, mono: true });
  const map = autoMapInputs(first, sel, ch, 125);
  if (inputLocked(Object.keys(map).map(Number))) return;
  store.update('Auto map inputs', (d) => {
    for (const [i, inp] of Object.entries(map)) d.mixer.tracks[Number(i)].input = inp;
  });
}

/** Reset mapping: no input on any track. */
export function resetInputMapping(): void {
  if (inputLocked(store.project.mixer.tracks.filter((t) => t.input).map((t) => t.index))) return;
  store.update('Reset input mapping', (d) => {
    for (const t of d.mixer.tracks) delete t.input;
  });
}

/** The recording pickup selector: where the recording is taken from, and "Monitor external input". */
export function pickupMenu(t: MixerTrack): MenuItem[] {
  const pick = t.pickup ?? 'ext';
  const mon = t.monitor ?? 'armed';
  return [
    { header: true, label: 'Record' },
    ...REC_PICKUPS.map((k): MenuItem => ({
      label: PICKUP_NAME[k], hint: PICKUP_HINT[k], radio: true, checked: pick === k,
      onClick: () => A.setMixer(t.index, 'pickup', k, 'Recording pickup'),
    })),
    { header: true, label: 'Monitor external input' },
    ...MONITOR_MODES.map((m): MenuItem => ({
      label: MONITOR_NAME[m], radio: true, checked: mon === m,
      onClick: () => A.setMixer(t.index, 'monitor', m, 'Monitor external input'),
    })),
  ];
}

/** The input delay compensation icon: a manual shift of the recording, in ms, samples or beats. */
export function delayMenu(t: MixerTrack): MenuItem[] {
  const ms = t.inputDelay ?? 0;
  return [
    { header: true, label: `Input latency: ${formatDelay(ms)}` },
    { label: 'Reset', disabled: ms === 0, onClick: () => A.setMixer(t.index, 'inputDelay', undefined, 'Input latency') },
    { label: 'Set in ms', onClick: () => promptDelay(t, 'ms') },
    { label: 'Set in samples', onClick: () => promptDelay(t, 'smp') },
    { label: 'Set in beats', onClick: () => promptDelay(t, 'beats') },
    { separator: true },
    {
      label: 'Adjust position of recorded audio', checked: t.inputAdjust !== false,
      hint: 'Also compensate the delay of the plugins the playback goes through',
      onClick: () => A.setMixer(t.index, 'inputAdjust', t.inputAdjust === false ? undefined : false, 'Adjust position of recorded audio'),
    },
  ];
}

function promptDelay(t: MixerTrack, unit: DelayUnit): void {
  const sr = host.sampleRate, tempo = store.project.tempo;
  const cur = delayFromMs(t.inputDelay ?? 0, unit, sr, tempo);
  const label = unit === 'ms' ? 'milliseconds' : unit === 'smp' ? 'samples' : 'beats';
  const v = prompt(`Input latency in ${label} (positive: the recording moves earlier)`, String(Math.round(cur * 1000) / 1000));
  if (v === null) return;
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return;
  const ms = Math.max(-MAX_INPUT_DELAY_MS, Math.min(MAX_INPUT_DELAY_MS, delayToMs(n, unit, sr, tempo)));
  A.setMixer(t.index, 'inputDelay', ms === 0 ? undefined : ms, 'Input latency');
}

/** The arm button's right-click: arms the track and names the recorded file. */
export function nameRecording(t: MixerTrack): void {
  armTrack(t.index, true);
  const cur = t.recordName ?? '';
  const n = prompt('Name of the recorded audio (empty: the track name)', cur);
  if (n === null) return;
  A.setMixer(t.index, 'recordName', n.trim() || undefined, 'Record file name');
}
