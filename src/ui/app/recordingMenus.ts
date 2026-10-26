// Menus of audio recording: the Record button's recording filter, the count-in
// and wait-for-input menus, Options > Audio settings > Input, and Mixer >
// Options > Disk recording. The wording is FL's.

import type { MenuItem } from '../widgets/ContextMenu';
import { store, host } from '../../store';
import { setRec, oneClickRecording } from '../../audio/recording';
import { flashHint } from '../hint';
import type { InputDevice, InputState } from '../../audio/AudioInput';
import { uid } from '../../model/defaults';

/** Right-click the Record button: what is recorded, and the recording options. */
export function recordFilterMenu(): MenuItem[] {
  const r = store.ui.rec;
  const markers = store.project.playlist.markers.filter((m) => m.kind === 'recStart' || m.kind === 'recStop');
  return [
    { header: true, label: 'Recording filter' },
    { label: 'Automation', disabled: true, hint: 'Recording automation is not available' },
    { label: 'Notes', disabled: true, hint: 'Recording notes is not available' },
    { label: 'Audio', checked: r.filterAudio, hint: 'Select what is included when recording audio', onClick: () => setRec({ filterAudio: !r.filterAudio }) },
    { label: 'Clips', disabled: true, hint: 'Recording clips triggered in Performance mode is not available' },
    { header: true, label: 'Audio goes' },
    { label: 'Into playlist as an audio clip', radio: true, checked: r.audioTo === 'playlist', onClick: () => setRec({ audioTo: 'playlist' }) },
    { label: 'Into Edison audio editor/recorder', radio: true, checked: r.audioTo === 'edison', onClick: () => setRec({ audioTo: 'edison' }) },
    { header: true, label: 'Options' },
    { label: 'Recording starts playback', checked: r.startsPlayback, onClick: () => setRec({ startsPlayback: !r.startsPlayback }) },
    { label: 'Disarm on stop', checked: r.disarmOnStop, onClick: () => setRec({ disarmOnStop: !r.disarmOnStop }) },
    { label: 'Enable recording markers', checked: r.markers, hint: 'Recording starts and stops at the Start recording / Stop recording markers of the Playlist', onClick: () => setRec({ markers: !r.markers }) },
    { label: 'Start/stop recording at selection', hint: 'Put the recording markers at the edges of the Playlist time selection', onClick: () => recordingMarkersAtSelection() },
    { label: 'Remove recording markers', disabled: markers.length === 0, onClick: () => removeRecordingMarkers() },
  ];
}

/** Right-click the countdown switch. */
export function countdownMenu(): MenuItem[] {
  const r = store.ui.rec;
  return [
    { header: true, label: 'Precount duration' },
    { label: '1 bar', radio: true, checked: r.countdownBars === 1, onClick: () => setRec({ countdownBars: 1 }) },
    { label: '2 bars', radio: true, checked: r.countdownBars === 2, onClick: () => setRec({ countdownBars: 2 }) },
  ];
}

/** Right-click the wait-for-input switch. */
export function waitMenu(): MenuItem[] {
  const r = store.ui.rec;
  return [
    { label: 'Only when recording', checked: r.waitOnlyRecording, onClick: () => setRec({ waitOnlyRecording: !r.waitOnlyRecording }) },
    { label: 'Respect recording filter', checked: r.waitRespectFilter, onClick: () => setRec({ waitRespectFilter: !r.waitRespectFilter }) },
  ];
}

/** Tools > One-click audio recording. */
export function oneClickItems(): MenuItem[] {
  return [
    { label: 'Into Edison audio editor/recorder', onClick: () => void oneClickRecording('edison') },
    { label: 'Into playlist as an audio clip', onClick: () => void oneClickRecording('playlist') },
  ];
}

