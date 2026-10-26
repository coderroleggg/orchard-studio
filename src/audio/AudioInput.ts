// The audio input device (main thread). FL's Options > Audio settings picks the
// input of the audio driver; in the browser that is enumerateDevices +
// getUserMedia. The stream is opened with echo cancellation, noise suppression
// and automatic gain control turned off (they would colour a recording), and
// handed to AudioHost, which connects it to the engine's worklet node. See
// docs/recording.md.
//
// Nothing here touches the DOM beyond navigator.mediaDevices, which is looked
// up through a getter so tests can stub it.

import { MAX_INPUT_CHANNELS } from '../model/recording';

export type InputStatus =
  | 'off' // no device selected
  | 'requesting' // waiting for the browser's permission prompt / the device
  | 'ready' // the stream is open
  | 'denied' // the user (or the browser's policy) refused access
  | 'missing' // the selected device is not there (unplugged)
  | 'error' // the device could not be opened (in use, hardware error)
  | 'unsupported'; // no navigator.mediaDevices (insecure page, old browser)

export interface InputDevice {
  id: string;
  label: string;
}

export interface InputState {
  status: InputStatus;
  /** The selected device: its deviceId, 'default' for the system default, null for none. */
  deviceId: string | null;
  /** Name of the open device. */
  label: string;
  /** Channels of the open stream. */
  channels: number;
  /** Seconds of latency the browser reports for the input (0: unknown). */
  latencySec: number;
  /** The processing the browser applied despite the request (an echo canceller that could not be turned off...). */
  processing: string[];
  devices: InputDevice[];
  /** What went wrong, in words. */
  message: string;
}

/** The parts of navigator.mediaDevices the module uses. */
export interface MediaDevicesLike {
  getUserMedia(c: MediaStreamConstraints): Promise<MediaStream>;
  enumerateDevices(): Promise<MediaDeviceInfo[]>;
  addEventListener?(type: 'devicechange', fn: () => void): void;
  removeEventListener?(type: 'devicechange', fn: () => void): void;
}

export interface StorageLike {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

const STORE_KEY = 'orchard-audio-input';

/** getUserMedia constraints for a device: the audio exactly as it arrives, with as many channels as the device has. */
export function inputConstraints(deviceId: string | null, channels = MAX_INPUT_CHANNELS): MediaStreamConstraints {
  const audio: MediaTrackConstraints & { latency?: ConstrainDouble } = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: channels },
    latency: { ideal: 0 },
  };
  if (deviceId && deviceId !== 'default') audio.deviceId = { exact: deviceId };
  return { audio, video: false };
}

/** The processing flags a track still reports as on. */
function leftOn(s: MediaTrackSettings): string[] {
  const out: string[] = [];
  if (s.echoCancellation) out.push('echo cancellation');
  if (s.noiseSuppression) out.push('noise suppression');
  if (s.autoGainControl) out.push('automatic gain control');
  return out;
}

function errorName(e: unknown): string {
  return e && typeof e === 'object' && 'name' in e ? String((e as { name: unknown }).name) : '';
}

export class AudioInput {
  state: InputState = {
    status: 'off', deviceId: null, label: '', channels: 0, latencySec: 0, processing: [], devices: [], message: '',
  };
  private stream: MediaStream | null = null;
  private listeners = new Set<() => void>();
  /** Called with the open stream (or null when it closed) and its channel count. */
  onStream: ((stream: MediaStream | null, channels: number) => void) | null = null;
  /** Called with a short message when the input changes without the user doing anything (a device was unplugged or came back). */
  onNotice: ((text: string) => void) | null = null;
  private opening: Promise<boolean> | null = null;
  private readonly onDeviceChange = () => { void this.devicesChanged(); };
  private started = false;

  constructor(
    private readonly mediaDevices: () => MediaDevicesLike | undefined = () => (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined),
    private readonly storage: () => StorageLike | undefined = () => {
      try { return typeof document !== 'undefined' && typeof localStorage !== 'undefined' ? localStorage : undefined; } catch { return undefined; }
    },
  ) {}

