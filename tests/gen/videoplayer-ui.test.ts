// The Video Player editor's logic that needs no browser: the file store's key,
// and the controller's actions on the project through the slot actions (the
// play range, Delay playback, seeking and the position the editor shows with
// and without Link transport). The <video> element, canvases and dialogs are
// checked in the app's browser pane.
import { describe, it, expect } from 'vitest';
import './util';

const g = globalThis as Record<string, unknown>;
g.window ??= { addEventListener() {}, removeEventListener() {}, devicePixelRatio: 1, innerWidth: 1000, innerHeight: 800 };

describe('Video Player: file keys', async () => {
  const { videoKeyOf } = await import('../../src/ui/plugins/gen/videoplayer/files');

  it('names a file by its name, size, date and bytes', async () => {
    const bytes = new Uint8Array(300000).map((_, i) => (i * 7) & 255);
    const a = new File([bytes], 'clip.mp4', { lastModified: 1700000000000 });
    const b = new File([bytes], 'clip.mp4', { lastModified: 1700000000000 });
    expect(await videoKeyOf(a)).toBe(await videoKeyOf(b));
    expect(await videoKeyOf(a)).toMatch(/^v[0-9a-z]+$/);
    expect(await videoKeyOf(new File([bytes], 'other.mp4', { lastModified: 1700000000000 }))).not.toBe(await videoKeyOf(a));
    expect(await videoKeyOf(new File([bytes], 'clip.mp4', { lastModified: 1700000000001 }))).not.toBe(await videoKeyOf(a));
    const tail = bytes.slice();
    tail[tail.length - 5] ^= 1;
    expect(await videoKeyOf(new File([tail], 'clip.mp4', { lastModified: 1700000000000 }))).not.toBe(await videoKeyOf(a));
    expect(await videoKeyOf(new File([], 'empty.mp4'))).toMatch(/^v/);
  });
});

describe('Video Player: the controller acts on the plugin state', async () => {
  const { store } = await import('../../src/store');
  const A = await import('../../src/store/actions');
  const { live } = await import('../../src/audio/live');
  const { VideoController } = await import('../../src/ui/plugins/gen/videoplayer/controller');
  const { vpState } = await import('../../src/model/gen/plugins/videoplayer');

  /** A Video Player channel with a clip of `duration` seconds and its controller. */
  function setup(state: Record<string, unknown> = {}) {
    const id = A.addGenChannel('videoplayer');
    const slot = 'ch:' + id;
    A.editFx(slot, 'setup', (p) => { Object.assign(p, { file: 'c.mp4', videoKey: 'vk', sampleId: 's', duration: 20, fps: 25, ...state }); });
    const ctl = new VideoController(slot);
    const params = () => store.project.channels.find((c) => c.id === id)!.plugin!.params as Record<string, unknown>;
    ctl.setParams(params());
    const st = () => vpState(params());
    const sync = () => ctl.setParams(params());
    return { id, slot, ctl, params, st, sync };
  }
  const at = (tick: number, playing = false) => { live.playing = playing; live.anchorTick = tick; live.tick = tick; live.anchorTime = performance.now(); };

  it('Set start / Set end keep the range valid; the end of the clip is stored as 0', () => {
    const { ctl, st, sync } = setup({ link: false });
    ctl.setStart(5);
    sync();
    expect(st().start).toBe(5);
    ctl.setEnd(12);
    sync();
    expect(st().end).toBe(12);
    // an inverted range is refused
    ctl.setEnd(4);
    ctl.setStart(13);
    sync();
    expect([st().start, st().end]).toEqual([5, 12]);
    // the clip's own end means "to the end"
    ctl.setEnd(20);
    sync();
    expect(st().end).toBe(0);
    ctl.setStart(0.5);
    sync();
    expect(st().start).toBe(0.5);
    // each is one undo step
    expect(store.undoLabel()).toBe('Set start time');
  });

  it('Delay playback by the song position makes the start negative', () => {
    store.update('tempo', (d) => { d.tempo = 120; }, { noHistory: true });
    const { ctl, st, sync } = setup({ link: true });
    at(960); // 5 s at 120 BPM (96 ppq)
    expect(ctl.songSeconds()).toBeCloseTo(5, 6);
    ctl.delayHere();
    sync();
    expect(st().start).toBeCloseTo(-5, 6);
    // the video shows its first frame until the song reaches 5 s, then follows it
    expect(ctl.time()).toMatchObject({ t: 0, on: false });
    at(960 + 192 * 3, true);
    const t = ctl.time();
    expect(t.playing).toBe(true);
    expect(t.on).toBe(true);
    expect(t.t).toBeGreaterThan(2.9);
    expect(t.t).toBeLessThan(3.2);
    at(0);
  });

  it('shows the song position (plus start) with Link transport; a scrub holds until the song moves', () => {
    const { ctl, sync, st } = setup({ link: true, start: 2 });
    at(0);
    expect(ctl.time()).toEqual({ t: 2, on: false, playing: false });
    ctl.seek(9);
    expect(ctl.time().t).toBe(9);
    // the song position changes: the picture follows the song again
    at(192);
    expect(ctl.time().t).toBeCloseTo(2 + 192 / ((store.project.tempo * store.project.ppq) / 60), 6);
    // nudge: one frame (1 / fps) while stopped
    at(0);
    ctl.seek(3);
    ctl.nudge(1);
    expect(ctl.time().t).toBeCloseTo(3.04, 9);
    ctl.nudge(-1);
    ctl.nudge(-1);
    expect(ctl.time().t).toBeCloseTo(2.96, 9);
    // while the song plays the scrub bar does not move the video
    at(0, true);
    ctl.seek(15);
    sync();
    expect(st().pos).toBe(0);
    at(0, false);
  });

  it('moves the player\'s own position without Link transport (pos and a seek counter), clamped to the clip', () => {
    const { ctl, st, sync } = setup({ link: false, start: 1 });
    ctl.seek(7.5);
    sync();
    expect(st()).toMatchObject({ pos: 7.5, seek: 1 });
    expect(ctl.time()).toEqual({ t: 7.5, on: false, playing: false });
    ctl.seek(99);
    sync();
    expect(st().pos).toBe(20);
    ctl.seek(-3);
    sync();
    expect(st()).toMatchObject({ pos: 0, seek: 3 });
    // Stop goes back to the start of the range and switches Play off (the position first)
    ctl.seek(6);
    sync();
    A.setFxParam(ctl.slotId, 'play', 1);
    sync();
    expect(st().play).toBe(true);
    ctl.stop();
    sync();
    expect(st()).toMatchObject({ play: false, pos: 1 });
    expect(st().seek).toBeGreaterThan(4);
  });

  it('follows the engine\'s clock while the player runs by itself', () => {
    const { ctl, sync } = setup({ link: false });
    A.setFxParam(ctl.slotId, 'play', 1);
    sync();
    // no monitor data yet: the resting position
    expect(ctl.time().playing).toBe(false);
    ctl.onMonitor({ vt: 4.25, playing: true, link: false, audio: true });
    const t = ctl.time();
    expect(t.playing).toBe(true);
    expect(t.t).toBeGreaterThanOrEqual(4.25 - 0.2);
    expect(t.t).toBeLessThan(4.6);
    expect(ctl.isPlaying()).toBe(true);
  });
});
