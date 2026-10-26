// The recording menus and what they do to the project, against a stubbed
// navigator.mediaDevices: Options > Audio settings > Input, the mixer track's
// Input / pickup / delay menus, the Record button's menus, one-click recording.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MenuItem } from '../src/ui/widgets/ContextMenu';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

/** Find an item by its label in a menu (and its submenus) and click it. */
function find(items: MenuItem[], label: string): MenuItem {
  for (const it of items) {
    if (it.label === label) return it;
    if (it.submenu) { try { return find(it.submenu, label); } catch { /* keep looking */ } }
  }
  throw new Error(`no menu item "${label}" in: ${items.map((i) => i.label).join(' | ')}`);
}
const click = (items: MenuItem[], label: string) => find(items, label).onClick?.();
const settle = () => new Promise((r) => setTimeout(r, 0));

function fakeMedia(channels: number) {
  const calls: MediaStreamConstraints[] = [];
  const track = { label: 'Interface', getSettings: () => ({ deviceId: 'dev1', channelCount: channels, latency: 0.008 }), stop() {}, addEventListener() {} };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream;
  const md = {
    async getUserMedia(c: MediaStreamConstraints) { calls.push(c); return stream; },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'default', label: 'Default', groupId: 'g' },
        { kind: 'audioinput', deviceId: 'dev1', label: 'Interface', groupId: 'g' },
        { kind: 'audioinput', deviceId: 'dev2', label: 'Built-in Microphone', groupId: 'h' },
      ] as MediaDeviceInfo[];
    },
    addEventListener() {},
    removeEventListener() {},
  };
  return { md, calls };
}

