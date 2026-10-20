// Automation runtime: compiles Playlist automation clips per target parameter
// and evaluates them at song positions.
//
// FL semantics: a control is driven only while a clip of it plays; after a
// clip ends nothing is sent, so the control keeps the clip's last value (and
// can be tweaked freely). Jumping to a position (seek, play, a song loop
// wrap) is a relocation: initialized controls ("Init song with this
// position") get their song-start value, then the value each target would
// have there is chased (the covering clip, else the last clip's end value).
// A control moved by hand during song playback is taken over: its clips stop
// driving it until playback restarts (FL 21 / 2024).
//
// A control linked to a controller ("Link to controller": a controller plugin
// output) follows the controller: while the link exists its automation clips
// and initialized value are ignored (see Engine.applyLinks).

import type { Clip, PlaylistTrack } from '../model/types';
import { autoOutput, denormalize, envelopeLevel, targetKey, type AutomationChannel, type AutomationTarget, type InitControl } from '../model/automation';

interface Instance {
  start: number;
  end: number;
  offset: number;
  track: number;
  src: AutomationChannel;
}

interface TargetEntry {
  target: AutomationTarget;
  inst: Instance[]; // sorted by start
  /** Model value at song start (initialized control). */
  init?: number;
}

/**
 * block: playback, apply values of clips that are playing;
 * edit: the clips or envelopes changed, apply what changed at the position;
 * seek: the position jumped (relocation, song loop wrap): initialized values,
 *   then every clip-defined value;
 * play: playback starts, the same as seek.
 */
export type AutoUpdate = 'block' | 'edit' | 'seek' | 'play';

export class AutomationRuntime {
  private sources = new Map<string, AutomationChannel>();
  private clips: Clip[] = [];
  private tracks: PlaylistTrack[] = [];
  private init = new Map<string, InitControl>();
  /** Ticks per beat (LFO speeds are tempo-based). */
  ppq = 96;
  readonly byTarget = new Map<string, TargetEntry>();
  /** Last applied model value per target key. */
  readonly current = new Map<string, number>();
  /** Targets whose value changed since the last status message. */
  readonly changed = new Set<string>();
  /** Targets a playing clip drives at the last update. */
  private driven = new Set<string>();
  /** Targets taken over by hand during this playback: nothing drives them until the next play. */
  private released = new Set<string>();
  /** Targets linked to a controller: the controller drives them, not their clips. */
  private linked = new Set<string>();

  setSources(list: AutomationChannel[]): void {
    this.sources = new Map(list.map((a) => [a.id, a]));
    this.compile();
  }

  setPlaylist(clips: Clip[], tracks: PlaylistTrack[]): void {
    this.clips = clips;
    this.tracks = tracks;
    this.compile();
  }

  setInit(list: InitControl[]): void {
    this.init = new Map(list.map((i) => [targetKey(i.target), i]));
    this.compile();
  }

  /** Number of targets with automation clips or initial values. */
  get size(): number { return this.byTarget.size; }

  /** Controls moved by hand during song playback: their clips stop driving them until playback restarts. */
  release(keys: Iterable<string>): void {
    for (const k of keys) {
      this.released.add(k);
      this.driven.delete(k);
    }
  }

  /** Targets driven by controller links (their clips are ignored while linked). */
  setLinked(keys: Iterable<string>): void {
    this.linked = new Set(keys);
    for (const k of this.linked) this.driven.delete(k);
  }

  isLinked(key: string): boolean {
    return this.linked.has(key);
  }

  /** Playback (re)starts: every control follows its clips again. */
  reclaim(): void {
    this.released.clear();
  }

  isReleased(key: string): boolean {
    return this.released.has(key);
  }

  private compile(): void {
    this.byTarget.clear();
    for (const c of this.clips) {
      if (c.kind !== 'automation' || !c.autoId || c.muted) continue;
      const tr = this.tracks[c.track];
      if (tr && !tr.enabled) continue;
      const src = this.sources.get(c.autoId);
      if (!src || !src.enabled || src.points.length === 0) continue;
      const key = targetKey(src.target);
      let e = this.byTarget.get(key);
      if (!e) { e = { target: src.target, inst: [] }; this.byTarget.set(key, e); }
      e.inst.push({ start: c.start, end: c.start + c.length, offset: c.offset, track: c.track, src });
    }
    for (const e of this.byTarget.values()) e.inst.sort((a, b) => a.start - b.start || a.track - b.track);
    for (const [key, i] of this.init) {
      const e = this.byTarget.get(key);
      if (e) e.init = i.value;
      else this.byTarget.set(key, { target: i.target, inst: [], init: i.value });
    }
    // forget values of targets that are no longer automated
    for (const k of [...this.current.keys()]) if (!this.byTarget.has(k)) this.current.delete(k);
    for (const k of [...this.driven]) if (!this.byTarget.has(k)) this.driven.delete(k);
  }

  /**
   * Model value of a target at song tick `t`: the clip covering `t` (the one
   * that started last wins on overlap, then the lower track) drives it;
   * between clips the previous clip's end value holds; before the first clip
   * the initial value (when `withInit`) or nothing.
   */
  valueAt(key: string, t: number, withInit = true): { v: number; driven: boolean } | null {
    const e = this.byTarget.get(key);
    if (!e) return null;
    let active: Instance | null = null;
    let last: Instance | null = null;
    for (const i of e.inst) {
      if (i.start > t) break;
      if (t < i.end) active = i;
      else if (!last || i.end >= last.end) last = i;
    }
    if (active) return { v: this.evalAt(e.target, active, t), driven: true };
    if (last) return { v: this.evalAt(e.target, last, last.end), driven: false };
    if (withInit && e.init !== undefined) return { v: e.init, driven: false };
    return null;
  }

  private evalAt(target: AutomationTarget, i: Instance, t: number): number {
    const local = t - i.start + i.offset;
    const len = i.src.length;
    const pos = i.src.loop && len > 0 ? ((local % len) + len) % len : local;
    return denormalize(target, autoOutput(i.src, envelopeLevel(i.src, pos, this.ppq)));
  }

  /** Evaluate every target at `t`; calls `apply` with the model values to set. */
  update(t: number, apply: (target: AutomationTarget, value: number) => void, mode: AutoUpdate = 'block'): void {
    // relocations re-send everything, initialized values included
    const force = mode === 'seek' || mode === 'play';
    const wasDriven = this.driven;
    this.driven = new Set();
    for (const [key, e] of this.byTarget) {
      if (this.released.has(key) || this.linked.has(key)) continue;
      const r = this.valueAt(key, t, force);
      if (!r) continue;
      if (r.driven) this.driven.add(key);
      // during playback only playing clips send values, plus the end value once a clip stops
      if (mode === 'block' && !r.driven && !wasDriven.has(key)) continue;
      const prev = this.current.get(key);
      if (!force && prev !== undefined && Math.abs(prev - r.v) <= 1e-7 * Math.max(1, Math.abs(r.v))) continue;
      this.current.set(key, r.v);
      this.changed.add(key);
      apply(e.target, r.v);
    }
  }

  /** Targets a playing clip drives on a scoped object (re-applied over UI updates). */
  *targetsOn(scope: AutomationTarget['scope'], id: string): Iterable<[AutomationTarget, number]> {
    for (const key of this.driven) {
      const e = this.byTarget.get(key);
      if (!e || e.target.scope !== scope || e.target.id !== id) continue;
      const v = this.current.get(key);
      if (v !== undefined) yield [e.target, v];
    }
  }

  target(key: string): AutomationTarget | undefined {
    return this.byTarget.get(key)?.target;
  }
}
