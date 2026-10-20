// Globals missing from AudioWorkletGlobalScope. Imported first by worklet.ts
// so they exist before any engine, model or plugin module is evaluated.
// (Plugin definitions in src/model/fx are shared with the UI and also load in
// the worklet, which has no DOM, structuredClone, timers or fetch.)

type Cloneable = unknown;

function cloneValue(v: Cloneable, seen: Map<object, unknown>): Cloneable {
  if (v === null || typeof v !== 'object') return v;
  const known = seen.get(v as object);
  if (known !== undefined) return known;
  if (ArrayBuffer.isView(v)) {
    const out = (v as unknown as { slice(): unknown }).slice();
    seen.set(v as object, out);
    return out;
  }
  if (v instanceof ArrayBuffer) { const out = v.slice(0); seen.set(v, out); return out; }
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Map) {
    const out = new Map();
    seen.set(v, out);
    for (const [k, x] of v) out.set(cloneValue(k, seen), cloneValue(x, seen));
    return out;
  }
  if (v instanceof Set) {
    const out = new Set();
    seen.set(v, out);
    for (const x of v) out.add(cloneValue(x, seen));
    return out;
  }
  if (Array.isArray(v)) {
    const out: unknown[] = new Array(v.length);
    seen.set(v, out);
    for (let i = 0; i < v.length; i++) out[i] = cloneValue(v[i], seen);
    return out;
  }
  const out: Record<string, unknown> = {};
  seen.set(v as object, out);
  for (const k of Object.keys(v as object)) out[k] = cloneValue((v as Record<string, unknown>)[k], seen);
  return out;
}

const g = globalThis as unknown as {
  structuredClone?: (v: unknown) => unknown;
  atob?: (s: string) => string;
  btoa?: (s: string) => string;
  TextDecoder?: unknown;
};
if (typeof g.structuredClone !== 'function') {
  g.structuredClone = (v: unknown) => cloneValue(v, new Map());
}

// base64 (plugin definitions decode embedded tables and preset banks with atob / btoa)
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
if (typeof g.btoa !== 'function') {
  g.btoa = (s: string) => {
    let out = '';
    for (let i = 0; i < s.length; i += 3) {
      const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: character out of range');
      const n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  };
}
if (typeof g.atob !== 'function') {
  const rev = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) rev[B64.charCodeAt(i)] = i;
  g.atob = (s: string) => {
    let out = '', buf = 0, bits = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c === 61) break; // '='
      const v = c < 128 ? rev[c] : -1;
      if (v < 0) { if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12) continue; throw new Error('atob: invalid character'); }
      buf = (buf << 6) | v;
      bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode((buf >> bits) & 255); }
    }
    return out;
  };
}

// TextDecoder for utf-8 / utf-16le / latin1 (plugin state parsers; not in every AudioWorkletGlobalScope)
if (typeof g.TextDecoder !== 'function') {
  class MiniTextDecoder {
    private readonly enc: string;
    constructor(label = 'utf-8') { this.enc = String(label).toLowerCase().replace(/_/g, '-'); }
    get encoding(): string { return this.enc; }
    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const b = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      let out = '';
      if (this.enc === 'utf-16le' || this.enc === 'utf-16') {
        for (let i = 0; i + 1 < b.length; i += 2) out += String.fromCharCode(b[i] | (b[i + 1] << 8));
        return out;
      }
      if (this.enc === 'latin1' || this.enc === 'iso-8859-1' || this.enc === 'ascii' || this.enc === 'windows-1252') {
        for (let i = 0; i < b.length; i++) out += String.fromCharCode(b[i]);
        return out;
      }
      // utf-8 (invalid sequences -> U+FFFD)
      for (let i = 0; i < b.length;) {
        const c = b[i++];
        if (c < 0x80) { out += String.fromCharCode(c); continue; }
        let need = 0, cp = 0;
        if (c >= 0xc2 && c <= 0xdf) { need = 1; cp = c & 0x1f; } else if (c >= 0xe0 && c <= 0xef) { need = 2; cp = c & 0x0f; } else if (c >= 0xf0 && c <= 0xf4) { need = 3; cp = c & 0x07; } else { out += '\ufffd'; continue; }
        let ok = i + need <= b.length;
        for (let k = 0; ok && k < need; k++) { const d = b[i + k]; if ((d & 0xc0) !== 0x80) ok = false; else cp = (cp << 6) | (d & 0x3f); }
        if (!ok) { out += '\ufffd'; continue; }
        i += need;
        out += String.fromCodePoint(cp);
      }
      return out;
    }
  }
  g.TextDecoder = MiniTextDecoder;
}

export {};