describe('the recording menus', async () => {
  const { store, host } = await import('../src/store');
  const A = await import('../src/store/actions');
  const R = await import('../src/audio/recording');
  const M = await import('../src/ui/app/recordingMenus');
  const T = await import('../src/ui/mixer/inputMenus');
  const { live } = await import('../src/audio/live');

  const media = fakeMedia(4);
  vi.stubGlobal('navigator', { mediaDevices: media.md });
  host.resume = async () => {};
  host.updateLatency = () => {};
  const queue = (host as unknown as { queue: { t: string; o?: Record<string, unknown> }[] }).queue;
  afterEach(() => { queue.length = 0; });

  it('Options > Audio settings > Input: no device yet, then the devices, then the open one with its latency', async () => {
    let items = M.audioInputItems();
    expect(items[0]).toMatchObject({ header: true, label: 'Input' });
    expect(find(items, '(none)')).toMatchObject({ radio: true, checked: true });
    expect(find(items, 'No audio input selected (Options > Audio settings)').disabled).toBe(true);
    await host.input.refresh();
    items = M.audioInputItems();
    expect(items.map((i) => i.label)).toContain('Interface');
    expect(items.map((i) => i.label)).toContain('Built-in Microphone');
    // choosing a device asks the browser for it, with the processing off
    click(items, 'Interface');
    await settle(); await settle();
    expect(media.calls).toHaveLength(1);
    const a = media.calls[0].audio as MediaTrackConstraints;
    expect([a.echoCancellation, a.noiseSuppression, a.autoGainControl]).toEqual([false, false, false]);
    expect(a.deviceId).toEqual({ exact: 'dev1' });
    items = M.audioInputItems();
    expect(find(items, 'Interface')).toMatchObject({ checked: true });
    expect(items.some((i) => /4 channels/.test(i.label ?? ''))).toBe(true);
    expect(items.some((i) => /^Latency: input: \d+smp, output: \d+smp/.test(i.label ?? ''))).toBe(true);
    // (none) closes it again
    click(items, '(none)');
    await settle();
    expect(host.input.state.status).toBe('off');
    await host.input.select('dev1');
    expect(host.input.ready).toBe(true);
  });

  it('the mixer track Input menu: none, stereo pairs, mono inputs of the open device; the choice goes to the project', () => {
    const t = () => store.project.mixer.tracks[5];
    let items = T.inputMenu(t());
    expect(items.map((i) => i.label).filter(Boolean)).toEqual([
      '(none)', 'Stereo', 'Input 1 - Input 2', 'Input 3 - Input 4', 'Mono', 'Input 1', 'Input 2', 'Input 3', 'Input 4',
      'Auto map', 'Reset mapping', 'Audio input device',
    ]);
    click(items, 'Input 3 - Input 4');
    expect(t().input).toEqual({ ch: 2 });
    items = T.inputMenu(t());
    expect(find(items, 'Input 3 - Input 4').checked).toBe(true);
    click(items, 'Input 2');
    expect(t().input).toEqual({ ch: 1, mono: true });
    click(T.inputMenu(t()), '(none)');
    expect(t().input).toBeUndefined();
  });

  it('Auto map gives the following inputs to the following tracks; Reset mapping clears them all', () => {
    R.setTrackInput(6, { ch: 0 });
    click(T.inputMappingMenu(store.project.mixer.tracks[6]), 'Auto map');
    const tr = store.project.mixer.tracks;
    expect([tr[6].input, tr[7].input, tr[8].input]).toEqual([{ ch: 0 }, { ch: 2 }, undefined]); // 4 channels: two pairs
    R.setTrackInput(9, { ch: 1, mono: true });
    click(T.inputMappingMenu(store.project.mixer.tracks[9]), 'Auto map');
    expect([9, 10, 11, 12].map((i) => store.project.mixer.tracks[i].input)).toEqual([
      { ch: 1, mono: true }, { ch: 2, mono: true }, { ch: 3, mono: true }, undefined,
    ]);
    click(T.inputMappingMenu(store.project.mixer.tracks[6]), 'Reset mapping');
    expect(store.project.mixer.tracks.some((x) => x.input)).toBe(false);
  });

  it('the pickup menu sets the recording pickup and the monitoring mode', () => {
    const t = () => store.project.mixer.tracks[5];
    let items = T.pickupMenu(t());
    expect(find(items, 'External input only').checked).toBe(true);
    expect(find(items, 'When armed').checked).toBe(true);
    expect(items.map((i) => i.label).filter(Boolean)).toEqual([
      'Record', 'External input only', 'External and mixer input', 'Post effects', 'Post EQ', 'Post level and panning', 'Post track',
      'Monitor external input', 'Off', 'When armed', 'On',
    ]);
    click(items, 'Post EQ');
    click(items, 'On');
    items = T.pickupMenu(t());
    expect(t().pickup).toBe('eq');
    expect(t().monitor).toBe('on');
    expect(find(items, 'Post EQ').checked).toBe(true);
    expect(find(items, 'On').checked).toBe(true);
  });

  it('the input delay menu: set in ms, samples or beats, reset, and Adjust position of recorded audio', () => {
    const t = () => store.project.mixer.tracks[5];
    const sr = host.sampleRate; // no audio context in Node: 44100
    vi.stubGlobal('prompt', () => '12.5');
    click(T.delayMenu(t()), 'Set in ms');
    expect(t().inputDelay).toBeCloseTo(12.5, 6);
    vi.stubGlobal('prompt', () => '441');
    click(T.delayMenu(t()), 'Set in samples');
    expect(t().inputDelay).toBeCloseTo((441 * 1000) / sr, 6);
    vi.stubGlobal('prompt', () => '0.5');
    click(T.delayMenu(t()), 'Set in beats');
    expect(t().inputDelay).toBeCloseTo((0.5 * 60000) / store.project.tempo, 6);
    vi.stubGlobal('prompt', () => '999999');
    click(T.delayMenu(t()), 'Set in ms');
    expect(t().inputDelay).toBe(5000); // limited
    click(T.delayMenu(t()), 'Reset');
    expect(t().inputDelay).toBeUndefined();
    expect(find(T.delayMenu(t()), 'Adjust position of recorded audio').checked).toBe(true);
    click(T.delayMenu(t()), 'Adjust position of recorded audio');
    expect(t().inputAdjust).toBe(false);
    click(T.delayMenu(t()), 'Adjust position of recorded audio');
    expect(t().inputAdjust).toBeUndefined();
    vi.unstubAllGlobals();
    vi.stubGlobal('navigator', { mediaDevices: media.md });
  });

  it('the arm button\'s right-click names the recording and arms the track', () => {
    vi.stubGlobal('prompt', () => '  Lead guitar ');
    R.armTrack(5, false);
    T.nameRecording(store.project.mixer.tracks[5]);
    expect(store.project.mixer.tracks[5].armed).toBe(true);
    expect(store.project.mixer.tracks[5].recordName).toBe('Lead guitar');
    vi.stubGlobal('prompt', () => '');
    T.nameRecording(store.project.mixer.tracks[5]);
    expect(store.project.mixer.tracks[5].recordName).toBeUndefined();
    R.armTrack(5, false);
    vi.unstubAllGlobals();
    vi.stubGlobal('navigator', { mediaDevices: media.md });
  });

  it('the Record button\'s recording filter, count-in and wait-for-input menus change the options', () => {
    const r = () => store.ui.rec;
    let items = M.recordFilterMenu();
    expect(items.filter((i) => i.disabled).map((i) => i.label)).toEqual(expect.arrayContaining(['Automation', 'Notes', 'Clips']));
    expect(find(items, 'Audio').checked).toBe(true);
    click(items, 'Audio');
    expect(r().filterAudio).toBe(false);
    click(M.recordFilterMenu(), 'Audio');
    click(M.recordFilterMenu(), 'Into Edison audio editor/recorder');
    expect(r().audioTo).toBe('edison');
    click(M.recordFilterMenu(), 'Into playlist as an audio clip');
    expect(r().audioTo).toBe('playlist');
    click(M.recordFilterMenu(), 'Recording starts playback');
    expect(r().startsPlayback).toBe(true);
    click(M.recordFilterMenu(), 'Recording starts playback');
    click(M.recordFilterMenu(), 'Disarm on stop');
    expect(r().disarmOnStop).toBe(false);
    click(M.recordFilterMenu(), 'Disarm on stop');
    click(M.countdownMenu(), '2 bars');
    expect(r().countdownBars).toBe(2);
    items = M.countdownMenu();
    expect(find(items, '2 bars').checked).toBe(true);
    click(items, '1 bar');
    click(M.waitMenu(), 'Respect recording filter');
    expect(r().waitRespectFilter).toBe(false);
    click(M.waitMenu(), 'Respect recording filter');
  });

  it('Mixer > Disk recording options and the recording markers at the Playlist selection', () => {
    const r = () => store.ui.rec;
    expect(find(M.diskRecordingItems(), 'Auto-unarm').checked).toBe(true);
    click(M.diskRecordingItems(), 'Auto-unarm');
    expect(r().autoUnarm).toBe(false);
    click(M.diskRecordingItems(), 'Auto-unarm');
    click(M.diskRecordingItems(), '16Bit int');
    expect(r().bits).toBe(16);
    click(M.diskRecordingItems(), '32Bit float');
    expect(r().bits).toBe(32);
    // no selection: no markers
    A.setUi((u) => { u.playlist.timeSel = null; });
    click(M.recordFilterMenu(), 'Start/stop recording at selection');
    expect(store.project.playlist.markers.some((m) => m.kind)).toBe(false);
    A.setUi((u) => { u.playlist.timeSel = { start: 384, end: 768 }; });
    click(M.recordFilterMenu(), 'Start/stop recording at selection');
    expect(store.project.playlist.markers.map((m) => [m.kind, m.pos])).toEqual([['recStart', 384], ['recStop', 768]]);
    expect(r().markers).toBe(true);
    expect(find(M.recordFilterMenu(), 'Remove recording markers').disabled).toBeFalsy();
    click(M.recordFilterMenu(), 'Remove recording markers');
    expect(store.project.playlist.markers).toHaveLength(0);
    click(M.recordFilterMenu(), 'Enable recording markers');
    expect(r().markers).toBe(false);
  });

  it('one-click audio recording arms the selected insert with the first input and asks for a session', async () => {
    A.selectMixerTrack(8);
    R.setTrackInput(8, undefined);
    live.playing = false;
    click(M.oneClickItems(), 'Into playlist as an audio clip');
    await settle(); await settle(); await settle();
    const t = store.project.mixer.tracks[8];
    expect(t.armed).toBe(true);
    expect(t.input).toEqual({ ch: 0 }); // a stereo pair: the device has 4 channels
    expect(store.ui.recording).toBe(true);
    expect(store.ui.rec.audioTo).toBe('playlist');
    // recording into the Playlist: Song mode, Playlist open
    expect(store.project.songMode).toBe(true);
    expect(store.ui.windows.playlist.open).toBe(true);
    const start = queue.find((m) => m.t === 'recStart');
    expect(start).toBeTruthy();
    // FL: the input of a mixer track can't be changed while recording
    expect(R.recorder.records(8)).toBe(true);
    R.setTrackInput(8, { ch: 2 });
    expect(store.project.mixer.tracks[8].input).toEqual({ ch: 0 });
    click(T.inputMappingMenu(store.project.mixer.tracks[8]), 'Reset mapping');
    expect(store.project.mixer.tracks[8].input).toEqual({ ch: 0 });
    click(T.inputMappingMenu(store.project.mixer.tracks[8]), 'Auto map');
    expect(store.project.mixer.tracks[7].input).toBeUndefined();
    // the other tracks are free
    R.setTrackInput(9, { ch: 2 });
    expect(store.project.mixer.tracks[9].input).toEqual({ ch: 2 });
    // the engine ends the session: the input can be changed again
    R.recorder.onEngine({ t: 'recDone', cancelled: true });
    expect(R.recorder.active).toBe(false);
    R.setTrackInput(8, { ch: 2 });
    expect(store.project.mixer.tracks[8].input).toEqual({ ch: 2 });
  });
});
