// The audio input device with a stubbed navigator.mediaDevices: permission, the
// constraints the stream is opened with, device lists, unplugging and the choice
// being remembered (docs/recording.md).

import { describe, it, expect, vi, afterEach } from 'vitest';
import { AudioInput, inputConstraints, type MediaDevicesLike, type StorageLike } from '../src/audio/AudioInput';

interface FakeTrack {
  label: string;
  stopped: boolean;
  settings: Record<string, unknown>;
  end: () => void;
  stop(): void;
  getSettings(): Record<string, unknown>;
  addEventListener(type: string, fn: () => void): void;
}

/** A browser's media devices: a list of microphones, a permission switch, devices that come and go. */
function fakeMedia(opts: { channels?: number; permission?: 'granted' | 'denied' | 'prompt'; latency?: number } = {}) {
  const calls: MediaStreamConstraints[] = [];
  const tracks: FakeTrack[] = [];
  const handlers = new Set<() => void>();
  let permission = opts.permission ?? 'prompt';
  let devices = [
    { kind: 'audioinput', deviceId: 'default', label: '', groupId: 'a' },
    { kind: 'audioinput', deviceId: 'usb1', label: '', groupId: 'a' },
    { kind: 'audioinput', deviceId: 'mic2', label: '', groupId: 'b' },
    { kind: 'audiooutput', deviceId: 'spk', label: '', groupId: 'c' },
  ] as { kind: string; deviceId: string; label: string; groupId: string }[];
  const names: Record<string, string> = { default: 'Default - USB Mic', usb1: 'USB Mic', mic2: 'Built-in Microphone', spk: 'Speakers' };
  let failWith: string | null = null;

  const md: MediaDevicesLike = {
    async getUserMedia(c) {
      calls.push(c);
      if (failWith) { const e = new Error('no'); e.name = failWith; throw e; }
      if (permission === 'denied') { const e = new Error('denied'); e.name = 'NotAllowedError'; throw e; }
      const audio = (c.audio ?? {}) as MediaTrackConstraints;
      const exact = audio.deviceId && typeof audio.deviceId === 'object' && 'exact' in audio.deviceId ? String(audio.deviceId.exact) : 'default';
      if (!devices.some((d) => d.deviceId === exact && d.kind === 'audioinput')) { const e = new Error('gone'); e.name = 'OverconstrainedError'; throw e; }
      permission = 'granted';
      const ended = new Set<() => void>();
      const track: FakeTrack = {
        label: names[exact],
        stopped: false,
        settings: { deviceId: exact, channelCount: opts.channels ?? 2, sampleRate: 48000, latency: opts.latency ?? 0.012, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        end() { for (const f of ended) f(); },
        stop() { this.stopped = true; },
        getSettings() { return this.settings; },
        addEventListener(type, fn) { if (type === 'ended') ended.add(fn); },
      };
      tracks.push(track);
      return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] } as unknown as MediaStream;
    },
    async enumerateDevices() {
      // labels are hidden until the user has given permission
      return devices.map((d) => ({ ...d, label: permission === 'granted' ? names[d.deviceId] : '', toJSON() { return {}; } })) as unknown as MediaDeviceInfo[];
    },
    addEventListener(_t, fn) { handlers.add(fn); },
    removeEventListener(_t, fn) { handlers.delete(fn); },
  };
  return {
    md, calls, tracks,
    setPermission(p: 'granted' | 'denied' | 'prompt') { permission = p; },
    failNext(name: string | null) { failWith = name; },
    plug(id: string, label: string) { devices = [...devices, { kind: 'audioinput', deviceId: id, label: '', groupId: 'z' }]; names[id] = label; handlers.forEach((f) => f()); },
    unplug(id: string) { devices = devices.filter((d) => d.deviceId !== id); handlers.forEach((f) => f()); },
    handlers,
  };
}

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); } };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('audio input: opening a device', () => {
  it('asks for the audio untouched: echo cancellation, noise suppression and auto gain off, every channel', () => {
    const c = inputConstraints('usb1');
    const a = c.audio as MediaTrackConstraints & { latency?: unknown };
    expect(a.echoCancellation).toBe(false);
    expect(a.noiseSuppression).toBe(false);
    expect(a.autoGainControl).toBe(false);
    expect(a.deviceId).toEqual({ exact: 'usb1' });
    expect((a.channelCount as { ideal: number }).ideal).toBeGreaterThanOrEqual(8);
    expect(a.latency).toEqual({ ideal: 0 });
    expect(c.video).toBe(false);
    // the system default is not pinned to a device
    expect((inputConstraints('default').audio as MediaTrackConstraints).deviceId).toBeUndefined();
  });

  it('selecting a device opens a stream with those constraints and reports its channels and latency', async () => {
    const m = fakeMedia({ channels: 4, latency: 0.01 });
    const streams: (MediaStream | null)[] = [];
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    inp.onStream = (s) => streams.push(s);
    expect(await inp.select('usb1')).toBe(true);
    expect(inp.state).toMatchObject({ status: 'ready', deviceId: 'usb1', channels: 4, latencySec: 0.01, label: 'USB Mic' });
    expect(streams).toHaveLength(1);
    const a = m.calls[0].audio as MediaTrackConstraints;
    expect(a.echoCancellation).toBe(false);
    expect(a.deviceId).toEqual({ exact: 'usb1' });
    expect(inp.describe()).toContain('4 channels');
  });

  it('the first use triggers the permission request; refusing it is reported and can be retried', async () => {
    const m = fakeMedia({ permission: 'denied' });
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    expect(await inp.ensureOpen(true)).toBe(false); // nothing selected: the system default
    expect(inp.state.status).toBe('denied');
    expect(inp.state.message).toMatch(/permission/i);
    expect(inp.ready).toBe(false);
    // the user allows it in the browser, then tries again
    m.setPermission('granted');
    expect(await inp.select('default')).toBe(true);
    expect(inp.state.status).toBe('ready');
  });

  it('ensureOpen does not ask for a device when none was chosen (FL: please select an audio input first)', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    expect(await inp.ensureOpen()).toBe(false);
    expect(m.calls).toHaveLength(0);
    expect(inp.state.status).toBe('off');
    expect(inp.describe()).toMatch(/no audio input selected/i);
  });

  it('the device list shows audio inputs only, with names once permission is given', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    let list = await inp.refresh();
    expect(list.map((d) => d.id)).toEqual(['default', 'usb1', 'mic2']);
    expect(list[1].label).toBe('Audio input 2'); // no names before permission
    await inp.select('mic2');
    list = inp.state.devices;
    expect(list.map((d) => d.label)).toEqual(['Default - USB Mic', 'USB Mic', 'Built-in Microphone']);
  });

  it('a device that is not there is reported as missing, a busy one as an error', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    expect(await inp.select('ghost')).toBe(false);
    expect(inp.state.status).toBe('missing');
    expect(inp.describe()).toBe('Missing external input');
    m.failNext('NotReadableError');
    expect(await inp.select('usb1')).toBe(false);
    expect(inp.state.status).toBe('error');
    expect(inp.state.message).toMatch(/could not be opened/i);
  });

  it('no media devices at all (an insecure page): unsupported', async () => {
    const inp = new AudioInput(() => undefined, () => memoryStorage());
    expect(inp.supported).toBe(false);
    expect(await inp.select('default')).toBe(false);
    expect(inp.state.status).toBe('unsupported');
    await inp.init();
    expect(inp.state.status).toBe('unsupported');
  });

  it('reports processing the browser applied although it was switched off', async () => {
    const m = fakeMedia();
    const orig = m.md.getUserMedia.bind(m.md);
    m.md.getUserMedia = async (c) => {
      const s = await orig(c);
      (s.getAudioTracks()[0].getSettings() as Record<string, unknown>).echoCancellation = true;
      return s;
    };
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    await inp.select('default');
    expect(inp.state.processing).toEqual(['echo cancellation']);
  });
});

