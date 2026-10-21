// FL Keys' own wavetables read from the user's FL Studio install, for the tests that compare the engine with FL's
// renders (skipped when FL is not installed): the .wti descriptors, raw .dat, PCM wavs and FL's Ogg Vorbis wavs
// (decoded with ffmpeg when it is installed, x 32767 like FL's decoder). Nothing of FL is stored in the repository.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KEYS_CATALOG } from '../../src/engine/gen/plugins/flkeys/catalog';
import { Ini, buildKeysTable, type KeysTable, type KeysWave } from '../../src/engine/gen/plugins/flkeys/table';

export const FL_WT = '/Applications/FL Studio 2026.app/Contents/Resources/FL/Plugins/Fruity/Generators/FL Keys/Wavtables';
export const FL_INSTALLED = existsSync(`${FL_WT}/default.wti`);

let ffmpegOk: boolean | null = null;
export function hasFfmpeg(): boolean {
  if (ffmpegOk === null) {
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegOk = true; } catch { ffmpegOk = false; }
  }
  return ffmpegOk;
}

function readWave(path: string): KeysWave | null {
  const b = readFileSync(path);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let fmt = 0, ch = 1, rate = 44100, bits = 16, dataOff = -1, dataLen = 0, ls = 0, le = -1, fact = 0;
  for (let o = 12; o + 8 <= b.length;) {
    const id = b.toString('latin1', o, o + 4), n = dv.getUint32(o + 4, true), body = o + 8;
    if (id === 'fmt ') { fmt = dv.getUint16(body, true); ch = dv.getUint16(body + 2, true); rate = dv.getUint32(body + 4, true); bits = dv.getUint16(body + 14, true); }
    else if (id === 'data') { dataOff = body; dataLen = Math.min(n, b.length - body); }
    else if (id === 'fact') fact = dv.getUint32(body, true);
    else if (id === 'smpl' && n >= 60 && dv.getUint32(body + 28, true) > 0) { ls = dv.getUint32(body + 44, true); le = dv.getUint32(body + 48, true); }
    o = body + n + (n & 1);
  }
  if (dataOff < 0) return null;
  if (fmt === 1 && bits === 16) {
    const data = new Int16Array(dataLen >> 1);
    for (let i = 0; i < data.length; i++) data[i] = dv.getInt16(dataOff + 2 * i, true);
    return { channels: ch as 1 | 2, rate, data, loopStart: ls, loopEnd: le < 0 ? Math.floor(data.length / ch) - 1 : le };
  }
  if (fmt === 0x674f && hasFfmpeg()) {
    const dir = mkdtempSync(join(tmpdir(), 'flkeys-'));
    try {
      writeFileSync(join(dir, 'x.ogg'), b.subarray(dataOff, dataOff + dataLen));
      let out: Buffer;
      try { out = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, 'x.ogg'), '-f', 'f32le', '-ac', String(ch), '-ar', String(rate), '-'], { maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch (e) { out = (e as { stdout?: Buffer }).stdout ?? Buffer.alloc(0); }
      const f = new Float32Array(out.buffer, out.byteOffset, out.length >> 2);
      const n = fact > 0 ? fact * ch : f.length;
      const data = new Int16Array(n);
      for (let i = 0; i < Math.min(n, f.length); i++) data[i] = Math.max(-32768, Math.min(32767, Math.round(f[i] * 32767)));
      return { channels: ch as 1 | 2, rate, data, loopStart: 0, loopEnd: Math.floor(n / ch) - 1 };
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  return null;
}

const tables = new Map<string, KeysTable>();

/** FL's wavetable `name` (a KEYS_CATALOG name) as the loader builds it, or null when FL (or ffmpeg for the Ogg wavs) is missing. */
export function loadFlTable(name: string): KeysTable | null {
  if (!FL_INSTALLED) return null;
  const hit = tables.get(name);
  if (hit) return hit;
  const e = KEYS_CATALOG.find((x) => x.name === name);
  if (!e) return null;
  const ini = new Ini(readFileSync(`${FL_WT}/${e.file}`, 'latin1'));
  const base = ini.str('info', 'path', '');
  const ci = (n: string) => (existsSync(`${FL_WT}/${n}`) ? n : readdirSync(FL_WT).find((f) => f.toLowerCase() === n.toLowerCase()) ?? n);
  try {
    const t = buildKeysTable(ini, {
      raw: (n) => { const b = readFileSync(`${FL_WT}/${ci(n)}`); const d = new Int16Array(b.length >> 1); for (let i = 0; i < d.length; i++) d[i] = b.readInt16LE(2 * i); return d; },
      wave: (n) => readWave(`${FL_WT}/${base}/${n}`),
    }, 44100);
    tables.set(name, t);
    return t;
  } catch {
    return null;
  }
}
