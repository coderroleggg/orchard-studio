// Minimal Standard MIDI File writer (type 0) for Newtone's "Save as MIDI".

export interface MidiNote { start: number; len: number; key: number; vel: number }

function vlq(v: number): number[] {
  let x = Math.max(0, Math.round(v));
  const out = [x & 0x7f];
  x >>= 7;
  while (x > 0) { out.unshift((x & 0x7f) | 0x80); x >>= 7; }
  return out;
}

/** Notes in seconds -> SMF bytes at `bpm` (96 ticks per quarter). */
export function writeMidi(notes: MidiNote[], bpm: number, name = 'Newtone'): Uint8Array {
  const ppq = 96;
  const tps = (ppq * bpm) / 60;
  const ev: { t: number; d: number[] }[] = [];
  for (const n of notes) {
    const k = Math.max(0, Math.min(127, Math.round(n.key)));
    const v = Math.max(1, Math.min(127, Math.round(n.vel)));
    const t0 = Math.round(n.start * tps), t1 = Math.max(t0 + 1, Math.round((n.start + n.len) * tps));
    ev.push({ t: t0, d: [0x90, k, v] }, { t: t1, d: [0x80, k, 0] });
  }
  ev.sort((a, b) => a.t - b.t || (a.d[0] === 0x80 ? -1 : 1));
  const trk: number[] = [];
  const nm = [...name].map((c) => c.charCodeAt(0) & 0x7f);
  trk.push(0, 0xff, 0x03, ...vlq(nm.length), ...nm);
  const us = Math.round(60000000 / bpm);
  trk.push(0, 0xff, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255);
  let last = 0;
  for (const e of ev) { trk.push(...vlq(e.t - last), ...e.d); last = e.t; }
  trk.push(0, 0xff, 0x2f, 0x00);
  const head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (ppq >> 8) & 255, ppq & 255];
  const len = trk.length;
  const th = [0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255];
  return Uint8Array.from([...head, ...th, ...trk]);
}