describe('audio input: devices coming and going', () => {
  it('a new device appears in the list when the browser reports a device change', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    await inp.init(false);
    expect(inp.state.devices).toHaveLength(3);
    m.plug('usb2', 'Interface');
    await settle();
    expect(inp.state.devices.map((d) => d.id)).toContain('usb2');
  });

  it('unplugging the open device closes the stream; plugging it in again opens it', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    const seen: (MediaStream | null)[] = [];
    inp.onStream = (s) => seen.push(s);
    await inp.init(false);
    await inp.select('usb1');
    expect(inp.ready).toBe(true);
    m.unplug('usb1');
    await settle();
    expect(inp.state.status).toBe('missing');
    expect(m.tracks[0].stopped).toBe(true);
    expect(seen.at(-1)).toBeNull();
    m.plug('usb1', 'USB Mic');
    await settle();
    await settle();
    expect(inp.state.status).toBe('ready');
    expect(m.tracks).toHaveLength(2);
    expect(seen.at(-1)).not.toBeNull();
  });

  it('says so when the device goes and when it is back', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    const notices: string[] = [];
    inp.onNotice = (t) => notices.push(t);
    await inp.init(false);
    await inp.select('usb1');
    expect(notices).toEqual([]); // the user's own choice is not announced
    m.unplug('usb1');
    await settle();
    m.plug('usb1', 'USB Mic');
    await settle(); await settle();
    expect(notices).toEqual(['Missing external input: the audio input was disconnected', 'USB Mic is connected again']);
  });

  it('a stream that ends by itself (the device was pulled out) is treated the same way', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    await inp.select('mic2');
    m.tracks[0].end();
    expect(inp.state.status).toBe('missing');
    expect(inp.state.message).toMatch(/disconnected/);
    expect(m.tracks[0].stopped).toBe(true);
  });

  it('choosing another device or none releases the first stream', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    await inp.select('usb1');
    await inp.select('mic2');
    expect(m.tracks[0].stopped).toBe(true);
    expect(inp.state.label).toBe('Built-in Microphone');
    await inp.select(null);
    expect(m.tracks[1].stopped).toBe(true);
    expect(inp.state.status).toBe('off');
  });

  it('two quick choices end with the second device open and no stream left behind', async () => {
    const m = fakeMedia();
    const inp = new AudioInput(() => m.md, () => memoryStorage());
    const a = inp.select('usb1');
    const b = inp.select('mic2');
    await Promise.all([a, b]);
    expect(inp.state.deviceId).toBe('mic2');
    expect(inp.state.status).toBe('ready');
    const open = m.tracks.filter((t) => !t.stopped);
    expect(open).toHaveLength(1);
    expect(open[0].label).toBe('Built-in Microphone');
  });
});