// ------------------------------------------------------------ audio input
/** The device list (radio items) shared by Options > Audio settings and the mixer's Input menu. */
export function inputDeviceItems(st: InputState = host.input.state): MenuItem[] {
  const items: MenuItem[] = [];
  if (!host.input.supported) {
    items.push({ label: 'Audio input is not available: the browser needs a secure page (https or localhost)', disabled: true });
    return items;
  }
  items.push({ label: '(none)', radio: true, checked: !st.deviceId, onClick: () => { void host.input.select(null); } });
  items.push({
    label: 'System default', radio: true, checked: st.deviceId === 'default',
    onClick: () => void connectInput('default'),
  });
  const named = st.devices.filter((d: InputDevice) => d.id !== 'default');
  for (const d of named) {
    items.push({ label: d.label, radio: true, checked: st.deviceId === d.id, onClick: () => void connectInput(d.id) });
  }
  items.push({ separator: true });
  items.push({ label: 'Refresh device list', onClick: () => { void host.input.refresh(); } });
  return items;
}

/** Choose the input device; the browser asks for permission the first time. */
export async function connectInput(id: string | null): Promise<void> {
  const ok = await host.input.select(id);
  if (id && !ok) flashHint(host.input.describe());
  else if (ok) flashHint(host.input.describe());
}

/** Options > Audio settings > Input. */
export function audioInputItems(): MenuItem[] {
  const st = host.input.state;
  const items: MenuItem[] = [{ header: true, label: 'Input' }, ...inputDeviceItems(st)];
  items.push({ separator: true });
  items.push({ label: host.input.describe(), disabled: true });
  if (st.status === 'ready') {
    const li = host.inputLatencyFrames(), lo = host.outputLatencyFrames();
    items.push({ label: `Latency: input: ${li}smp, output: ${lo}smp (${Math.round(((li + lo) / host.sampleRate) * 1000)}ms)`, disabled: true });
    if (st.processing.length) items.push({ label: `The browser applies ${st.processing.join(', ')}`, disabled: true });
  } else if (st.message) {
    items.push({ label: st.message, disabled: true });
  }
  return items;
}

// ---------------------------------------------------------- disk recording
/** Mixer > Options > Disk recording. */
export function diskRecordingItems(): MenuItem[] {
  const r = store.ui.rec;
  return [
    { label: 'Auto-unarm', checked: r.autoUnarm, hint: 'Unarm mixer tracks after recording', onClick: () => setRec({ autoUnarm: !r.autoUnarm }) },
    { label: 'Auto-create audio clip', checked: r.autoClip, hint: 'Record / render to audio clip (song mode only)', onClick: () => setRec({ autoClip: !r.autoClip }) },
    { label: 'Latency compensation', checked: r.latencyComp, hint: 'Compensate for latency when recording audio from an external device', onClick: () => setRec({ latencyComp: !r.latencyComp }) },
    { label: 'Ignore silent takes', checked: r.ignoreSilent, onClick: () => setRec({ ignoreSilent: !r.ignoreSilent }) },
    { label: 'Auto name playlist tracks', checked: r.autoName, onClick: () => setRec({ autoName: !r.autoName }) },
    { header: true, label: 'Format' },
    { label: '16Bit int', radio: true, checked: r.bits === 16, onClick: () => setRec({ bits: 16 }) },
    { label: '24Bit int', radio: true, checked: r.bits === 24, onClick: () => setRec({ bits: 24 }) },
    { label: '32Bit float', radio: true, checked: r.bits === 32, onClick: () => setRec({ bits: 32 }) },
  ];
}

// --------------------------------------------------------------- markers
/** "Start/stop recording at selection": the two recording markers at the edges of the Playlist time selection. */
export function recordingMarkersAtSelection(): void {
  const sel = store.ui.playlist.timeSel;
  if (!sel || sel.end <= sel.start) {
    flashHint('Select a time range in the Playlist first (Ctrl+drag on the time ruler)');
    return;
  }
  store.update('Recording markers', (d) => {
    d.playlist.markers = d.playlist.markers.filter((m) => m.kind !== 'recStart' && m.kind !== 'recStop');
    d.playlist.markers.push({ id: uid('m'), pos: sel.start, name: 'Start recording', kind: 'recStart' });
    d.playlist.markers.push({ id: uid('m'), pos: sel.end, name: 'Stop recording', kind: 'recStop' });
  });
  setRec({ markers: true });
  flashHint('Recording starts and stops at the selection');
}

export function removeRecordingMarkers(): void {
  store.update('Remove recording markers', (d) => {
    d.playlist.markers = d.playlist.markers.filter((m) => m.kind !== 'recStart' && m.kind !== 'recStop');
  });
}


