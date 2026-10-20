// MIDI controller links (Remote control settings > MIDI controller): Web MIDI
// control change messages move linked parameters, through the link's mapping
// formula. Runs on the main thread (a CC moves a control like a mouse tweak;
// the store sync sends it to the engine). MIDI access is requested only when
// the project has MIDI links or the dialog's Auto detect waits for a
// controller. Port = the index of the MIDI input (-1: any input).

import { store } from '../store';
import { denormalize, normalize, sameTarget, setPath } from '../model/automation';
import { mapLinkValue, type ControllerLink } from '../model/links';
import type { Project } from '../model/types';

type Learn = (m: { port: number; chan: number; ctrl: number }) => void;

let access: MIDIAccess | null = null;
let requesting: Promise<MIDIAccess | null> | null = null;
const learners = new Set<Learn>();
let midiLinks: ControllerLink[] = [];
let lastLinks: Project['links'] | null = null;

export function midiLinkSupport(): boolean {
  return typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
}

function ensureAccess(): void {
  if (access || requesting || !midiLinkSupport()) return;
  requesting = navigator.requestMIDIAccess().then((a) => {
    access = a;
    attach();
    a.addEventListener('statechange', attach);
    return a;
  }).catch(() => null).finally(() => { requesting = null; });
}

const attached = new WeakSet<MIDIInput>();

function attach(): void {
  if (!access) return;
  for (const input of access.inputs.values()) {
    if (attached.has(input)) continue;
    attached.add(input);
    input.addEventListener('midimessage', (e) => onMessage(input, e as MIDIMessageEvent));
  }
}

function portOf(input: MIDIInput): number {
  if (!access) return 0;
  let i = 0;
  for (const x of access.inputs.values()) { if (x === input) return i; i++; }
  return 0;
}

function onMessage(input: MIDIInput, e: MIDIMessageEvent): void {
  const d = e.data;
  if (!d || d.length < 3 || (d[0] & 0xf0) !== 0xb0) return;
  const chan = (d[0] & 0x0f) + 1, ctrl = d[1], val = d[2];
  const port = portOf(input);
  if (learners.size) {
    for (const fn of [...learners]) fn({ port, chan, ctrl });
    return;
  }
  const hits = midiLinks.filter((l) => l.midi && l.midi.ctrl === ctrl && (l.midi.omni || l.midi.chan === chan) && (l.midi.port < 0 || l.midi.port === port));
  if (!hits.length) return;
  store.update('MIDI controller', (draft) => {
    const p = draft as unknown as Project;
    for (const l of hits) {
      const obj = rootOf(p, l);
      if (!obj) continue;
      const t = l.target;
      let v: number;
      if (l.relative) {
        // endless encoders: 1..63 up, 65..127 down (two's complement around 64)
        const steps = val < 64 ? val : val - 128;
        const cur = Number(getValue(obj, t.path));
        v = Math.min(1, Math.max(0, normalize(t, Number.isFinite(cur) ? cur : t.min) + mapLinkValue(l.formula, steps / 128, undefined, true)));
      } else {
        v = mapLinkValue(l.formula, val / 127);
      }
      setPath(obj, t.path, denormalize(t, v));
    }
  }, { noHistory: true }); // like a knob tweak ("Undo knob tweaks" is off by default)
}

function getValue(obj: unknown, path: string): unknown {
  let o = obj as Record<string, unknown> | undefined;
  for (const k of path.split('.')) o = o?.[k] as Record<string, unknown> | undefined;
  return o;
}

function rootOf(p: Project, l: ControllerLink): unknown {
  const t = l.target;
  switch (t.scope) {
    case 'channel': return p.channels.find((c) => c.id === t.id);
    case 'mixer': return p.mixer.tracks[Number(t.id)];
    case 'fx': {
      for (const tr of p.mixer.tracks) for (const s of tr.slots) if (s && s.id === t.id) return s;
      return undefined;
    }
    case 'global': return p;
  }
}

/** Auto detect: `fn` gets the next controller moved; returns the unsubscribe. */
export function watchMidiLearn(fn: Learn): () => void {
  learners.add(fn);
  ensureAccess();
  return () => learners.delete(fn);
}

function sync(p: Project): void {
  if (p.links === lastLinks) return;
  lastLinks = p.links;
  midiLinks = (p.links ?? []).filter((l) => l.midi && l.midi.ctrl >= 0);
  if (midiLinks.length) ensureAccess();
}

if (typeof window !== 'undefined') {
  sync(store.project);
  store.projectListeners.add((next) => sync(next));
}

/** Links of a parameter that a MIDI controller drives (for tests and menus). */
export function midiLinksOf(t: ControllerLink['target']): ControllerLink[] {
  return midiLinks.filter((l) => sameTarget(l.target, t));
}
