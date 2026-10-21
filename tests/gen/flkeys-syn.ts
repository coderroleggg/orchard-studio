// Synthetic FL Keys wavetables for the tests: the same data goes to FL's real plugin (through a private build of the
// test host that scans another Wavtables folder, `writeSynFiles`) and to the clone's loader (`synTable`), so FL's
// renders pin the loader and the engine without any of FL's own content. Deterministic.
import { Ini, buildKeysTable, type KeysFiles, type KeysTable, type KeysWave } from '../../src/engine/gen/plugins/flkeys/table';

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return (s / 4294967296) * 2 - 1; };
}

function tone(f: number, rate: number, n: number, amp: number, dec: number, harm: [number, number][], seed: number): Int16Array {
  const rnd = lcg(seed);
  const o = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const [k, a] of harm) v += a * Math.sin(2 * Math.PI * f * k * t + 0.3 * k);
    v = amp * v * Math.exp(-t * dec) + 0.01 * rnd() * Math.exp(-t * 20);
    o[i] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  }
  return o;
}

const hz = (n: number) => 440 * Math.pow(2, (n - 69) / 12);

export interface SynSet {
  /** The wavetable's name (info name, the plugin state refers to it). */
  name: string;
  wti: string;
  /** Raw sample files by name. */
  raw: Record<string, Int16Array>;
  /** RIFF waves by name (relative to `path`). */
  waves: Record<string, KeysWave>;
  /** `path=` of the wavetable (folder of its wave files). */
  path: string;
}

function rawSet(): SynSet {
  const rate = 22050;
  const data: number[] = [];
  const regs: { root: number; pos: number; end: number; loop: number }[] = [];
  [48, 60, 72].forEach((root, gi) => {
    for (let layer = 0; layer < 2; layer++) {
      const n = 6000 + gi * 1500 + layer * 700;
      const s = tone(hz(root), rate, n, 0.5, 0.8 + layer * 0.5, [[1, 1], [2, 0.4 + 0.3 * layer], [3, 0.2]], 11 + gi * 3 + layer);
      const pos = data.length;
      for (const v of s) data.push(v);
      data.push(0, 0);
      regs.push({ root, pos, end: pos + n - 1, loop: 1500 + 300 * gi + 200 * layer });
    }
  });
  const lines = ['[info]', 'name=Syn Raw', 'samples=6', 'samplefile=synraw.dat', 'filetype=raw', 'samplerate=22050', 'velocityfactor=2.5', '',
    '[velocitylayers]', 'count=2', '0=0', '1=70', ''];
  regs.forEach((r, i) => {
    lines.push(`[sample${i}]`);
    if (i % 2 === 0) { lines.push(`root=${r.root}`, `high=${r.root < 72 ? r.root + 5 : 999}`); }
    // the middle group's second layer shares the first one's data (like the Rhodes' top keys)
    if (i === 3) lines.push(`pos=${regs[2].pos}`, `end=${regs[2].end}`, `loop=${regs[2].loop}`);
    else lines.push(`pos=${r.pos}`, `end=${r.end}`, `loop=${r.loop}`);
    lines.push('');
  });
  return { name: 'Syn Raw', wti: lines.join('\r\n'), raw: { 'synraw.dat': Int16Array.from(data) }, waves: {}, path: '' };
}

function wave(rate: number, ch: 1 | 2, n: number, f: number, dec: number, seed: number, loop?: [number, number]): KeysWave {
  const m = tone(f, rate, n, 0.45, dec, [[1, 1], [2, 0.5], [4, 0.25]], seed);
  let data = m;
  if (ch === 2) {
    const r = tone(f * 1.003, rate, n, 0.4, dec * 1.2, [[1, 1], [3, 0.4]], seed + 100);
    data = new Int16Array(n * 2);
    for (let i = 0; i < n; i++) { data[2 * i] = m[i]; data[2 * i + 1] = r[i]; }
  }
  return { channels: ch, rate, data, loopStart: loop ? loop[0] : 0, loopEnd: loop ? loop[1] : n - 1 };
}

function riffSet(): SynSet {
  const w: Record<string, KeysWave> = {
    's1.wav': wave(44100, 1, 9000, hz(40), 1.2, 21, [3000, 8200]),
    's2.wav': wave(44100, 1, 8000, hz(52), 1.0, 22, [2500, 7400]),
    's3.wav': wave(44100, 1, 7000, hz(64), 2.0, 23),
    's4.wav': wave(44100, 1, 6000, hz(76), 3.0, 24, [1000, 5500]),
  };
  const wti = ['[info]', 'name=Syn Riff', 'samples=4', 'filetype=riff', 'samplerate=44100', 'path=Syn Riff', 'resample=false', 'velocityfactor=4', '',
    '[velocitylayers]', 'count=1', '0=0', '', '[parameters]', '0=0.25', '1=0.6', '7=0.75', '',
    '[sample0]', 'name=s1.wav', 'root=40', 'high=45', '',
    '[sample1]', 'name=s2.wav', 'root=52', 'high=57', '',
    '[sample2]', 'name=s3.wav', 'root=64', 'high=69', 'canloop=false', 'loop=500', '',
    '[sample3]', 'name=s4.wav', 'root=76', 'high=999', ''].join('\r\n');
  return { name: 'Syn Riff', wti, raw: {}, waves: w, path: 'Syn Riff' };
}

