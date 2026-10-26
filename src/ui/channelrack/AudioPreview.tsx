// An Audio Clip channel's row in the Channel Rack has no step buttons (it plays
// through its clips in the Playlist): in their place the waveform of its
// sample as the channel plays it. Click opens the channel settings.

import { useEffect, useRef } from 'react';
import { store, useProject } from '../../store';
import * as A from '../../store/actions';
import type { Channel } from '../../model/types';
import { setHint, clearHint } from '../hint';
import { minMax, sourceMap } from '../playlist/audioClip';
import { onSamplesChanged } from '../../audio/samples';

export function AudioPreview({ channel: c }: { channel: Channel }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const uses = useProject((p) => p.playlist.clips.reduce((n, k) => n + (k.kind === 'audio' && k.channelId === c.id ? 1 : 0), 0));
  const tempo = useProject((p) => p.tempo);
  const s = c.sampler;
  const draw = () => {
    const cv = ref.current;
    if (!cv) return;
    const w = cv.clientWidth, h = cv.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    const g = cv.getContext('2d')!;
    g.scale(dpr, dpr);
    g.fillStyle = '#2c3237';
    g.fillRect(0, 0, w, h);
    const m = sourceMap(c, tempo);
    if (!m) {
      g.fillStyle = '#4a545b';
      g.fillRect(0, h / 2, w, 1);
      return;
    }
    const cy = h / 2, amp = (h / 2 - 2) * 0.95;
    g.fillStyle = c.enabled ? c.color : '#5a646b';
    const mm: [number, number] = [0, 0];
    for (let x = 0; x < w; x++) {
      const a = m.startFrame + Math.floor((x * m.frames) / w), b = m.startFrame + Math.max(Math.floor(((x + 1) * m.frames) / w), Math.floor((x * m.frames) / w) + 1);
      let lo = Infinity, hi = -Infinity;
      for (const ch of m.chans) {
        minMax(ch, a, b, mm);
        if (mm[0] < lo) lo = mm[0];
        if (mm[1] > hi) hi = mm[1];
      }
      const top = cy - Math.min(1, hi) * amp, bot = cy - Math.max(-1, lo) * amp;
      g.fillRect(x, top, 1, Math.max(1, bot - top));
    }
  };
  useEffect(() => {
    draw();
    return onSamplesChanged(draw);
  });
  return (
    <div className="cr-preview" onPointerDown={() => { A.selectChannel(c.id, 'only'); A.openChannelSettings(c.id); }}
      onPointerEnter={() => setHint(`${c.name} - audio clip${s.sampleId ? '' : ' (no sample)'}, used by ${uses} clip${uses === 1 ? '' : 's'} in the playlist: click to show the settings`)}
      onPointerLeave={clearHint}>
      <canvas ref={ref} />
    </div>
  );
}

void store;
