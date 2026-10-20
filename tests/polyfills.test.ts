// The AudioWorklet lacks atob / btoa / TextDecoder / structuredClone: src/engine/polyfills.ts
// provides them there. Check the polyfills against Node's own implementations.
import { describe, it, expect } from 'vitest';

const g = globalThis as Record<string, unknown>;
const nodeAtob = globalThis.atob, nodeBtoa = globalThis.btoa, NodeTD = globalThis.TextDecoder;

describe('worklet polyfills', () => {
  it('atob / btoa / TextDecoder match the platform versions', async () => {
    delete g.atob;
    delete g.btoa;
    delete g.TextDecoder;
    await import('../src/engine/polyfills');
    const atob = g.atob as (s: string) => string, btoa = g.btoa as (s: string) => string;
    expect(atob).not.toBe(nodeAtob);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    for (let n = 0; n < 200; n++) {
      const len = Math.floor(rnd() * 40);
      let s = '';
      for (let i = 0; i < len; i++) s += String.fromCharCode(Math.floor(rnd() * 256));
      const enc = btoa(s);
      expect(enc).toBe(nodeBtoa(s));
      expect(atob(enc)).toBe(s);
      expect(atob(enc)).toBe(nodeAtob(enc));
    }
    expect(atob(' QU JD\n')).toBe('ABC');
    const TD = g.TextDecoder as typeof NodeTD;
    expect(TD).not.toBe(NodeTD);
    const text = 'Harmor — Ünïcode ✓ 🎹 plain';
    const utf8 = new TextEncoder().encode(text);
    expect(new TD().decode(utf8)).toBe(new NodeTD().decode(utf8));
    const u16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); u16[2 * i] = c & 255; u16[2 * i + 1] = c >> 8; }
    expect(new TD('utf-16le').decode(u16)).toBe(text);
    expect(new TD('utf-8').decode(new Uint8Array([0x41, 0xff, 0x42]))).toBe('A�B');
  });
});