describe('audio input: the choice is remembered', () => {
  it('is saved, and a new session picks it up without opening it (the browser would ask first)', async () => {
    const m = fakeMedia();
    const store = memoryStorage();
    const a = new AudioInput(() => m.md, () => store);
    await a.select('mic2');
    expect(JSON.parse(store.data.get('orchard-audio-input')!)).toEqual({ deviceId: 'mic2' });
    const b = new AudioInput(() => m.md, () => store);
    await b.init(false);
    expect(b.state.deviceId).toBe('mic2');
    expect(b.state.status).toBe('off');
    expect(m.calls).toHaveLength(1);
  });

  describe('with a stubbed navigator', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('opens a remembered device by itself when the browser already allows the microphone', async () => {
      const m = fakeMedia({ permission: 'granted' });
      vi.stubGlobal('navigator', { mediaDevices: m.md, permissions: { query: async () => ({ state: 'granted' }) } });
      const store = memoryStorage();
      store.setItem('orchard-audio-input', JSON.stringify({ deviceId: 'usb1' }));
      const inp = new AudioInput(undefined, () => store); // the real lookup: navigator.mediaDevices
      await inp.init();
      expect(inp.state).toMatchObject({ status: 'ready', deviceId: 'usb1' });
    });

    it('does not open it when the permission would have to be asked for', async () => {
      const m = fakeMedia();
      vi.stubGlobal('navigator', { mediaDevices: m.md, permissions: { query: async () => ({ state: 'prompt' }) } });
      const store = memoryStorage();
      store.setItem('orchard-audio-input', JSON.stringify({ deviceId: 'usb1' }));
      const inp = new AudioInput(undefined, () => store);
      await inp.init();
      expect(inp.state.status).toBe('off');
      expect(m.calls).toHaveLength(0);
    });
  });
});
