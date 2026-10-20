// A tiny immutable store with patch-based undo/redo. Project edits are recorded
// as immer patches, so an undo only reverts what that step changed (knob tweaks
// that are not recorded survive undoing other edits, like in FL Studio). UI
// state (windows, selections, zoom...) is never recorded.

import { produce, produceWithPatches, applyPatches, enablePatches, type Draft, type Patch } from 'immer';
import { useSyncExternalStore, useRef } from 'react';

enablePatches();

export interface StoreState<P, U> {
  project: P;
  ui: U;
}

interface HistoryEntry {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  time: number;
  mergeKey?: string;
}

export interface UpdateOptions {
  /** Consecutive updates with the same mergeKey within 1.5s collapse into one undo step. */
  mergeKey?: string;
  /** Skip recording (e.g. selection of the current pattern). */
  noHistory?: boolean;
}

interface Gesture {
  label: string;
  patches: Patch[];
  inverse: Patch[];
  /** Knob / slider tweak: recorded only when "Undo knob tweaks" is on. */
  knob: boolean;
}

export class Store<P, U> {
  state: StoreState<P, U>;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private listeners = new Set<() => void>();
  private gesture: Gesture | null = null;
  private notifyScheduled = false;
  readonly maxHistory = 200;
  /** FL's General settings > "Undo knob tweaks" (off by default). */
  undoKnobTweaks = false;
  /** Set by knob/slider controls right before they begin a gesture. */
  nextGestureIsKnob = false;
  /** Called whenever the project object changes (engine sync, autosave...). */
  projectListeners = new Set<(next: P, prev: P) => void>();

  constructor(project: P, ui: U) {
    this.state = { project, ui };
  }

  get project(): P { return this.state.project; }
  get ui(): U { return this.state.ui; }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(prevProject: P): void {
    if (prevProject !== this.state.project) {
      for (const l of this.projectListeners) l(this.state.project, prevProject);
    }
    for (const l of this.listeners) l();
  }

  private record(e: HistoryEntry): void {
    this.past.push(e);
    if (this.past.length > this.maxHistory) this.past.shift();
    this.future = [];
  }

  /** Apply a project edit. */
  update(label: string, recipe: (d: Draft<P>) => void, opts: UpdateOptions = {}): void {
    const prev = this.state.project;
    const [next, patches, inverse] = produceWithPatches(prev, recipe);
    if (next === prev) return;
    if (this.gesture) {
      this.gesture.patches.push(...patches);
      this.gesture.inverse.unshift(...inverse);
    } else if (!opts.noHistory) {
      const last = this.past[this.past.length - 1];
      const now = performance.now();
      if (opts.mergeKey && last && last.mergeKey === opts.mergeKey && now - last.time < 1500 && this.future.length === 0) {
        last.patches.push(...patches);
        last.inverse.unshift(...inverse);
        last.time = now;
      } else {
        this.record({ label, patches, inverse, time: now, mergeKey: opts.mergeKey });
      }
    }
    this.state = { project: next as P, ui: this.state.ui };
    this.emit(prev);
  }

  /** Replace the project wholesale (load / new). Clears history. */
  replaceProject(project: P): void {
    const prev = this.state.project;
    this.past = [];
    this.future = [];
    this.gesture = null;
    this.state = { project, ui: this.state.ui };
    this.emit(prev);
  }

  updateUi(recipe: (d: Draft<U>) => void): void {
    const prev = this.state.ui;
    const next = produce(prev, recipe);
    if (next === prev) return;
    this.state = { project: this.state.project, ui: next };
    for (const l of this.listeners) l();
  }

  /** Begin a continuous edit (knob drag, note drag...). One undo step for the whole gesture. */
  beginGesture(label: string): void {
    if (this.gesture) this.endGesture();
    this.gesture = { label, patches: [], inverse: [], knob: this.nextGestureIsKnob };
    this.nextGestureIsKnob = false;
  }

  endGesture(): void {
    const g = this.gesture;
    if (!g) return;
    this.gesture = null;
    if (g.patches.length && (!g.knob || this.undoKnobTweaks)) {
      this.record({ label: g.label, patches: g.patches, inverse: g.inverse, time: performance.now() });
      for (const l of this.listeners) l();
    }
  }

  get inGesture(): boolean { return this.gesture !== null; }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }
  undoLabel(): string | null { return this.past.length ? this.past[this.past.length - 1].label : null; }
  redoLabel(): string | null { return this.future.length ? this.future[this.future.length - 1].label : null; }
  historyLabels(): { past: string[]; future: string[] } {
    return { past: this.past.map((e) => e.label), future: this.future.map((e) => e.label).reverse() };
  }

  undo(): string | null {
    if (this.gesture) this.endGesture();
    const e = this.past.pop();
    if (!e) return null;
    const prev = this.state.project;
    try {
      this.state = { project: applyPatches(prev as unknown as object, e.inverse) as unknown as P, ui: this.state.ui };
    } catch {
      // the state changed in a way the patches no longer fit: drop the history
      this.past = [];
      this.future = [];
      return null;
    }
    this.future.push(e);
    this.emit(prev);
    return e.label;
  }

  redo(): string | null {
    const e = this.future.pop();
    if (!e) return null;
    const prev = this.state.project;
    try {
      this.state = { project: applyPatches(prev as unknown as object, e.patches) as unknown as P, ui: this.state.ui };
    } catch {
      this.future = [];
      return null;
    }
    this.past.push(e);
    this.emit(prev);
    return e.label;
  }

  /** Batch notifications for high-frequency UI updates (unused for now). */
  scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    requestAnimationFrame(() => {
      this.notifyScheduled = false;
      for (const l of this.listeners) l();
    });
  }
}

/**
 * React hook: subscribe to a slice of the store. The selector must return a
 * stable value (a primitive or an object already present in the state).
 */
export function useStoreSelector<P, U, T>(store: Store<P, U>, selector: (s: StoreState<P, U>) => T): T {
  const selRef = useRef(selector);
  selRef.current = selector;
  return useSyncExternalStore(store.subscribe, () => selRef.current(store.state));
}
