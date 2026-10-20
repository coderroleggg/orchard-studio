// Reading a video file in the browser: its length, size and frame rate (a
// <video> element), and its audio track decoded to PCM (decodeAudioData, which
// takes the common containers). FL uses FFmpeg for all of it; what the browser
// cannot open is reported, never guessed.

import { host } from '../../../../store';
import { snapFps } from '../../../../model/gen/plugins/videoplayer';

export interface VideoInfo {
  /** Length in seconds. */
  duration: number;
  width: number;
  height: number;
  /** Frame rate (0 = not measurable). */
  fps: number;
}

export interface DecodedAudio {
  channels: Float32Array[];
  sampleRate: number;
}

/**
 * Longest clip whose audio is decoded into the sample pool: ten minutes (230 MB
 * of stereo float PCM at 48 kHz). The pool sample is kept in memory, copied to
 * the audio thread and saved with the project like any imported sample (as base64
 * text: a longer one would not fit a JSON string), so a whole film does not go in.
 */
export const MAX_AUDIO_SECONDS = 600;

type FrameCallback = (now: number, meta: { mediaTime: number; presentedFrames: number }) => void;
type FrameVideo = HTMLVideoElement & { requestVideoFrameCallback?: (cb: FrameCallback) => number };

/** A hidden element in the page (some browsers only present frames of attached videos). */
export function hiddenVideo(): HTMLVideoElement {
  const v = document.createElement('video');
  v.muted = true;
  v.defaultMuted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.setAttribute('playsinline', '');
  v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none;z-index:-1';
  return v;
}

/**
 * Measure the frame rate by playing the video muted for a moment: between two
 * frame callbacks, the media time passed over the number of frames presented
 * is the frame duration (requestVideoFrameCallback; browsers without it, or a
 * file that does not play, give 0).
 */
async function measureFps(v: FrameVideo): Promise<number> {
  if (typeof v.requestVideoFrameCallback !== 'function') return 0;
  return new Promise<number>((resolve) => {
    let first: { t: number; n: number } | null = null;
    let last: { t: number; n: number } | null = null;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { v.pause(); } catch { /* ignore */ }
      if (!first || !last || last.n - first.n < 3 || last.t <= first.t) { resolve(0); return; }
      resolve(snapFps((last.n - first.n) / (last.t - first.t)));
    };
    const cb: FrameCallback = (_now, meta) => {
      const cur = { t: meta.mediaTime, n: meta.presentedFrames };
      if (!first) first = cur; else last = cur;
      // twenty frames are plenty (frame callbacks are rare in background tabs)
      if (last && last.n - first!.n >= 20) finish(); else v.requestVideoFrameCallback!(cb);
    };
    const timer = setTimeout(finish, 3500);
    v.requestVideoFrameCallback!(cb);
    v.play().catch(finish);
  });
}

/** Open a video file in a temporary element: its length, size and frame rate. Rejects when the browser cannot play it. */
export function probeVideo(blob: Blob): Promise<VideoInfo> {
  return new Promise<VideoInfo>((resolve, reject) => {
    const v = hiddenVideo() as FrameVideo;
    const url = URL.createObjectURL(blob);
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      v.onerror = null;
      v.onloadedmetadata = null;
      v.removeAttribute('src');
      v.load();
      v.remove();
      URL.revokeObjectURL(url);
    };
    const fail = (e: unknown) => { if (settled) return; settled = true; cleanup(); reject(e instanceof Error ? e : new Error(String(e))); };
    const timer = setTimeout(() => fail(new Error('Timed out opening the video')), 30000);
    v.onerror = () => fail(new Error(v.error?.message || 'The browser cannot play this file'));
    v.onloadedmetadata = async () => {
      try {
        let duration = v.duration;
        if (!Number.isFinite(duration)) {
          // streams without a length in their header (some webm): seeking far reveals it
          await new Promise<void>((res) => { v.ontimeupdate = () => { v.ontimeupdate = null; res(); }; v.currentTime = 1e7; setTimeout(res, 3000); });
          duration = Number.isFinite(v.duration) ? v.duration : 0;
          v.currentTime = 0;
        }
        const fps = await measureFps(v);
        const info: VideoInfo = { duration, width: v.videoWidth, height: v.videoHeight, fps };
        if (settled) return;
        settled = true;
        cleanup();
        resolve(info);
      } catch (e) {
        fail(e);
      }
    };
    document.body.appendChild(v);
    v.src = url;
  });
}

/**
 * The file's audio as PCM (at most two channels: stereo / mono, surround is
 * folded down), or null when it has none, the browser cannot decode it or it
 * is too long for the sample pool.
 */
export async function decodeAudio(blob: Blob, durationHint: number): Promise<DecodedAudio | null> {
  if (durationHint > MAX_AUDIO_SECONDS) return null;
  try {
    const bytes = await blob.arrayBuffer();
    const ctx: BaseAudioContext = host.ctx ?? new OfflineAudioContext(2, 1, 48000);
    const buf = await ctx.decodeAudioData(bytes);
    if (buf.length === 0 || buf.numberOfChannels === 0) return null;
    const get = (c: number) => buf.getChannelData(c);
    if (buf.numberOfChannels <= 2) {
      const channels: Float32Array[] = [];
      for (let c = 0; c < buf.numberOfChannels; c++) channels.push(new Float32Array(get(c)));
      return { channels, sampleRate: buf.sampleRate };
    }
    // surround: ITU-style fold-down of the usual 5.1 / 7.1 order (L R C LFE Ls Rs [Lrs Rrs])
    const n = buf.length;
    const L = new Float32Array(n), R = new Float32Array(n);
    const [l, r, c] = [get(0), get(1), get(2)];
    const k = Math.SQRT1_2;
    const ls = buf.numberOfChannels > 4 ? get(4) : null, rs = buf.numberOfChannels > 5 ? get(5) : null;
    const lb = buf.numberOfChannels > 6 ? get(6) : null, rb = buf.numberOfChannels > 7 ? get(7) : null;
    const norm = 1 / (1 + k + k + (lb ? k : 0));
    for (let i = 0; i < n; i++) {
      L[i] = (l[i] + k * c[i] + (ls ? k * ls[i] : 0) + (lb ? k * lb[i] : 0)) * norm;
      R[i] = (r[i] + k * c[i] + (rs ? k * rs[i] : 0) + (rb ? k * rb[i] : 0)) * norm;
    }
    return { channels: [L, R], sampleRate: buf.sampleRate };
  } catch {
    return null;
  }
}
