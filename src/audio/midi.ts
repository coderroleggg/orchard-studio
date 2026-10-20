// Web MIDI input: notes from hardware controllers play the selected channel.
// MIDI note numbers map directly to FL keys (60 = C5).

import { store, host } from '../store';
import { flashHint } from '../ui/hint';

let access: MIDIAccess | null = null;
const held = new Map<string, { ch: string; key: number; tag: number }>();

function onMessage(e: MIDIMessageEvent): void {
  const d = e.data;
  if (!d || d.length < 2) return;
  const status = d[0] & 0xf0;
  const key = d[1];
  const vel = d.length > 2 ? d[2] : 0;
  const id = `${(e.target as MIDIInput).id}:${d[0] & 0x0f}:${key}`;
  if (status === 0x90 && vel > 0) {
    const ch = store.ui.selectedChannels[0] ?? store.project.channels[0]?.id;
    if (!ch) return;
    const prev = held.get(id);
    if (prev) host.noteOff(prev.ch, prev.key, prev.tag);
    // MIDI velocity 0..127 -> FL velocity 0..128
    const tag = host.noteOn(ch, key, Math.round((vel * 128) / 127));
    held.set(id, { ch, key, tag });
  } else if (status === 0x80 || (status === 0x90 && vel === 0)) {
    const h = held.get(id);
    if (h) { host.noteOff(h.ch, h.key, h.tag); held.delete(id); }
  } else if (status === 0xb0 && (key === 123 || key === 120)) {
    // all notes off / all sound off
    for (const h of held.values()) host.noteOff(h.ch, h.key, h.tag);
    held.clear();
  }
}

function attach(): void {
  if (!access) return;
  for (const input of access.inputs.values()) input.onmidimessage = onMessage;
}

export async function setMidiEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    if (access) for (const input of access.inputs.values()) input.onmidimessage = null;
    access = null;
    flashHint('MIDI input disabled');
    return false;
  }
  if (!('requestMIDIAccess' in navigator)) { flashHint('Web MIDI is not supported by this browser'); return false; }
  try {
    access = await navigator.requestMIDIAccess();
    attach();
    access.onstatechange = () => attach();
    const n = access.inputs.size;
    flashHint(n ? `MIDI input enabled (${n} device${n > 1 ? 's' : ''})` : 'MIDI input enabled (no devices connected)');
    return true;
  } catch {
    flashHint('MIDI access was not granted');
    return false;
  }
}

export function midiEnabled(): boolean {
  return access !== null;
}