  // ----------------------------------------------------------------- state
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<InputState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  get supported(): boolean {
    return !!this.mediaDevices();
  }

  get ready(): boolean {
    return this.state.status === 'ready';
  }

  /** The open stream (null: none). */
  get currentStream(): MediaStream | null {
    return this.stream;
  }

  /** FL's words for what is wrong ("Audio input needed ..."). */
  describe(): string {
    const s = this.state;
    switch (s.status) {
      case 'off': return 'No audio input selected (Options > Audio settings)';
      case 'requesting': return 'Waiting for permission to use the audio input...';
      case 'ready': return `${s.label || 'Audio input'}: ${s.channels} channel${s.channels === 1 ? '' : 's'}`;
      case 'denied': return 'The browser did not give access to the audio input';
      case 'missing': return 'Missing external input';
      case 'unsupported': return 'This browser cannot record audio here (it needs a secure page)';
      default: return s.message || 'The audio input could not be opened';
    }
  }

  // ------------------------------------------------------------------ setup
  /**
   * Start listening for devices coming and going and remember which device the user chose last time.
   * Does not open anything: the browser would ask for the microphone before the user did anything.
   * With `autoOpen`, a remembered device that the browser already allows is opened.
   */
  async init(autoOpen = true): Promise<void> {
    if (this.started) return;
    this.started = true;
    const md = this.mediaDevices();
    if (!md) { this.set({ status: 'unsupported' }); return; }
    md.addEventListener?.('devicechange', this.onDeviceChange);
    const saved = this.load();
    if (saved) this.set({ deviceId: saved, status: 'off' });
    await this.refresh();
    if (saved && autoOpen && (await this.permitted())) await this.open();
  }

  dispose(): void {
    this.mediaDevices()?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.closeStream();
    this.started = false;
  }

  private load(): string | null {
    try {
      const raw = this.storage()?.getItem(STORE_KEY);
      if (!raw) return null;
      const v = (JSON.parse(raw) as { deviceId?: unknown }).deviceId;
      return typeof v === 'string' && v ? v : null;
    } catch { return null; }
  }

  private save(): void {
    try { this.storage()?.setItem(STORE_KEY, JSON.stringify({ deviceId: this.state.deviceId })); } catch { /* private mode */ }
  }

  /** Has the browser been told to allow the microphone for this page (so that opening does not prompt)? */
  private async permitted(): Promise<boolean> {
    try {
      const p = await (navigator as unknown as { permissions?: { query(d: { name: string }): Promise<{ state: string }> } }).permissions?.query({ name: 'microphone' });
      return p?.state === 'granted';
    } catch { return false; }
  }

  // ---------------------------------------------------------------- devices
  /** The audio input devices (names are empty until the user has given permission once). */
  async refresh(): Promise<InputDevice[]> {
    const md = this.mediaDevices();
    if (!md) return [];
    try {
      const all = await md.enumerateDevices();
      const seen = new Set<string>();
      const devices: InputDevice[] = [];
      let n = 0;
      for (const d of all) {
        if (d.kind !== 'audioinput') continue;
        // before the user has given permission the browser lists a nameless placeholder without an id
        if (!d.deviceId) continue;
        // Chrome lists the system default twice: as 'default' and as the device it points to
        if (seen.has(d.deviceId)) continue;
        seen.add(d.deviceId);
        n++;
        devices.push({ id: d.deviceId, label: d.label || `Audio input ${n}` });
      }
      this.set({ devices });
      return devices;
    } catch {
      return this.state.devices;
    }
  }

  private async devicesChanged(): Promise<void> {
    const devices = await this.refresh();
    const { deviceId, status } = this.state;
    if (!deviceId) return;
    const there = deviceId === 'default' ? devices.length > 0 : devices.some((d) => d.id === deviceId);
    if (status === 'ready' && !there) {
      // unplugged: FL turns the input monitoring off when the device disappears
      this.closeStream();
      this.set({ status: 'missing', message: 'The audio input was disconnected', channels: 0 });
      this.onNotice?.('Missing external input: the audio input was disconnected');
    } else if ((status === 'missing' || status === 'error') && there) {
      // plugged in again
      if (await this.open()) this.onNotice?.(`${this.state.label || 'Audio input'} is connected again`);
    }
  }