function stereoSet(): SynSet {
  const w: Record<string, KeysWave> = {
    'a.wav': wave(32000, 2, 9000, hz(45), 0.9, 31, [2000, 8500]),
    'b.wav': wave(32000, 2, 8000, hz(57), 1.1, 32, [1800, 7600]),
    'c.wav': wave(32000, 2, 7000, hz(69), 1.4, 33, [1500, 6500]),
  };
  const wti = ['[info]', 'name=Syn Stereo', 'samples=3', 'filetype=riff', 'samplerate=32000', 'path=Syn Stereo', 'resample=false', 'releasehighnotes=true', '',
    '[velocitylayers]', 'count=1', '0=0', '',
    '[sample0]', 'name=a.wav', 'root=45', 'high=51', '',
    '[sample1]', 'name=b.wav', 'root=57', 'high=63', '',
    '[sample2]', 'name=c.wav', 'root=69', 'high=999', ''].join('\r\n');
  return { name: 'Syn Stereo', wti, raw: {}, waves: w, path: 'Syn Stereo' };
}

/** Files at another rate than the host's, `resample` left at its default (FL converts them when it loads them). */
function resSet(): SynSet {
  const rate = 32000;
  const mk = (n: number, loop: [number, number] | undefined, seed: number): KeysWave => {
    const o = new Int16Array(n);
    const rnd = lcg(seed);
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      const v = 0.3 * Math.sin(2 * Math.PI * 440 * t) + 0.2 * Math.sin(2 * Math.PI * 3300 * t + 1) + 0.15 * Math.sin(2 * Math.PI * 9100 * t + 2) + 0.02 * rnd();
      o[i] = Math.round(v * 32767 * Math.min(1, i / 200));
    }
    return { channels: 1, rate, data: o, loopStart: loop ? loop[0] : 0, loopEnd: loop ? loop[1] : n - 1 };
  };
  const w: Record<string, KeysWave> = { 'r1.wav': mk(12000, [2000, 11004], 41), 'r2.wav': mk(9000, undefined, 42), 'r3.wav': mk(9002, undefined, 43) };
  const wti = ['[info]', 'name=Syn Res', 'samples=3', 'filetype=riff', 'samplerate=44100', 'path=Syn Res', '', '[velocitylayers]', 'count=1', '0=0', '',
    '[sample0]', 'name=r1.wav', 'root=50', 'high=60', '', '[sample1]', 'name=r2.wav', 'root=64', 'high=69', 'canloop=false', 'loop=300', '', '[sample2]', 'name=r3.wav', 'root=76', 'high=999', 'canloop=false', 'loop=300', ''].join('\r\n');
  return { name: 'Syn Res', wti, raw: {}, waves: w, path: 'Syn Res' };
}

export const SYN_NAMES = ['Syn Raw', 'Syn Riff', 'Syn Stereo', 'Syn Res'] as const;
export type SynName = (typeof SYN_NAMES)[number];

export function synSet(name: SynName): SynSet {
  return name === 'Syn Raw' ? rawSet() : name === 'Syn Riff' ? riffSet() : name === 'Syn Stereo' ? stereoSet() : resSet();
}

/** The clone's table of a synthetic wavetable (built by the loader's rules from the same data FL gets). */
export function synTable(name: SynName, hostRate = 44100): KeysTable {
  const s = synSet(name);
  const files: KeysFiles = {
    raw: (n) => s.raw[n] ?? null,
    wave: (n) => s.waves[n] ?? null,
  };
  return buildKeysTable(new Ini(s.wti), files, hostRate);
}

/** Write a wave file (16-bit PCM with an optional smpl chunk) as bytes. */
export function wavBytes(w: KeysWave, withLoop: boolean): Uint8Array {
  const n = w.data.length;
  const smpl = withLoop ? 8 + 60 : 0;
  const out = new Uint8Array(44 + n * 2 + smpl);
  const dv = new DataView(out.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2 + smpl, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, w.channels, true); dv.setUint32(24, w.rate, true);
  dv.setUint32(28, w.rate * w.channels * 2, true); dv.setUint16(32, w.channels * 2, true); dv.setUint16(34, 16, true);
  str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + 2 * i, w.data[i], true);
  if (withLoop) {
    const o = 44 + n * 2;
    str(o, 'smpl'); dv.setUint32(o + 4, 60, true);
    dv.setUint32(o + 8 + 28, 1, true); // one loop
    dv.setUint32(o + 8 + 44, w.loopStart, true); dv.setUint32(o + 8 + 48, w.loopEnd, true);
  }
  return out;
}
