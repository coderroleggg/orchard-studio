// What the Playlist shows of audio recording: the Start recording / Stop recording
// markers (punch in / out) and the stretch being recorded. Drawn on the
// Playlist's overlay canvas every frame while the song plays.

import { store } from '../../store';
import { currentTick, live } from '../../audio/live';
import { recorder } from '../../audio/recording';

/**
 * `h`: the canvas height (ruler and grid), `rulerH`: the ruler's height, `xOf`: ticks to the canvas x,
 * `yOf`: a Playlist track to the y of its top in the grid, `th`: the track height.
 */
export function drawRecordingOverlay(
  g: CanvasRenderingContext2D, w: number, h: number, rulerH: number, xOf: (tick: number) => number, yOf: (track: number) => number, th: number,
): void {
  g.save();
  g.font = '10px sans-serif';
  g.textBaseline = 'top';
  // the recording markers: a red flag on the ruler and a thin line down the tracks
  const marks = store.project.playlist.markers.filter((m) => m.kind === 'recStart' || m.kind === 'recStop');
  const start = marks.find((m) => m.kind === 'recStart'), stop = marks.find((m) => m.kind === 'recStop');
  // the two flags point away from each other: when there is no room for both names they are shortened
  const full = !start || !stop || xOf(stop.pos) - xOf(start.pos) > g.measureText('Start recording').width + g.measureText('Stop recording').width + 24;
  for (const m of marks) {
    const x = Math.round(xOf(m.pos)) + 0.5;
    if (x < -120 || x > w + 120) continue;
    g.strokeStyle = 'rgba(255,74,58,0.55)';
    g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(x, rulerH); g.lineTo(x, h); g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#ff4a3a';
    g.fillRect(x - 0.5, 0, 1.5, rulerH);
    const label = m.kind === 'recStart' ? (full ? 'Start recording' : 'In') : (full ? 'Stop recording' : 'Out');
    const tw = g.measureText(label).width + 8;
    const fx = m.kind === 'recStart' ? x : x - tw;
    g.fillRect(fx, 1, tw, 12);
    g.fillStyle = '#1c0b09';
    g.fillText(label, fx + 4, 2);
  }
  // the stretch being recorded: from where the take started to the playhead
  if (live.rec.state === 'recording' && live.playing) {
    const x0 = xOf(live.rec.tick0), x1 = xOf(Math.max(live.rec.tick0, currentTick()));
    if (x1 > 0 && x0 < w) {
      g.fillStyle = 'rgba(255,74,58,0.16)';
      g.fillRect(Math.max(0, x0), rulerH, Math.min(w, x1) - Math.max(0, x0), h - rulerH);
      g.fillStyle = 'rgba(255,74,58,0.9)';
      g.fillRect(Math.max(0, x0), rulerH - 3, Math.min(w, x1) - Math.max(0, x0), 3);
      drawWaves(g, w, h, rulerH, x0, xOf, yOf, th);
    }
  }
  g.restore();
}

/** The audio recorded so far, on the Playlist tracks the clips will land on (the free tracks from the top of the view, one per recorded track). */
function drawWaves(
  g: CanvasRenderingContext2D, w: number, h: number, rulerH: number, x0: number, xOf: (tick: number) => number, yOf: (track: number) => number, th: number,
): void {
  const p = store.project;
  const tpf = (p.tempo * p.ppq) / (60 * live.rec.sampleRate); // ticks per frame
  const top = Math.max(0, Math.floor(store.ui.playlist.scrollTrack));
  const used = new Set(p.playlist.clips.map((c) => c.track));
  let row = top;
  g.fillStyle = 'rgba(255,150,130,0.85)';
  for (const track of live.rec.tracks) {
    while (row < p.playlist.tracks.length && used.has(row)) row++;
    const wv = recorder.waves.get(track);
    const y = rulerH + yOf(row);
    row++;
    if (!wv || y + th < rulerH || y > h) continue;
    const mid = y + th / 2, amp = th * 0.42;
    const pxPerBin = wv.bin * tpf * (xOf(1) - xOf(0));
    let lastPx = -1, peak = 0;
    for (let i = 0; i < wv.n; i++) {
      const px = Math.floor(x0 + i * pxPerBin);
      if (px < 0) continue;
      if (px > w) break;
      if (px !== lastPx) { if (lastPx >= 0) g.fillRect(lastPx, mid - peak * amp, 1, Math.max(1, peak * amp * 2)); lastPx = px; peak = 0; }
      if (wv.peaks[i] > peak) peak = Math.min(1, wv.peaks[i]);
    }
    if (lastPx >= 0) g.fillRect(lastPx, mid - peak * amp, 1, Math.max(1, peak * amp * 2));
  }
}