  // ------------------------------------------------------------------- open
  /** Choose the input device (null: none). The first time, the browser asks for permission. */
  async select(deviceId: string | null): Promise<boolean> {
    this.closeStream();
    this.set({ deviceId, status: deviceId ? 'requesting' : 'off', message: '', channels: 0, label: '' });
    this.save();
    if (!deviceId) return false;
    // an open that is still waiting for the old choice gives its stream back first
    if (this.opening) await this.opening;
    return this.open();
  }

  /** Open the selected device (a second call while it is opening waits for the first). */
  open(): Promise<boolean> {
    if (this.opening) return this.opening;
    this.opening = this.doOpen().finally(() => { this.opening = null; });
    return this.opening;
  }

  private async doOpen(): Promise<boolean> {
    const md = this.mediaDevices();
    if (!md) { this.set({ status: 'unsupported' }); return false; }
    const id = this.state.deviceId;
    if (!id) { this.set({ status: 'off' }); return false; }
    if (this.stream) return true;
    this.set({ status: 'requesting', message: '' });
    let stream: MediaStream;
    try {
      stream = await md.getUserMedia(inputConstraints(id));
    } catch (e) {
      const name = errorName(e);
      if (name === 'NotAllowedError' || name === 'SecurityError' || name === 'PermissionDeniedError') {
        this.set({ status: 'denied', message: 'Permission to use the audio input was denied. Allow the microphone for this page in the browser, then choose the input again.' });
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError' || name === 'DevicesNotFoundError') {
        this.set({ status: 'missing', message: 'The audio input was not found' });
      } else {
        this.set({ status: 'error', message: `The audio input could not be opened (${name || 'unknown error'})` });
      }
      await this.refresh();
      return false;
    }
    // the stream may arrive after the user chose something else
    if (this.state.deviceId !== id) { for (const t of stream.getTracks()) t.stop(); return false; }
    const track = stream.getAudioTracks()[0];
    if (!track) {
      for (const t of stream.getTracks()) t.stop();
      this.set({ status: 'error', message: 'The audio input has no audio' });
      return false;
    }
    const s = track.getSettings?.() ?? {};
    const channels = Math.max(1, Math.min(MAX_INPUT_CHANNELS, s.channelCount ?? 1));
    this.stream = stream;
    track.addEventListener?.('ended', () => this.trackEnded(stream));
    await this.refresh(); // names are available now that the user has agreed
    const dev = this.state.devices.find((d) => d.id === (s.deviceId ?? id));
    this.set({
      status: 'ready', message: '', channels, label: track.label || dev?.label || 'Audio input',
      latencySec: Number((s as { latency?: number }).latency) || 0, processing: leftOn(s),
    });
    this.onStream?.(stream, channels);
    return true;
  }

  private trackEnded(stream: MediaStream): void {
    if (this.stream !== stream) return;
    this.closeStream();
    this.set({ status: 'missing', message: 'The audio input was disconnected', channels: 0 });
    this.onNotice?.('Missing external input: the audio input was disconnected');
  }

  private closeStream(): void {
    const s = this.stream;
    if (!s) return;
    this.stream = null;
    for (const t of s.getTracks()) t.stop();
    this.onStream?.(null, 0);
    this.set({ channels: 0, latencySec: 0, processing: [] });
  }

  /** Close the input device (it stays selected). */
  close(): void {
    this.closeStream();
    if (this.state.deviceId) this.set({ status: 'off' });
  }

  /**
   * Make sure the input is open before something needs it (arming a track, recording). Opens the
   * selected device; with none selected and `useDefault`, the system default (the browser asks for permission).
   */
  async ensureOpen(useDefault = false): Promise<boolean> {
    if (this.ready && this.stream) return true;
    if (!this.state.deviceId) {
      if (!useDefault) return false;
      return this.select('default');
    }
    return this.open();
  }
}
