// Minimal raw DEFLATE (RFC 1951) decoder for the compressed Sytrus preset bank
// (synchronous, no dependencies; decoding runs once, on first preset access).

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073,
  4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

/** Canonical Huffman decoding table: counts per length and symbols sorted by code. */
interface Huff { count: Uint16Array; sym: Uint16Array }

function build(lengths: ArrayLike<number>, n: number): Huff {
  const count = new Uint16Array(16);
  for (let i = 0; i < n; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const sym = new Uint16Array(n);
  for (let i = 0; i < n; i++) if (lengths[i]) sym[offs[lengths[i]]++] = i;
  return { count, sym };
}

export function inflateRaw(src: Uint8Array): Uint8Array {
  let out = new Uint8Array(Math.max(1024, src.length * 4));
  let op = 0;
  let pos = 0, bitBuf = 0, bitCnt = 0;
  const need = (n: number) => {
    while (bitCnt < n) {
      if (pos >= src.length) throw new Error('inflate: truncated');
      bitBuf |= src[pos++] << bitCnt;
      bitCnt += 8;
    }
  };
  const bits = (n: number): number => {
    if (n === 0) return 0;
    need(n);
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  };
  const decode = (h: Huff): number => {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.sym[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('inflate: bad code');
  };
  const ensure = (n: number) => {
    if (op + n <= out.length) return;
    const grown = new Uint8Array(Math.max(out.length * 2, op + n));
    grown.set(out.subarray(0, op));
    out = grown;
  };
  let fixedLit: Huff | null = null, fixedDist: Huff | null = null;
  let last = 0;
  while (!last) {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0; bitCnt = 0;
      const len = src[pos] | (src[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(src.subarray(pos, pos + len), op);
      op += len; pos += len;
      continue;
    }
    let lit: Huff, dist: Huff;
    if (type === 1) {
      if (!fixedLit) {
        const l = new Uint8Array(288);
        l.fill(8, 0, 144); l.fill(9, 144, 256); l.fill(7, 256, 280); l.fill(8, 280, 288);
        fixedLit = build(l, 288);
        fixedDist = build(new Uint8Array(30).fill(5), 30);
      }
      lit = fixedLit; dist = fixedDist!;
    } else if (type === 2) {
      const hlit = bits(5) + 257, hdist = bits(5) + 1, hclen = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < hclen; i++) cl[CL_ORDER[i]] = bits(3);
      const clh = build(cl, 19);
      const lens = new Uint8Array(hlit + hdist);
      for (let i = 0; i < hlit + hdist;) {
        const s = decode(clh);
        if (s < 16) lens[i++] = s;
        else if (s === 16) { const r = 3 + bits(2), p = lens[i - 1]; for (let k = 0; k < r; k++) lens[i++] = p; }
        else if (s === 17) i += 3 + bits(3);
        else i += 11 + bits(7);
      }
      lit = build(lens.subarray(0, hlit), hlit);
      dist = build(lens.subarray(hlit), hdist);
    } else throw new Error('inflate: bad block type');
    for (;;) {
      const s = decode(lit);
      if (s < 256) { ensure(1); out[op++] = s; continue; }
      if (s === 256) break;
      const li = s - 257;
      const len = LEN_BASE[li] + bits(LEN_EXTRA[li]);
      const di = decode(dist);
      const d = DIST_BASE[di] + bits(DIST_EXTRA[di]);
      ensure(len);
      for (let k = 0; k < len; k++, op++) out[op] = out[op - d];
    }
  }
  return out.subarray(0, op);
}

/** Base64 (standard alphabet) to bytes; no dependency on atob (worklet / Node). */
export function base64ToBytes(s: string): Uint8Array {
  const T = new Int16Array(128).fill(-1);
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  for (let i = 0; i < 64; i++) T[A.charCodeAt(i)] = i;
  let n = s.length;
  while (n > 0 && s[n - 1] === '=') n--;
  const out = new Uint8Array((n * 3) >> 2);
  let acc = 0, cnt = 0, o = 0;
  for (let i = 0; i < n; i++) {
    const v = T[s.charCodeAt(i)];
    if (v < 0) continue;
    acc = (acc << 6) | v; cnt += 6;
    if (cnt >= 8) { cnt -= 8; out[o++] = (acc >> cnt) & 0xff; }
  }
  return out.subarray(0, o);
}
